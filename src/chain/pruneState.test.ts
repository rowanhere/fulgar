import { describe, it, expect } from 'vitest';
import { Blockchain } from './blockchain.js';
import { blockHashHex, type Block } from './block.js';
import { emptyMine } from './testutil.js';
import { ChainSync } from '../minerd/sync.js';

async function mineN(chain: Blockchain, n: number): Promise<Block[]> {
  const miner = new Uint8Array(32);
  const out: Block[] = [];
  for (let i = 0; i < n; i++) {
    const b = await emptyMine(chain, miner);
    const e = await chain.addBlockWithPow(b, true);
    if (e) throw new Error(String(e));
    out.push(b);
  }
  return out;
}

/** Canonical block hash at a given height (walks back from the tip). */
function hashAt(chain: Blockchain, height: number): string {
  const h = chain.getRecentHeaders(100_000).find((hd) => hd.height === height);
  if (!h) throw new Error('no header at height ' + height);
  return blockHashHex(h);
}
const stateAt = (chain: Blockchain, height: number) => chain.getBlock(hashAt(chain, height))!.state;

describe('Blockchain.pruneStateBelow', () => {
  it('nulls state below minHeight, keeps the window + tip + genesis', async () => {
    const chain = new Blockchain();
    await mineN(chain, 12); // heights 1..12, tip = 12
    expect(chain.height).toBe(12);
    chain.pruneStateBelow(8); // keep >= 8 (8..12), null 1..7
    for (let h = 1; h <= 7; h++) expect(stateAt(chain, h)).toBeNull();
    for (let h = 8; h <= 12; h++) expect(stateAt(chain, h)).not.toBeNull();
    expect(stateAt(chain, 0)).not.toBeNull(); // genesis always kept
    expect(() => chain.tipState).not.toThrow(); // tip always materialized
  });

  it('is idempotent + monotone (re-prune same = no-op; higher prunes more)', async () => {
    const chain = new Blockchain();
    await mineN(chain, 10);
    chain.pruneStateBelow(6);
    chain.pruneStateBelow(6); // idempotent
    expect(stateAt(chain, 5)).toBeNull();
    expect(stateAt(chain, 6)).not.toBeNull();
    chain.pruneStateBelow(9); // prune more
    expect(stateAt(chain, 8)).toBeNull();
    expect(stateAt(chain, 9)).not.toBeNull();
  });

  it('returns early (no-op) when minHeight <= 1 (chain shorter than the window)', async () => {
    const chain = new Blockchain();
    await mineN(chain, 3);
    chain.pruneStateBelow(0);
    chain.pruneStateBelow(1);
    for (let h = 0; h <= 3; h++) expect(stateAt(chain, h)).not.toBeNull();
  });

  it('never nulls the tip even if minHeight is above the tip height (defensive vs bad config)', async () => {
    const chain = new Blockchain();
    await mineN(chain, 6);
    chain.pruneStateBelow(chain.height + 50); // absurd minHeight > tip height
    expect(() => chain.tipState).not.toThrow(); // tip still materialized
    expect(stateAt(chain, 6)).not.toBeNull();
  });

  it('the chain can still extend after pruning (parent within the window is materialized)', async () => {
    const chain = new Blockchain();
    await mineN(chain, 10);
    chain.pruneStateBelow(6); // tip (10) state retained
    await mineN(chain, 1); // extend to 11 — needs parent(10).state, which is kept
    expect(chain.height).toBe(11);
  });

  it('ChainSync with stateRetain bounds materialized state during the bootstrap', async () => {
    // Produce 12 valid blocks on a source chain, serve them to a fresh chain's sync.
    const src = new Blockchain();
    const blocks = await mineN(src, 12);
    const chain = new Blockchain();
    const sync = new ChainSync({
      chain,
      cores: 1,
      getBlocks: async (from: number) => blocks.filter((b) => b.header.height >= from),
      verifyBlocksParallel: async (bs: Block[]) => bs.map(() => true),
      stateRetain: 5,
    });
    await sync.bootstrap();
    expect(chain.height).toBe(12);
    // Far fewer than 13 states materialized — genesis + ~the last 5, NOT one per block.
    const headers = chain.getRecentHeaders(100);
    const materialized = headers.filter((h) => chain.getBlock(blockHashHex(h))!.state !== null).length;
    expect(materialized).toBeLessThanOrEqual(8);
    expect(stateAt(chain, 1)).toBeNull(); // an early block is pruned
    expect(() => chain.tipState).not.toThrow();
  });
});
