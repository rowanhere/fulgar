import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MinerCoordinator, type CoordinatorDeps } from './miner.js';

// the busy flag must ALWAYS reset, even when submit() or syncCatchUp() throws —
// otherwise the miner wedges (every future solve / tip-advance early-returns on busy,
// the stale grind keeps running, found blocks are ignored). Tested via the injected
// CoordinatorDeps with no real grind pool / chain.

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const TIP = new Uint8Array(32);
const NINE = new Uint8Array(32).fill(9);

function makeCoord(opts: {
  submit?: () => Promise<{ label: string }>;
  catchUp?: () => Promise<void>;
  catchUpChanged?: boolean;
  buildTemplate?: () => any;
  retryRebuildMs?: number;
  tipHash?: () => Uint8Array;
} = {}): {
  coord: MinerCoordinator;
  calls: { builds: number; starts: number; stops: number; submits: number; catchUps: number; logs: string[] };
  solve: (nonce: number) => void;
  exhaust: () => void;
} {
  const calls = { builds: 0, starts: 0, stops: 0, submits: 0, catchUps: 0, logs: [] as string[] };
  let solvedCb: ((nonce: number) => void) | null = null;
  let exhaustedCb: (() => void) | null = null;
  const deps: CoordinatorDeps = {
    buildTemplate: () => {
      calls.builds++;
      return opts.buildTemplate ? opts.buildTemplate() : { header: { height: 1, prevHash: TIP }, headerBytes: new Uint8Array(), targetHex: 'ff' } as any;
    },
    poolStart: (_hb, _tx, onSolved, _onHashrate, onExhausted) => {
      calls.starts++;
      solvedCb = onSolved;
      exhaustedCb = onExhausted;
    },
    poolStop: () => { calls.stops++; },
    submit: async () => { calls.submits++; return opts.submit ? await opts.submit() : { label: 'h=1' }; },
    syncCatchUp: async () => { calls.catchUps++; if (opts.catchUp) await opts.catchUp(); return opts.catchUpChanged ?? true; },
    onLog: (m) => calls.logs.push(m),
    retryRebuildMs: opts.retryRebuildMs,
    tipHash: () => (opts.tipHash ? opts.tipHash() : TIP),
  };
  const coord = new MinerCoordinator(deps);
  return { coord, calls, solve: (n) => solvedCb!(n), exhaust: () => exhaustedCb!() };
}

test('onSolved (happy path): poolStop, submit, rebuild; busy resets so the next solve is processed', async () => {
  const { coord, calls, solve } = makeCoord();
  coord.rebuild();
  assert.equal(calls.builds, 1);
  solve(5);
  await flush();
  assert.equal(calls.stops, 1);
  assert.equal(calls.submits, 1);
  assert.equal(calls.builds, 2, 'rebuilt after the solve');
  assert.ok(calls.logs.some((l) => l.startsWith('solved:')));
});

test('onSolved: a THROWING submit still resets busy + rebuilds (no wedge)', async () => {
  const { coord, calls, solve } = makeCoord({ submit: async () => { throw new Error('helpers down'); } });
  coord.rebuild();
  solve(5);
  await flush();
  assert.equal(calls.builds, 2, 'rebuilt despite the submit throw');
  // The real proof of "no wedge": a SECOND solve is processed (busy was reset).
  solve(6);
  await flush();
  assert.equal(calls.submits, 2, 'second solve processed → busy did not stick');
  assert.equal(calls.builds, 3);
});

test('tipAdvanced (happy path): catchUp, poolStop, rebuild; busy resets', async () => {
  const { coord, calls } = makeCoord();
  coord.rebuild();
  await coord.tipAdvanced();
  assert.equal(calls.catchUps, 1);
  assert.equal(calls.stops, 1);
  assert.equal(calls.builds, 2, 'rebuilt on the new tip');
});

test('tipAdvanced: a THROWING syncCatchUp resets busy AND stops the known-stale grind (no private fork); a later catch-up rebuilds', async () => {
  let fail = true;
  const { coord, calls } = makeCoord({ catchUp: async () => { if (fail) throw new Error('getBlocks 500'); } });
  coord.rebuild();
  assert.equal(calls.builds, 1);
  await coord.tipAdvanced(); // catchUp throws
  // the tip moved (that's why we're here) so the template is known-stale — STOP it
  // (a stale solve could be adopted via a lagging helper → private fork). No rebuild.
  assert.equal(calls.stops, 1, 'stale grind stopped on catch-up failure');
  assert.equal(calls.builds, 1, 'no rebuild on failure');
  // busy must have reset → a subsequent successful tip-advance proceeds.
  fail = false;
  await coord.tipAdvanced();
  assert.equal(calls.catchUps, 2);
  assert.equal(calls.stops, 2, 'stop again + rebuild on the successful catch-up');
  assert.equal(calls.builds, 2);
});

test('tipAdvanced with an UNCHANGED chain does not stop or rebuild the grind (anti-churn pin)', async () => {
  // A stale-but-answering helper disagreeing with our chain must not restart
  // the grind every poll tick — catchUp reports "nothing changed" and the
  // running template stays valid (live-observed churn scenario, 2026-07-25).
  const { coord, calls } = makeCoord({ catchUpChanged: false });
  coord.rebuild();
  await coord.tipAdvanced({ height: 10, tipHash: 'ff' });
  assert.equal(calls.catchUps, 1);
  assert.equal(calls.stops, 0, 'grind not stopped');
  assert.equal(calls.builds, 1, 'no rebuild — only the initial one');
});

test('tipAdvanced with a CHANGED chain stops the stale grind and rebuilds', async () => {
  const { coord, calls } = makeCoord({ catchUpChanged: true });
  coord.rebuild();
  await coord.tipAdvanced({ height: 10, tipHash: 'ff' });
  assert.equal(calls.stops, 1);
  assert.equal(calls.builds, 2);
});

test('tipAdvanced passes sourceBase through to syncCatchUp untouched', async () => {
  let seen: unknown;
  const coord = new MinerCoordinator({
    buildTemplate: () => ({ header: {}, headerBytes: new Uint8Array(), targetHex: 'ff' } as any),
    poolStart: () => {}, poolStop: () => {},
    submit: async () => ({ label: 'x' }),
    syncCatchUp: async (rt) => { seen = rt; return false; },
    onLog: () => {},
    tipHash: () => TIP,
  });
  await coord.tipAdvanced({ height: 7, tipHash: 'aa', sourceBase: 'https://x.example' });
  assert.deepEqual(seen, { height: 7, tipHash: 'aa', sourceBase: 'https://x.example' });
});

test('HIGH rebuild-guard: a throwing buildTemplate is caught + logged (no unhandled rejection), busy resets', async () => {
  let builds = 0;
  const logs: string[] = [];
  let solvedCb: ((n: number) => void) | null = null;
  const deps: CoordinatorDeps = {
    buildTemplate: () => {
      builds++;
      if (builds >= 2) throw new Error('chain in a bad state'); // startup build ok; the post-solve rebuild throws
      return { header: { height: 1 }, headerBytes: new Uint8Array(), targetHex: 'ff' } as any;
    },
    poolStart: (_h, _t, onSolved) => { solvedCb = onSolved; },
    poolStop: () => {},
    submit: async () => ({ label: 'h=1' }),
    syncCatchUp: async () => true,
    onLog: (m) => logs.push(m),
    tipHash: () => TIP,
  };
  const coord = new MinerCoordinator(deps);
  coord.rebuild();   // build #1 ok
  solvedCb!(5);      // onSolved → submit → finally safeRebuild → build #2 THROWS (must be caught)
  await flush();
  assert.ok(logs.some((l) => /error:rebuild failed/.test(l)), 'rebuild failure surfaced via the error: channel');
  // No unhandled rejection (the runner would fail the test). busy must have reset:
  let caughtUp = false;
  deps.syncCatchUp = async () => { caughtUp = true; return true; };
  await coord.tipAdvanced();
  assert.equal(caughtUp, true, 'busy reset → a later tip-advance still runs after the rebuild failure');
  coord.dispose();
});

test('busy guard: a tip-advance in progress blocks a re-entrant solve', async () => {
  let release: (() => void) | null = null;
  const { coord, calls, solve } = makeCoord({ catchUp: () => new Promise<void>((r) => { release = () => r(); }) });
  coord.rebuild();
  const adv = coord.tipAdvanced(); // enters, awaits catchUp (busy=true)
  await flush();
  solve(9); // should early-return: busy
  await flush();
  assert.equal(calls.submits, 0, 'solve ignored while a catch-up is in flight');
  release!();
  await adv;
  assert.equal(calls.catchUps, 1);
});

test('safeRebuild retries without waiting for a tip advance after buildTemplate throws', async () => {
  let remainingFailures = 1;
  const { coord, calls, exhaust } = makeCoord({
    retryRebuildMs: 5,
    buildTemplate: () => {
      if (calls.builds > 1 && remainingFailures-- > 0) throw new Error('temporary bad tip');
      return { header: { height: calls.builds }, headerBytes: new Uint8Array(), targetHex: 'ff' } as any;
    },
  });
  coord.rebuild();
  exhaust();
  assert.equal(calls.builds, 2, 'first safe rebuild attempted immediately');
  assert.ok(calls.logs.some((l) => /error:rebuild failed/.test(l)), 'failure logged');
  await wait(25);
  assert.equal(calls.builds, 3, 'retry rebuilt without a new tip');
  assert.equal(calls.starts, 2, 'startup + successful retry started the pool');
  coord.dispose();
});

test('dispose cancels a pending rebuild retry', async () => {
  const { coord, calls, exhaust } = makeCoord({
    retryRebuildMs: 5,
    buildTemplate: () => {
      if (calls.builds > 1) throw new Error('still bad');
      return { header: { height: 1 }, headerBytes: new Uint8Array(), targetHex: 'ff' } as any;
    },
  });
  coord.rebuild();
  exhaust();
  assert.equal(calls.builds, 2);
  coord.dispose();
  await wait(25);
  assert.equal(calls.builds, 2, 'pending retry was cleared');
});

test('repeated rebuild failures keep only one retry timer pending', async () => {
  let fail = true;
  const { coord, calls, exhaust } = makeCoord({
    retryRebuildMs: 8,
    buildTemplate: () => {
      if (calls.builds > 1 && fail) throw new Error('not ready');
      return { header: { height: calls.builds }, headerBytes: new Uint8Array(), targetHex: 'ff' } as any;
    },
  });
  coord.rebuild();
  exhaust();
  exhaust();
  exhaust();
  assert.equal(calls.builds, 4, 'three explicit rebuild attempts failed');
  fail = false;
  await wait(30);
  assert.equal(calls.builds, 5, 'only the latest pending retry fired');
  assert.equal(calls.starts, 2, 'startup + one retry success');
  coord.dispose();
});

test('a pending rebuild retry DEFERS while a tip catch-up holds busy (no mid-catchUp grind)', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let failNext = false;
  const { coord, calls, exhaust } = makeCoord({
    retryRebuildMs: 5,
    catchUp: () => gate, // tipAdvanced holds busy until we release the gate
    buildTemplate: () => {
      if (failNext) { failNext = false; throw new Error('bad tip'); }
      return { header: { height: calls.builds }, headerBytes: new Uint8Array(), targetHex: 'ff' } as any;
    },
  });
  coord.rebuild();            // builds=1 ok
  failNext = true;
  exhaust();                  // builds=2 throws → retry scheduled (5ms)
  assert.equal(calls.builds, 2);
  const startsBefore = calls.starts;
  const adv = coord.tipAdvanced(); // busy=true; awaits the gated catch-up (hangs)
  await wait(20);             // the 5ms retry matures (repeatedly) DURING the hang
  assert.equal(calls.builds, 2, 'retry deferred while busy — no rebuild mid-catchUp');
  assert.equal(calls.starts, startsBefore, 'no grind started mid-catchUp');
  release();                  // catch-up resolves → tipAdvanced poolStop + safeRebuild
  await adv;
  await flush();
  assert.equal(calls.builds, 3, 'tipAdvanced rebuilt on the new tip after catch-up');
  await wait(15);
  assert.equal(calls.builds, 3, 'no leftover retry fired (tipAdvanced cleared it)');
  coord.dispose();
});

test('a solve during a NO-OP tip-advance is queued and submitted after (the dropped-reward fix)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { coord, calls, solve } = makeCoord({ catchUp: () => gate, catchUpChanged: false });
  coord.rebuild();
  const adv = coord.tipAdvanced({ height: 2, tipHash: 'aa' });
  await flush();
  solve(7); // arrives while the catch-up holds busy
  await flush();
  assert.equal(calls.submits, 0, 'queued, not submitted mid-op');
  assert.ok(calls.logs.some((l) => l.includes('queued')));
  release();
  await adv;
  assert.equal(calls.submits, 1, 'queued solve submitted after the busy op');
  assert.ok(calls.logs.some((l) => l.startsWith('solved:')));
  assert.equal(calls.builds, 2, 'rebuilt after the drained submit, like the direct path');
});

test('a solve during a REAL advance is discarded with the supersede log', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { coord, calls, solve } = makeCoord({ catchUp: () => gate, catchUpChanged: true, tipHash: () => NINE });
  coord.rebuild();
  const adv = coord.tipAdvanced({ height: 2, tipHash: 'aa' });
  await flush();
  solve(7);
  await flush();
  release();
  await adv;
  assert.equal(calls.submits, 0, 'a stale-parent solve is never broadcast');
  assert.ok(calls.logs.some((l) => l.includes('superseded')));
});

test('a second solve during a submit is dropped once the first adopts (height already won)', async () => {
  let releaseSubmit!: () => void;
  const submitGate = new Promise<void>((r) => { releaseSubmit = r; });
  let tip = TIP;
  const { coord, calls, solve } = makeCoord({
    submit: async () => { await submitGate; tip = NINE; return { label: 'h=1' }; },
    tipHash: () => tip,
  });
  coord.rebuild();
  solve(1); await flush();
  solve(2); await flush(); // queued behind the in-flight submit
  assert.equal(calls.submits, 1);
  releaseSubmit(); await wait(5);
  assert.equal(calls.submits, 1, 'pending dropped — the tip moved to our own block');
  assert.ok(calls.logs.some((l) => l.includes('superseded')));
});

test('the catch-up FAILURE path always discards a queued solve (lagging-helper trap)', async () => {
  let reject!: (e: Error) => void;
  const gate = new Promise<void>((_r, rj) => { reject = rj; });
  const { coord, calls, solve } = makeCoord({ catchUp: () => gate, catchUpChanged: false });
  coord.rebuild();
  const adv = coord.tipAdvanced({ height: 2, tipHash: 'aa' });
  await flush();
  solve(7);
  await flush();
  reject(new Error('network down'));
  await adv;
  assert.equal(calls.submits, 0, 'no broadcast when the network state is unverifiable');
  assert.ok(calls.logs.some((l) => l.includes('discarded')));
  // No wedge: a later direct solve still processes.
  solve(8); await flush();
  assert.equal(calls.submits, 1);
});

test('dispose() clears a pending solve (nothing submits after dispose)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { coord, calls, solve } = makeCoord({ catchUp: () => gate, catchUpChanged: false });
  coord.rebuild();
  const adv = coord.tipAdvanced({ height: 2, tipHash: 'aa' });
  await flush();
  solve(9); await flush();
  coord.dispose();
  release();
  await adv;
  assert.equal(calls.submits, 0);
});
