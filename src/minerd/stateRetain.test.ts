// The retain window must stay ABOVE the snapshot anchor. If it ever drops below,
// snapshotAt() returns null → saveSnapshot() silently skips → warm start stops
// working with no error anywhere, and every launch full-replays from genesis.
// These tests pin that relationship with the REAL constants.
//
// Blocks are appended via addBlockWithPow(b, true): it skips the PoW re-hash but
// runs every state-dependent check, exactly as ChainSync does per page. That keeps
// a 200-block fixture instant (no Argon2id grinding — the mirrored chain-side suite
// takes ~100s for 12 mined blocks) while still exercising real validation and real
// per-block state materialization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { Blockchain } from '../chain/blockchain.js';
import { hashHeader, computeTxRoot, blockHashHex, type Block, type BlockHeader } from '../chain/block.js';
import { GENESIS_TIMESTAMP, SNAPSHOT_DEPTH, TARGET_BLOCK_TIME_S } from '../chain/genesis.js';
import { applyBlockTxs, cloneState, stateRoot } from '../chain/state.js';
import { saveSnapshot } from './persistence.js';
import { STATE_RETAIN } from './sync.js';

const MINER = new Uint8Array(32).fill(1);

/** Append `n` valid blocks without grinding PoW. Timestamps step one target spacing
 *  per block, which keeps ASERT at the genesis difficulty floor (testutil's strategy). */
async function extend(chain: Blockchain, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const parent = chain.tip.block.header;
    const height = parent.height + 1;
    const timestamp = parent.height === 0
      ? GENESIS_TIMESTAMP + TARGET_BLOCK_TIME_S
      : parent.timestamp + TARGET_BLOCK_TIME_S;
    const sim = cloneState(chain.tipState);
    const applyErr = applyBlockTxs(sim, height, MINER, [], chain.nextBlockScriptContext());
    if (applyErr) throw new Error(`fixture apply failed at ${height}: ${applyErr}`);
    const header: BlockHeader = {
      height,
      prevHash: hashHeader(parent),
      txRoot: computeTxRoot([]),
      stateRoot: stateRoot(sim),
      timestamp,
      difficulty: chain.expectedNextDifficulty(timestamp),
      nonce: 0,
      miner: MINER,
    };
    const block: Block = { header, transactions: [] };
    const addErr = await chain.addBlockWithPow(block, true);
    if (addErr) throw new Error(`fixture add failed at ${height}: ${addErr}`);
  }
}

/** Run `fn` with HOME pointed at a throwaway temp dir so snapshotPath() can never
 *  touch the user's real ~/.fulgurminer. Same pattern as persistence.test.ts. */
function withIsolatedHome(fn: () => void): void {
  const orig = process.env.HOME;
  process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'fulgur-retain-'));
  try {
    fn();
  } finally {
    if (orig === undefined) delete process.env.HOME;
    else process.env.HOME = orig;
  }
}

test('STATE_RETAIN sits above SNAPSHOT_DEPTH', () => {
  assert.ok(
    STATE_RETAIN > SNAPSHOT_DEPTH,
    `STATE_RETAIN (${STATE_RETAIN}) must exceed SNAPSHOT_DEPTH (${SNAPSHOT_DEPTH}) or the snapshot anchor gets pruned`,
  );
});

test('a chain pruned at STATE_RETAIN still has its snapshot anchor materialized', async () => {
  const chain = new Blockchain();
  await extend(chain, STATE_RETAIN + 40); // deep enough that the prune actually bites
  chain.pruneStateBelow(chain.height - STATE_RETAIN);

  const anchorHeight = chain.height - SNAPSHOT_DEPTH;
  assert.notEqual(
    chain.snapshotAt(anchorHeight),
    null,
    `snapshotAt(${anchorHeight}) must survive a prune at STATE_RETAIN=${STATE_RETAIN}`,
  );
});

test('a chain pruned at STATE_RETAIN can still save a snapshot (warm start survives)', async () => {
  const chain = new Blockchain();
  await extend(chain, STATE_RETAIN + 40);
  chain.pruneStateBelow(chain.height - STATE_RETAIN);

  withIsolatedHome(() => {
    assert.equal(saveSnapshot(chain), true, 'a pruned chain must still be able to save a snapshot');
  });
});

test('pruning bounds materialized state instead of growing with height', async () => {
  const chain = new Blockchain();
  await extend(chain, STATE_RETAIN + 40);
  chain.pruneStateBelow(chain.height - STATE_RETAIN);

  const materialized = chain
    .getRecentHeaders(100_000)
    .filter((h) => chain.getBlock(blockHashHex(h))!.state !== null).length;
  assert.ok(
    materialized <= STATE_RETAIN + 2, // the window + tip + genesis
    `expected <= ${STATE_RETAIN + 2} materialized states, got ${materialized} at height ${chain.height}`,
  );
  assert.ok(materialized < chain.height, 'materialized state must not scale with chain height');
});
