// src/minerd/verify.ts
import { Worker } from 'node:worker_threads';
import { compactToTarget, bytesToHex } from '../util/binary.js';
import { encodeHeader, type Block } from '../chain/block.js';

const WORKER_URL = new URL('./powWorker.bootstrap.mjs', import.meta.url);
// Empty execArgv so the worker can't inherit the parent's `--import tsx` (which
// doesn't reliably activate tsx's .js->.ts resolver inside worker threads on some
// Node versions). The .mjs bootstrap registers tsx via its API instead.
const WORKER_OPTS = { execArgv: [] };

// Safety net: if a worker dies/hangs and never posts a 'verified' message, the
// assignTo pipeline would stall forever (done never reaches blocks.length) and
// bootstrap would hang. Reject the call after this idle window so the caller can
// surface/retry rather than block indefinitely. Generous so a slow-but-alive
// worker (cold Argon2 WASM, busy CPU) is never killed mid-verify.
const VERIFY_TIMEOUT_MS = 60_000;

function targetHexFor(difficulty: number): string {
  return compactToTarget(difficulty).toString(16).padStart(64, '0');
}

/** A pending route: how to deliver a worker's verdict, or reject the call. */
interface Route {
  onResult: (ok: boolean) => void;
  onReject: (err: Error) => void;
}

/**
 * VerifierPool — a persistent pool of PoW-verification worker threads.
 *
 * The workers are created ONCE in the constructor and reused across every
 * `verify(blocks)` call. This is the hot path during bootstrap: ChainSync calls
 * verify once per sync page. Spawning fresh
 * workers per page (the old `verifyBlocksParallel` behavior) re-loaded tsx and
 * re-allocated the ~65 MB Argon2 WASM on every page, which dominated sync time.
 *
 * Each `verify` call gets its own message-id namespace so sequential (or
 * accidentally concurrent) calls can never cross results: every dispatched block
 * carries a unique id, and the routing table maps id → that call's result slot.
 * Call `terminate()` to dispose the workers when done.
 *
 * Safe for concurrent verify() calls: each call gets an isolated per-call id
 * namespace (its own `callIds` Map) while the shared global `routes` map keys on
 * the globally-unique ids (`idSeq++`), so a worker's verdict is always delivered
 * to the correct call's result slot — batches can never mix. (In practice the
 * bootstrap path is sequential — sync.bootstrap awaits each applyBatch — and the
 * tip poller serializes itself via a busy flag, but concurrency is safe by
 * design regardless.)
 *
 * Termination is race-safe: terminate() rejects every in-flight route before
 * clearing the map, and verify() guards against registering new routes once
 * terminating, so an abort mid-page can never orphan a pending promise.
 */
export class VerifierPool {
  private readonly workers: Worker[];
  /** Global id → route so a worker's verdict (or a rejection) lands in the right call. */
  private readonly routes = new Map<number, Route>();
  private idSeq = 1;
  private terminated = false;

  constructor(cores: number) {
    const n = Math.max(1, Math.floor(cores) || 1);
    this.workers = Array.from({ length: n }, () => new Worker(WORKER_URL, WORKER_OPTS));
    for (const w of this.workers) {
      w.on('message', (m: { type: string; id: number; ok: boolean }) => {
        if (m.type !== 'verified') return;
        const route = this.routes.get(m.id);
        if (!route) return; // stale / unknown id (e.g. drained on terminate) — ignore
        this.routes.delete(m.id);
        route.onResult(m.ok);
      });
    }
  }

  /** Verify each block's PoW across the persistent workers. Verdicts in input order. */
  verify(blocks: Block[]): Promise<boolean[]> {
    if (this.terminated) return Promise.reject(new Error('VerifierPool is terminated'));
    if (blocks.length === 0) return Promise.resolve([]);
    const results = new Array<boolean>(blocks.length);

    // Per-call cleanup handles (removing worker error listeners, clearing the
    // timeout, dropping any still-registered routes for this call). Hoisted out
    // of the Promise body so the try/finally below can guarantee they run even if
    // the executor throws synchronously (e.g. encodeHeader on a malformed block)
    // — otherwise the error listeners we attach below would leak across pages.
    let next = 0;
    let done = 0;
    let settled = false;
    const ids = new Set<number>(); // ids this call registered, for terminate/timeout cleanup
    // Per-call id → block index so concurrent calls don't collide (the global
    // routes map keys on these ids and is shared across calls).
    const callIds = new Map<number, number>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      for (const w of this.workers) w.removeListener('error', onError);
      // Drop any routes this call still owns so a late/never-arriving worker
      // message can't fire into a settled call.
      for (const id of ids) this.routes.delete(id);
    };

    // Resolver/rejecter captured from the Promise so terminate() (via the route's
    // onReject) and the timeout can settle this call from outside the executor.
    let resolveCall: (r: boolean[]) => void = () => {};
    let rejectCall: (e: Error) => void = () => {};

    // Per-call worker error listener. Attached to each worker for the duration of
    // THIS call and removed once it settles, so error listeners never accumulate
    // across the ~60 bootstrap pages (which would otherwise trip
    // MaxListenersExceededWarning and leak handlers).
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectCall(err);
    };

    try {
      return new Promise<boolean[]>((resolve, reject) => {
        resolveCall = resolve;
        rejectCall = reject;

        // If a worker dies/hangs and never posts back, fail the call instead of
        // stalling the whole bootstrap forever.
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`VerifierPool.verify timed out after ${VERIFY_TIMEOUT_MS}ms (worker unresponsive)`));
        }, VERIFY_TIMEOUT_MS);
        timer.unref?.();

        // Each worker, when it finishes a block, is handed the next unassigned one.
        const assignTo = (w: Worker): void => {
          if (settled || next >= blocks.length) return;
          const idx = next++;
          const id = this.idSeq++;
          ids.add(id);
          callIds.set(id, idx);
          const b = blocks[idx]!;
          this.routes.set(id, {
            onResult: (ok: boolean) => {
              ids.delete(id);
              const i = callIds.get(id)!;
              callIds.delete(id);
              results[i] = ok;
              done++;
              if (done === blocks.length) {
                if (!settled) { settled = true; cleanup(); resolve(results); }
                return;
              }
              assignTo(w);
            },
            // Invoked by terminate() to fail any block still in flight when the
            // pool is disposed mid-call (e.g. on abort).
            onReject: (err: Error) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(err);
            },
          });
          w.postMessage({
            type: 'verify',
            id,
            headerHex: bytesToHex(encodeHeader(b.header)),
            targetHex: targetHexFor(b.header.difficulty),
          });
        };

        for (const w of this.workers) w.on('error', onError);

        // Prime: give each worker one block to start the pipeline.
        for (const w of this.workers) assignTo(w);
      });
    } catch (err) {
      // The executor threw synchronously (it ran before `return` resolved the
      // Promise to the caller). Run cleanup so listeners/timer/routes don't leak,
      // then re-throw as a rejected promise to preserve verify()'s signature.
      cleanup();
      return Promise.reject(err as Error);
    }
  }

  /** Dispose all workers. Idempotent. */
  async terminate(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    // Reject any in-flight verify() calls BEFORE clearing the map so an abort
    // mid-page settles those promises (their own cleanup then drops the routes)
    // rather than orphaning them. Snapshot first since onReject mutates `routes`.
    const pending = [...this.routes.values()];
    this.routes.clear();
    for (const route of pending) {
      route.onReject(new Error('VerifierPool terminated while verifying'));
    }
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

/**
 * Verify each block's PoW across `cores` worker threads. Returns verdicts in
 * input order. One-shot convenience wrapper: spins up a short-lived VerifierPool,
 * verifies, and terminates it. `index.ts` / dryrun keep using this unchanged.
 * The hot bootstrap loop should instead hold a persistent VerifierPool and call
 * `pool.verify(blocks)` directly (see miner.ts).
 */
export async function verifyBlocksParallel(blocks: Block[], cores: number): Promise<boolean[]> {
  if (blocks.length === 0) return [];
  const n = Math.max(1, Math.min(cores, blocks.length));
  const pool = new VerifierPool(n);
  try {
    return await pool.verify(blocks);
  } finally {
    await pool.terminate();
  }
}
