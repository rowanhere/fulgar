import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HelperPool, AllHelpersFailed, staleHelperWarnings } from './helperPool.js';
import type { Tip } from './http.js';

const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';
const tip = (h: number): Tip => ({ height: h, tipHash: 'hash' + h });
const noSleep = async (): Promise<void> => {};
const sink = { onDebug() {}, onInfo() {} };

test('getTip returns the primary when it succeeds', async () => {
  const pool = new HelperPool([A, B], { ...sink, sleep: noSleep, getTip: async (base) => { assert.equal(base, A); return tip(10); } });
  assert.deepEqual(await pool.getTip(), tip(10));
  assert.equal(pool.primary(), A);
});

test('getTip fails over to the next helper on a primary error', async () => {
  const seen: string[] = [];
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getTip: async (base) => { seen.push(base); if (base === A) throw new Error('525'); return tip(7); },
  });
  assert.deepEqual(await pool.getTip(), tip(7));
  assert.deepEqual(seen, [A, B]); // tried A, then B
});

test('getTip throws AllHelpersFailed only when every helper fails a round', async () => {
  const pool = new HelperPool([A, B], { ...sink, sleep: noSleep, getTip: async () => { throw new Error('boom'); } });
  await assert.rejects(() => pool.getTip(), (e) => e instanceof AllHelpersFailed && /a\.example.*b\.example/s.test(e.message));
});

test('a caller AbortError propagates immediately (no failover, no retry)', async () => {
  const seen: string[] = [];
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getTip: async (base) => { seen.push(base); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
  await assert.rejects(() => pool.getTip(), (e) => (e as Error).name === 'AbortError');
  assert.deepEqual(seen, [A]); // did not try B
});

test('primary rotates after rotateThreshold sustained failures', async () => {
  const warned: string[] = [];
  let aUp = false;
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep, rotateThreshold: 3, onInfo: (m) => warned.push(m),
    getTip: async (base) => { if (base === A && !aUp) throw new Error('down'); return tip(1); },
  });
  // 3 rounds: A fails each time, B serves. On the 3rd, primary rotates to B.
  await pool.getTip(); await pool.getTip();
  assert.equal(pool.primary(), A);            // not yet
  await pool.getTip();
  assert.equal(pool.primary(), B);            // rotated
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /b\.example/);
});

test('a primary success resets the failure streak', async () => {
  let aFails = true;
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep, rotateThreshold: 3,
    getTip: async (base) => { if (base === A && aFails) throw new Error('down'); return tip(1); },
  });
  await pool.getTip(); await pool.getTip(); // 2 primary failures
  aFails = false; await pool.getTip();      // primary recovers → streak reset
  aFails = true; await pool.getTip(); await pool.getTip(); // 2 again, still < 3
  assert.equal(pool.primary(), A);
});

test('getBlocks fails over within a round, then bounded-retries rounds', async () => {
  let calls = 0;
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep, blocksRounds: 4,
    getBlocks: async (base) => { calls++; if (calls < 4) throw new Error('5xx'); return []; },
  });
  await pool.getBlocks(0, 200);
  assert.equal(calls, 4); // A,B (round1) A,B... until the 4th attempt returns
});

test('blockAt is a single failover round (A down -> B serves the block)', async () => {
  const seen: string[] = [];
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getBlocks: async (base, from, max) => { seen.push(base); assert.equal(max, 1); if (base === A) throw new Error('x'); return [{ header: { height: from } } as any]; },
  });
  const blk = await pool.blockAt(42);
  assert.equal((blk as any).header.height, 42);
  assert.deepEqual(seen, [A, B]);
});

test('blockAt returns undefined when the winning helper has no block there', async () => {
  const pool = new HelperPool([A], { ...sink, sleep: noSleep, getBlocks: async () => [] });
  assert.equal(await pool.blockAt(9), undefined);
});

test('constructor rejects an empty helper list', () => {
  assert.throws(() => new HelperPool([], {}), /at least one/);
});

test('getTip rotates with wraparound across 3 helpers', async () => {
  let downA = true;
  const seen: string[] = [];
  const pool = new HelperPool([A, B, C], {
    ...sink, sleep: noSleep, rotateThreshold: 2,
    getTip: async (base) => { seen.push(base); if (base === A && downA) throw new Error('down'); return tip(3); },
  });
  await pool.getTip(); await pool.getTip();   // 2 primary(A) failures -> rotate to B
  assert.equal(pool.primary(), B);
  seen.length = 0;
  await pool.getTip();                          // now starts at B (success), order begins at B
  assert.equal(seen[0], B);
});

test('getBlocks propagates an AbortError from the inter-round sleep', async () => {
  let calls = 0;
  const pool = new HelperPool([A, B], {
    ...sink, blocksRounds: 4,
    getBlocks: async () => { calls++; throw new Error('5xx'); },           // every helper fails -> round fails
    sleep: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, // abort during backoff
  });
  await assert.rejects(() => pool.getBlocks(0, 200), (e) => (e as Error).name === 'AbortError');
  assert.equal(calls, 2); // one full round (A,B) then the sleep aborts before round 2
});

// ─── getBestTip: parallel best-claim selection + stale-primary rotation ──────

test('getBestTip returns the max-height claim and its source helper', async () => {
  const pool = new HelperPool([A, B, C], {
    ...sink, sleep: noSleep,
    getTip: async (base) => (base === B ? tip(12) : tip(10)),
  });
  const r = await pool.getBestTip();
  assert.deepEqual(r.best, tip(12));
  assert.equal(r.sourceBase, B);
  assert.equal(r.views.length, 3); // every successful view is reported
});

test('getBestTip tie prefers the current primary (stability)', async () => {
  const pool = new HelperPool([A, B], { ...sink, sleep: noSleep, getTip: async () => tip(9) });
  const r = await pool.getBestTip();
  assert.equal(r.sourceBase, A); // primary among the max claimants → primary wins
});

test('getBestTip tolerates partial failures and never rotates off a fresh primary', async () => {
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getTip: async (base) => { if (base === B) throw new Error('525'); return tip(5); },
  });
  for (let i = 0; i < 5; i++) assert.deepEqual((await pool.getBestTip()).best, tip(5));
  assert.equal(pool.primary(), A);
});

test('getBestTip throws AllHelpersFailed when every helper fails', async () => {
  const pool = new HelperPool([A, B], { ...sink, sleep: noSleep, getTip: async () => { throw new Error('boom'); } });
  await assert.rejects(() => pool.getBestTip(), (e) => e instanceof AllHelpersFailed);
});

test('getBestTip propagates a caller AbortError', async () => {
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getTip: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
  await assert.rejects(() => pool.getBestTip(), (e) => (e as Error).name === 'AbortError');
});

test('a stale-but-answering primary rotates to the best claimant after 3 consecutive polls', async () => {
  const infos: string[] = [];
  const pool = new HelperPool([A, B, C], {
    ...sink, sleep: noSleep, onInfo: (m) => infos.push(m),
    getTip: async (base) => (base === A ? tip(10) : base === C ? tip(13) : tip(12)),
  });
  await pool.getBestTip(); await pool.getBestTip();
  assert.equal(pool.primary(), A); // 2 stale polls — hysteresis holds
  await pool.getBestTip();
  assert.equal(pool.primary(), C); // 3rd → jump DIRECTLY to the best claimant (not +1)
  assert.ok(infos.some((m) => m.includes('stale')));
});

test('a primary back at the best height resets the staleness streak', async () => {
  let aBehind = true;
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getTip: async (base) => (base === A && aBehind ? tip(10) : tip(12)),
  });
  await pool.getBestTip(); await pool.getBestTip(); // 2 stale
  aBehind = false; await pool.getBestTip();         // recovered → streak reset
  aBehind = true; await pool.getBestTip(); await pool.getBestTip(); // 2 again
  assert.equal(pool.primary(), A);                  // never reached 3 consecutive
});

test('a hard-failing primary still rotates +1 via the existing failure streak', async () => {
  const pool = new HelperPool([A, B, C], {
    ...sink, sleep: noSleep, rotateThreshold: 3,
    getTip: async (base) => { if (base === A) throw new Error('down'); return tip(7); },
  });
  await pool.getBestTip(); await pool.getBestTip(); await pool.getBestTip();
  assert.equal(pool.primary(), B); // connectivity rotation unchanged: +1, not jump
});

// ─── staleHelperWarnings: once-per-episode warn state ────────────────────────

test('staleHelperWarnings warns once per episode and clears on recovery', () => {
  const staleBases = new Set<string>();
  const views = [{ base: A, tip: tip(10) }, { base: B, tip: tip(13) }];
  const w1 = staleHelperWarnings(views, tip(13), B, staleBases);
  assert.equal(w1.length, 1);
  assert.ok(w1[0]!.includes(A) && w1[0]!.includes('3 blocks behind') && w1[0]!.includes(B));
  assert.equal(staleHelperWarnings(views, tip(13), B, staleBases).length, 0); // same episode → silent
  const recovered = [{ base: A, tip: tip(13) }, { base: B, tip: tip(13) }];
  assert.equal(staleHelperWarnings(recovered, tip(13), B, staleBases).length, 0);
  assert.equal(staleBases.size, 0); // episode cleared…
  assert.equal(staleHelperWarnings(views, tip(13), B, staleBases).length, 1); // …so a relapse warns again
});

test('staleHelperWarnings ignores a 1-block propagation lag', () => {
  const staleBases = new Set<string>();
  const views = [{ base: A, tip: tip(12) }, { base: B, tip: tip(13) }];
  assert.equal(staleHelperWarnings(views, tip(13), B, staleBases).length, 0);
  assert.equal(staleBases.size, 0);
});

// ─── getBlocks preferBase: claimant-first ordering + error absorption ────────

test('getBlocks with preferBase tries the claimant first, then rotation order', async () => {
  const seen: string[] = [];
  const pool = new HelperPool([A, B, C], {
    ...sink, sleep: noSleep,
    getBlocks: async (base) => { seen.push(base); if (base !== C) throw new Error('empty'); return ['blk' as any]; },
  });
  const out = await pool.getBlocks(5, 200, undefined, B);
  assert.deepEqual(out, ['blk']);
  assert.deepEqual(seen, [B, A, C]); // claimant B first, then rotation A, C — deduped
});

test('a throwing claimant is absorbed and the round falls through to the next helper', async () => {
  // The per-helper error-absorb contract: a claimant whose /blocks response
  // throws (HTTP failure or a decodeBlockHex reject) must fail over exactly
  // like any helper — never propagate out of a round that another helper can serve.
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getBlocks: async (base) => { if (base === B) throw new Error('oversized block hex'); return ['ok' as any]; },
  });
  assert.deepEqual(await pool.getBlocks(1, 200, undefined, B), ['ok']);
});

test('an unknown preferBase falls back to plain rotation order', async () => {
  const seen: string[] = [];
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getBlocks: async (base) => { seen.push(base); return ['x' as any]; },
  });
  await pool.getBlocks(1, 200, undefined, 'https://not-in-list.example');
  assert.deepEqual(seen, [A]);
});

test('a preferBase round does not touch primary rotation bookkeeping', async () => {
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep, rotateThreshold: 1,
    getBlocks: async (base) => { if (base === A) throw new Error('down'); return ['x' as any]; },
  });
  // Primary A fails inside a claimant-first round — with rotateThreshold 1 a
  // counted failure would rotate immediately. It must not.
  await pool.getBlocks(1, 200, undefined, B);
  assert.equal(pool.primary(), A);
});

// ─── rotation-state fixes (review round 1) ──────────────────────────────────

test('a primary alternating hard-failure and stale answers still rotates (no counter-reset deadlock)', async () => {
  // Each event used to clear the OTHER counter, so neither ever reached its
  // threshold and a permanently unhealthy helper kept the primary role forever.
  let failNext = true;
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getTip: async (base) => {
      if (base !== A) return tip(20);
      const shouldFail = failNext;
      failNext = !failNext;
      if (shouldFail) throw new Error('down');
      return tip(10); // answers, but stale
    },
  });
  for (let i = 0; i < 8 && pool.primary() === A; i++) await pool.getBestTip();
  assert.equal(pool.primary(), B, 'rotated away from the alternately-failing/stale primary');
});

test('a hard-failure rotation does not hand the new primary its predecessor stale streak', async () => {
  const helpers = [A, B, C];
  let aStale = true;
  const pool = new HelperPool(helpers, {
    ...sink, sleep: noSleep, rotateThreshold: 1,
    getTip: async (base) => {
      if (base === A) {
        if (aStale) return tip(10); // stale answer, accrues primaryStale
        throw new Error('down');    // then hard-fails → rotates to B
      }
      return base === B ? tip(10) : tip(20); // B is also stale; C is best
    },
  });
  await pool.getBestTip();
  await pool.getBestTip(); // primaryStale = 2 on A
  assert.equal(pool.primary(), A);
  aStale = false;
  await pool.getBestTip(); // A hard-fails, rotateThreshold 1 → rotate to B
  assert.equal(pool.primary(), B);
  await pool.getBestTip(); // B answers stale ONCE — must not be handed off yet
  assert.equal(pool.primary(), B, 'new primary starts its own staleness streak');
});
