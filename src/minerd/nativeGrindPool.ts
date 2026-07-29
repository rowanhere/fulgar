// src/minerd/nativeGrindPool.ts
//
// Native grind pool — a drop-in alternative to GrindPool (src/minerd/grindPool.ts)
// that runs the proof-of-work search in the native Rust binary
// (native/brc-pow/target/release/brc-pow) instead of worker_threads + WASM.
//
// Same public interface as GrindPool: constructor(workerCount, throttle),
// start(headerBytes, targetHex, onSolved, onHashrate, onExhausted?, onError?,
// nonceStart?, nonceEnd?, continuous?), stop(), terminate(), and respawn().
// One OS process per nonce range (reusing
// partitionNonceSpace), so the host stays single-threaded per child and the
// kernel schedules the heavy Argon2id work across cores.
//
// The Rust `grind` subcommand is byte-for-byte parity-equivalent to the WASM
// powHash/powWorker: it writes the u32 nonce BIG-ENDIAN at offset 112 of the
// 148-byte header and big-endian-compares the Argon2id digest against the
// target — so a solution found here is a valid solution under the WASM
// consensus. This module is ADDITIVE; the WASM GrindPool remains the default.
//
// Protocol (per child, on stdout/stderr):
//   stdout: `SOLVED <nonce> <hashhex>`  (then exits 0 unless continuous)
//   stdout: `EXHAUSTED`                  (range scanned, no hit; then exits 0)
//   stderr: `HASHRATE <n>`               (hashes in the last ~1s window)

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import { FAST_FAIL_MS, MAX_FAST_FAILS, MAX_CRASHES_PER_GEN } from './grindPool.js';

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/** A native `SOLVED` line is trustworthy only if the nonce is an integer inside the
 *  child's served slot [start,end) and the hash is 64 hex chars — a stale/replaced
 *  binary emitting an out-of-slot nonce or malformed hash must NOT become a pool share. */
export function isValidNativeHit(nonce: number, hashHex: unknown, start: number, end: number): boolean {
  return Number.isInteger(nonce) && nonce >= start && nonce < end
    && typeof hashHex === 'string' && HEX64_RE.test(hashHex);
}
import { partitionNonceSpace } from './partition.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Executable suffix: Windows cargo emits `brc-pow.exe`; Linux/macOS emit a bare name.
 *  Without this, existsSync(NATIVE_BIN) never matches on Windows → the engine reports
 *  "build failed" after a successful cargo build and re-prompts every launch. */
const EXE = process.platform === 'win32' ? '.exe' : '';
/** Path to the release binary built by `cargo build --release` in native/brc-pow. */
export const NATIVE_BIN = resolve(__dirname, `../../native/brc-pow/target/release/brc-pow${EXE}`);

export type OnSolved = (nonce: number, hash: Uint8Array) => void;
export type OnHashrate = (hashesPerSec: number) => void;
/** Called when every child has exhausted its nonce range without finding a solution.
 *  The caller should rebuild the template (new timestamp) and call start() again. */
export type OnExhausted = () => void;
export type OnError = (err: Error) => void;

/** stdin/stdout/stderr are piped so live throttle updates can be sent. */
type GrindProc = ChildProcessByStdio<Writable, Readable, Readable>;

interface Child {
  proc: GrindProc;
  stdoutRl: Interface;
  stderrRl: Interface;
  gen: number; // generation this child was spawned for
  index: number;
  start: number;
  end: number;
  spawnedAt: number;
  expectedStop: boolean;
  final: boolean;
  failureHandled: boolean;
  closed: boolean;
}

interface ChildRange {
  start: number;
  end: number;
}

interface ActiveGrind {
  headerHex: string;
  targetHex: string;
  throttle: number;
  continuous: boolean;
  gen: number;
  ranges: ChildRange[];
}

/** Pool of native grind processes. One template at a time; first valid solve per generation wins. */
export class NativeGrindPool {
  private children: Child[] = [];
  private gen = 0;
  private solvedThisGen = false;
  private onSolved: OnSolved = () => {};
  private onExhausted: OnExhausted = () => {};
  private onError: OnError = (err) => console.error('[NativeGrindPool] child error:', err);
  private hashCounts = new Map<number, number>(); // child index (this gen) -> hashes since last tick
  private rateTimer: ReturnType<typeof setInterval> | null = null;
  private exhaustedThisGen = 0; // count of children that reported 'exhausted' this gen
  private permanentlyDownThisGen = 0; // children left down by the fast-fail breaker
  private expectedChildCount = 0; // stable quorum size for the current generation
  private continuous = false;   // pool share mode: keep grinding after each hit
  private activeGrind: ActiveGrind | null = null;
  private terminating = false;
  private fastFailures: number[] = [];
  private fastFailureReported: boolean[] = [];
  private crashesThisGen: number[] = []; // cumulative crashes per child this gen
  private childDown: boolean[] = [];
  private pendingRespawns = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly workerCount: number, private throttle = 1) {}

  setThrottle(throttle: number): void {
    const t = Math.min(1, Math.max(0.05, throttle));
    this.throttle = t;
    if (this.activeGrind) this.activeGrind.throttle = t;
    for (const child of this.children) {
      if (child.proc.stdin && !child.proc.stdin.destroyed) child.proc.stdin.write('THROTTLE ' + t + '\n');
    }
  }

  private resetFastFailures(count = this.workerCount): void {
    this.fastFailures = Array.from({ length: count }, () => 0);
    this.fastFailureReported = Array.from({ length: count }, () => false);
    this.crashesThisGen = Array.from({ length: count }, () => 0);
  }

  private clearPendingRespawns(): void {
    for (const handle of this.pendingRespawns.values()) clearTimeout(handle);
    this.pendingRespawns.clear();
  }

  private removeChild(child: Child): void {
    this.children = this.children.filter((candidate) => candidate !== child);
  }

  private closeChild(child: Child): void {
    if (child.closed) return;
    child.closed = true;
    child.stdoutRl.removeAllListeners();
    child.stderrRl.removeAllListeners();
    child.stdoutRl.close();
    child.stderrRl.close();
  }

  private maybeExhausted(): void {
    if (this.solvedThisGen) return;
    if (this.expectedChildCount === 0) return;
    if (this.exhaustedThisGen + this.permanentlyDownThisGen < this.expectedChildCount) return;
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
    this.activeGrind = null;
    this.onExhausted();
  }

  private scheduleRespawn(index: number, delay: number, genAtExit: number): void {
    const existing = this.pendingRespawns.get(index);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.pendingRespawns.delete(index);
      const state = this.activeGrind;
      if (
        this.terminating
        || !state
        || state.gen !== genAtExit
        || state.gen !== this.gen
        || (!state.continuous && this.solvedThisGen)
      ) {
        return;
      }
      const range = state.ranges[index];
      if (!range || this.childDown[index]) return;
      this.spawnChild(index, state.gen, state.headerHex, state.targetHex, range.start, range.end, state.throttle, state.continuous);
    }, delay);
    this.pendingRespawns.set(index, handle);
  }

  /** Start grinding a template. Aborts any previous template.
   *  @param onExhausted - called when all children exhaust their nonce ranges (no solution found).
   *  @param onError     - called if a child crashes / can't be spawned (optional; defaults to console.error). */
  start(
    headerBytes: Uint8Array,
    targetHex: string,
    onSolved: OnSolved,
    onHashrate: OnHashrate,
    onExhausted: OnExhausted = () => {},
    onError: OnError = (err) => console.error('[NativeGrindPool] child error:', err),
    nonceStart?: number,
    nonceEnd?: number,
    continuous = false,
  ): void {
    // Tear down any children from a previous template before starting fresh.
    this.killChildren();

    this.gen++;
    const myGen = this.gen;
    this.solvedThisGen = false;
    this.exhaustedThisGen = 0;
    this.permanentlyDownThisGen = 0;
    this.expectedChildCount = 0;
    this.onSolved = onSolved;
    this.onExhausted = onExhausted;
    this.onError = onError;
    this.continuous = continuous;
    this.terminating = false;
    this.clearPendingRespawns();
    this.hashCounts.clear();

    const headerHex = bytesToHex(headerBytes);
    const throttle = Math.min(1, Math.max(0.05, this.throttle));
    // Solo passes no bounds -> full [0, 2^32). Pool passes the assigned slot.
    const ranges = partitionNonceSpace(this.workerCount, nonceStart, nonceEnd);
    this.expectedChildCount = ranges.length;
    this.activeGrind = { headerHex, targetHex, throttle, continuous, gen: myGen, ranges };
    this.childDown = Array.from({ length: ranges.length }, () => false);
    this.resetFastFailures(ranges.length);

    ranges.forEach((range, index) => {
      this.spawnChild(index, myGen, headerHex, targetHex, range.start, range.end, throttle, continuous);
    });

    // Aggregate per-child HASHRATE reports into a single ~1s window total, the
    // same shape GrindPool delivers (onHashrate(total hashes in last ~1s)).
    if (this.rateTimer) clearInterval(this.rateTimer);
    this.rateTimer = setInterval(() => {
      let total = 0;
      for (const v of this.hashCounts.values()) total += v;
      this.hashCounts.clear();
      onHashrate(total);
    }, 1000);
  }

  private spawnChild(
    index: number,
    myGen: number,
    headerHex: string,
    targetHex: string,
    start: number,
    end: number,
    throttle: number,
    continuous: boolean,
  ): void {
    if (this.terminating || myGen !== this.gen) return;
    const previous = this.children.find((child) => child.index === index);
    if (previous) {
      previous.expectedStop = true;
      this.closeChild(previous);
      if (previous.proc.exitCode === null && previous.proc.signalCode === null) previous.proc.kill('SIGKILL');
      this.removeChild(previous);
    }

    let proc: GrindProc;
    try {
      proc = spawn(
        NATIVE_BIN,
        ['grind', headerHex, targetHex, String(start), String(end), String(throttle), String(continuous ? 1 : 0)],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      this.onError(err as Error);
      return;
    }
    proc.stdin.on('error', () => {});

    const stdoutRl = createInterface({ input: proc.stdout });
    const stderrRl = createInterface({ input: proc.stderr });
    const child: Child = {
      proc,
      stdoutRl,
      stderrRl,
      gen: myGen,
      index,
      start,
      end,
      spawnedAt: Date.now(),
      expectedStop: false,
      final: false,
      failureHandled: false,
      closed: false,
    };
    this.children.push(child);
    this.childDown[index] = false;

    stdoutRl.on('line', (line) => this.handleStdout(child, line));
    stderrRl.on('line', (line) => this.handleStderr(myGen, index, line));

    // A failure to spawn (e.g. binary missing) surfaces as an 'error' event.
    proc.on('error', (err) => {
      this.handleChildFailure(child, undefined, undefined, err);
    });
    // Classify the child's death on the stdout 'close' event, NOT on proc
    // 'exit'. 'exit' can fire BEFORE the final buffered SOLVED/EXHAUSTED line is
    // read, which would misread a child that finished normally as an unexpected
    // death and respawn it — re-grinding its range and resubmitting the same
    // shares as duplicates. readline emits 'close' only after every 'line' has
    // been delivered, so child.final is accurate by then. (When WE stop a child,
    // closeChild() removes this listener first, so an expected stop never
    // reaches handleChildFailure's recovery path.)
    stdoutRl.on('close', () => {
      this.handleChildFailure(child, proc.exitCode, proc.signalCode, undefined);
    });
  }

  private handleChildFailure(child: Child, code: number | null | undefined, signal: NodeJS.Signals | null | undefined, err: Error | undefined): void {
    if (child.failureHandled) return;
    child.failureHandled = true;
    this.closeChild(child);
    this.removeChild(child);
    this.hashCounts.delete(child.index);

    if (
      child.gen !== this.gen
      || this.terminating
      || child.expectedStop
      || child.final
      || (!this.continuous && this.solvedThisGen)
    ) {
      return;
    }

    const livedMs = Date.now() - child.spawnedAt;
    this.fastFailures[child.index] = livedMs < FAST_FAIL_MS ? (this.fastFailures[child.index] ?? 0) + 1 : 0;
    this.crashesThisGen[child.index] = (this.crashesThisGen[child.index] ?? 0) + 1; // cumulative, never resets
    const failures = this.fastFailures[child.index] ?? 0;
    const totalCrashes = this.crashesThisGen[child.index] ?? 0;
    // Leave the child permanently down on a RAPID failure burst (MAX_FAST_FAILS) OR when
    // it exceeds the cumulative per-generation crash budget (a slow-crash loop that
    // lives >FAST_FAIL_MS then dies repeatedly would otherwise reset the rapid counter
    // and respawn forever).
    if (failures >= MAX_FAST_FAILS || totalCrashes >= MAX_CRASHES_PER_GEN) {
      this.childDown[child.index] = true;
      this.permanentlyDownThisGen++;
      if (!this.fastFailureReported[child.index]) {
        this.fastFailureReported[child.index] = true;
        const why = failures >= MAX_FAST_FAILS ? `failed ${MAX_FAST_FAILS}x rapidly` : `crashed ${totalCrashes}x this generation`;
        this.onError(new Error(`native grind child ${child.index} ${why} — leaving it down (pool degraded)`));
      }
      this.maybeExhausted();
      return;
    }

    const delay = Math.min(FAST_FAIL_MS, 100 * 2 ** failures);
    const reason = err ? err.message : `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    this.onError(new Error(`native grind child ${child.index} exited (${reason}) — respawning in ${delay}ms`));
    this.scheduleRespawn(child.index, delay, child.gen);
  }

  private handleStdout(child: Child, line: string): void {
    const myGen = child.gen;
    const index = child.index;
    if (myGen !== this.gen) return; // stale message from a superseded template
    const trimmed = line.trim();
    if (trimmed.startsWith('SOLVED ')) {
      if (!this.continuous && this.solvedThisGen) return;
      const parts = trimmed.split(/\s+/);
      const nonce = Number(parts[1]);
      const hashHex = parts[2];
      // a stale/replaced binary could emit an out-of-slot nonce or a malformed
      // hash; forwarding it would post an INVALID pool share. Trust it only if the
      // nonce is inside THIS child's served range [start,end) and the hash is 64-hex.
      if (!isValidNativeHit(nonce, hashHex, child.start, child.end)) {
        this.onError(new Error(`invalid SOLVED from child ${index} (range [${child.start},${child.end})): ${trimmed}`));
        return;
      }
      if (this.continuous) {
        // Pool share mode: every hit is a share. Keep ALL children grinding the
        // rest of their slot — don't stop, don't latch solvedThisGen.
        this.onSolved(nonce, hexToBytes(hashHex));
        return;
      }
      this.solvedThisGen = true;
      child.final = true;
      // Halt all sibling processes immediately so they stop burning CPU on this
      // already-solved template and cannot race in with a competing solution.
      this.killChildren();
      if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
      this.onSolved(nonce, hexToBytes(hashHex));
    } else if (trimmed === 'EXHAUSTED') {
      child.final = true;
      this.exhaustedThisGen++;
      // Every expected child must either scan its range or be permanently left
      // down by the fast-fail circuit breaker before the generation exhausts.
      this.maybeExhausted();
    }
  }

  private handleStderr(myGen: number, index: number, line: string): void {
    if (myGen !== this.gen) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('HASHRATE ')) {
      const n = Number(trimmed.slice('HASHRATE '.length).trim());
      if (Number.isFinite(n)) {
        this.hashCounts.set(index, (this.hashCounts.get(index) ?? 0) + n);
      }
    }
  }

  /** Abort the current template; all children are killed and go idle. */
  stop(): void {
    this.gen++; // bump so any in-flight messages are treated as stale
    this.solvedThisGen = true;
    this.exhaustedThisGen = 0;
    this.permanentlyDownThisGen = 0;
    this.expectedChildCount = 0;
    this.continuous = false;
    this.activeGrind = null;
    this.clearPendingRespawns();
    this.hashCounts.clear();
    this.killChildren();
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
  }

  /** Permanently shut down the pool, killing all child processes (no zombies). */
  terminate(): void {
    this.gen++;
    this.solvedThisGen = true;
    this.exhaustedThisGen = 0;
    this.permanentlyDownThisGen = 0;
    this.expectedChildCount = 0;
    this.continuous = false;
    this.activeGrind = null;
    this.terminating = true;
    this.clearPendingRespawns();
    this.hashCounts.clear();
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
    this.killChildren();
  }

  /** Replace every process and leave the pool idle for the caller's next start(). */
  respawn(): void {
    this.terminating = true;
    this.clearPendingRespawns();
    this.resetFastFailures();
    this.gen++;
    this.solvedThisGen = true;
    this.exhaustedThisGen = 0;
    this.permanentlyDownThisGen = 0;
    this.expectedChildCount = 0;
    this.continuous = false;
    this.activeGrind = null;
    this.hashCounts.clear();
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
    this.killChildren();
    this.terminating = false;
  }

  /** Kill every live child process and tear down its line readers. */
  private killChildren(): void {
    for (const child of this.children) {
      child.expectedStop = true;
      this.closeChild(child);
      if (child.proc.exitCode === null && child.proc.signalCode === null) {
        // SIGKILL — the grind loop is a tight CPU loop with no signal handler,
        // so a hard kill is the reliable way to stop it immediately and avoid
        // zombies. The OS reaps the process; Node's ChildProcess emits 'exit'.
        child.proc.kill('SIGKILL');
      }
    }
    this.children = [];
  }
}
