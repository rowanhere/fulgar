//! Native Rust Argon2id PoW core for BrowserCoin.
//!
//! Invariant: the digest produced here MUST be
//! byte-identical to the WASM `powHash` (src/crypto/pow.ts), which uses the
//! openpgpjs/argon2id WASM implementation of RFC 9106 Argon2id.
//!
//! Parameters (mirrored from POW_PARAMS in src/crypto/pow.ts):
//!   - Algorithm : Argon2id
//!   - Version   : 0x13 (RFC 9106 / v1.3)
//!   - Memory    : 32 * 1024 KiB = 32768 KiB (32 MB)
//!   - Iterations: 1 (passes)
//!   - Parallelism: 1 (lanes)
//!   - Output    : 32 bytes
//!   - Salt      : raw ASCII bytes of "browsercoin-pow-v5" (NOT base64-decoded)
//!   - Password  : the raw header bytes (encodeHeader output, 148 bytes)
//!
//! CLI:
//!   brc-pow hash <header-hex>
//!     -> prints lowercase hex of the 32-byte Argon2id digest.
//!
//!   brc-pow grind <header-hex> <target-hex> <start> <end> <throttle> [continuous]
//!     -> loops nonce in [start, end), writing the u32 nonce BIG-ENDIAN at byte
//!        offset 112 of the 148-byte header (same offset as src/minerd/powWorker.ts),
//!        argon2id-hashes, and big-endian-compares hash < target. On each hit
//!        prints `SOLVED <nonce> <hashhex>` to stdout. By default it exits after
//!        the first hit; with continuous set to `1` or `true`, it keeps scanning
//!        the range and reports every hit. If the range is exhausted prints
//!        `EXHAUSTED`. Honors `throttle` in (0,1] with the same duty-cycle idea
//!        as powWorker.ts (rest in proportion to time just spent hashing). Emits
//!        `HASHRATE <n>` to stderr roughly once per second. Single-threaded per
//!        process — Node spawns one process per nonce range.

mod affinity;
mod hugepage;

use argon2::{Algorithm, Argon2, Block, Params, Version};
use hugepage::HugeBuffer;
use sha2::{Digest, Sha256};
use std::io::BufRead;
use std::process::exit;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Network-wide fixed salt — must match `SALT` in src/crypto/pow.ts exactly.
const SALT: &[u8] = b"browsercoin-pow-v5";

const MEM_KIB: u32 = 32 * 1024; // 32768 KiB
const ITERATIONS: u32 = 1;
const PARALLELISM: u32 = 1;
const OUTPUT_LEN: usize = 32;

/// u32 nonce position in the 148-byte header — must match NONCE_OFFSET in
/// src/minerd/powWorker.ts (and miner.worker.ts).
const NONCE_OFFSET: usize = 112;
const HEADER_LEN: usize = 148;
const HASHRATE_REPORT: Duration = Duration::from_millis(1000);

// ─── Fork #2: Sandglass v3 PoW — mirrors src/crypto/sandglass.ts byte-for-byte ───
// Any deviation → wrong digest → post-fork blocks rejected → wedge. The frozen
// vectors (src/crypto/sandglass.vectors.json) are the ultimate arbiter.
//
// ⚠️ MUST match SANDGLASS_FORK_HEIGHT in src/chain/genesis.ts. Rust can't import
// the TS constant; the boundary check in parity-harness.ts is the anti-drift gate.
const SANDGLASS_FORK_HEIGHT: u32 = 33_550;

const SG_W: usize = 1 << 17; // 131,072 u32 = 512 KiB
const SG_MASK: u32 = (SG_W as u32) - 1; // 0x1FFFF
const SG_STEPS: usize = 1 << 21; // 2,097,152 total dependent steps
const SG_CHAINS: usize = 4;
const SG_PER: usize = SG_STEPS / SG_CHAINS; // 524,288 steps per chain
const GOLDEN: u32 = 0x9e37_79b9;

/// Hints the memory subsystem to start fetching `buf[idx]` now, ahead of when the
/// walk actually reads it (3 other chains' worth of work away, since the loop below
/// is step-outer / chain-inner). A hardware hint only — it can never change which
/// values get computed or written, only when the underlying cache line arrives, so
/// it needs no test coverage beyond the existing digest parity tests still passing.
/// Measured +9-14% single-thread on a real Ryzen 7000-series box with this exact
/// walk shape (own benchmark, not this repo) — free on any platform where the
/// intrinsic isn't available, since the fallback below is a no-op.
#[inline(always)]
#[cfg(target_arch = "x86_64")]
fn sg_prefetch(buf: &[u32], idx: u32) {
    #[cfg(target_feature = "sse")]
    unsafe {
        std::arch::x86_64::_mm_prefetch(buf.as_ptr().add(idx as usize) as *const i8, std::arch::x86_64::_MM_HINT_T0);
    }
}
#[inline(always)]
#[cfg(not(target_arch = "x86_64"))]
fn sg_prefetch(_buf: &[u32], _idx: u32) {}

/// lowbias32 32-bit finalizer — matches `mix` in sandglass.ts (all wrapping u32).
#[inline(always)]
fn sg_mix(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

/// Block height = the header's first 4 bytes, u32 big-endian. Mirrors the gate in
/// src/crypto/pow.ts and the encodeHeader layout.
#[inline]
fn header_height(header: &[u8]) -> u32 {
    ((header[0] as u32) << 24)
        | ((header[1] as u32) << 16)
        | ((header[2] as u32) << 8)
        | (header[3] as u32)
}

/// Sandglass core: fill `buf` (a reused 512 KiB heap scratch — never a stack
/// array, which overflows a spawned grind worker thread) from SHA256(header) and
/// run the 4-chain read-modify-write walk. Returns the 32-byte digest.
///
/// Mirrors `sandglassHash`/`fillAndWalk` in src/crypto/sandglass.ts exactly.
fn sandglass_hash_into(header: &[u8], buf: &mut [u32]) -> [u8; OUTPUT_LEN] {
    debug_assert_eq!(buf.len(), SG_W);
    let digest = Sha256::digest(header);
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&digest);

    // The 8 words of the 256-bit seed (big-endian).
    let mut sw = [0u32; 8];
    for i in 0..8 {
        sw[i] = u32::from_be_bytes([seed[i * 4], seed[i * 4 + 1], seed[i * 4 + 2], seed[i * 4 + 3]]);
    }

    // Phase 1 — fill. One seed word injected on EVERY step (cyclically), so the
    // buffer — and the whole walk that reads it — is keyed by all 256 seed bits.
    let mut h = sg_mix(sw[0] ^ GOLDEN);
    for i in 0..SG_W {
        h = sg_mix(h.wrapping_add(GOLDEN).wrapping_add(sw[i & 7]));
        buf[i] = h;
    }

    // Init 4 chains from h (same derivation as the bench kernel).
    let mut x = h;
    x = sg_mix(x ^ 1); let mut a0 = sg_mix(x ^ GOLDEN); let mut i0 = (x & SG_MASK) as usize;
    x = sg_mix(x ^ 2); let mut a1 = sg_mix(x ^ GOLDEN); let mut i1 = (x & SG_MASK) as usize;
    x = sg_mix(x ^ 3); let mut a2 = sg_mix(x ^ GOLDEN); let mut i2 = (x & SG_MASK) as usize;
    x = sg_mix(x ^ 4); let mut a3 = sg_mix(x ^ GOLDEN); let mut i3 = (x & SG_MASK) as usize;

    // Phase 2 — 4 interleaved dependent read-modify-write walks.
    for s in 0..SG_PER {
        let s = s as u32;
        a0 = sg_mix(a0 ^ buf[i0]); buf[i0] = a0.wrapping_add(s); i0 = (a0 & SG_MASK) as usize; sg_prefetch(buf, i0 as u32);
        a1 = sg_mix(a1 ^ buf[i1]); buf[i1] = a1.wrapping_add(s); i1 = (a1 & SG_MASK) as usize; sg_prefetch(buf, i1 as u32);
        a2 = sg_mix(a2 ^ buf[i2]); buf[i2] = a2.wrapping_add(s); i2 = (a2 & SG_MASK) as usize; sg_prefetch(buf, i2 as u32);
        a3 = sg_mix(a3 ^ buf[i3]); buf[i3] = a3.wrapping_add(s); i3 = (a3 & SG_MASK) as usize; sg_prefetch(buf, i3 as u32);
    }

    // Phase 3 — finalize: SHA256(seed ‖ u32be(h) ‖ u32be(a0..a3)).
    let mut fin = [0u8; 52];
    fin[0..32].copy_from_slice(&seed);
    fin[32..36].copy_from_slice(&h.to_be_bytes());
    fin[36..40].copy_from_slice(&a0.to_be_bytes());
    fin[40..44].copy_from_slice(&a1.to_be_bytes());
    fin[44..48].copy_from_slice(&a2.to_be_bytes());
    fin[48..52].copy_from_slice(&a3.to_be_bytes());
    let out = Sha256::digest(fin);
    let mut result = [0u8; OUTPUT_LEN];
    result.copy_from_slice(&out);
    result
}

/// Convenience wrapper that allocates its own 512 KiB scratch (for `hash` + tests;
/// the grind loop reuses one buffer per process instead).
fn sandglass_hash(header: &[u8]) -> [u8; OUTPUT_LEN] {
    let mut buf = vec![0u32; SG_W];
    sandglass_hash_into(header, &mut buf)
}

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err(format!("hex string has odd length ({})", s.len()));
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    let nib = |c: u8| -> Result<u8, String> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(format!("invalid hex char: {:?}", c as char)),
        }
    };
    let mut i = 0;
    while i < bytes.len() {
        let hi = nib(bytes[i])?;
        let lo = nib(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Compute the Argon2id PoW digest of `password` using the fixed network salt.
/// Byte-identical to the WASM `powHash`.
pub fn pow_hash(password: &[u8]) -> Result<[u8; OUTPUT_LEN], String> {
    let params = Params::new(MEM_KIB, ITERATIONS, PARALLELISM, Some(OUTPUT_LEN))
        .map_err(|e| format!("invalid argon2 params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; OUTPUT_LEN];
    argon2
        .hash_password_into(password, SALT, &mut out)
        .map_err(|e| format!("argon2 hashing failed: {e}"))?;
    Ok(out)
}

/// Height-gated single hash: Sandglass v3 at/after the fork height, Argon2id
/// below it. Mirrors the gate in src/crypto/pow.ts (powHash).
fn pow_dispatch(header: &[u8]) -> Result<[u8; OUTPUT_LEN], String> {
    if header.len() < 4 {
        return Err(format!("header too short for height: {} bytes", header.len()));
    }
    if header_height(header) >= SANDGLASS_FORK_HEIGHT {
        Ok(sandglass_hash(header))
    } else {
        pow_hash(header)
    }
}

/// Write `nonce` as a big-endian u32 at NONCE_OFFSET of `header`.
/// Mirrors writeNonceBE() in src/minerd/powWorker.ts byte-for-byte.
#[inline]
fn write_nonce_be(header: &mut [u8], nonce: u32) {
    header[NONCE_OFFSET] = ((nonce >> 24) & 0xff) as u8;
    header[NONCE_OFFSET + 1] = ((nonce >> 16) & 0xff) as u8;
    header[NONCE_OFFSET + 2] = ((nonce >> 8) & 0xff) as u8;
    header[NONCE_OFFSET + 3] = (nonce & 0xff) as u8;
}

/// Big-endian 256-bit comparison: returns true iff `hash` < `target`.
/// Both are 32-byte arrays interpreted as big-endian unsigned integers — the
/// same numeric semantics as hashMeetsTarget() in src/util/binary.ts.
#[inline]
fn meets_target(hash: &[u8; OUTPUT_LEN], target: &[u8; OUTPUT_LEN]) -> bool {
    for i in 0..OUTPUT_LEN {
        if hash[i] != target[i] {
            return hash[i] < target[i];
        }
    }
    false // equal => not strictly less than
}

/// Grind a contiguous nonce range single-threaded.
///
/// Returns the exit code to use. Prints `SOLVED <nonce> <hashhex>` to stdout for
/// each nonce whose digest is strictly below the target. In non-continuous mode
/// it returns 0 after the first hit; in continuous mode it keeps scanning the
/// range. Otherwise prints `EXHAUSTED` and returns 0. Emits `HASHRATE <n>` to
/// stderr roughly once per second (n = hashes completed in the last ~1s window).
fn grind(
    mut header: Vec<u8>,
    target: [u8; OUTPUT_LEN],
    start: u64,
    end: u64,
    throttle: f64,
    continuous: bool,
) -> Result<i32, String> {
    if header.len() != HEADER_LEN {
        return Err(format!(
            "header must be {HEADER_LEN} bytes, got {}",
            header.len()
        ));
    }
    // Clamp throttle into (0, 1], mirroring powWorker.ts's duty-cycle clamp
    // (Math.min(1, Math.max(0.05, throttle))).
    let throttle = throttle.max(0.05).min(1.0);
    let throttle_bits = Arc::new(AtomicU64::new(throttle.to_bits()));
    {
        let tb = Arc::clone(&throttle_bits);
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines().flatten() {
                if let Some(rest) = line.trim().strip_prefix("THROTTLE ") {
                    if let Ok(v) = rest.trim().parse::<f64>() {
                        tb.store(v.max(0.05).min(1.0).to_bits(), Ordering::Relaxed);
                    }
                }
            }
        });
    }

    // Height is constant across a grind range (only the nonce at offset 112
    // varies), so pick the PoW engine ONCE. At/after the fork → Sandglass; below
    // → Argon2id (byte-unchanged). Allocate only the scratch the chosen engine
    // needs — the 32 MB Argon2 blocks OR the 512 KiB Sandglass buffer, never both.
    let sandglass = header_height(&header) >= SANDGLASS_FORK_HEIGHT;
    let params = Params::new(MEM_KIB, ITERATIONS, PARALLELISM, Some(OUTPUT_LEN))
        .map_err(|e| format!("invalid argon2 params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params.clone());
    let mut blocks = if sandglass {
        Vec::new()
    } else {
        vec![Block::new(); params.block_count()]
    };
    // Huge-page (2 MiB) allocation on Windows when the environment grants it,
    // transparently falling back to a normal Vec otherwise — never a regression,
    // see hugepage.rs. Only allocated for the Sandglass era, same as before.
    let mut sg_buf: Option<HugeBuffer> = if sandglass { Some(HugeBuffer::new(SG_W)) } else { None };

    let mut hashes_window: u64 = 0;
    let mut last_report = Instant::now();

    // u64 loop counter so `end == 2^32` (the exclusive upper bound of the
    // nonce space, i.e. partitionNonceSpace's last range end) is representable
    // without overflow. Nonces themselves are always < 2^32 (u32 in the header).
    let mut nonce: u64 = start;
    while nonce < end {
        write_nonce_be(&mut header, nonce as u32);
        let t0 = Instant::now();
        let out = if sandglass {
            sandglass_hash_into(&header, sg_buf.as_mut().expect("sg_buf allocated when sandglass is true").as_mut_slice())
        } else {
            let mut o = [0u8; OUTPUT_LEN];
            argon2
                .hash_password_into_with_memory(&header, SALT, &mut o, &mut blocks)
                .map_err(|e| format!("argon2 hashing failed: {e}"))?;
            o
        };
        let work = t0.elapsed();
        hashes_window += 1;

        if meets_target(&out, &target) {
            println!("SOLVED {} {}", nonce, to_hex(&out));
            if !continuous {
                return Ok(0);
            }
        }

        // Duty-cycle throttle: rest in proportion to the time just spent
        // hashing, so sustained CPU is capped at ~throttle (same idea as
        // powWorker.ts). 1.0 = full blast (no sleep).
        let throttle = f64::from_bits(throttle_bits.load(Ordering::Relaxed));
        if throttle < 1.0 {
            let work_ms = work.as_secs_f64() * 1000.0;
            let sleep_ms = (work_ms * (1.0 - throttle) / throttle).min(1000.0);
            if sleep_ms >= 1.0 {
                std::thread::sleep(Duration::from_secs_f64(sleep_ms / 1000.0));
            }
        }

        let now = Instant::now();
        if now.duration_since(last_report) >= HASHRATE_REPORT {
            eprintln!("HASHRATE {}", hashes_window);
            hashes_window = 0;
            last_report = now;
        }

        nonce += 1;
    }

    println!("EXHAUSTED");
    Ok(0)
}

/// Parse a nonce-space bound (start or end). Accepts decimal in [0, 2^32].
/// 2^32 (4294967296) is the exclusive upper bound used by partitionNonceSpace
/// for the final range's `end`.
fn parse_bound(s: &str, name: &str) -> Result<u64, String> {
    let s = s.trim();
    match s.parse::<u64>() {
        Ok(v) if v <= 1u64 << 32 => Ok(v),
        Ok(v) => Err(format!("{name}={v} exceeds 2^32")),
        Err(_) => Err(format!("invalid {name}: {s:?}")),
    }
}

const USAGE: &str = "usage:\n  brc-pow hash <header-hex>\n  brc-pow grind <header-hex> <target-hex> <start> <end> <throttle> [continuous]";

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("error: {msg}");
    exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("{USAGE}");
        exit(2);
    }
    match args[1].as_str() {
        "hash" => {
            if args.len() != 3 {
                eprintln!("{USAGE}");
                exit(2);
            }
            let header = decode_hex(&args[2]).unwrap_or_else(|e| fail(e));
            match pow_dispatch(&header) {
                Ok(digest) => println!("{}", to_hex(&digest)),
                Err(e) => fail(e),
            }
        }
        "grind" => {
            if args.len() != 7 && args.len() != 8 {
                eprintln!("{USAGE}");
                exit(2);
            }
            let header = decode_hex(&args[2]).unwrap_or_else(|e| fail(e));
            let target_bytes = decode_hex(&args[3]).unwrap_or_else(|e| fail(e));
            if target_bytes.len() != OUTPUT_LEN {
                fail(format!(
                    "target must be {OUTPUT_LEN} bytes ({} hex chars), got {} bytes",
                    OUTPUT_LEN * 2,
                    target_bytes.len()
                ));
            }
            let mut target = [0u8; OUTPUT_LEN];
            target.copy_from_slice(&target_bytes);

            let start = parse_bound(&args[4], "start").unwrap_or_else(|e| fail(e));
            let end = parse_bound(&args[5], "end").unwrap_or_else(|e| fail(e));
            if start > end {
                fail(format!("start ({start}) > end ({end})"));
            }
            let throttle: f64 = args[6]
                .trim()
                .parse()
                .unwrap_or_else(|_| fail(format!("invalid throttle: {:?}", args[6])));
            let continuous = args
                .get(7)
                .map(|v| {
                    let v = v.trim();
                    v == "1" || v.eq_ignore_ascii_case("true")
                })
                .unwrap_or(false);

            affinity::pin_worker_from_env();

            match grind(header, target, start, end, throttle, continuous) {
                Ok(code) => exit(code),
                Err(e) => fail(e),
            }
        }
        other => {
            eprintln!("unknown subcommand: {other}");
            eprintln!("{USAGE}");
            exit(2);
        }
    }
}

#[cfg(test)]
mod sandglass_tests {
    use super::{decode_hex, sandglass_hash, to_hex};

    #[derive(serde::Deserialize)]
    struct Vector {
        #[serde(rename = "headerHex")]
        header_hex: String,
        #[serde(rename = "digestHex")]
        digest_hex: String,
    }

    /// The Rust Sandglass core must reproduce the SAME frozen digests the TS side
    /// pins (src/crypto/sandglass.vectors.json). One wrong bit fails here — this is
    /// the Node-independent do-or-wedge gate on the Rust port. If the vectors are
    /// regenerated upstream, re-copy the json (Task 2) and this test tracks it.
    #[test]
    fn reproduces_frozen_vectors() {
        let raw = include_str!("../../../src/crypto/sandglass.vectors.json");
        let vectors: Vec<Vector> = serde_json::from_str(raw).expect("parse vectors json");
        assert!(vectors.len() >= 5, "expected >=5 frozen vectors, got {}", vectors.len());
        for v in &vectors {
            let header = decode_hex(&v.header_hex).expect("decode header hex");
            let got = to_hex(&sandglass_hash(&header));
            assert_eq!(got, v.digest_hex, "Sandglass digest mismatch for header {}", v.header_hex);
        }
    }

    use super::{header_height, pow_dispatch, pow_hash, SANDGLASS_FORK_HEIGHT};

    fn header_at_height(height: u32) -> Vec<u8> {
        let mut h = vec![0u8; 148];
        h[0] = (height >> 24) as u8;
        h[1] = (height >> 16) as u8;
        h[2] = (height >> 8) as u8;
        h[3] = height as u8;
        h
    }

    /// Anti-drift: the Rust gate must switch eras at EXACTLY SANDGLASS_FORK_HEIGHT
    /// (mirroring genesis.ts). If this Rust const drifts from the TS one, the
    /// boundary check in parity-harness.ts also catches it against the live TS gate.
    #[test]
    fn gate_switches_exactly_at_fork_height() {
        let below = header_at_height(SANDGLASS_FORK_HEIGHT - 1);
        let at = header_at_height(SANDGLASS_FORK_HEIGHT);
        assert_eq!(header_height(&below), SANDGLASS_FORK_HEIGHT - 1);
        assert_eq!(header_height(&at), SANDGLASS_FORK_HEIGHT);
        // Below the fork → Argon2id path.
        assert_eq!(pow_dispatch(&below).unwrap(), pow_hash(&below).unwrap());
        // At/after the fork → Sandglass path.
        assert_eq!(pow_dispatch(&at).unwrap(), sandglass_hash(&at));
        // The two eras must differ for the same-shaped header.
        assert_ne!(pow_dispatch(&below).unwrap(), pow_dispatch(&at).unwrap());
    }
}
