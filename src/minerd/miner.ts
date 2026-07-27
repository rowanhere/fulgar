// src/minerd/miner.ts
import os from 'node:os';
import { existsSync } from 'node:fs';
import { Blockchain, type ReorgDelta } from '../chain/blockchain.js';
import { hashHeader, type Block, type BlockHeader } from '../chain/block.js';
import { checkPoW } from '../chain/consensus.js';
import { bytesToHex, compareBytes } from '../util/binary.js';
import { applyBlockTxs, cloneState, stateRoot } from '../chain/state.js';
import type { MinerConfig } from './config.js';
import { postBlock } from './http.js';
import { HelperPool, staleHelperWarnings } from './helperPool.js';
import { VerifierPool, verifyBlocksParallel } from './verify.js';
import { ChainSync, STATE_RETAIN } from './sync.js';
import { buildTemplate, type Template } from './template.js';
import { GrindPool } from './grindPool.js';
import { NATIVE_BIN, NativeGrindPool } from './nativeGrindPool.js';
import { nativePowIsCurrent } from './nativeParity.js';
import { submitSoloBlock } from './submitSolo.js';
import { ConsoleReporter, type MinerReporter, type ReporterStatus } from './reporter.js';
import { restoreSnapshot, saveSnapshot, deleteSnapshot } from './persistence.js';
import { SmartController, applyPriorityPolicy, smartStartDuty } from './smartController.js';
import { createDemandSignal } from './demand.js';
import { perfHints, nodeMajorOf } from './perfAdvice.js';
import { cpuBudget } from './cpuBudget.js';

/**
 * Post-restore integrity gate, identical in spirit to `mine:dryrun`: build a
 * template off the live tip and confirm it agrees with the chain exactly
 * (prevHashOK && stateRootOK). The stateRoot side is recomputed independently
 * from the live tipState (not from `template.postState`, which would be
 * circular). Returns true only when a snapshot-seeded chain is provably mining on
 * the correct state. A `false` here forces a discard + full replay.
 */
export function chainIntegrityOK(chain: Blockchain, minerPubkey: Uint8Array): boolean {
  try {
    const t = buildTemplate(chain, minerPubkey);
    const okPrev = compareBytes(t.header.prevHash, chain.tip.hash) === 0;
    const expected = cloneState(chain.tipState);
    applyBlockTxs(expected, t.header.height, minerPubkey, [], chain.nextBlockScriptContext());
    const okStateRoot = compareBytes(t.header.stateRoot, stateRoot(expected)) === 0;
    return okPrev && okStateRoot;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// snapshot network confirmation
// ---------------------------------------------------------------------------
// A restored ~/.fulgurminer snapshot is attacker-writable local state. Before we
// trust it and mine on it, pin it to the network: ask the helper for its
// canonical block at the restored anchor height and require the header hashes
// match. Because `seedHistoricalBlock` links every restored block to its parent
// by hash, a matching anchor pins the WHOLE seeded prefix to canonical, so a
// forged anchor (or any forged ancestor) is rejected here. Then PoW-verify the
// anchor header as a belt-and-suspenders check. Mismatch, an unreachable helper,
// or a bad PoW all return ok:false → the caller discards the snapshot and
// full-syncs from genesis.
//
// Layer-1 helper confirmation is the security boundary. A full-prefix PoW
// re-verify is deliberately NOT done: it would cost ~minutes per launch (the
// finalized prefix is the whole chain, and grows) and negate the warm-start the
// snapshot exists to provide — for no added security once the anchor is
// helper-pinned and the prefix is hash-linked to it. A self-consistent cheap
// forge (floor difficulty + matching timestamps) passes local PoW+retarget
// anyway; only the network reference distinguishes it from the real chain.
export interface SnapshotConfirmDeps {
  /** Height of the restored finalized anchor (RestoreOutcome.anchorHeight). */
  anchorHeight: number;
  /** Hash of the restored chain tip (the anchor) — `chain.tip.hash`. */
  anchorHash: Uint8Array;
  /** Fetch the helper's canonical block at a height (undefined if none). */
  fetchBlockAt: (height: number) => Promise<Block | undefined>;
  /** PoW verifier (consensus `checkPoW`); injected for testability. */
  checkPoW: (header: BlockHeader) => Promise<boolean>;
}

// Failure is CLASSIFIED so the caller reacts correctly:
//   'forged'        — the helper PROVES this anchor isn't canonical (a different
//                     block at the same height, or a bad PoW) → delete the file.
//   'indeterminate' — we simply couldn't confirm (helper unreachable / lagging /
//                     timed out / PoW check errored) → KEEP the file for a later
//                     healthy-helper launch, but still don't trust it this session.
export type SnapshotConfirmResult =
  | { ok: true }
  | { ok: false; kind: 'forged' | 'indeterminate'; reason: string };

/** Confirm a restored snapshot sits on the network canonical chain. Never throws. */
export async function confirmRestoredSnapshot(deps: SnapshotConfirmDeps): Promise<SnapshotConfirmResult> {
  let helperBlock: Block | undefined;
  try {
    helperBlock = await deps.fetchBlockAt(deps.anchorHeight);
  } catch (e) {
    // Helper unreachable / timed out — can't confirm, but not proof of forgery.
    return { ok: false, kind: 'indeterminate', reason: `helper-unreachable: ${(e as Error).message}` };
  }
  if (!helperBlock) return { ok: false, kind: 'indeterminate', reason: 'helper-no-block-at-anchor' };

  // A helper that's BEHIND our finalized anchor (or clamps the page) can hand back
  // a block at the wrong height. That's "can't confirm", NOT proof of a forgery —
  // so it's indeterminate and the local file is preserved.
  if (helperBlock.header.height !== deps.anchorHeight) {
    return {
      ok: false,
      kind: 'indeterminate',
      reason: `helper-height-mismatch (got ${helperBlock.header.height}, want ${deps.anchorHeight})`,
    };
  }

  // Same height, different hash → the helper's canonical block here is NOT our
  // anchor → the restored anchor (and the whole prefix it hash-links) is forged.
  if (compareBytes(hashHeader(helperBlock.header), deps.anchorHash) !== 0) {
    return { ok: false, kind: 'forged', reason: 'anchor-not-canonical' };
  }

  // Belt-and-suspenders: the pinned anchor must itself carry valid PoW. A thrown
  // check is indeterminate (the verifier errored); a clean `false` is definitive.
  let powOk: boolean;
  try {
    powOk = await deps.checkPoW(helperBlock.header);
  } catch (e) {
    return { ok: false, kind: 'indeterminate', reason: `anchor-pow-check-threw: ${(e as Error).message}` };
  }
  if (!powOk) return { ok: false, kind: 'forged', reason: 'anchor-pow-invalid' };

  return { ok: true };
}

/** Debug logger gated on MINER_DEBUG — used for non-fatal persistence anomalies. */
function debugLog(reporter: MinerReporter): ((msg: string) => void) | undefined {
  if (!process.env.MINER_DEBUG) return undefined;
  return (msg: string): void => reporter.event('info', `[minerd] ${msg}`);
}

// How often to persist a fresh snapshot: whichever of these comes first.
export const SAVE_EVERY_BLOCKS = 50;
export const SAVE_EVERY_MS = 60_000;

// Bound the snapshot-confirmation fetch so a half-open helper connection can't
// wedge startup — on timeout the confirm comes back 'indeterminate' (keep the
// file, full-sync this session) rather than hanging unresponsive.
export const SNAPSHOT_CONFIRM_TIMEOUT_MS = 15_000;

/** The subset of the grind-pool surface that runMiner depends on. Both the
 *  default worker_threads GrindPool and the native NativeGrindPool implement it. */
interface GrindPoolLike {
  start(
    headerBytes: Uint8Array,
    targetHex: string,
    onSolved: (nonce: number, hash: Uint8Array) => void,
    onHashrate: (hps: number) => void,
    onExhausted?: () => void,
    onError?: (err: Error) => void,
  ): void;
  stop(): void;
  setThrottle(throttle: number): void;
  terminate(): void;
}

// ---------------------------------------------------------------------------
// Coordinator — testable coordination logic extracted from runMiner
// ---------------------------------------------------------------------------

export interface CoordinatorDeps {
  buildTemplate: () => Template;
  poolStart: (
    headerBytes: Uint8Array,
    targetHex: string,
    onSolved: (nonce: number) => void,
    onHashrate: (hps: number) => void,
    onExhausted: () => void,
  ) => void;
  poolStop: () => void;
  submit: (template: Template, nonce: number) => Promise<{ label: string }>;
  /** Catch the chain up; resolves TRUE iff the local chain actually changed.
   *  The observed remote tip (when known) lets the sync fetch below a
   *  heavier-but-SHORTER fork whose canonical tip sits below our height;
   *  `sourceBase` is the helper that claimed it (blocks fetched claimant-first). */
  syncCatchUp: (remoteTip?: { height: number; tipHash: string; sourceBase?: string }) => Promise<boolean>;
  onLog: (msg: string) => void;
  retryRebuildMs?: number;
}

/** Pure coordination logic: busy-flag, rebuild-on-solve, rebuild-on-exhaust, tip-advance. */
export class MinerCoordinator {
  private current: Template | null = null;
  private busy = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: CoordinatorDeps) {}

  private get retryMs(): number {
    return this.deps.retryRebuildMs ?? 5000;
  }

  rebuild(): void {
    this.current = this.deps.buildTemplate();
    this.deps.poolStart(
      this.current.headerBytes,
      this.current.targetHex,
      (nonce) => void this.onSolved(nonce),
      (hps) => this.deps.onLog(`hps:${hps}`),
      () => void this.onExhausted(),
    );
  }

  /** rebuild() that can never crash the miner: a throw in buildTemplate/poolStart is
   *  caught + logged instead of becoming an unhandled rejection (onSolved/onExhausted
   *  are fire-and-forget) or a process crash. The next tip poll re-attempts. Used by
   *  the in-loop callers; runMiner's initial rebuild() stays throwing (startup should
   *  surface a hard failure). */
  private safeRebuild(): void {
    if (this.disposed) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      this.rebuild();
    } catch (e) {
      this.deps.onLog(`error:rebuild failed — ${(e as Error).message}`);
      this.scheduleRebuildRetry();
    }
  }

  // Retry a failed rebuild without waiting for the next network block — but NEVER
  // mid-flight. If a solve / tip-advance owns the chain (busy) when the timer fires,
  // reschedule instead of starting a grind over a chain another op is mutating (that
  // race could stack pool starts or grind a stale template, emitting a solve from the
  // wrong tip). The in-flight op runs its own safeRebuild on completion, which clears
  // this timer; the reschedule only matters when that op took the no-rebuild failure
  // path (a catch-up failure) — exactly the idle case this retry exists to cover.
  // unref so a pending retry never holds the process open on its own.
  private scheduleRebuildRetry(): void {
    if (this.disposed || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed) return;
      if (this.busy) { this.scheduleRebuildRetry(); return; }
      this.safeRebuild();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async onSolved(nonce: number): Promise<void> {
    if (this.busy || !this.current) return;
    this.busy = true;
    // never let the busy flag stick. EVERYTHING after busy=true (incl. poolStop —
    // a synchronous throw there would otherwise stick busy + become an unhandled
    // rejection) runs under try/catch/finally. CATCH + log a failure (don't re-throw —
    // onSolved is fire-and-forget), then ALWAYS reset busy and rebuild so the next
    // solve/tip-advance is processed. Without this the miner wedges forever.
    try {
      this.deps.poolStop();
      const out = await this.deps.submit(this.current, nonce);
      this.deps.onLog(`solved:${out.label}`);
    } catch (e) {
      this.deps.onLog(`error:solo submit failed — ${(e as Error).message}`);
    } finally {
      this.busy = false;
      this.safeRebuild();
    }
  }

  private async onExhausted(): Promise<void> {
    if (this.busy) return;
    // No solution found across the full nonce range. Rebuild with a fresh
    // timestamp (timestamp changes → new template → new nonce search space).
    this.safeRebuild();
  }

  /** Called by the tip poller when the network has advanced past us. The observed
   *  remote tip is threaded into the sync so a heavier-but-shorter fork is reachable. */
  async tipAdvanced(remoteTip?: { height: number; tipHash: string; sourceBase?: string }): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // busy must ALWAYS reset (try/catch/finally) or the miner wedges. On a clean
    // catch-up we stop the stale grind and rebuild on the new tip.
    try {
      const advanced = await this.deps.syncCatchUp(remoteTip);
      // Only a chain that actually CHANGED invalidates the running grind. An
      // unverifiable/empty claim (a wedged or lying helper) must NOT restart the
      // grind: the poller re-fires every tick while any helper disagrees with
      // us, and stopping verified work on a no-op is self-inflicted downtime.
      if (advanced) {
        this.deps.poolStop();
        this.safeRebuild();
      }
    } catch (e) {
      // Catch-up FAILED — but the tip HAS moved (that's why the poller called us), so
      // the current template is known-stale. STOP grinding it rather than leaving it
      // running: a stale-template solve broadcast to a LAGGING helper could come back
      // 'added' and get adopted locally → a private fork the public chain won't
      // replace. The next tip poll retries the catch-up and rebuilds once it succeeds.
      this.deps.poolStop();
      this.deps.onLog(`error:catch-up failed — ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}

// ---------------------------------------------------------------------------
// runMiner — wires real deps into MinerCoordinator and starts the tip poller
// ---------------------------------------------------------------------------

export interface WarmChain {
  /** The synced, integrity-proven in-memory chain to reuse across restarts. */
  chain: Blockchain;
  /** True once a prior session reached the mining loop. Only a `synced: true`
   *  handle is reused; otherwise runMiner cold-starts a fresh chain. */
  synced: boolean;
}

export async function runMiner(
  cfg: MinerConfig,
  reporter: MinerReporter = new ConsoleReporter(),
  signal?: AbortSignal,
  warm?: WarmChain,
): Promise<WarmChain> {
  // Reuse the prior session's chain ONLY if it was fully synced (item G). A
  // not-synced handle (e.g. aborted mid-bootstrap) is discarded and we cold-start
  // a fresh chain, so a half-built chain can never be mined on.
  const chain = warm?.synced ? warm.chain : new Blockchain();
  const isWarm = !!warm?.synced;
  const debug = debugLog(reporter);

  // Solo reads (tip + blocks + snapshot-confirm) fail over across all configured
  // helpers with a rotating primary, so a single helper 525/timeout is silent
  // (debug only) instead of an error wall; only a whole-round failure warns. Submit
  // stays broadcast-to-all (different semantics). Solo path only.
  const helperPool = new HelperPool(cfg.helpers, {
    onDebug: (m) => debug?.(m),
    onInfo: (m) => reporter.event('info', m),
  });

  // the chain is only network-TRUSTED (returnable as a reusable warm handle)
  // once it was either confirmed against the helper this session (warm reuse, or a
  // confirmed snapshot restore) OR fully re-synced from the helper. A restored-but-
  // unconfirmed chain (e.g. aborted before confirmation) must NEVER be returned as
  // synced:true. The cold path sets this true only after it completes confirm +
  // bootstrap + the integrity gate.
  let chainConfirmed = isWarm;

  // Snapshot-invalidation listener — wired in BOTH cold and warm sessions: a warm
  // in-memory chain can still see a deep reorg while mining, which must discard
  // the on-disk snapshot + reset. Re-subscribed fresh each session; the prior
  // session's unsubInvalidated() ran in its done() teardown, so no listener leak.
  let snapshotInvalidated = false;
  const unsubInvalidated = chain.onSnapshotInvalidated(() => {
    snapshotInvalidated = true;
    deleteSnapshot();
    try { chain.reset(); } catch { /* genesis-only re-init; ignore */ }
    // reset() clears the chain WITHOUT firing onTipChanged, so the tip-change prune
    // can't see the displaced blocks. Orphan ALL recorded solo rewards here; the full
    // replay re-connects (onTipChanged) any block still canonical, which un-orphans
    // the survivors via reorg() — genuine orphans stay excluded. (Correct, not just
    // conservative.)
    reporter.soloReorgReset?.();
    debug?.('snapshot invalidated (deep reorg) — cleared; will full-replay');
  });
  const unsubTipChanged = chain.onTipChanged((d: ReorgDelta) => {
    if (d.connected.length === 0 && d.disconnected.length === 0) return;
    reporter.reorg?.(
      d.connected.map((cb) => bytesToHex(cb.hash)),
      d.disconnected.map((cb) => bytesToHex(cb.hash)),
    );
  });

  // The persistent verifier pool is a bootstrap-only (cold) resource. Declared at
  // function scope (null on the warm path) so the ChainSync verify closure can
  // fall back to the one-shot verify when no pool exists.
  let verifierPool: VerifierPool | null = null;
  let verifierTerminated = false;
  const terminateVerifier = (): void => {
    if (verifierTerminated) return;
    verifierTerminated = true;
    if (verifierPool) void verifierPool.terminate();
  };

  // ChainSync exists in BOTH paths — the tip poller's catchUp() needs it. The
  // verify fn uses the persistent pool during cold bootstrap and the one-shot
  // verifyBlocksParallel otherwise (after bootstrap, or the whole warm path).
  const sync = new ChainSync({
    chain,
    cores: cfg.workers,
    getBlocks: (from, max, preferBase) => helperPool.getBlocks(from, max, undefined, preferBase),
    verifyBlocksParallel: (blocks, cores) =>
      verifierPool && !verifierTerminated ? verifierPool.verify(blocks) : verifyBlocksParallel(blocks, cores),
    stateRetain: STATE_RETAIN,
  });

  // ── Cold start: restore snapshot → bootstrap → integrity gate ──
  // Skipped on a warm reuse: the in-memory chain was already synced and
  // integrity-proven last session, so re-running these would re-fetch ~60 pages
  // and re-run the dryrun-equivalent gate for nothing. A bootstrap abort returns
  // a not-synced handle so the next iteration cold-starts a fresh chain.
  if (!isWarm) {
    // Restore the local chain snapshot BEFORE bootstrap (§1 persistence). On
    // success the chain is seeded to the finalized anchor and bootstrap() only
    // fetches the delta (warm restart). On ANY anomaly restoreSnapshot resets to
    // genesis and returns restored:false, so we fall back to a full sync.
    const restore = restoreSnapshot(chain, debug);
    let warmStart = restore.restored;
    verifierPool = new VerifierPool(cfg.workers);
    signal?.addEventListener('abort', terminateVerifier, { once: true });

    // a restored snapshot is attacker-writable local state — confirm it
    // against the network before trusting it. `restore.restored` narrows the union
    // so `restore.anchorHeight` is available.
    if (restore.restored) {
      // Already aborting → we can't (and shouldn't) network-confirm. NEVER return an
      // unconfirmed restored chain as a reusable warm handle: tear down and report
      // not-synced so the next session cold-starts and confirms from scratch.
      if (signal?.aborted) {
        terminateVerifier();
        unsubInvalidated();
        unsubTipChanged();
        await new Promise<void>((resolve) => { queueMicrotask(() => { reporter.close?.(); resolve(); }); });
        return { chain, synced: false };
      }
      // Pin the restored anchor to the helper's canonical chain (+ a single anchor
      // PoW check), via a bounded, cancellable fetch so a half-open helper can't
      // wedge startup. 'forged' (a different canonical block here, or bad PoW) →
      // delete the file; 'indeterminate' (helper down/lagging/timeout) → KEEP it for
      // a later healthy-helper launch. Either way we don't trust it this session.
      const confirm = await confirmRestoredSnapshot({
        anchorHeight: restore.anchorHeight,
        anchorHash: chain.tip.hash,
        fetchBlockAt: async (h) => {
          // Per-call AbortController (timeout OR caller teardown), released in
          // finally — avoids AbortSignal.any holding a composite on the long-lived
          // run signal (the timedFetch invariant).
          const ac = new AbortController();
          const t = setTimeout(
            () => ac.abort(new DOMException(`snapshot confirm timed out after ${SNAPSHOT_CONFIRM_TIMEOUT_MS}ms`, 'TimeoutError')),
            SNAPSHOT_CONFIRM_TIMEOUT_MS,
          );
          const onAbort = (): void => ac.abort(signal!.reason ?? new DOMException('aborted', 'AbortError'));
          if (signal) {
            if (signal.aborted) ac.abort(signal.reason);
            else signal.addEventListener('abort', onAbort, { once: true });
          }
          try {
            return await helperPool.blockAt(h, ac.signal);
          } finally {
            clearTimeout(t);
            if (signal) signal.removeEventListener('abort', onAbort);
          }
        },
        checkPoW,
      });
      if (!confirm.ok) {
        debug?.(
          `restored snapshot ${confirm.kind} (${confirm.reason}) — full replay` +
            (confirm.kind === 'forged' ? ' (deleting file)' : ' (keeping file for retry)'),
        );
        if (confirm.kind === 'forged') deleteSnapshot();
        try { chain.reset(); } catch { /* genesis-only re-init; ignore */ }
        warmStart = false;
        reporter.event(
          'info',
          confirm.kind === 'forged'
            ? '[minerd] saved chain did not match the network — re-syncing from genesis…'
            : '[minerd] could not confirm saved chain against the network — re-syncing this session…',
        );
      }
    }

    if (warmStart) {
      reporter.event(
        'info',
        `[minerd] Resuming saved chain (height ${chain.height.toLocaleString('en-US')}) — catching up…`,
      );
    }

    // Learn the target tip height up front so sync progress has a denominator.
    // Poll EVERY helper (not primary-first): the cold sync must chase the BEST
    // claim through the helper that made it, or a stale primary answering an
    // empty/short /blocks ends the bootstrap early and we declare a chain the
    // network left behind "synced". A failed round yields an indeterminate
    // target and no claimant (primary-first, as before).
    let targetHeight = 0;
    let syncSource: string | undefined;
    try {
      const best = await helperPool.getBestTip();
      targetHeight = best.best.height;
      syncSource = best.sourceBase;
    } catch (e) {
      targetHeight = 0;
      reporter.event(
        'warn',
        `[minerd] tip fetch failed (${(e as Error).message}); proceeding with indeterminate sync`,
      );
    }
    reporter.event(
      'info',
      targetHeight > 0
        ? `[minerd] syncing chain from ${syncSource ?? helperPool.primary()} (target height ${targetHeight.toLocaleString('en-US')})…`
        : `[minerd] syncing chain from ${helperPool.primary()}…`,
    );
    try {
      await sync.bootstrap((h) => reporter.syncProgress(h, targetHeight), syncSource);
    } catch (e) {
      // An abort during bootstrap disposes the verifier pool, rejecting the
      // in-flight verify() and unwinding here. Intentional shutdown — tear down
      // and return a not-synced handle so the loop cold-starts next time. Any
      // non-abort failure is a real error and must still propagate.
      if (signal?.aborted) {
          terminateVerifier();
          unsubInvalidated();
          unsubTipChanged();
          await new Promise<void>((resolve) => { queueMicrotask(() => { reporter.close?.(); resolve(); }); });
          return { chain, synced: false };
      }
      // Release the persistent verifier pool + listener before propagating, or its
      // worker threads (~65 MB Argon2 WASM each) leak across a caller retry.
      terminateVerifier();
      unsubInvalidated();
      unsubTipChanged();
      throw e;
    }

    // Bootstrap ends on the first empty/short page, which a helper can serve
    // while the network is demonstrably higher (it failed over mid-sync, or the
    // claimant itself fell behind). Say so rather than presenting a chain the
    // network has left behind as fully synced — the tip poller closes the gap on
    // its next tick, and this line is what makes that visible if it doesn't.
    if (targetHeight > 0 && chain.height < targetHeight) {
      reporter.event(
        'warn',
        `[minerd] synced to ${chain.height.toLocaleString('en-US')} but the network reported ${targetHeight.toLocaleString('en-US')} — catching up`,
      );
    }

    // Free the bootstrap workers before mining. The occasional catchUp() (tip
    // poller) is one small page, so the one-shot pool there is fine.
    terminateVerifier();

    // ── Post-restore safety gate (§1) ──
    // Prove a snapshot-seeded chain mines on the correct state before any block is
    // built. Two triggers force a clean full replay: a deep reorg during catch-up,
    // or the dryrun-equivalent integrity check failing.
    if (!signal?.aborted && (warmStart || snapshotInvalidated)) {
      const integrityOK = !snapshotInvalidated && chainIntegrityOK(chain, cfg.minerPubkey);
      if (!integrityOK) {
        debug?.(
          snapshotInvalidated
            ? 'snapshot invalidated during catch-up — full replay'
            : 'post-restore integrity check failed — discarding snapshot, full replay',
        );
        deleteSnapshot();
        try { chain.reset(); } catch { /* ignore */ }
        snapshotInvalidated = false;
        reporter.event('info', `[minerd] re-syncing BrowserCoin chain from genesis…`);
        // Re-derive the claimant: the startup pick can be minutes old by now and
        // may itself have fallen behind, which would pin the whole replay to a
        // stale chain. A failed re-poll keeps the startup values.
        try {
          const fresh = await helperPool.getBestTip(signal);
          targetHeight = fresh.best.height;
          syncSource = fresh.sourceBase;
        } catch { /* keep the startup target/claimant */ }
        try {
          await sync.bootstrap((h) => reporter.syncProgress(h, targetHeight), syncSource);
        } catch (e) {
          if (signal?.aborted) {
            terminateVerifier();
            unsubInvalidated();
            unsubTipChanged();
            await new Promise<void>((resolve) => { queueMicrotask(() => { reporter.close?.(); resolve(); }); });
            return { chain, synced: false };
          }
          terminateVerifier();
          unsubInvalidated();
          unsubTipChanged();
          throw e;
        }
      }
    }
  }

  // On a warm reuse the in-memory chain may be behind the helper tip — after a
  // menu pause, or especially a solo→pool→solo detour where it froze while
  // pooling. Catch the delta up to the tip BEFORE mining so we never grind on a
  // stale template (which would build rejected blocks until the tip poller caught
  // up seconds later). bootstrap() resumes from the current height and verifies
  // new blocks via the one-shot path; with zero drift it does a single empty
  // getBlocks and spawns no workers, so a no-op restart stays near-instant. If a
  // deep reorg fires its invalidation listener mid-catch-up, the chain resets and
  // bootstrap full-replays from genesis. An abort mid-catch-up returns a
  // not-synced handle so the next iteration cold-starts cleanly.
  if (isWarm) {
    try {
      await sync.bootstrap((h) => reporter.syncProgress(h, 0));
    } catch (e) {
      if (signal?.aborted) {
        unsubInvalidated();
        unsubTipChanged();
        await new Promise<void>((resolve) => { queueMicrotask(() => { reporter.close?.(); resolve(); }); });
        return { chain, synced: false };
      }
      throw e;
    }
  }

  // Structural guard: if the signal aborted ANYWHERE during cold-start or warm
  // catch-up — including windows where the bootstrap fetches aren't signal-wired, so
  // the abort didn't unwind via a bootstrap-catch — never claim a synced handle.
  // Tear down and report not-synced. This makes the line below reachable ONLY on a
  // non-aborted path that completed confirm + bootstrap + integrity (cold) or
  // catch-up (warm), so a restored-but-unconfirmed chain can never be returned
  // synced:true (do not rely on fetch-cancellation timing as the sole defense).
  if (signal?.aborted) {
    terminateVerifier();
    unsubInvalidated();
    unsubTipChanged();
    await new Promise<void>((resolve) => { queueMicrotask(() => { reporter.close?.(); resolve(); }); });
    return { chain, synced: false };
  }
  // Reaching here means the chain is network-trusted: a confirmed snapshot + delta
  // bootstrap, a full genesis re-sync, or a warm catch-up. Safe to reuse as a warm
  // handle and to persist.
  chainConfirmed = true;

  // Default = worker_threads + WASM GrindPool (byte-unchanged behavior).
  // Set MINER_NATIVE to use the native Rust grind processes instead (same
  // interface, parity-equivalent solutions, one OS process per nonce range).
  // Guard as the pool path does: a native binary built before the Sandglass v3
  // fork (or against the earlier 34,800 fork constant) still grinds Argon2id in the
  // live range and would solo-mine 100% invalid blocks. Only use native if it
  // exists AND grinds the current PoW at the fork boundary; otherwise fall back to
  // wasm and say why. (index.ts's headless solo path never calls resolveEngine, so
  // this is the only algo gate here.) Resolve this BEFORE lowering priority below:
  // nativePowIsCurrent() spawns a child that would inherit the lowered priority and
  // could then time out on a loaded box, falsely demoting a good native binary.
  const nativeSelected = !!process.env.MINER_NATIVE;
  const useNative = nativeSelected && existsSync(NATIVE_BIN) && nativePowIsCurrent();
  let backendNote: string | undefined;
  if (nativeSelected && !useNative) {
    backendNote = existsSync(NATIVE_BIN)
      ? 'native engine outdated — rebuild: cd native/brc-pow && cargo build --release; using wasm'
      : 'native engine not built — install Rust (https://rustup.rs) and build it; using wasm';
    reporter.event('warn', `[minerd] ${backendNote}`);
  }

  // Priority policy: Considerate-only (applyPriorityPolicy — one policy for all
  // three paths). Solo used to nice UNCONDITIONALLY as a "safeguard", quietly
  // costing Max/Manual miners scheduler races the pool paths never paid.
  const prio = applyPriorityPolicy(cfg.smart);
  if (prio.note) reporter.event('info', `[minerd] ${prio.note}`);
  // Smart modes set their OWN starting duty cycle from the mode (Max=100%,
  // Considerate=50%); only Manual uses cfg.throttle. Seeding from cfg.throttle made
  // Smart Max start at a lowered manual throttle and ramp up slowly instead of
  // going straight to full — see smartStartDuty().
  const startDuty = smartStartDuty(cfg.smart, cfg.throttle);
  const pool: GrindPoolLike = useNative
    ? new NativeGrindPool(cfg.workers, startDuty)
    : new GrindPool(cfg.workers, startDuty);
  const smartController = cfg.smart !== 'off'
    ? new SmartController(
      pool,
      // Considerate leaves the THERMAL ceiling open and eases in via the demand
      // allowance instead (see SmartDemandOptions.demandStart) — capping the ceiling at
      // the eased start strands the demand loop below its own target.
      { start: cfg.smart === 'considerate' ? 1 : startDuty },
      undefined,
      cfg.smart === 'considerate'
        ? {
          demand: createDemandSignal({ onWarn: (m) => reporter.event('warn', m) }),
          workers: cfg.workers,
          demandStart: startDuty,
        }
        : undefined,
    )
    : null;

  const status: ReporterStatus = {
    mode: 'solo',
    target: 'solo',
    backend: useNative ? 'native' : 'wasm',
    backendNote,
    workers: cfg.workers,
    // The effective starting duty cycle: mode-derived in Smart, the manual value in
    // 'off'. (Not cfg.throttle — that would print the leftover manual throttle while
    // Smart Max actually starts at 100%.)
    throttle: startDuty,
    address: cfg.minerPubkeyHex,
  };
  // Startup output. The pre-reporter code printed the synced height + the
  // "mining to … (workers, throttle)" detail on a single line; the reporter
  // abstraction emits them as separate clean lines (synced, then status). The
  // spec explicitly allows "equivalent clean logging" over byte-parity, so this
  // multi-line shape is intentional — same information, split for readability.
  reporter.chain(chain.height, chain.tipDifficulty.toString(16));
  reporter.synced(chain.height);
  reporter.status(status);

  // One-time hashrate advice. Reads config only - it never writes a setting.
  for (const hint of perfHints({
    smart: cfg.smart as 'off' | 'max' | 'considerate',
    throttle: startDuty,
    workers: cfg.workers,
    usableCores: cpuBudget().usableCores,
    nodeMajor: nodeMajorOf(process.versions.node),
  })) {
    reporter.event('info', hint);
  }

  // Best-known network height (from the helper poll) + per-helper stale-episode
  // state for once-per-episode warnings. Declared before the coordinator so the
  // hashrate tick's reporter.chain(...) can render net= too.
  let netTip = 0;
  const staleBases = new Set<string>();

  // ── Snapshot persistence: periodic debounced save (§1) ──
  // Persist a fresh snapshot whenever the chain has advanced ≥SAVE_EVERY_BLOCKS
  // or ≥SAVE_EVERY_MS since the last write, whichever comes first. saveSnapshot
  // is a no-op (returns false) until the chain is deep enough to have a finalized
  // anchor, and never throws. lastSaveHeight tracks the chain height at the last
  // *attempt* so a too-shallow chain doesn't retry on every single tick.
  let lastSaveHeight = -SAVE_EVERY_BLOCKS;
  let lastSaveAt = 0;
  const maybeSave = (): void => {
    const now = Date.now();
    if (chain.height - lastSaveHeight < SAVE_EVERY_BLOCKS && now - lastSaveAt < SAVE_EVERY_MS) {
      return;
    }
    lastSaveHeight = chain.height;
    lastSaveAt = now;
    if (saveSnapshot(chain)) debug?.(`snapshot saved at height ${chain.height}`);
  };
  // Write one immediately after the first successful sync so the very next launch
  // is a warm start (subject to having a finalized anchor — short chains skip).
  maybeSave();

  const coord = new MinerCoordinator({
    buildTemplate: () => buildTemplate(chain, cfg.minerPubkey),
    poolStart: (headerBytes, targetHex, onSolved, onHashrate, onExhausted) =>
      pool.start(
        headerBytes,
        targetHex,
        (nonce) => onSolved(nonce),
        (hps) => { smartController?.onHashrate(hps); onHashrate(hps); },
        onExhausted,
      ),
    poolStop: () => pool.stop(),
    submit: async (template, nonce) => {
      // broadcast to all helpers FIRST and adopt the block locally only once
      // ≥1 helper confirms the network has it (no private fork). `accepted` (which
      // drives solo-earnings accounting in the reporter) is true only when the block
      // is both on the network AND adopted into our chain.
      const out = await submitSoloBlock(
        { chain, helpers: cfg.helpers, postBlock },
        template,
        nonce,
      );
      const hash = bytesToHex(hashHeader(out.block.header));
      const accepted = out.adopted;
      // An adopted solve is the ONE chain advance that does not come through a
      // ChainSync page, so it is the one that would otherwise never be pruned:
      // once the helper holds our block the tip poller sees an identical tip and
      // never calls catchUp, and a catchUp that does run returns on the hasBlock
      // fast path before applyBatch. Prune here so every path that materializes
      // state also retires it (idempotent, and O(1) with one block newly buried).
      if (out.adopted) chain.pruneStateBelow(chain.height - STATE_RETAIN);
      reporter.found({
        height: out.block.header.height,
        hash,
        accepted,
        detail: `submit=${out.statuses.join(',')} ${
          out.adopted ? 'adopted' : out.helperAccepted ? `adopt-failed=${out.localError}` : 'not-on-network'
        }`,
      });
      return { label: `h=${out.block.header.height} hash=${hash}` };
    },
    syncCatchUp: (remoteTip) => sync.catchUp(remoteTip),
    // The coordinator emits two message shapes through onLog:
    //   `hps:<n>`      — a hashrate tick (also a good moment to refresh h/diff)
    //   `solved:<lbl>` — after a solve has been submitted
    // Both were printed to stdout in the pre-reporter code, so route both:
    // hashrate ticks via reporter.hashrate(), and the `solved:` confirmation via
    // reporter.event() so plain mode still surfaces it (the rich FOUND detail is
    // additionally reported from `submit` via reporter.found()).
    onLog: (msg) => {
      const hps = /^hps:(\d+(?:\.\d+)?)$/.exec(msg);
      if (hps) {
        reporter.chain(chain.height, chain.tipDifficulty.toString(16), netTip);
        reporter.hashrate(Number(hps[1]));
        if (smartController) reporter.smart?.({ mode: cfg.smart as 'max' | 'considerate', throttle: smartController.appliedThrottle(), clamped: smartController.isClamped(), phase: smartController.phase() });
        // ~1/sec tick is a convenient debounce clock for the periodic save.
        maybeSave();
        return;
      }
      const solved = /^solved:(.*)$/s.exec(msg);
      if (solved) {
        reporter.event('info', `[minerd] solved ${solved[1]}`);
        return;
      }
      // surface coordinator recovery errors (submit / catch-up failures) instead
      // of dropping them — the miner self-recovers, but the operator should see why.
      const err = /^error:(.*)$/s.exec(msg);
      if (err) {
        reporter.event('warn', `[minerd] ${err[1]}`);
      }
    },
  });

  // Tip poller: poll EVERY helper and follow the best verifiable claim — a
  // wedged-but-answering helper must never capture the miner (live-observed
  // 2026-07-25: a default helper served a >10-min-stale tip with clean HTTP
  // 200s and zero warnings, pinning solo miners blocks behind the network).
  // Blocks are fetched claimant-first (sourceBase). Only a whole-round (all
  // helpers) failure warns. An overlap guard skips a tick whose previous round
  // is still in flight, so we never stack concurrent rounds.
  let tipPolling = false;
  const tipTimer = setInterval(() => {
    if (tipPolling) return;
    tipPolling = true;
    void (async () => {
      try {
        const { best, sourceBase, views } = await helperPool.getBestTip();
        // The OBSERVED network tip, verbatim — never clamped up to our own
        // height: after a reorg onto a heavier-but-shorter fork the network tip
        // is genuinely below where we were, and clamping would report a height
        // no helper claims. Rendering is suppressed unless we are BEHIND it.
        netTip = best.height;
        for (const w of staleHelperWarnings(views, best, sourceBase, staleBases)) {
          reporter.event('warn', w);
        }
        if (best.height > chain.height || best.tipHash !== bytesToHex(chain.tip.hash)) {
          await coord.tipAdvanced({ height: best.height, tipHash: best.tipHash, sourceBase });
          reporter.chain(chain.height, chain.tipDifficulty.toString(16), netTip);
          // The chain advanced from the network — a good moment to persist.
          maybeSave();
        }
      } catch (e) {
        reporter.event('warn', `[minerd] tip poll failed: ${(e as Error).message}`);
      } finally {
        tipPolling = false;
      }
    })();
  }, cfg.tipPollMs);

  coord.rebuild();
  smartController?.start();

  // With no signal this Promise never resolves → runs forever, exactly like
  // today. With a signal, abort tears everything down cleanly and resolves with
  // the synced chain so the caller can warm-reuse it next session (item G).
  return await new Promise<WarmChain>((resolve) => {
    const done = (): void => {
      clearInterval(tipTimer);
      // Persist once more on graceful shutdown / abort so the next launch warm-
      // starts from the freshest finalized anchor. Forced (bypasses the debounce)
      // and best-effort — saveSnapshot never throws. Gated on chainConfirmed so an
      // unconfirmed chain is never (re)persisted (defensive — we only reach
      // done() with chainConfirmed true).
      if (chainConfirmed && saveSnapshot(chain)) debug?.(`snapshot saved on shutdown at height ${chain.height}`);
      unsubInvalidated();
      unsubTipChanged();
      coord.dispose();
      smartController?.stop();
      pool.terminate();
      reporter.close?.();
      resolve({ chain, synced: chainConfirmed });
    };
    if (signal?.aborted) return done();
    signal?.addEventListener('abort', done, { once: true });
  });
}
