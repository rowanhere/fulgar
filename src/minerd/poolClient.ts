// src/minerd/poolClient.ts
import os from 'node:os';
import { GrindPool } from './grindPool.js';
import { NativeGrindPool } from './nativeGrindPool.js';
import { hexToBytes } from '../util/binary.js';
import { HEADER_LEN } from '../chain/block.js';
import { ConsoleReporter, type MinerReporter, type ReporterStatus } from './reporter.js';
import { VERSION } from './version.js';
import { backoffDelay, classify, parseRetryAfterMs, PoolError, poolFetch, withPoolRetry } from './poolHttp.js';
import { negotiatedRequired, runNegotiatedPoolClient } from './negotiatedClient.js';
import { startPoolStats } from './poolStats.js';
import { checkForUpdate } from './updateCheck.js';
import { isFulgurPool } from './pools.js';
import { NONCE_SPACE } from './partition.js';
import { SmartController, smartStartDuty } from './smartController.js';
import { createDemandSignal } from './demand.js';
import { resolvePoolEngine } from './poolEngine.js';

export type ShareVerdict = 'accepted' | 'block-strike' | 'rejected';

/** Money-critical: ONLY result==="accepted" counts; block:true marks a whole block solved. */
export function classifyShare(body: { result?: string; block?: boolean } | null | undefined): ShareVerdict {
  if (!body || body.result !== 'accepted') return 'rejected';
  return body.block === true ? 'block-strike' : 'accepted';
}

/**
 * Combined /share decision incl. transient retry. `status` is the HTTP status,
 * `body` carries {result, block?}. A transient status (429/503) → 'retry' (the
 * caller backs off, NEVER reports a rejected share, burns no nonce). Otherwise
 * defer to the exact verdict. Money-critical — unit-tested.
 */
export function shareOutcome(status: number, body: { result?: string; block?: boolean } | null | undefined): 'retry' | ShareVerdict {
  if (classify(status) === 'transient') return 'retry'; // 429/503
  // 408/425/5xx are AMBIGUOUS — the share may or may not have landed (a pool 5xx
  // on Render deploys/cold-starts, a request timeout). Retry rather than record a
  // false 'rejected' that loses PPLNS credit + pollutes reject stats. Only 400/426
  // (and other 4xx) are definitive fatals → defer to the exact verdict.
  if (status === 408 || status === 425 || (status >= 500 && status <= 599)) return 'retry';
  return classifyShare(body);
}

/** A pool slot is usable only if it's a non-empty integer sub-range of [0, 2^32). */
export function isValidSlot(nonceStart: unknown, nonceEnd: unknown): boolean {
  return Number.isInteger(nonceStart) && Number.isInteger(nonceEnd)
    && (nonceStart as number) >= 0
    && (nonceStart as number) < (nonceEnd as number)
    && (nonceEnd as number) <= NONCE_SPACE;
}

/** Restart key: re-grind whenever the job, the share target, the assigned nonce slot,
 *  OR the header template (headerHex) changes. The pool can change the template
 *  (new txs / fresh mtp) while REUSING jobId+target+slot — grinding the stale header
 *  would build rejected blocks, so the header must be part of the restart key. */
export function jobRestartKey(j: { jobId: string; shareTargetHex: string; nonceStart: number; nonceEnd: number; headerHex: string }): string {
  return `${j.jobId}|${j.shareTargetHex}|${j.headerHex}|${j.nonceStart}|${j.nonceEnd}`;
}

const HEX_RE = /^[0-9a-fA-F]+$/;
const isHexOfLen = (v: unknown, len: number): boolean => typeof v === 'string' && v.length === len && HEX_RE.test(v);

/**
 * validate the FULL /job schema before acting on it. The body is cast from JSON,
 * so a malformed shareTargetHex, a wrong-length / non-hex header, or a missing jobId
 * would otherwise crash `hexToBytes`/`pool.start` or spin the grinder on garbage. The
 * header is a fixed 148-byte structure (HEADER_LEN) and the share target is 32 bytes —
 * both verified against the live pool (296 / 64 hex). An invalid job is treated like an
 * invalid slot: kept-current-work + re-poll (see refresh). */
export function isValidJob(j: unknown): j is PoolJob {
  if (typeof j !== 'object' || j === null) return false;
  const o = j as Record<string, unknown>;
  return typeof o.jobId === 'string' && o.jobId.length > 0
    && isHexOfLen(o.headerHex, HEADER_LEN * 2)
    && isHexOfLen(o.shareTargetHex, 64)
    && isValidSlot(o.nonceStart, o.nonceEnd);
}

/** Do not re-grind an already exhausted job key; otherwise restart only on key changes. */
export function shouldRegrind(key: string, lastKey: string | null, exhaustedKey: string | null): boolean {
  return key !== exhaustedKey && key !== lastKey;
}

/** Should a `stale` share verdict trigger an immediate /job re-poll? Only when the
 *  stale share is for the CURRENT active job (`staleJobId === activeJobId`) AND we
 *  haven't already woken for that job (`staleJobId !== lastStaleWakeJob`). This
 *  coalesces a burst of concurrent stale verdicts for the same job into ONE re-poll
 *  (so repeated wakes can't keep aborting the recovery poll) and ignores a LATE stale
 *  for a job we've already rolled past (so it can't abort a healthy poll for the new
 *  job). The caller sets lastStaleWakeJob = staleJobId when this returns true. */
export function shouldWakeOnStale(
  staleJobId: string,
  activeJobId: string | null,
  lastStaleWakeJob: string | null,
): boolean {
  return staleJobId === activeJobId && staleJobId !== lastStaleWakeJob;
}

/** Grind-watchdog tuning. A grind that HAS produced then goes silent for STALL_MS is a
 *  stall; a grind that has NOT produced yet (booting / just re-issued) is given
 *  BOOT_GRACE_MS since the episode (re)started before that counts — so a slow VPS
 *  worker isn't killed mid-boot, and a respawn's fresh workers get time to come up. */
export const WATCHDOG_STALL_MS = 12_000;
export const WATCHDOG_BOOT_GRACE_MS = 30_000;
/** Stall strikes before the heavy remedy. The 1st..(K-1)th stall re-applies the
 *  current job to the existing workers (cheap); the Kth respawns the worker pool. */
export const WATCHDOG_RESPAWN_AFTER_STRIKES = 2;
export const WATCHDOG_INTERVAL_MS = 3_000;

export type WatchdogAction = 'ok' | 're-apply' | 'respawn';

/**
 * Pure decision for the grind watchdog, evaluated on every WATCHDOG_INTERVAL_MS tick.
 *
 * The old watchdog respawned ALL workers on the FIRST STALL_MS with no hashes. On a
 * constrained / oversubscribed VPS a full respawn (fresh tsx workers + wasm init) can
 * itself take longer than STALL_MS, so it never recovers before the next check and
 * self-sustains — the user sees "no hashes for >12s — restarting grind" on repeat.
 *
 * This escalates and separates two states so ordinary job churn can't mask a real stall
 * and a slow boot isn't mistaken for one:
 *  - dormant while stopped or between jobs (no active job);
 *  - `producing` (the current grind episode has landed ≥1 hash): a stall is msSinceTick
 *    past STALL_MS — keyed on the last REAL hash, NOT reset by job changes;
 *  - not yet `producing` (booting / just re-issued): a stall is msSinceGrindStart past
 *    BOOT_GRACE_MS — the episode never produced within its grace;
 *  - on a stall → RE-APPLY the job to the existing workers (cheap; recovers a transient
 *    starvation / a briefly wedged grind) for the first (K-1) strikes, then RESPAWN on
 *    the Kth. `strikes` counts prior consecutive strikes; a real hash resets it to 0.
 */
export function watchdogDecision(args: {
  stopped: boolean;
  hasActiveJob: boolean;
  producing: boolean;
  msSinceTick: number;
  msSinceGrindStart: number;
  strikes: number;
}): WatchdogAction {
  if (args.stopped || !args.hasActiveJob) return 'ok';
  const stalled = args.producing
    ? args.msSinceTick > WATCHDOG_STALL_MS
    : args.msSinceGrindStart > WATCHDOG_BOOT_GRACE_MS;
  if (!stalled) return 'ok';
  return args.strikes + 1 >= WATCHDOG_RESPAWN_AFTER_STRIKES ? 'respawn' : 're-apply';
}

/** /job poll cadence (ms). Default 1000. After the pool's tip advances, a headless
 *  miner keeps grinding the OLD job until its next /job poll — blocks found in that
 *  window are born stale and get orphaned. Polling every ~1s (vs the old ~3s) closes
 *  most of that window. Purely a cadence knob: the GET /job request/response shape,
 *  the 404->re-register path, and all backoff/retry are unchanged. Env-overridable
 *  via JOB_POLL_MS; junk/non-positive falls back to the default; clamped to
 *  [250, 60000]ms so a typo can neither hammer the pool nor stall job refresh. */
const DEFAULT_JOB_POLL_MS = 1000;
const MIN_JOB_POLL_MS = 250;
const MAX_JOB_POLL_MS = 60_000;
export function resolveJobPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JOB_POLL_MS;
  if (raw == null || raw.trim() === '') return DEFAULT_JOB_POLL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_JOB_POLL_MS;
  return Math.min(MAX_JOB_POLL_MS, Math.max(MIN_JOB_POLL_MS, Math.round(n)));
}

/** /job long-poll wait (seconds). Default 25, clamped [0, 30] (pool caps at 30).
 *  0 disables long-poll (pure fast-poll). Env JOB_WAIT_S; junk/unset -> default. */
const DEFAULT_JOB_WAIT_S = 25;
const MAX_JOB_WAIT_S = 30;
export function resolveJobWaitS(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JOB_WAIT_S;
  if (raw == null || raw.trim() === '') return DEFAULT_JOB_WAIT_S;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_JOB_WAIT_S;
  return Math.max(0, Math.min(MAX_JOB_WAIT_S, Math.floor(n)));
}

/** Extra client timeout budget over `wait` for a long-poll request (the pool holds
 *  up to `wait`, ≤30s; we time out a bit later to absorb network latency). */
export const LONGPOLL_TIMEOUT_MARGIN_MS = 10_000;

/** Fraction of `wait` a same-job response must have been held to count as "the pool
 *  honored ?wait" (vs a legacy pool / over-cap pool returning immediately). */
const LONGPOLL_HONORED_FRAC = 0.8;

/** A /job request that returned faster than this did NOT meaningfully block (it was
 *  not a held long-poll — just network round-trip). Used by the loop's hot-loop guard
 *  to tell a genuine immediate re-poll (after a held long-poll, ≥ ~1s) from a spin
 *  (instant returns). Fixed + independent of JOB_POLL_MS on purpose: JOB_POLL_MS can
 *  exceed JOB_WAIT_S, so the cadence is not a valid "did it block" threshold. */
const HOT_LOOP_FAST_MS = 500;

/** Build the /job URL. Long-poll params are appended ONLY when wait>0 AND a current
 *  job is held (have) — otherwise it's a plain immediate poll, byte-identical to today. */
export function buildJobUrl(poolUrl: string, workerId: string, opts: { waitS?: number; have?: string | null } = {}): string {
  const base = `${poolUrl}/job?workerId=${encodeURIComponent(workerId)}`;
  const waitS = opts.waitS ?? 0;
  const have = opts.have ?? '';
  if (waitS > 0 && have) return `${base}&wait=${waitS}&have=${encodeURIComponent(have)}`;
  return base;
}

/** Pure scheduling decision: ms to sleep before the next /job poll. The confirmed
 *  pool contract returns 200 with the SAME job body on wait-expiry, so a held-then-
 *  expired response and a legacy-ignored response are indistinguishable by body —
 *  elapsed time disambiguates. A pool that ignores ?wait simply yields the fast-poll
 *  cadence (never a hot loop). */
export function nextJobPollDelayMs(args: {
  hadJob: boolean;        // did we send have= (were we holding a job)?
  usedWaitS: number;      // wait seconds actually sent (0 = no long-poll this request)
  responseJobId: string;  // jobId returned (a valid job)
  haveJobId: string | null;
  elapsedMs: number;
  jobPollMs: number;
  honoredFrac?: number;
}): number {
  if (!args.hadJob) return 0;                                  // plain poll got work -> long-poll next
  // Defensive: never let a bad caller-supplied cadence collapse the fast-poll
  // fallback into a 0ms hot loop. resolveJobPollMs already clamps, but the
  // no-hot-loop guarantee must hold intrinsically here too.
  const fastPollMs = Number.isFinite(args.jobPollMs) && args.jobPollMs > 0 ? args.jobPollMs : DEFAULT_JOB_POLL_MS;
  if (args.usedWaitS <= 0) return fastPollMs;                  // long-poll disabled -> fast-poll
  if (args.responseJobId !== args.haveJobId) return 0;         // job changed -> grab next now
  const heldMs = (args.honoredFrac ?? LONGPOLL_HONORED_FRAC) * args.usedWaitS * 1000;
  return args.elapsedMs >= heldMs ? 0 : fastPollMs;           // honored expiry vs early return
}

/** setTimeout that rejects with the signal's reason the moment it aborts (no leaked
 *  listener). Used between /job polls so a teardown OR a watchdog wake interrupts the
 *  wait. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    let t: ReturnType<typeof setTimeout>;
    const onAbort = (): void => { clearTimeout(t); reject(signal!.reason ?? new DOMException('aborted', 'AbortError')); };
    t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type RefreshResult =
  | { kind: 'job'; jobId: string }   // a valid job is held (possibly same or changed)
  | { kind: 'reregister' }           // 404 handled -> re-poll now
  | { kind: 'stopped' }              // pool mode stopped (426/400/teardown) -> exit loop
  | { kind: 'retry' };               // transient/fatal/invalid -> fast-poll cadence

export interface JobPollLoopDeps {
  isStopped: () => boolean;
  getHave: () => string | null;             // current activeJobId
  takeForcePlain: () => boolean;            // reads + clears the forcePlainPoll flag
  waitS: number;
  jobPollMs: number;
  honoredFrac?: number;
  now: () => number;
  setCurrentCycle: (ac: AbortController | null) => void; // lets wake() reach the live request
  teardownSignal?: AbortSignal;
  refresh: (args: { have: string | null; waitS: number; signal: AbortSignal }) => Promise<RefreshResult>;
  onPollError: (e: unknown) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The /job poll loop. One request per iteration; the next delay comes from the
 *  response (immediate when the pool held to ~expiry or the job changed; the fast-
 *  poll cadence when a pool ignored ?wait or returned early). A per-iteration
 *  AbortController (registered via setCurrentCycle) lets a teardown exit and a
 *  watchdog wake() force an immediate plain re-poll. Grinding is independent — this
 *  loop only triggers job swaps inside refresh(). */
export async function runJobPollLoop(deps: JobPollLoopDeps): Promise<void> {
  // Clamp once so the loop is self-protecting regardless of caller. Production passes
  // the clamped resolveJobPollMs() but a direct caller with 0/negative/NaN would
  // otherwise spin (the throttle sets delay=0 when jobPollMs is 0).
  const jobPollMs = Number.isFinite(deps.jobPollMs) && deps.jobPollMs > 0 ? deps.jobPollMs : DEFAULT_JOB_POLL_MS;
  // Hot-loop guard state: consecutive immediate (delay 0) iterations whose request
  // did NOT actually block. See the guard below.
  let consecutiveImmediate = 0;
  while (!deps.isStopped()) {
    const cycle = new AbortController();
    deps.setCurrentCycle(cycle);
    const onTeardown = (): void => cycle.abort(deps.teardownSignal?.reason ?? new DOMException('aborted', 'AbortError'));
    if (deps.teardownSignal?.aborted) cycle.abort(deps.teardownSignal.reason);
    else deps.teardownSignal?.addEventListener('abort', onTeardown, { once: true });

    const have = deps.getHave();
    const plain = deps.takeForcePlain();
    const usedWaitS = have && !plain ? deps.waitS : 0;
    const startedAt = deps.now();
    let exit = false;
    try {
      const res = await deps.refresh({ have, waitS: usedWaitS, signal: cycle.signal });
      const elapsed = deps.now() - startedAt;
      let delay: number;
      if (res.kind === 'stopped') { exit = true; delay = 0; }
      else if (res.kind === 'reregister') delay = 0;
      else if (res.kind === 'retry') delay = jobPollMs;
      else delay = nextJobPollDelayMs({
        hadJob: !!have, usedWaitS, responseJobId: res.jobId, haveJobId: have,
        elapsedMs: elapsed, jobPollMs, honoredFrac: deps.honoredFrac,
      });
      // No-hot-loop guard. An immediate re-poll (delay 0) is correct for a genuine
      // event: a job change, a reregister, or a long-poll that actually held to
      // ~expiry. But if the request did NOT block (it returned faster than the
      // fast-poll cadence) and this keeps happening, a buggy/hostile pool — rapid
      // 404s, or an ever-changing jobId while ignoring ?wait — would spin the loop.
      // Allow ONE fast immediate transition, then floor repeats at the fast-poll
      // cadence. A held long-poll (large elapsed) or any non-zero delay resets it.
      if (delay === 0 && elapsed < HOT_LOOP_FAST_MS) {
        if (++consecutiveImmediate >= 2) delay = jobPollMs;
      } else {
        consecutiveImmediate = 0;
      }
      if (!exit && delay > 0 && !cycle.signal.aborted) await deps.sleep(delay, cycle.signal);
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'AbortError') exit = true;           // real teardown
      else if (name === 'WakeError') { /* woken -> re-poll now (plain) */ }
      else { deps.onPollError(e); try { await deps.sleep(jobPollMs, cycle.signal); } catch { /* aborted */ } }
    } finally {
      deps.teardownSignal?.removeEventListener('abort', onTeardown);
      deps.setCurrentCycle(null);
    }
    if (exit || deps.isStopped()) break;
  }
}

export interface CurrentJob { workerId: string; jobId: string; }
export type PostShare = (s: { workerId: string; jobId: string; nonce: number }) => Promise<{ status: number; result?: string; block?: boolean; retryAfterMs?: number }>;

/** Pure mapping: a solved nonce -> a share POST for the active job. Unit-tested. */
export async function onSolvedShare(post: PostShare, job: CurrentJob, nonce: number): Promise<{ status: number; result?: string; block?: boolean; retryAfterMs?: number }> {
  return post({ workerId: job.workerId, jobId: job.jobId, nonce });
}

export interface ShareSubmitDeps {
  post: PostShare;
  sleep: (ms: number) => Promise<void>;
  backoff: (attempt: number, opts?: { retryAfterMs?: number }) => number;
  now: () => number;
  isStopped: () => boolean;
  /** The jobId currently being ground. If it rolls, a solved nonce is stale -> drop. */
  getActiveJobId: () => string | null;
  /** The submission-identity epoch (bumped on reregister). If it rolls -> drop. */
  getEpoch: () => number;
  reporter: { share: (ok: boolean, label: string) => void; event: (kind: 'info' | 'warn', msg: string) => void };
  /** Called on a terminal accepted/block verdict (bump counters + block log). */
  onAccepted: (block: boolean) => void;
  /** Called with the share's jobId on a `stale` pool verdict — a definitive "this job
   *  already rolled" signal. Lets the caller force an immediate /job re-poll so the
   *  miner switches to the current job instead of grinding the stale one for the rest
   *  of the poll window and submitting a storm of further stale shares. The jobId lets
   *  the caller ignore a late verdict for an already-superseded job and coalesce a burst
   *  of concurrent stale verdicts into a single re-poll (see shouldWakeOnStale). */
  onStale?: (jobId: string) => void;
  /** Per-share wall-clock ceiling — caps retries during a long same-job outage. */
  deadlineMs: number;
}

/** Clamp a backoff delay to [0, remaining-to-deadline] and an absolute 30s ceiling
 *  so a hostile/huge Retry-After can't park a retry loop. */
function clampShareDelay(delay: number, deadline: number, now: number): number {
  return Math.max(0, Math.min(delay, deadline - now, 30_000));
}

/**
 * Submit one solved nonce as a /share, retrying until a TERMINAL pool verdict OR
 * the job/worker identity rolls OR the per-share deadline passes. Returns true iff
 * the share reached the pool with a terminal verdict (so it must not be resubmitted);
 * false when it never landed (abort/teardown, identity roll, or deadline) so a later
 * re-scan of the same job may legitimately retry the nonce. Pure — deps injected.
 *
 * retry-until-terminal-or-roll + a wall-clock deadline (no fixed 3-attempt drop).
 * POSTs with the CAPTURED workerId/epoch and bails if the epoch rolls, so a
 *     concurrent reregister can never produce a {newWorkerId, oldJobId} "Frankenstein".
 */
export async function runShareSubmit(
  deps: ShareSubmitDeps,
  capWorkerId: string,
  jId: string,
  capEpoch: number,
  nonce: number,
): Promise<boolean> {
  const deadline = deps.now() + deps.deadlineMs;
  for (let attempt = 0; ; attempt++) {
    // Bail checks BEFORE each POST: never submit a stale / dead-identity share.
    if (deps.isStopped()) return false;
    if (deps.getEpoch() !== capEpoch) return false;     // worker re-registered
    if (deps.getActiveJobId() !== jId) return false;     // job rolled -> nonce stale
    if (deps.now() >= deadline) {                         // wall-clock ceiling
      deps.reporter.event('warn', '[pool-miner] share dropped after a prolonged pool outage (no nonce burned)');
      return false;
    }
    let r: { status: number; result?: string; block?: boolean; retryAfterMs?: number };
    try {
      r = await deps.post({ workerId: capWorkerId, jobId: jId, nonce });
    } catch (e) {
      // AbortError = teardown -> stop silently. Anything else (network reset, a
      // TimeoutError from the request timeout) is transient -> back off and retry.
      if ((e as Error)?.name === 'AbortError' || deps.isStopped()) return false;
      await deps.sleep(clampShareDelay(deps.backoff(attempt), deadline, deps.now()));
      continue;
    }
    if (deps.isStopped()) return false;
    const outcome = shareOutcome(r.status, r);
    if (outcome === 'retry') {
      await deps.sleep(clampShareDelay(deps.backoff(attempt, { retryAfterMs: r.retryAfterMs }), deadline, deps.now()));
      continue;
    }
    if (outcome === 'rejected') {
      // A `stale` verdict means the pool has already rolled the job we submitted for.
      // Signal the caller to re-poll /job NOW so we switch to the current job instead
      // of grinding this stale one for the rest of the poll window and posting a storm
      // of further stale shares (the activeJobId gate above then drops the old ones).
      if (r.result === 'stale') deps.onStale?.(jId);
      deps.reporter.share(false, r.result ?? 'rejected');
      return true;
    }
    deps.onAccepted(outcome === 'block-strike');
    deps.reporter.share(true, r.result ?? 'accepted');
    return true;
  }
}

export interface ShareDispatcherDeps {
  /** Max concurrently in-flight /share submissions. */
  pendingCap: number;
  /** Max shares waiting behind the in-flight cap before the oldest is dropped. */
  queueCap: number;
  /** Current submission-identity epoch (bumped on reregister); guards stale drains. */
  getEpoch: () => number;
  /** Actually submit one share; resolves true once it must NOT be resubmitted. */
  submit: (nonce: number, jobId: string, capWorkerId: string, capEpoch: number) => Promise<boolean>;
  onWarn?: (msg: string) => void;
}

interface QueuedShare { nonce: number; jobId: string; capWorkerId: string; capEpoch: number; }

/**
 * Dispatch solved nonces to /share with a bounded in-flight cap AND a bounded FIFO
 * backlog queue. Continuous-grind never re-scans a slot, so a solved nonce dropped
 * over the cap is a PERMANENTLY lost payable share — the old hard `return` lost them
 * on any healthy burst + slow /share. Here, over-cap shares queue and drain as
 * in-flight slots free, so nothing is lost unless BOTH the cap and the queue fill
 * (a real outage, where the pool can't credit them anyway → drop the oldest).
 *
 * Owns the per-(workerId,jobId) dedup: `submitted` (terminal — never resubmit),
 * `inFlight` (a POST is live), `queued` (waiting). Resets on a jobId change; a
 * reregister calls clear(). Drains skip shares whose job/epoch rolled while queued
 * (never submit under a new identity). Pure: all effects are injected.
 */
export function createShareDispatcher(deps: ShareDispatcherDeps): {
  offer: (nonce: number, jobId: string, capWorkerId: string, capEpoch: number) => void;
  clear: () => void;
} {
  let submitJobId: string | null = null;
  const submitted = new Set<number>();
  const inFlight = new Set<number>();
  const queued = new Set<number>();
  const queue: QueuedShare[] = [];

  const wipe = (): void => { submitted.clear(); inFlight.clear(); queued.clear(); queue.length = 0; };

  const drain = (): void => {
    while (inFlight.size < deps.pendingCap && queue.length > 0) {
      const item = queue.shift()!;
      queued.delete(item.nonce);
      // Job rolled or identity rolled while it waited → no longer payable, skip.
      if (item.jobId !== submitJobId || item.capEpoch !== deps.getEpoch()) continue;
      if (submitted.has(item.nonce) || inFlight.has(item.nonce)) continue;
      launch(item.nonce, item.jobId, item.capWorkerId, item.capEpoch);
    }
  };

  function launch(nonce: number, jobId: string, capWorkerId: string, capEpoch: number): void {
    inFlight.add(nonce);
    void deps.submit(nonce, jobId, capWorkerId, capEpoch)
      // Mark durable only on a terminal verdict, and only if neither the job nor the
      // worker epoch rolled out from under this late completion (cross-epoch guard).
      .then((reached) => { if (reached && submitJobId === jobId && deps.getEpoch() === capEpoch) submitted.add(nonce); })
      .catch((e) => deps.onWarn?.(`[pool-miner] share post failed: ${(e as Error).message}`))
      .finally(() => {
        if (submitJobId === jobId && deps.getEpoch() === capEpoch) inFlight.delete(nonce);
        drain();
      });
  }

  const offer = (nonce: number, jobId: string, capWorkerId: string, capEpoch: number): void => {
    // A new jobId is a fresh dedup epoch (the /share payload carries no target, so a
    // vardiff/slot roll under the SAME jobId must NOT clear dedup).
    if (jobId !== submitJobId) { submitJobId = jobId; wipe(); }
    if (submitted.has(nonce) || inFlight.has(nonce) || queued.has(nonce)) return;
    if (inFlight.size >= deps.pendingCap) {
      if (queue.length >= deps.queueCap) {
        const old = queue.shift()!;
        queued.delete(old.nonce);
        deps.onWarn?.('[pool-miner] share backlog full — dropping oldest pending share');
      }
      queue.push({ nonce, jobId, capWorkerId, capEpoch });
      queued.add(nonce);
      return;
    }
    launch(nonce, jobId, capWorkerId, capEpoch);
  };

  return { offer, clear: () => { submitJobId = null; wipe(); } };
}

interface PoolJob { jobId: string; headerHex: string; shareTargetHex: string; nonceStart: number; nonceEnd: number; }
interface RegisterBody {
  workerId: string;
  shareTargetHex?: string;
  latestMinerVersion?: string;
  minMinerVersion?: string;
  notice?: string;
  releaseNotesUrl?: string;
}

/** Live pool client: register, poll jobs, grind vs shareTarget, post shares. Not unit-tested (network). */
export async function runPoolClient(
  poolUrl: string,
  payoutAddress: string,
  workers: number,
  throttle: number,
  reporter: MinerReporter = new ConsoleReporter(),
  signal?: AbortSignal,
  status?: ReporterStatus,
  smart: 'off' | 'max' | 'considerate' = 'off',
  /** Injectable fetch for tests; defaults to the global fetch. Never changes the
   *  wire protocol — only which fetch implementation performs the request. */
  doFetch: typeof fetch = fetch,
  /** Injectable grind-pool constructor for tests (e.g. to simulate the OS
   *  refusing another worker thread without spinning real ones). Defaults to
   *  the real engine choice already resolved into `useNative` — never changes
   *  which engine actually mines, only lets a test force this construction
   *  step to throw. */
  createPool: (useNative: boolean, workers: number, startDuty: number) => GrindPool | NativeGrindPool
    = (useNative, workers, startDuty) => (useNative ? new NativeGrindPool(workers, startDuty) : new GrindPool(workers, startDuty)),
): Promise<void> {
  // Show "connecting to pool…" as bootstrapping activity before the first job
  // arrives. Pools need no chain sync, but registration + the first job poll
  // still take a beat; an indeterminate syncProgress (target 0) gives the TUI an
  // amber SYNCING dot for the connect window instead of a silent gap that jumps
  // straight to MINING. synced(0) below flips it to MINING. A plain event line
  // surfaces the same thing in non-TUI logs with pool-appropriate wording.
  reporter.event('info', `[pool-miner] connecting to ${poolUrl}…`);
  reporter.syncProgress(0, 0);

  const register = async (): Promise<RegisterBody | 'negotiated' | null> => {
    let waitingSince = 0;
    let nudged = false;
    const reg = await withPoolRetry(
      () => poolFetch(`${poolUrl}/register`, {
        method: 'POST',
        body: JSON.stringify({ payoutAddress, minerVersion: VERSION }),
      }, undefined, doFetch),
      {
        signal,
        onWait: () => {
          const now = Date.now();
          if (!waitingSince) waitingSince = now;
          reporter.event('info', `[pool-miner] ${poolUrl} unavailable (syncing/busy) — retrying…`);
          reporter.syncProgress(0, 0);
          if (!nudged && now - waitingSince > 120_000) {
            nudged = true;
            reporter.event('info', '[pool-miner] still unavailable — you can switch to Solo in the menu.');
          }
        },
      },
    ).catch((e: unknown) => {
      if (e instanceof PoolError && negotiatedRequired(e.status, e.body)) {
        // The pool retired pool-built jobs: miners must build their own blocks
        // (Stratum-V2-style job negotiation). Hand over to the negotiated client.
        return 'negotiated' as const;
      }
      if (e instanceof PoolError && e.status === 400) {
        reporter.event('error', `[pool-miner] registration rejected: ${(e.body as { error?: string } | null)?.error ?? 'bad payoutAddress'} — fix MINER_PUBKEY. Stopping pool mode.`);
        return null;
      }
      if (e instanceof PoolError && e.status === 426) {
        reporter.updateNotice?.({ currentVersion: VERSION, latestVersion: undefined, mustUpdate: true });
        reporter.event('error', '[pool-miner] miner upgrade required by pool — stopping pool mode.');
        return null;
      }
      if ((e as Error).name === 'AbortError') return null;
      throw e;
    });
    if (reg === 'negotiated') return reg;
    return reg ? reg.body as RegisterBody : null;
  };

  const initialReg = await register();
  if (initialReg === 'negotiated') {
    return runNegotiatedPoolClient(poolUrl, payoutAddress, workers, throttle, reporter, signal, status, smart);
  }
  if (!initialReg) {
    reporter.close?.();
    return;
  }
  let workerId = initialReg.workerId;
  const versionFields = {
    latestMinerVersion: initialReg.latestMinerVersion,
    minMinerVersion: initialReg.minMinerVersion,
    notice: initialReg.notice,
    releaseNotesUrl: initialReg.releaseNotesUrl,
  };
  void checkForUpdate({ reporter, poolVersionFields: versionFields, signal }).catch(() => {});
  // Engine gate + fallback note (why the probes exist, why the note is
  // persistent): shared with the negotiated path — see poolEngine.ts.
  const { useNative, backendNote } = resolvePoolEngine();
  // The duty cycle the grind actually STARTS at. Under a Smart mode the controller
  // owns the throttle and `throttle` (MINER_THROTTLE) is only a manual leftover —
  // starting from it made Max crawl up from a previously-lowered manual value
  // instead of going straight to full tilt. Declared before the status block below
  // because both the status line and the grind pool need it.
  const startDuty = smartStartDuty(smart, throttle);

  if (status) {
    // Correct the passed-in status to what the pool gate actually resolved: the
    // launcher set backend from the engine selection, but resolvePoolEngine() can
    // demote a present-but-stale binary to wasm here.
    status.backend = useNative ? 'native' : 'wasm';
    status.backendNote = backendNote;
    // …and to the duty we actually start at, not the manual throttle the launcher
    // baked in (start.ts builds status from cfg.throttle before the mode is applied).
    status.throttle = startDuty;
  }

  reporter.status(status ?? {
    mode: 'pool',
    target: poolUrl,
    backend: useNative ? 'native' : 'wasm',
    backendNote,
    workers,
    throttle: startDuty,
    address: payoutAddress,
  });
  reporter.event('info', `[pool-miner] registered worker ${workerId} at ${poolUrl}`);
  reporter.event('info', `[pool-miner] grind engine: ${useNative ? 'native' : 'wasm'}`);
  reporter.synced(0);
  let acceptedShares = 0;

  // Considerate's whole job is to get out of your way, so it also grinds at a lower
  // scheduling priority (solo has always done this). Manual and Max are NOT niced: a
  // user who asked for a fixed rate or for full tilt did not ask to lose scheduler
  // races, and quietly costing them hashrate would be a regression.
  if (smart === 'considerate') {
    try { os.setPriority(10); } catch { /* not permitted on some platforms — ignore */ }
  }

  const pool: GrindPool | NativeGrindPool = createPool(useNative, workers, startDuty);
  const smartController = smart !== 'off'
    ? new SmartController(
      pool,
      // Considerate leaves the THERMAL ceiling open and eases in via the demand
      // allowance instead; capping the ceiling at the eased start would strand the
      // demand loop below its own target (see SmartDemandOptions.demandStart).
      { start: smart === 'considerate' ? 1 : startDuty },
      undefined,
      smart === 'considerate'
        ? {
          demand: createDemandSignal({ onWarn: (m) => reporter.event('warn', m) }),
          workers,
          demandStart: startDuty,
        }
        : undefined,
    )
    : null;
  const post: PostShare = async (s) => {
    const r = await poolFetch(`${poolUrl}/share`, { method: 'POST', body: JSON.stringify(s), signal }, undefined, doFetch);
    // Spread the pool body FIRST so the authoritative HTTP status + the parsed
    // Retry-After (from headers) always win, even if the body carries its own
    // `status`/`retryAfterMs` field.
    return { ...(r.body ?? {}), status: r.status, retryAfterMs: parseRetryAfterMs(r.headers) } as { status: number; result?: string; block?: boolean; retryAfterMs?: number };
  };
  const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

  let lastKey: string | null = null;
  let exhaustedKey: string | null = null;
  let lastNonzeroTickAt = Date.now();
  // When the current grind EPISODE (re)started — a not-yet-producing grind gets a boot
  // grace from here before the stall watchdog counts, so a slow-booting worker isn't
  // killed mid-boot. Reset only on an episode start (idle→grinding), not job churn.
  let grindStartedAt = Date.now();
  // Has the current episode landed ≥1 real hash? Until it has, the watchdog judges by
  // the boot grace; after, by time since the last hash. Set on hps>0, reset on episode start.
  let grindProducing = false;
  // Consecutive watchdog stall strikes; reset to 0 by any real hash (see onHashrate).
  let watchdogStrikes = 0;
  // the jobId currently being ground (set synchronously in refresh). A solved
  // nonce whose job has rolled is stale -> submitShare drops it before POSTing.
  let activeJobId: string | null = null;
  // the last job a stale verdict woke a re-poll for — coalesces a burst of stale
  // verdicts for the same job into a single re-poll (see shouldWakeOnStale / onStale).
  let lastStaleWakeJob: string | null = null;
  // submission-identity epoch, bumped on reregister. A share captures the epoch
  // at solve time and bails if it rolls, so a retry never posts under a new workerId.
  let epoch = 0;
  // caps: bound the concurrently in-flight shares + a bounded backlog queue
  // + a per-share wall-clock ceiling. A long same-job outage can't pile up unbounded
  // retry loops, while a healthy burst over the cap is QUEUED (not dropped — a
  // continuous grind never re-scans, so a dropped solved nonce is a lost payable
  // share). Dedup/queue/drain all live in createShareDispatcher, which covers BOTH
  // the wasm and native grind pools.
  const PENDING_CAP = Math.max(16, workers * 2);
  const SHARE_QUEUE_CAP = PENDING_CAP * 4;
  const SHARE_DEADLINE_MS = 120_000;
  let stopped = false;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let stopPoolMode: () => void = () => {};

  const reregister = async (): Promise<void> => {
    pool.stop();
    lastKey = null;
    exhaustedKey = null;
    activeJobId = null;
    // A new workerId is a fresh share-submission identity at the pool. Bump the
    // epoch so any in-flight share retry bails instead of POSTing under the new
    // workerId, and clear the per-(workerId,jobId) dedup/queue state too.
    epoch++;
    dispatcher.clear();
    const regBody = await register();
    if (stopped) return;
    if (regBody === 'negotiated') {
      // The pool switched to mandatory negotiated mode mid-run. Stop the classic
      // loop; the runner/menu restarts pool mode, which then hands off cleanly.
      reporter.event('warn', '[pool-miner] pool now requires negotiated mode — restart the miner to switch over.');
      stopPoolMode();
      return;
    }
    if (!regBody) {
      stopPoolMode();
      return;
    }
    workerId = regBody.workerId;
    reporter.event('info', `[pool-miner] registered worker ${workerId} at ${poolUrl}`);
  };

  // Submit one solved nonce, retrying until a terminal pool verdict OR the job/
  // worker identity rolls OR the per-share deadline (see runShareSubmit). Returns
  // true once the share reached the pool (must NOT be resubmitted); false when it
  // never landed (abort/teardown, identity roll, deadline) so a later re-scan of the
  // same job may legitimately retry the nonce (no share silently burned).
  async function submitShare(capWorkerId: string, jId: string, capEpoch: number, nonce: number): Promise<boolean> {
    return runShareSubmit(
      {
        post,
        sleep,
        backoff: backoffDelay,
        now: Date.now,
        isStopped: () => stopped,
        getActiveJobId: () => activeJobId,
        getEpoch: () => epoch,
        reporter,
        onAccepted: (block) => {
          acceptedShares++;
          if (block) reporter.event('info', '[pool-miner] BLOCK FOUND — >=50 BRC! (reward + finder bonus credit after maturity)');
        },
        // A stale verdict = the pool already rolled the job we submitted for; re-poll
        // /job immediately so we switch to the current job (the activeJobId gate then
        // drops old-job shares) instead of grinding the stale one and posting a storm of
        // stale shares. Coalesced + job-guarded (shouldWakeOnStale): a BURST of stale
        // verdicts for the same job wakes once (repeated wakes would keep aborting the
        // recovery poll), and a LATE stale for a job we've already rolled past is ignored
        // (it must not abort a healthy poll for the current job).
        onStale: (staleJobId) => {
          if (shouldWakeOnStale(staleJobId, activeJobId, lastStaleWakeJob)) {
            lastStaleWakeJob = staleJobId;
            wake();
          }
        },
        deadlineMs: SHARE_DEADLINE_MS,
      },
      capWorkerId,
      jId,
      capEpoch,
      nonce,
    );
  }

  // Bounded queue+drain for solved nonces (replaces the old hard PENDING_CAP drop).
  // Owns the per-(workerId,jobId) dedup, the in-flight cap, and the backlog queue.
  const dispatcher = createShareDispatcher({
    pendingCap: PENDING_CAP,
    queueCap: SHARE_QUEUE_CAP,
    getEpoch: () => epoch,
    submit: (nonce, jobId, capWorkerId, capEpoch) => submitShare(capWorkerId, jobId, capEpoch, nonce),
    onWarn: (msg) => reporter.event('warn', msg),
  });

  // Jackpot is a FulgurPool-only feature. Gate on pool IDENTITY (isFulgurPool),
  // not on whether a /jackpot response happens to parse — a third-party pool
  // must never be asked for an endpoint it doesn't have, and must never be able
  // to paint the FulgurPool-branded panel by returning a jackpot-shaped body.
  // Derived here, once, from the canonical poolUrl this function was called with,
  // so the gate is identical on the TUI path and the headless `npm run mine` path
  // — both funnel through this one runPoolClient implementation.
  //
  // Started only AFTER the grind pool / smart controller / share dispatcher have
  // all been constructed above: those are the only synchronous steps between
  // registration and the `done()` teardown (below) that can throw (e.g. the OS
  // refusing another worker thread), and until this branch the only stop()
  // funnel for this interval was `done()`, defined much later. If any of those
  // constructions throws, runPoolClient now rejects BEFORE this timer ever
  // exists, instead of leaving it polling forever — the same ghost-process
  // class already fixed for the 426/400 exits, closed at its origin.
  const poolStats = startPoolStats({
    poolUrl, address: payoutAddress, getAcceptedShares: () => acceptedShares, pageUrl: undefined,
    reporter, signal, wantJackpot: isFulgurPool(poolUrl), doFetch,
  });

  // Each solved nonce is offered to the dispatcher, capturing the submission identity
  // (workerId + epoch) NOW so a concurrent reregister can't make a later retry POST a
  // {newWorkerId, oldJobId} share. Over the in-flight cap the dispatcher queues
  // rather than dropping; a continuous grind never re-scans, so a dropped solved
  // nonce would be a permanently lost payable share.
  const onNonce = (j: PoolJob) => (nonce: number): void => {
    dispatcher.offer(nonce, j.jobId, workerId, epoch);
  };

  async function refresh(args: { have: string | null; waitS: number; signal: AbortSignal }): Promise<RefreshResult> {
    if (stopped) return { kind: 'stopped' };
    const url = buildJobUrl(poolUrl, workerId, { waitS: args.waitS, have: args.have });
    const timeoutMs = args.waitS > 0 ? args.waitS * 1000 + LONGPOLL_TIMEOUT_MARGIN_MS : undefined;
    const r = await poolFetch(url, { signal: args.signal }, timeoutMs, doFetch);
    if (stopped) return { kind: 'stopped' };
    if (r.status === 404) {
      await reregister();
      return { kind: 'reregister' };
    }
    // Actionable fatals from /job stop pool mode cleanly, mirroring register:
    // 426 = pool requires an upgrade; 400 = pool rejected the request/address.
    if (r.status === 426) {
      reporter.updateNotice?.({ currentVersion: VERSION, latestVersion: undefined, mustUpdate: true });
      reporter.event('error', '[pool-miner] miner upgrade required by pool — stopping pool mode.');
      stopPoolMode();
      return { kind: 'stopped' };
    }
    if (r.status === 400) {
      reporter.event('error', `[pool-miner] pool rejected /job (400${(r.body as { error?: string } | null)?.error ? `: ${(r.body as { error?: string }).error}` : ''}) — stopping pool mode.`);
      stopPoolMode();
      return { kind: 'stopped' };
    }
    if (r.status === 410) {
      // The pool retired pool-built jobs mid-session and now requires negotiated
      // mode (410 is the negotiated-required signal register() hands off on). We
      // can't hand off to negotiated mode in place on a live session, so stop pool
      // mode cleanly with a restart hint instead of looping on a dead /job forever.
      reporter.event('error', '[pool-miner] pool now requires negotiated mode (410) — restart the miner to switch. Stopping pool mode.');
      stopPoolMode();
      return { kind: 'stopped' };
    }
    const cls = classify(r.status);
    if (cls === 'transient') return { kind: 'retry' };
    if (cls === 'fatal') {
      // Other non-2xx (e.g. 5xx) may be a passing server hiccup — keep polling.
      reporter.event('warn', `[pool-miner] /job ${r.status} — retrying`);
      return { kind: 'retry' };
    }
    const j = r.body as PoolJob;
    // validate the WHOLE job schema (jobId, header length, share target,
    // nonce slot) before acting on it — the body is cast from JSON, so a malformed
    // header/target/slot would otherwise crash hexToBytes/pool.start or spin the
    // grinder. A malformed job (like a degenerate slot) is almost always a TRANSIENT
    // pool glitch: warn and re-poll, but DO NOT stop the current grind or clear
    // activeJobId. Tearing down here would drop an in-flight share for the previous
    // VALID job (it bails on the activeJobId guard, and a continuous grind never
    // re-scans → that payable share is lost). In pool mode we must also NEVER fall back
    // to full-space grinding (every nonce would be out-of-slot, rejected pre-hash).
    // Keep the best current assignment until a VALID replacement job arrives.
    if (!isValidJob(j)) {
      reporter.event('warn', '[pool-miner] /job: malformed/invalid job (bad header/target/slot) — ignoring, keeping current work, will re-poll');
      return { kind: 'retry' };
    }
    // The slot is part of the mining contract now, so a fresh slot for the SAME
    // job/target must still trigger a restart — include it in the key.
    const key = jobRestartKey(j);
    if (key === exhaustedKey) return { kind: 'job', jobId: j.jobId };
    exhaustedKey = null;
    if (!shouldRegrind(key, lastKey, exhaustedKey)) return { kind: 'job', jobId: j.jobId };
    if (stopped) return { kind: 'stopped' };
    // #5: clear the active job BEFORE tearing down the old grind. If header decode
    // (hexToBytes) or pool.start throws, activeJobId stays null rather than pointing
    // at a stale job, so no in-flight share keeps submitting under a job we're no
    // longer mining. It is re-asserted only AFTER a successful start, below.
    activeJobId = null;
    // An "episode" begins when a grind (re)starts from idle — the initial job, the job
    // after a slot exhaustion, or a watchdog restart (all leave lastKey === null). Only
    // then does the boot-grace clock restart and `producing` reset: a job-to-job change
    // reuses already-producing workers, so it must NOT reset those (else ordinary job
    // churn would keep masking a real stall — see watchdogDecision).
    const episodeStart = lastKey === null;
    pool.stop();
    pool.start(
      hexToBytes(j.headerHex),
      j.shareTargetHex,
      onNonce(j),
      (hps) => {
        if (hps > 0) { lastNonzeroTickAt = Date.now(); watchdogStrikes = 0; grindProducing = true; }
        smartController?.onHashrate(hps);
        reporter.hashrate(hps);
        if (smartController) reporter.smart?.({ mode: smart as 'max' | 'considerate', throttle: smartController.appliedThrottle(), clamped: smartController.isClamped(), phase: smartController.phase() });
      },
      () => {
        reporter.event('info', '[pool-miner] nonce slot exhausted — requesting fresh work');
        exhaustedKey = lastKey;
        lastKey = null;
      },
      (err) => reporter.event('warn', `[pool-miner] grind error: ${err.message}`),
      j.nonceStart, // honor the pool's per-worker slot — out-of-slot nonces are
      j.nonceEnd,   // rejected pre-hash as "invalid"
      true,         // share mode: keep grinding the slot for many shares per job
    );
    lastKey = key;
    if (episodeStart) {
      grindStartedAt = Date.now();
      grindProducing = false; // this episode must land its own first hash
    }
    // nonces solved from here are valid for this job until it rolls. Set only AFTER a
    // successful pool.start (which fires onNonce asynchronously), synchronously here.
    activeJobId = j.jobId;
    return { kind: 'job', jobId: j.jobId };
  }

  const stoppedPromise = new Promise<void>((resolve) => {
    const done = (): void => {
      if (stopped) return;
      stopped = true;
      activeJobId = null;
      // Every pool-mode exit path (abort, 426, 400, a failed reregister) funnels
      // through here via stopPoolMode = done, so stopping the stats poller here
      // covers all of them — not just the abort listener the old code relied on
      // (which never fired in headless mode, since both headless call sites pass
      // signal===undefined).
      poolStats.stop();
      if (watchdogTimer) clearInterval(watchdogTimer);
      smartController?.stop();
      pool.terminate();
      reporter.close?.();
      signal?.removeEventListener('abort', done);
      resolve();
    };
    stopPoolMode = done;
    if (signal?.aborted) return done();
    signal?.addEventListener('abort', done, { once: true });
  });

  // Swallow abort-driven fetch rejections and any error once we've stopped —
  // an in-flight /job aborted by teardown must not emit a spurious warning.
  const onPollError = (e: unknown): void => {
    if (!stopped && (e as Error)?.name !== 'AbortError') {
      reporter.event('warn', `[pool-miner] job poll failed: ${(e as Error).message}`);
    }
  };

  // (onPollError stays as defined above — swallows abort/stopped, warns on a real
  // poll failure. Long-poll wait-expiry is a normal 200, not an error, so it never
  // warns. The setInterval-based runRefresh is replaced by runJobPollLoop below.)

  const waitS = resolveJobWaitS();
  const jobPollMs = resolveJobPollMs();
  let forcePlainPoll = false;
  let currentCycle: AbortController | null = null;
  // Force the next poll to be an immediate PLAIN /job (no wait/have) and interrupt any
  // outstanding long-poll — used by the watchdog to re-apply work after a grind stall.
  const wake = (): void => {
    forcePlainPoll = true;
    currentCycle?.abort(new DOMException('wake', 'WakeError'));
  };

  if (!stopped) {
    smartController?.start();
    watchdogTimer = setInterval(() => {
      const now = Date.now();
      const action = watchdogDecision({
        stopped,
        hasActiveJob: lastKey !== null,
        producing: grindProducing,
        msSinceTick: now - lastNonzeroTickAt,
        msSinceGrindStart: now - grindStartedAt,
        strikes: watchdogStrikes,
      });
      if (action === 'ok') return;
      // Both remedies clear lastKey + wake(): the poll loop then re-applies the current
      // job (via refresh, whose episode-start resets the boot-grace clock + `producing`,
      // giving the re-issued grind time to produce before the next strike). Re-apply
      // reuses the existing workers (cheap); respawn replaces them.
      watchdogStrikes++;
      if (action === 'respawn') {
        reporter.event('warn', `[pool-miner] grind still stalled after ${watchdogStrikes} tries — restarting workers (a box stuck at 0 H/s may be out of memory or CPU-starved; try lowering MINER_WORKERS)`);
        pool.respawn();
        watchdogStrikes = 0;
      } else {
        reporter.event('warn', `[pool-miner] grind stalled — re-applying work (attempt ${watchdogStrikes})`);
      }
      lastKey = null;
      wake(); // interrupt the long-poll + force an immediate plain re-poll to re-apply work
    }, WATCHDOG_INTERVAL_MS);
  }

  if (!stopped) {
    await runJobPollLoop({
      isStopped: () => stopped,
      getHave: () => activeJobId,
      takeForcePlain: () => { const f = forcePlainPoll; forcePlainPoll = false; return f; },
      waitS,
      jobPollMs,
      now: Date.now,
      setCurrentCycle: (ac) => { currentCycle = ac; },
      teardownSignal: signal,
      refresh,
      onPollError,
      sleep: abortableDelay,
    });
  }

  // With no signal this Promise never resolves → runs forever, exactly like
  // today. With a signal, abort tears everything down cleanly and resolves.
  await stoppedPromise;
}
