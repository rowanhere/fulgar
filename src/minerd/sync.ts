// src/minerd/sync.ts
import type { Blockchain } from '../chain/blockchain.js';
import type { Block } from '../chain/block.js';
import { bytesToHex, compareBytes } from '../util/binary.js';
import { SNAPSHOT_DEPTH } from '../chain/genesis.js';

const PAGE = 200;
const CATCHUP_OVERLAP = 5; // re-fetch a few blocks below our tip to absorb small reorgs
// when a fixed 5-block overlap can't reach the fork point (a reorg deeper than 5),
// progressively widen the overlap toward the common ancestor instead of re-grinding
// the old fork forever. Bounded BELOW SNAPSHOT_DEPTH so the incremental widen never
// reaches the null-state finalized prefix (blocks below `tip - SNAPSHOT_DEPTH` have no
// materialized state → a reorg there is the catastrophic / below-anchor case handled
// by the throw + the snapshot-invalidation reset, not by routine catch-up).
const CATCHUP_WIDEN_FACTOR = 5;
const CATCHUP_MAX_OVERLAP = SNAPSHOT_DEPTH - 10; // = 90; comfortably above the anchor
const YIELD_EVERY = 32; // yield a macrotask every N blocks so timers/keypresses run

/** An observed remote tip. `sourceBase` is the helper that CLAIMED it — block
 *  fetches chase the claim through that helper first, so a tip learned from one
 *  helper is never pursued through a different, staler one (which returns an
 *  empty page and masquerades as "caught up"). */
export interface RemoteTip { height: number; tipHash: string; sourceBase?: string }

export interface SyncDeps {
  chain: Blockchain;
  cores: number;
  getBlocks: (fromHeight: number, max: number, preferBase?: string) => Promise<Block[]>;
  // The `cores` arg is honored by the one-shot verifyBlocksParallel but is
  // ignored when a persistent VerifierPool is bound (the pool already owns its
  // worker count). The interface shape is kept stable for both callers.
  verifyBlocksParallel: (blocks: Block[], cores: number) => Promise<boolean[]>;
  /** Optional: called after each page is applied, with the new chain height. */
  onProgress?: (height: number) => void;
}

export class ChainSync {
  readonly chain: Blockchain;
  constructor(private readonly deps: SyncDeps) {
    this.chain = deps.chain;
  }

  /**
   * Pull + validate the whole chain from genesis up to the helper's tip.
   * `onProgress` (if given) overrides the deps-level callback for this run; it is
   * called after each page is applied with the current chain height.
   */
  async bootstrap(onProgress?: (height: number) => void): Promise<void> {
    const report = onProgress ?? this.deps.onProgress;
    let from = this.chain.height + 1; // genesis (0) is already seeded
    for (;;) {
      const blocks = await this.deps.getBlocks(from, PAGE);
      if (blocks.length === 0) return;
      const heightBefore = this.chain.height;
      await this.applyBatch(blocks);
      // Report progress after every page so the UI/logs advance steadily.
      report?.(this.chain.height);
      // If no block was accepted the chain didn't advance — every block in the
      // page was rejected (PoW invalid, parent unknown, stateRoot mismatch, …).
      // Continuing would re-fetch the same page forever, so bail out.
      if (this.chain.height === heightBefore) return;
      from = this.chain.height + 1;
      if (blocks.length < PAGE) return; // last (partial) page -> caught up
    }
  }

  /**
   * Incremental: fetch from just below our tip to absorb new blocks / small reorgs.
   * if the helper has a divergent tip we can't connect with the current overlap
   * (a reorg deeper than CATCHUP_OVERLAP), progressively widen the overlap toward the
   * common ancestor and retry, so we stop re-grinding the old fork. Bounded so a
   * pathologically deep fork warns and yields rather than thrashing.
   */
  async catchUp(remoteTip?: RemoteTip): Promise<boolean> {
    // Fast path: if we already hold the helper's tip block, we're at or ahead of it on
    // the same chain → in sync, nothing to fetch or re-verify.
    if (remoteTip && this.chain.hasBlock(remoteTip.tipHash)) return false;
    // Report whether this call CHANGED the local chain: the caller only restarts
    // the grind on a real change. An unverifiable/empty claim (a wedged or lying
    // helper) must not stop verified work — that was a grind restart every poll
    // tick for as long as the helper disagreed with us (observed 2026-07-25).
    const entryHeight = this.chain.height;
    const entryTip = this.chain.tip.hash;
    const changedSinceEntry = (): boolean =>
      this.chain.height !== entryHeight || compareBytes(this.chain.tip.hash, entryTip) !== 0;
    let overlap = CATCHUP_OVERLAP;
    for (;;) {
      // Fetch from below BOTH our tip AND the remote tip. A heavier-but-SHORTER fork's
      // canonical tip sits BELOW our height, so `height - overlap` alone could fetch
      // ABOVE it and get an empty page that masks the reorg.
      const base = remoteTip ? Math.min(this.chain.height, remoteTip.height) : this.chain.height;
      const from = Math.max(1, base - overlap);
      const heightBefore = this.chain.height;
      const tipBefore = this.chain.tip.hash;
      const blocks = await this.deps.getBlocks(from, PAGE, remoteTip?.sourceBase);
      if (blocks.length === 0) return changedSinceEntry(); // even fetching from below the remote tip got nothing → caught up
      // Does the helper's LOWEST fetched block link to a block we already hold? If so,
      // the chain now has a complete branch from a known ancestor and makes its OWN
      // strictly-work-based fork choice in applyBatch (reorg iff the branch is heavier).
      // If not, the common ancestor is below `from` (a reorg deeper than `overlap`) →
      // widen. We must NOT decide by HEIGHT: fork choice is by cumulative work, so a
      // heavier-but-shorter fork is canonical. Only trust the connection shortcut when
      // the page actually starts at `from` — a clamped/sparse page could otherwise look
      // connected while missing the branch.
      const connected = blocks[0]!.header.height === from
        && this.chain.hasBlock(bytesToHex(blocks[0]!.header.prevHash));
      await this.applyBatch(blocks);
      // A height DECREASE means the chain was reset / deep-reorged BELOW us mid-apply
      // (e.g. a below-anchor reorg fired the snapshot-invalidation listener → reset to
      // genesis). Do NOT treat that drop as catch-up "progress" (the caller would mine
      // from the reset point) — re-sync forward to the helper tip first.
      if (this.chain.height < heightBefore) { await this.bootstrap(); return true; }
      // Tip moved (advanced, or reorged BY WORK to a heavier fork) → caught up.
      if (this.chain.height !== heightBefore || compareBytes(this.chain.tip.hash, tipBefore) !== 0) return changedSinceEntry();
      // Tip unchanged but the branch CONNECTED → the chain saw it and kept ours (the
      // branch was not strictly heavier: an equal-work sibling, a lighter fork, or just
      // already-known blocks). We're in sync; don't widen or re-verify deeper.
      if (connected) return changedSinceEntry();
      // The branch did NOT connect → the fork is deeper than `overlap`. Widen toward
      // the common ancestor; or, past the cap (a catastrophic 51%-class reorg), THROW
      // so the caller (tipAdvanced) STOPS the grind instead of mining a chain it can't
      // reconcile. The next tip poll retries (bounded per call).
      if (from === 1 || overlap >= CATCHUP_MAX_OVERLAP) {
        throw new Error(`catchUp: fork deeper than ${overlap} blocks — cannot reach the common ancestor`);
      }
      overlap = Math.min(overlap * CATCHUP_WIDEN_FACTOR, CATCHUP_MAX_OVERLAP);
    }
  }

  private async applyBatch(blocks: Block[]): Promise<void> {
    // Validation order: ALL blocks in the page are PoW-verified in parallel FIRST
    // (the verdicts array is fully resolved here), and only THEN are blocks added
    // one-by-one. The setImmediate yield below is interspersed in that per-block
    // add loop — i.e. strictly POST-verification — so it never affects PoW
    // checking; it only lets the render timer/keypresses run between adds.
    const verdicts = await this.deps.verifyBlocksParallel(blocks, this.deps.cores);
    let rejectedCount = 0;
    for (let i = 0; i < blocks.length; i++) {
      // addBlockWithPow skips re-hashing (already verified) but runs all
      // state-dependent checks. Idempotent errors (dup / already known) return
      // null and are harmless. Non-null on a new block signals a real problem
      // (PoW invalid, parent unknown, stateRoot mismatch, height gap, …).
      const err = await this.chain.addBlockWithPow(blocks[i]!, verdicts[i]!);
      if (err !== null) {
        rejectedCount++;
      }
      // The per-block addBlockWithPow loop is synchronous CPU on the main thread.
      // Yield a macrotask every ~32 blocks so the render timer and keypresses are
      // serviced mid-page. A microtask (await Promise.resolve()) would NOT let
      // timers/IO run — setImmediate schedules after the I/O/timer phases, so it
      // genuinely unblocks the event loop.
      if (i % YIELD_EVERY === YIELD_EVERY - 1) {
        await new Promise((r) => setImmediate(r));
      }
    }
    // Surface a count so callers (and logging) can distinguish a fully-rejected
    // page (every block refused) from one where some blocks were applied.
    if (rejectedCount > 0 && rejectedCount === blocks.length) {
      // All blocks in this batch were rejected — chain made no progress.
      // Log a warning so the stall is observable rather than silent.
      // (bootstrap() will also detect the stall via heightBefore check and break.)
      console.warn(`[ChainSync] applyBatch: all ${blocks.length} blocks rejected`);
    }
  }
}
