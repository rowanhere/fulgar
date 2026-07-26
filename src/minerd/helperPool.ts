// src/minerd/helperPool.ts — solo-read helper failover + rotating primary.
// Miner-only transport (NOT shared consensus code). Reads the chain tip + blocks
// from the configured helper list, trying each in rotation order on failure so a
// single helper outage (5xx / timeout / network) becomes a silent failover instead
// of an error wall. Only a whole-round failure surfaces a warning; the primary
// rotates after sustained failures so reads stop leading with a dead helper.
import { getTip as httpGetTip, getBlocks as httpGetBlocks, type Tip, type GetJsonOpts } from './http.js';
import type { Block } from '../chain/block.js';

const DEFAULT_ROTATE_THRESHOLD = 3;
const DEFAULT_TIP_TIMEOUT_MS = 8_000;     // short: a black-holed helper fails over fast
const DEFAULT_BLOCKS_TIMEOUT_MS = 30_000; // generous: /blocks can return up to 200 blocks
const DEFAULT_BLOCKS_ROUNDS = 4;
const STALE_ROTATE_ROUNDS = 3; // consecutive best-trailing polls before the primary hands off
export const STALE_WARN_BLOCKS = 2; // blocks behind the best claim before a helper is called stale
const BLOCKS_BACKOFF_MS = [500, 1_000, 2_000, 4_000];
const blocksBackoff = (round: number): number => BLOCKS_BACKOFF_MS[Math.min(round, BLOCKS_BACKOFF_MS.length - 1)]!;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    let t: ReturnType<typeof setTimeout>;
    const onAbort = (): void => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
    t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class AllHelpersFailed extends Error {
  constructor(public readonly errors: Array<{ base: string; error: Error }>) {
    super(`all ${errors.length} helpers failed: ${errors.map((e) => `${e.base} (${e.error.message})`).join('; ')}`);
    this.name = 'AllHelpersFailed';
  }
}

export interface HelperTipView { base: string; tip: Tip }
export interface BestTip { best: Tip; sourceBase: string; views: HelperTipView[] }

export interface HelperPoolOpts {
  getTip?: (base: string, opts: GetJsonOpts) => Promise<Tip>;
  getBlocks?: (base: string, from: number, max: number, signal: AbortSignal | undefined, opts: Omit<GetJsonOpts, 'signal'>) => Promise<Block[]>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onDebug?: (msg: string) => void; // per-helper failure (invisible by default)
  onInfo?: (msg: string) => void;  // primary rotation
  rotateThreshold?: number;
  tipTimeoutMs?: number;
  blocksTimeoutMs?: number;
  blocksRounds?: number;
}

export class HelperPool {
  private primaryIdx = 0;
  private primaryFails = 0;
  private primaryStale = 0;
  private readonly helpers: string[];
  private readonly getTipFn: NonNullable<HelperPoolOpts['getTip']>;
  private readonly getBlocksFn: NonNullable<HelperPoolOpts['getBlocks']>;
  private readonly sleep: NonNullable<HelperPoolOpts['sleep']>;
  private readonly onDebug: (m: string) => void;
  private readonly onInfo: (m: string) => void;
  private readonly rotateThreshold: number;
  private readonly tipTimeoutMs: number;
  private readonly blocksTimeoutMs: number;
  private readonly blocksRounds: number;

  constructor(helpers: string[], opts: HelperPoolOpts = {}) {
    if (helpers.length === 0) throw new Error('HelperPool needs at least one helper');
    this.helpers = helpers;
    this.getTipFn = opts.getTip ?? httpGetTip;
    this.getBlocksFn = opts.getBlocks ?? httpGetBlocks;
    this.sleep = opts.sleep ?? defaultSleep;
    this.onDebug = opts.onDebug ?? (() => {});
    this.onInfo = opts.onInfo ?? (() => {});
    this.rotateThreshold = opts.rotateThreshold ?? DEFAULT_ROTATE_THRESHOLD;
    this.tipTimeoutMs = opts.tipTimeoutMs ?? DEFAULT_TIP_TIMEOUT_MS;
    this.blocksTimeoutMs = opts.blocksTimeoutMs ?? DEFAULT_BLOCKS_TIMEOUT_MS;
    this.blocksRounds = opts.blocksRounds ?? DEFAULT_BLOCKS_ROUNDS;
  }

  primary(): string {
    return this.helpers[this.primaryIdx]!;
  }

  /** Helper indices to try this round, starting at the current primary; with a
   *  `preferBase` (the helper whose tip claim we are chasing) that helper is
   *  tried FIRST, then the usual rotation order, deduped. */
  private order(preferBase?: string): number[] {
    const n = this.helpers.length;
    const rotation = Array.from({ length: n }, (_, k) => (this.primaryIdx + k) % n);
    if (preferBase === undefined) return rotation;
    const p = this.helpers.indexOf(preferBase);
    if (p < 0) return rotation;
    return [p, ...rotation.filter((i) => i !== p)];
  }

  /** Record this round's primary outcome (exactly once per round) and rotate when
   *  the primary has failed `rotateThreshold` rounds in a row. */
  private recordPrimary(failed: boolean): void {
    if (!failed) { this.primaryFails = 0; return; }
    this.primaryFails++;
    if (this.primaryFails >= this.rotateThreshold && this.helpers.length > 1) {
      this.primaryIdx = (this.primaryIdx + 1) % this.helpers.length;
      this.primaryFails = 0;
      // The staleness streak is a property of the helper holding the role, not
      // of the role — a new primary must not inherit its predecessor's count
      // (it would be handed off after a single stale poll).
      this.primaryStale = 0;
      this.onInfo(`[minerd] switching primary helper to ${this.primary()}`);
    }
  }

  /** Freshness bookkeeping for chain catch-up rounds. Negotiated mode has no
   *  getBestTip poll — its tip is the POOL's WS announcement — so this is the
   *  only staleness signal on that path. A STALLED round (helpers answered,
   *  but the chain neither changed nor reached the announced tip) counts
   *  against the primary's staleness streak; at STALE_ROTATE_ROUNDS the role
   *  advances to the next helper in rotation order (there is no claimant to
   *  hand to). A healthy round clears the streak. Callers must only call this
   *  for a catch-up that RAN and RETURNED — a thrown round is connectivity
   *  (recorded inside getBlocks already) and a round that learned nothing must
   *  not clear or grow a freshness streak. The successor starts clean of
   *  INHERITED counts on both streaks (an inherited count would hand the role
   *  off after a single bad round) — but a stalled catch-up round that ENDS on
   *  its watch charges it, even in the rare interleaving where a mid-round
   *  rotation plus a recovered predecessor means another helper served the
   *  terminal page (exact attribution would need the failover round to report
   *  who served — a wrongly-charged healthy helper clears on its next healthy
   *  round, and the rotation walk converges either way).
   *  Attribution note: the caller cannot know which helper
   *  served a stalled round (first-success inside getBlocks), so pressure
   *  lands on the primary; if a fallback served it, the primary took a
   *  connectivity strike in that same round anyway — either streak reaching
   *  the threshold rotates, so a stale source is evicted regardless. */
  noteCatchUpRound(stalled: boolean): void {
    if (!stalled) { this.primaryStale = 0; return; }
    this.primaryStale++;
    if (this.primaryStale >= STALE_ROTATE_ROUNDS && this.helpers.length > 1) {
      this.primaryIdx = (this.primaryIdx + 1) % this.helpers.length;
      this.primaryStale = 0;
      this.primaryFails = 0;
      this.onInfo(`[minerd] switching primary helper to ${this.primary()} (previous primary cannot serve the announced network tip)`);
    }
  }

  /** One failover round: try each helper once from the primary; first success wins.
   *  A caller AbortError propagates immediately (never retried/failed-over). */
  private async round<T>(label: string, attempt: (base: string) => Promise<T>, preferBase?: string): Promise<T> {
    const errors: Array<{ base: string; error: Error }> = [];
    const order = this.order(preferBase); // order[0] === primaryIdx when no preferBase
    for (let k = 0; k < order.length; k++) {
      const base = this.helpers[order[k]!]!;
      try {
        const value = await attempt(base);
        // A claimant-first round says nothing about the primary's health (the
        // claimant, not the primary, leads it) — skip the bookkeeping entirely.
        if (preferBase === undefined) this.recordPrimary(k > 0); // primary failed iff a fallback (k>0) served the round
        return value;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        errors.push({ base, error: e as Error });
        this.onDebug(`${label} via ${base} failed: ${(e as Error).message}`);
      }
    }
    if (preferBase === undefined) this.recordPrimary(true);
    throw new AllHelpersFailed(errors);
  }

  getTip(signal?: AbortSignal): Promise<Tip> {
    return this.round('tip poll', (base) => this.getTipFn(base, { attempts: 1, timeoutMs: this.tipTimeoutMs, signal }));
  }

  /** Poll EVERY helper's /tip in parallel and return the best (max-height)
   *  claim, which helper made it, and all successful views. This is the
   *  staleness defense: getTip() returns the FIRST success primary-first, so a
   *  wedged-but-answering primary captures the miner forever (live-observed
   *  2026-07-25). Tie-break prefers the current primary, else the first max
   *  claimant in rotation order (stability — no flapping on propagation races).
   *  Rotation: a hard-failed primary keeps the existing +1 failure streak; a
   *  primary that ANSWERS but trails the best by ≥1 block for
   *  STALE_ROTATE_ROUNDS consecutive polls hands the primary role directly to
   *  the best claimant (the next helper in line may be just as stale). Zero
   *  successes throw AllHelpersFailed, like a fully-failed round. */
  async getBestTip(signal?: AbortSignal): Promise<BestTip> {
    const results = await Promise.allSettled(
      this.helpers.map((base) => this.getTipFn(base, { attempts: 1, timeoutMs: this.tipTimeoutMs, signal })),
    );
    const views: HelperTipView[] = [];
    const errors: Array<{ base: string; error: Error }> = [];
    for (let i = 0; i < this.helpers.length; i++) {
      const base = this.helpers[i]!;
      const r = results[i]!;
      if (r.status === 'fulfilled') {
        views.push({ base, tip: r.value });
      } else {
        const err = r.reason as Error;
        if (err?.name === 'AbortError') throw err; // caller teardown — stop now
        errors.push({ base, error: err });
        this.onDebug(`tip poll via ${base} failed: ${err?.message}`);
      }
    }
    if (views.length === 0) {
      // Same rule as the partial-failure path below: a round that learned
      // nothing must not CLEAR the staleness streak, or a primary alternating
      // stale answers with all-helpers-down rounds resets one counter with each
      // event and never reaches either threshold.
      this.recordPrimary(true);
      throw new AllHelpersFailed(errors);
    }
    const bestHeight = Math.max(...views.map((v) => v.tip.height));
    const atBest = new Map(views.filter((v) => v.tip.height === bestHeight).map((v) => [v.base, v]));
    let chosen = atBest.get(this.primary());
    if (!chosen) {
      for (const idx of this.order()) {
        const v = atBest.get(this.helpers[idx]!);
        if (v) { chosen = v; break; }
      }
    }
    const primaryView = views.find((v) => v.base === this.primary());
    if (!primaryView) {
      // Primary's request failed → the existing connectivity streak (+1 rotation
      // at threshold). Staleness is not MEASURABLE this round, but the streak is
      // deliberately NOT cleared: a primary alternating failure/stale-answer
      // would otherwise reset one counter with each event and never rotate on
      // either, keeping a permanently unhealthy helper in the role forever.
      this.recordPrimary(true);
    } else {
      this.recordPrimary(false); // any primary answer resets the connectivity streak
      if (primaryView.tip.height < bestHeight) {
        this.primaryStale++;
        if (this.primaryStale >= STALE_ROTATE_ROUNDS) {
          this.primaryIdx = this.helpers.indexOf(chosen!.base);
          this.primaryStale = 0;
          this.onInfo(`[minerd] switching primary helper to ${this.primary()} (previous primary served a stale tip)`);
        }
      } else {
        this.primaryStale = 0;
      }
    }
    return { best: chosen!.tip, sourceBase: chosen!.base, views };
  }

  /** Multi-round retry for block fetches; may rotate the primary mid-call (intentional — rotation is not call-scoped).
   *  `preferBase` (the helper that claimed the tip we are chasing) is tried first,
   *  so a tip from one helper is never chased through a different, staler one. */
  async getBlocks(from: number, max = 200, signal?: AbortSignal, preferBase?: string): Promise<Block[]> {
    let lastErr: Error | undefined;
    for (let r = 0; r < this.blocksRounds; r++) {
      try {
        return await this.round('blocks', (base) => this.getBlocksFn(base, from, max, signal, { attempts: 1, timeoutMs: this.blocksTimeoutMs }), preferBase);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        lastErr = e as Error;
        if (r < this.blocksRounds - 1) await this.sleep(blocksBackoff(r), signal);
      }
    }
    throw lastErr ?? new AllHelpersFailed([]);
  }

  async blockAt(height: number, signal?: AbortSignal): Promise<Block | undefined> {
    const blocks = await this.round('block', (base) => this.getBlocksFn(base, height, 1, signal, { attempts: 1, timeoutMs: this.blocksTimeoutMs }));
    return blocks[0];
  }
}

/** Compute once-per-episode stale-helper warnings. A helper trailing the best
 *  claim by ≥ STALE_WARN_BLOCKS enters `staleBases` and yields ONE warning
 *  line; it leaves silently once back within 1 block (so a relapse warns
 *  again). Mutates `staleBases` — the caller owns the episode state. Helpers
 *  that hard-failed are not in `views` and are deliberately not warned about
 *  here (the failure/rotation paths already surface them). */
export function staleHelperWarnings(
  views: HelperTipView[],
  best: Tip,
  sourceBase: string,
  staleBases: Set<string>,
): string[] {
  const warnings: string[] = [];
  for (const v of views) {
    const behind = best.height - v.tip.height;
    if (behind >= STALE_WARN_BLOCKS) {
      if (!staleBases.has(v.base)) {
        staleBases.add(v.base);
        warnings.push(
          `[minerd] helper ${v.base} is ${behind} blocks behind the network (serving height ${v.tip.height}) — following ${sourceBase}`,
        );
      }
    } else if (behind <= 1) {
      staleBases.delete(v.base);
    }
  }
  return warnings;
}
