import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainSync } from './sync.js';

// catchUp() absorbs a reorg DEEPER than the fixed 5-block overlap by widening
// toward the common ancestor, deciding whether to widen by whether the fetched branch
// CONNECTS to our chain (hasBlock of the lowest block's parent), NOT by height — fork
// choice is strictly work-based, so a heavier-but-SHORTER fork (helper tip BELOW our
// height) is canonical. The observed remote tip is threaded in so we fetch from below
// it (else an empty page above the short tip masks the reorg). Fake chain + getBlocks,
// no Argon2. prevHash byte [1]→hasBlock '01' true ('connected'); [0]→'00' false.

function scenario(opts: {
  start: number; forkAt: number; helperTip: number; onConnect: 'reorg' | 'insync'; remoteHasTip?: boolean; sourceBase?: string;
}): { run: () => Promise<boolean>; froms: number[]; prefers: Array<string | undefined>; height: () => number } {
  let height = opts.start;
  let tipHash = new Uint8Array([opts.start & 0xff, 1]);
  const froms: number[] = [];
  const prefers: Array<string | undefined> = [];
  const chain = {
    get height() { return height; },
    get tip() { return { hash: tipHash }; },
    hasBlock: (hex: string) => hex === '01',
    addBlockWithPow: async (block: any): Promise<string | null> => {
      if (!block.__connects) return 'parent block unknown';
      if (opts.onConnect === 'reorg') { height = block.__tipHeight; tipHash = new Uint8Array([block.__tipHeight & 0xff, 2]); }
      return null; // connected (applied / known / equal-work sibling)
    },
  };
  const getBlocks = async (from: number, _max: number, preferBase?: string): Promise<any[]> => {
    froms.push(from);
    prefers.push(preferBase);
    if (from > opts.helperTip) return []; // helper has nothing at/above this height
    const connects = opts.forkAt >= 0 && from <= opts.forkAt;
    return [{ header: { height: from, prevHash: new Uint8Array([connects ? 1 : 0]) }, __connects: connects, __tipHeight: opts.helperTip, transactions: [] }];
  };
  const sync = new ChainSync({ chain: chain as any, cores: 1, getBlocks, verifyBlocksParallel: async (b) => b.map(() => true) });
  const remoteTip = { height: opts.helperTip, tipHash: opts.remoteHasTip ? '01' : 'ff', sourceBase: opts.sourceBase };
  return { run: () => sync.catchUp(remoteTip), froms, prefers, height: () => height };
}

test('a reorg deeper than the 5-overlap is absorbed by progressively widening', async () => {
  const s = scenario({ start: 200, forkAt: 130, helperTip: 205, onConnect: 'reorg' });
  await s.run();
  assert.deepEqual(s.froms, [195, 175, 110], 'widened 5→25→90(cap) until the page connected past the fork');
  assert.equal(s.height(), 205);
});

test('a heavier-but-SHORTER fork BELOW our height is taken (fetch below the remote tip, reorg by WORK)', async () => {
  // Helper canonical tip at 190 (< our 200), ancestor at 165. height-overlap alone would
  // fetch from 195 → empty page → missed. Threading the remote tip fetches from below 190.
  const s = scenario({ start: 200, forkAt: 165, helperTip: 190, onConnect: 'reorg' });
  await s.run();
  assert.equal(s.height(), 190, 'reorged DOWN to the heavier-shorter canonical fork');
  assert.equal(s.froms[0], 185, 'fetched from below the remote tip (190), not from 195');
  assert.ok(s.froms.includes(165), 'widened to reach the ancestor (then a harmless no-op bootstrap)');
});

test('an equal-work sibling (connects, not heavier) does NOT widen or throw', async () => {
  const s = scenario({ start: 100, forkAt: 100, helperTip: 100, onConnect: 'insync' });
  await s.run(); // must not throw
  assert.deepEqual(s.froms, [95], 'one fetch — connected + not heavier → in sync, no deep widen');
  assert.equal(s.height(), 100);
});

test('a fork deeper than the cap (90) THROWS after a bounded widen', async () => {
  const s = scenario({ start: 200, forkAt: -1, helperTip: 205, onConnect: 'reorg' }); // never connects
  await assert.rejects(s.run(), /fork deeper than/);
  assert.deepEqual(s.froms, [195, 175, 110], 'widened 5→25→90(cap), then threw — bounded, finite');
  assert.equal(s.height(), 200, 'no spurious progress');
});

test('a normal single-page advance needs no widening', async () => {
  const s = scenario({ start: 100, forkAt: 100, helperTip: 110, onConnect: 'reorg' });
  await s.run();
  assert.equal(s.froms.length, 1);
  assert.equal(s.height(), 110);
});

test('fast-path — we already hold the helper tip block → return without fetching', async () => {
  const s = scenario({ start: 200, forkAt: 100, helperTip: 50, onConnect: 'insync', remoteHasTip: true });
  await s.run();
  assert.deepEqual(s.froms, [], 'no getBlocks/re-verify when we already have the helper tip');
  assert.equal(s.height(), 200);
});

test('a reset (height drops below us mid-apply) re-syncs via bootstrap, not "progress"', async () => {
  let height = 200;
  let tipHash = new Uint8Array([9]);
  let didReset = false;
  const froms: number[] = [];
  const chain = {
    get height() { return height; },
    get tip() { return { hash: tipHash }; },
    hasBlock: (hex: string) => hex === '01',
    addBlockWithPow: async (block: any): Promise<string | null> => {
      if (block.__resets && !didReset) { didReset = true; height = 0; tipHash = new Uint8Array([0]); return null; }
      if (block.__advance) { height = block.__tipHeight; tipHash = new Uint8Array([height & 0xff]); return null; }
      return 'rejected';
    },
  };
  const getBlocks = async (from: number): Promise<any[]> => {
    froms.push(from);
    if (!didReset) return [{ header: { height: from, prevHash: new Uint8Array([1]) }, __resets: true, transactions: [] }];
    if (from > 205) return [];
    return [{ header: { height: from, prevHash: new Uint8Array([1]) }, __advance: true, __tipHeight: 205, transactions: [] }];
  };
  const sync = new ChainSync({ chain: chain as any, cores: 1, getBlocks, verifyBlocksParallel: async (b) => b.map(() => true) });
  await sync.catchUp({ height: 205, tipHash: 'ff' });
  assert.equal(didReset, true, 'the reset fired during applyBatch');
  assert.equal(height, 205, 're-synced forward via bootstrap (NOT left at genesis to mine from)');
  assert.ok(froms.includes(1), 'bootstrap re-fetched from genesis+1 after the reset');
});

// ─── the changed-flag: only a REAL chain change may restart the grind ────────

test('catchUp returns true when the chain advanced', async () => {
  const s = scenario({ start: 200, forkAt: 130, helperTip: 205, onConnect: 'reorg' });
  assert.equal(await s.run(), true);
});

test('catchUp returns true on a down-reorg to a heavier-shorter fork', async () => {
  const s = scenario({ start: 200, forkAt: 165, helperTip: 190, onConnect: 'reorg' });
  assert.equal(await s.run(), true);
});

test('catchUp fast path (remote tip already held) returns false without fetching', async () => {
  const s = scenario({ start: 200, forkAt: 130, helperTip: 205, onConnect: 'reorg', remoteHasTip: true });
  assert.equal(await s.run(), false);
  assert.deepEqual(s.froms, []); // never fetched
});

test('catchUp returns false on an empty page (unverifiable claim — grind must not restart)', async () => {
  const chain = {
    get height() { return 200; },
    get tip() { return { hash: new Uint8Array([200 & 0xff, 1]) }; },
    hasBlock: () => false,
    addBlockWithPow: async () => 'unreachable',
  };
  const sync = new ChainSync({ chain: chain as any, cores: 1, getBlocks: async () => [], verifyBlocksParallel: async (b) => b.map(() => true) });
  assert.equal(await sync.catchUp({ height: 205, tipHash: 'ff' }), false);
});

test('catchUp returns false when the branch connected but was not heavier (in sync)', async () => {
  const s = scenario({ start: 200, forkAt: 199, helperTip: 205, onConnect: 'insync' });
  assert.equal(await s.run(), false);
});

test('catchUp threads the claimant into every getBlocks call', async () => {
  const s = scenario({ start: 200, forkAt: 130, helperTip: 205, onConnect: 'reorg', sourceBase: 'https://claimant.example' });
  await s.run();
  assert.ok(s.prefers.length > 0);
  assert.ok(s.prefers.every((p) => p === 'https://claimant.example'), `every fetch used the claimant: ${JSON.stringify(s.prefers)}`);
});

test('catchUp still THROWS past the widen cap (deep-fork contract preserved)', async () => {
  const s = scenario({ start: 200, forkAt: -1, helperTip: 205, onConnect: 'reorg' });
  await assert.rejects(() => s.run(), /fork deeper than/);
});

test('a reset-recovery bootstrap re-syncs through the claimant, not the (possibly stale) primary', async () => {
  // Applying the claimant's page can trigger a snapshot-invalidation reset. The
  // recovery bootstrap must keep chasing the SAME helper that claimed the tip —
  // leading with a stale primary can stop early on its short chain and report
  // progress from a height the network has left behind.
  let height = 200;
  let tipHash = new Uint8Array([9]);
  let didReset = false;
  const prefers: Array<string | undefined> = [];
  const chain = {
    get height() { return height; },
    get tip() { return { hash: tipHash }; },
    hasBlock: (hex: string) => hex === '01',
    addBlockWithPow: async (block: any): Promise<string | null> => {
      if (block.__resets && !didReset) { didReset = true; height = 0; tipHash = new Uint8Array([0]); return null; }
      if (block.__advance) { height = block.__tipHeight; tipHash = new Uint8Array([height & 0xff]); return null; }
      return 'rejected';
    },
  };
  const getBlocks = async (from: number, _max: number, preferBase?: string): Promise<any[]> => {
    prefers.push(preferBase);
    if (!didReset) return [{ header: { height: from, prevHash: new Uint8Array([1]) }, __resets: true, transactions: [] }];
    if (from > 205) return [];
    return [{ header: { height: from, prevHash: new Uint8Array([1]) }, __advance: true, __tipHeight: 205, transactions: [] }];
  };
  const sync = new ChainSync({ chain: chain as any, cores: 1, getBlocks, verifyBlocksParallel: async (b) => b.map(() => true) });
  await sync.catchUp({ height: 205, tipHash: 'ff', sourceBase: 'https://claimant.example' });
  assert.equal(didReset, true, 'the reset fired during applyBatch');
  assert.ok(prefers.length > 1, 'bootstrap fetched after the reset');
  assert.ok(
    prefers.every((p) => p === 'https://claimant.example'),
    `every fetch (incl. the recovery bootstrap) used the claimant: ${JSON.stringify(prefers)}`,
  );
});

test('bootstrap prefetches the next full page while applying the current page', async () => {
  let height = 0;
  let applyStarted = false;
  let nextRequestStarted = false;
  let releaseApply!: () => void;
  const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
  const chain = {
    get height() { return height; },
    get tip() { return { hash: new Uint8Array([height]) }; },
    addBlockWithPow: async (block: any): Promise<string | null> => {
      applyStarted = true;
      await applyGate;
      height = block.header.height;
      return null;
    },
  };
  const getBlocks = async (from: number, max: number): Promise<any[]> => {
    if (from === 501) nextRequestStarted = true;
    if (from > 501) return [];
    return Array.from({ length: max }, (_, i) => ({
      header: { height: from + i, prevHash: new Uint8Array([0]) },
      transactions: [],
    }));
  };
  const sync = new ChainSync({
    chain: chain as any,
    cores: 1,
    getBlocks,
    verifyBlocksParallel: async (blocks) => blocks.map(() => true),
  });
  const run = sync.bootstrap();
  while (!applyStarted) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextRequestStarted, true, 'the successor request should overlap current-page apply');
  releaseApply();
  await run;
});
