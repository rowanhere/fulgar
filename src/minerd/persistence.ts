// src/minerd/persistence.ts
//
// Local chain-state persistence so the miner doesn't re-sync the whole chain on
// every launch. This is a LOCAL, regenerable performance cache — never a
// consensus input. It only ever *calls* existing Blockchain methods
// (`snapshotAt`, `seedHistoricalBlock`, `reset`) and the existing state
// serializers; it never re-implements any validation. Any anomaly on restore is
// non-fatal: we wipe the cache, reset to genesis, and full-replay. A bad cache
// must never block mining or let the miner build on a wrong state.
//
// On disk: ~/.fulgurminer/snapshot-<network>.json where <network> is a prefix of
// the genesis header hash. The network tag means a chain reset (new genesis)
// never loads a stale snapshot, and we only ever read a snapshot whose tag
// matches the genesis we booted with.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Blockchain } from '../chain/blockchain.js';
import { decodeBlock, encodeBlock, hashHeader, type Block } from '../chain/block.js';
import { GENESIS, SNAPSHOT_DEPTH } from '../chain/genesis.js';
import { serializeState, serializeLocks, deserializeState, stateRoot, type StateRow, type LockRow } from '../chain/state.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';

/**
 * Bump when the on-disk shape changes incompatibly — old files are then ignored.
 * v2: anchor state now carries `locks` (the scripting hard-fork added script
 * locks to State). A v1 file holds accounts only; restoring it onto a post-fork
 * chain whose anchor has live locks would yield a locks-less state that the tail
 * replay rejects on a stateRoot mismatch (safe, but a needless full resync), so
 * v1 files are discarded outright.
 */
const SCHEMA_VERSION = 2;

/** Network tag = first 16 hex chars (8 bytes) of the genesis header hash. */
function networkTag(): string {
  return bytesToHex(hashHeader(GENESIS.header)).slice(0, 16);
}

/** Directory holding the snapshot file: ~/.fulgurminer (created 0700 if missing). */
export function snapshotDir(): string {
  return path.join(os.homedir(), '.fulgurminer');
}

/** Absolute path to the snapshot file for the current network. */
export function snapshotPath(): string {
  return path.join(snapshotDir(), `snapshot-${networkTag()}.json`);
}

/**
 * On-disk snapshot shape. The anchor is the finalized block at
 * `tip.height - SNAPSHOT_DEPTH`; `state` is its materialized account state.
 *
 * `blocksHex` is the canonical block chain from height 1 up to and INCLUDING the
 * anchor (oldest-first), each hex-encoded via `encodeBlock`. We store the whole
 * finalized prefix — not just the single anchor — because `seedHistoricalBlock`
 * links every block to its already-present parent and derives cumulative work
 * from it, so the anchor can only be seeded once its ancestors are. The prefix
 * blocks are seeded with `null` state (cheap — no per-block clone+apply); only
 * the anchor carries materialized state, exactly mirroring the chain's
 * finalized-prefix design. Bootstrap then resumes from anchor+1, so the network
 * fetch is the delta only (the prefix is never re-downloaded or re-verified).
 *
 * Everything is plain JSON-clonable (hex strings + decimal strings).
 */
interface SnapshotFile {
  schema: number;
  network: string;
  anchorHeight: number;
  anchorHashHex: string;
  /** Canonical blocks, height 1..anchor inclusive, oldest-first; each = hex of encodeBlock. */
  blocksHex: string[];
  /** serializeState(anchorState) rows: [addressHex, balanceDecimal, nonce]. */
  state: StateRow[];
  /**
   * serializeLocks(anchorState) rows: [lockIdHex, amountDecimal, scriptHashHex, createdHeight].
   * Live script locks in the anchor state (scripting hard-fork). Empty pre-fork.
   * Without these, a post-fork anchor restores locks-less and the tail replay
   * rejects the first block whose stateRoot commits to the dropped lock.
   */
  locks: LockRow[];
}

/**
 * Persist a snapshot taken at a *finalized* anchor `tipHeight - SNAPSHOT_DEPTH`.
 * Returns true if a snapshot was written, false if there was nothing finalized
 * to snapshot yet (chain too short) or any non-fatal error occurred. Never
 * throws — a failed save must never disrupt mining.
 */
export function saveSnapshot(chain: Blockchain): boolean {
  try {
    const finalizedHeight = chain.height - SNAPSHOT_DEPTH;
    if (finalizedHeight <= 0) return false; // nothing finalized to persist yet
    const snap = chain.snapshotAt(finalizedHeight);
    if (!snap) return false; // anchor state not materialized / gap — skip quietly

    const anchor = chain.getBlock(snap.hashHex);
    if (!anchor) return false; // shouldn't happen, but never throw

    // Collect the canonical chain from the anchor back to (but excluding) genesis,
    // then reverse to oldest-first. Walking from the ANCHOR (not the tip) keeps the
    // prefix to finalized blocks only — the unfinalized tail above the anchor is
    // re-fetched by bootstrap. iterateCanonical() walks from the tip, so we instead
    // hop parent links starting at the anchor via getBlock.
    const prefix: string[] = [];
    let cursor: string | undefined = snap.hashHex;
    while (cursor) {
      const entry = chain.getBlock(cursor);
      if (!entry) return false; // gap in the canonical chain — don't persist a hole
      prefix.push(bytesToHex(encodeBlock(entry.block)));
      if (entry.block.header.height === 1) break; // height 0 (genesis) is always seeded
      cursor = bytesToHex(entry.block.header.prevHash);
    }
    prefix.reverse(); // oldest-first so restore feeds parents before children

    const payload: SnapshotFile = {
      schema: SCHEMA_VERSION,
      network: networkTag(),
      anchorHeight: snap.height,
      anchorHashHex: snap.hashHex,
      blocksHex: prefix,
      state: serializeState(snap.state),
      locks: serializeLocks(snap.state),
    };

    const dir = snapshotDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const finalPath = snapshotPath();
    // Atomic write: temp file in the same dir, then rename over the target.
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmpPath, finalPath);
    return true;
  } catch {
    // A save failure is never fatal — the next launch just full-syncs.
    return false;
  }
}

/** Delete the snapshot file for the current network. Silent if absent. */
export function deleteSnapshot(): void {
  try {
    rmSync(snapshotPath(), { force: true });
  } catch {
    /* nothing to clean up — ignore */
  }
}

export type RestoreOutcome =
  | { restored: true; anchorHeight: number }
  | { restored: false };

/**
 * Attempt to restore the chain from the on-disk snapshot. On success the chain
 * is seeded up to the finalized anchor (so a following `bootstrap()` only fetches
 * the delta to the tip). On ANY anomaly — missing / corrupt / old-schema /
 * wrong-network file, decode failure, or a `seedHistoricalBlock` error — we
 * reset the chain back to genesis and report `{ restored: false }` so the caller
 * runs a normal full bootstrap. A debug note (when MINER_DEBUG is set) explains
 * why. This function never throws.
 */
export function restoreSnapshot(chain: Blockchain, debug?: (msg: string) => void): RestoreOutcome {
  const note = (msg: string): void => debug?.(`[persistence] ${msg}`);
  let raw: string;
  try {
    raw = readFileSync(snapshotPath(), 'utf8');
  } catch {
    note('no snapshot file — full sync');
    return { restored: false };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SnapshotFile>;

    // --- schema / network gate -------------------------------------------
    if (parsed.schema !== SCHEMA_VERSION) {
      note(`schema mismatch (have ${String(parsed.schema)}, want ${SCHEMA_VERSION}) — discarding`);
      return discard(chain, note, 'old/unknown schema');
    }
    if (parsed.network !== networkTag()) {
      note(`network tag mismatch (have ${String(parsed.network)}, want ${networkTag()}) — discarding`);
      return discard(chain, note, 'wrong network');
    }
    if (
      !Array.isArray(parsed.blocksHex) ||
      parsed.blocksHex.length === 0 ||
      !Array.isArray(parsed.state) ||
      !Array.isArray(parsed.locks) || // schema 2: locks are always present (possibly empty)
      typeof parsed.anchorHeight !== 'number'
    ) {
      note('malformed fields — discarding');
      return discard(chain, note, 'malformed');
    }

    // The prefix is heights 1..anchor inclusive, so its length is exactly the
    // anchor height. Checking that BEFORE the decode loop turns an unbounded
    // "decode every entry, then look at the anchor" into a cheap O(1) rejection
    // of a truncated/padded/corrupt file, and bounds the allocation by the
    // file's own declared height. anchorHeight itself is only known to be a
    // `number` at this point — NaN, negative and fractional all reach here.
    if (!Number.isInteger(parsed.anchorHeight) || parsed.anchorHeight < 1) {
      note('anchor height is not a positive integer — discarding');
      return discard(chain, note, 'malformed');
    }
    if (parsed.blocksHex.length !== parsed.anchorHeight) {
      note(`prefix length ${parsed.blocksHex.length} does not match anchor height ${parsed.anchorHeight} — discarding`);
      return discard(chain, note, 'malformed');
    }

    // --- rebuild + seed the finalized prefix, anchor last ----------------
    // blocksHex is oldest-first (height 1..anchor). Each prefix block is seeded
    // with `null` state (cheap — no clone+apply); the LAST block is the anchor and
    // carries the materialized state so the tail can replay on it. seedHistoricalBlock
    // links each block to its already-present parent, so feeding them ascending
    // satisfies the parent-precedes-child invariant.
    const blocks: Block[] = parsed.blocksHex.map((h) => decodeBlock(hexToBytes(h)));
    const anchorBlock = blocks[blocks.length - 1]!;

    // Sanity: the decoded anchor's height + hash must match the recorded anchor so
    // a tampered/inconsistent file can't seed a wrong tip.
    const decodedHashHex = bytesToHex(hashHeader(anchorBlock.header));
    if (anchorBlock.header.height !== parsed.anchorHeight) {
      note('anchor height mismatch — discarding');
      return discard(chain, note, 'anchor height mismatch');
    }
    if (typeof parsed.anchorHashHex === 'string' && decodedHashHex !== parsed.anchorHashHex) {
      note('anchor hash mismatch — discarding');
      return discard(chain, note, 'anchor hash mismatch');
    }

    const state = deserializeState(parsed.state as StateRow[], parsed.locks as LockRow[]);

    // Verify the materialized anchor state hashes to the anchor block's COMMITTED
    // stateRoot. This is an independent (non-circular) check: it catches a dropped/
    // corrupt lock set — or any wrong materialized state — HERE, before seeding,
    // rather than deferring to the tail replay. (The post-restore chainIntegrityOK
    // gate recomputes from the same restored tipState, so it cannot catch this on
    // its own; a wrong anchor whose tail all rejects would otherwise strand the
    // miner at a stale height.) On mismatch we discard and full-replay — safe.
    if (bytesToHex(stateRoot(state)) !== bytesToHex(anchorBlock.header.stateRoot)) {
      note('anchor stateRoot mismatch (materialized state disagrees with the committed root) — discarding');
      return discard(chain, note, 'anchor stateRoot mismatch');
    }

    // Seed prefix blocks (null state), then the anchor with materialized state.
    // Any seed error (e.g. a missing parent from a corrupt/holey file) returns a
    // string rather than throwing — treat it as an anomaly and full-replay.
    for (let i = 0; i < blocks.length; i++) {
      const isAnchor = i === blocks.length - 1;
      const seedErr = chain.seedHistoricalBlock(blocks[i]!, isAnchor ? state : null);
      if (seedErr !== null) {
        note(`seed error at height ${blocks[i]!.header.height}: ${seedErr} — discarding`);
        return discard(chain, note, 'seed error');
      }
    }

    return { restored: true, anchorHeight: anchorBlock.header.height };
  } catch (e) {
    note(`restore exception: ${(e as Error).message} — discarding`);
    return discard(chain, note, 'parse/decode exception');
  }
}

/** Reset to genesis and remove the bad file so the next launch full-syncs clean. */
function discard(chain: Blockchain, note: (m: string) => void, _why: string): RestoreOutcome {
  try {
    chain.reset();
  } catch {
    /* reset is genesis-only re-init; ignore any failure */
  }
  deleteSnapshot();
  return { restored: false };
}
