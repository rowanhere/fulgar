// src/minerd/cudaGrindPool.ts
//
// CUDA grind pool. This is a process wrapper around native/brc-pow-cuda, using
// the same stdout/stderr protocol as NativeGrindPool:
//   stdout: SOLVED <nonce> <hashhex>
//   stdout: EXHAUSTED
//   stderr: HASHRATE <n>
//
// One CUDA child owns a nonce range. Multiple children can be used for multiple
// GPUs by setting MINER_WORKERS, but a single child is usually right for one GPU.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import { FAST_FAIL_MS, MAX_CRASHES_PER_GEN, MAX_FAST_FAILS } from './grindPool.js';
import { partitionNonceSpace } from './partition.js';
import type { OnError, OnExhausted, OnHashrate, OnSolved } from './nativeGrindPool.js';
import { isValidNativeHit } from './nativeGrindPool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CUDA_BIN = resolve(__dirname, '../../native/brc-pow-cuda/target/release/brc-pow-cuda');

type GrindProc = ChildProcessByStdio<Writable, Readable, Readable>;

interface Child {
  proc: GrindProc;
  stdoutRl: Interface;
  stderrRl: Interface;
  gen: number;
  index: number;
  start: number;
  end: number;
  spawnedAt: number;
  expectedStop: boolean;
  final: boolean;
  failureHandled: boolean;
  closed: boolean;
}

interface ActiveGrind {
  headerHex: string;
  targetHex: string;
  throttle: number;
  continuous: boolean;
  gen: number;
  ranges: { start: number; end: number }[];
  noncesPerLane: number;
}

export class CudaGrindPool {
  private children: Child[] = [];
  private gen = 0;
  private solvedThisGen = false;
  private onSolved: OnSolved = () => {};
  private onExhausted: OnExhausted = () => {};
  private onError: OnError = (err) => console.error('[CudaGrindPool] child error:', err);
  private hashCounts = new Map<number, number>();
  private rateTimer: ReturnType<typeof setInterval> | null = null;
  private exhaustedThisGen = 0;
  private permanentlyDownThisGen = 0;
  private expectedChildCount = 0;
  private activeGrind: ActiveGrind | null = null;
  private noncesPerLane = resolveCudaNoncesPerLane();
  private terminating = false;
  private fastFailures: number[] = [];
  private fastFailureReported: boolean[] = [];
  private crashesThisGen: number[] = [];
  private childDown: boolean[] = [];
  private pendingRespawns = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly workerCount: number, private throttle = 1) {}

  setThrottle(throttle: number): void {
    this.throttle = Math.min(1, Math.max(0.05, throttle));
    if (this.activeGrind) this.activeGrind.throttle = this.throttle;
  }

  setNoncesPerLane(noncesPerLane: number): void {
    this.noncesPerLane = Math.max(1, Math.floor(noncesPerLane));
    if (this.activeGrind) this.activeGrind.noncesPerLane = this.noncesPerLane;
  }

  start(
    headerBytes: Uint8Array,
    targetHex: string,
    onSolved: OnSolved,
    onHashrate: OnHashrate,
    onExhausted: OnExhausted = () => {},
    onError: OnError = (err) => console.error('[CudaGrindPool] child error:', err),
    nonceStart?: number,
    nonceEnd?: number,
    continuous = false,
  ): void {
    this.killChildren();
    this.gen++;
    this.solvedThisGen = false;
    this.exhaustedThisGen = 0;
    this.permanentlyDownThisGen = 0;
    this.onSolved = onSolved;
    this.onExhausted = onExhausted;
    this.onError = onError;
    this.terminating = false;
    this.clearPendingRespawns();
    this.hashCounts.clear();
    const ranges = partitionNonceSpace(this.workerCount, nonceStart, nonceEnd);
    this.expectedChildCount = ranges.length;
    this.childDown = Array.from({ length: ranges.length }, () => false);
    this.fastFailures = Array.from({ length: ranges.length }, () => 0);
    this.fastFailureReported = Array.from({ length: ranges.length }, () => false);
    this.crashesThisGen = Array.from({ length: ranges.length }, () => 0);
    this.activeGrind = {
      headerHex: bytesToHex(headerBytes),
      targetHex,
      throttle: this.throttle,
      continuous,
      gen: this.gen,
      ranges,
      noncesPerLane: this.noncesPerLane,
    };
    ranges.forEach((range, index) => this.spawnChild(index, this.gen, range.start, range.end));
    if (this.rateTimer) clearInterval(this.rateTimer);
    this.rateTimer = setInterval(() => {
      let total = 0;
      for (const v of this.hashCounts.values()) total += v;
      this.hashCounts.clear();
      onHashrate(total);
    }, 1000);
  }

  stop(): void {
    this.gen++;
    this.solvedThisGen = true;
    this.activeGrind = null;
    this.clearPendingRespawns();
    this.hashCounts.clear();
    this.killChildren();
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
  }

  terminate(): void {
    this.terminating = true;
    this.stop();
  }

  respawn(): void {
    const state = this.activeGrind;
    this.killChildren();
    if (!state) return;
    this.gen++;
    this.solvedThisGen = false;
    this.exhaustedThisGen = 0;
    this.permanentlyDownThisGen = 0;
    this.activeGrind = { ...state, gen: this.gen };
    state.ranges.forEach((range, index) => this.spawnChild(index, this.gen, range.start, range.end));
  }

  private spawnChild(index: number, gen: number, start: number, end: number): void {
    const state = this.activeGrind;
    if (!state || this.terminating) return;
    let proc: GrindProc;
    try {
      const noncesPerLane = this.activeGrind?.noncesPerLane ?? this.noncesPerLane;
      proc = spawn(
        CUDA_BIN,
        ['grind', state.headerHex, state.targetHex, String(start), String(end), String(state.throttle), state.continuous ? '1' : '0', String(noncesPerLane)],
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
      proc, stdoutRl, stderrRl, gen, index, start, end,
      spawnedAt: Date.now(), expectedStop: false, final: false,
      failureHandled: false, closed: false,
    };
    this.children.push(child);
    stdoutRl.on('line', (line) => this.handleStdout(child, line));
    stderrRl.on('line', (line) => this.handleStderr(gen, index, line));
    proc.on('error', (err) => this.handleChildFailure(child, undefined, undefined, err));
    stdoutRl.on('close', () => this.handleChildFailure(child, proc.exitCode, proc.signalCode, undefined));
  }

  private handleStdout(child: Child, line: string): void {
    if (child.gen !== this.gen) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('SOLVED ')) {
      if (!this.activeGrind?.continuous && this.solvedThisGen) return;
      const parts = trimmed.split(/\s+/);
      const nonce = Number(parts[1]);
      const hashHex = parts[2];
      if (!isValidNativeHit(nonce, hashHex, child.start, child.end)) {
        this.onError(new Error(`invalid SOLVED from CUDA child ${child.index}: ${trimmed}`));
        return;
      }
      if (this.activeGrind?.continuous) {
        this.onSolved(nonce, hexToBytes(hashHex));
        return;
      }
      this.solvedThisGen = true;
      child.final = true;
      this.killChildren();
      if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
      this.onSolved(nonce, hexToBytes(hashHex));
    } else if (trimmed === 'EXHAUSTED') {
      child.final = true;
      this.exhaustedThisGen++;
      this.maybeExhausted();
    }
  }

  private handleStderr(gen: number, index: number, line: string): void {
    if (gen !== this.gen) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('HASHRATE ')) {
      const n = Number(trimmed.slice('HASHRATE '.length).trim());
      if (Number.isFinite(n)) this.hashCounts.set(index, (this.hashCounts.get(index) ?? 0) + n);
    }
  }

  private maybeExhausted(): void {
    if (this.solvedThisGen) return;
    if (this.exhaustedThisGen + this.permanentlyDownThisGen < this.expectedChildCount) return;
    this.activeGrind = null;
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
    this.onExhausted();
  }

  private handleChildFailure(child: Child, code: number | null | undefined, signal: NodeJS.Signals | null | undefined, err: Error | undefined): void {
    if (child.failureHandled) return;
    child.failureHandled = true;
    this.closeChild(child);
    this.children = this.children.filter((c) => c !== child);
    this.hashCounts.delete(child.index);
    if (child.gen !== this.gen || this.terminating || child.expectedStop || child.final || (!this.activeGrind?.continuous && this.solvedThisGen)) return;
    const livedMs = Date.now() - child.spawnedAt;
    this.fastFailures[child.index] = livedMs < FAST_FAIL_MS ? (this.fastFailures[child.index] ?? 0) + 1 : 0;
    this.crashesThisGen[child.index] = (this.crashesThisGen[child.index] ?? 0) + 1;
    const failures = this.fastFailures[child.index] ?? 0;
    const crashes = this.crashesThisGen[child.index] ?? 0;
    if (failures >= MAX_FAST_FAILS || crashes >= MAX_CRASHES_PER_GEN) {
      this.childDown[child.index] = true;
      this.permanentlyDownThisGen++;
      if (!this.fastFailureReported[child.index]) {
        this.fastFailureReported[child.index] = true;
        this.onError(new Error(`CUDA child ${child.index} failed repeatedly - leaving it down`));
      }
      this.maybeExhausted();
      return;
    }
    const delay = Math.min(FAST_FAIL_MS, 100 * 2 ** failures);
    const reason = err ? err.message : `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    this.onError(new Error(`CUDA child ${child.index} exited (${reason}) - respawning in ${delay}ms`));
    const handle = setTimeout(() => {
      this.pendingRespawns.delete(child.index);
      if (this.activeGrind && !this.childDown[child.index]) this.spawnChild(child.index, this.gen, child.start, child.end);
    }, delay);
    this.pendingRespawns.set(child.index, handle);
  }

  private closeChild(child: Child): void {
    if (child.closed) return;
    child.closed = true;
    child.stdoutRl.removeAllListeners();
    child.stderrRl.removeAllListeners();
    child.stdoutRl.close();
    child.stderrRl.close();
  }

  private killChildren(): void {
    for (const child of this.children) {
      child.expectedStop = true;
      this.closeChild(child);
      if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill('SIGKILL');
    }
    this.children = [];
  }

  private clearPendingRespawns(): void {
    for (const handle of this.pendingRespawns.values()) clearTimeout(handle);
    this.pendingRespawns.clear();
  }
}

function resolveCudaNoncesPerLane(): number {
  const raw = (process.env.MINER_CUDA_NONCES_PER_LANE ?? '').trim();
  if (raw === '') return 16;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 16;
  return Math.max(1, Math.floor(n));
}
