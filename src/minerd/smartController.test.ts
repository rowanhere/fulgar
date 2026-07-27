import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartController, applyPriorityPolicy, smartStartDuty } from './smartController.js';

// synthetic machine: H/s rises with throttle up to a knee, then flattens/dips (throttle).
function machine(knee = 0.7) {
  return (t: number) => {
    const base = t <= knee ? 700 * t : 700 * knee - 900 * (t - knee); // dips past knee
    return Math.max(0, base);
  };
}

function runWindow(sc: SmartController, hps: number, advance: (ms: number) => void): void {
  for (let s = 0; s < 5; s++) { sc.onHashrate(hps); advance(200); }
  sc.tick();
}

test('hill-climb converges to just below the knee and holds', () => {
  let now = 0; const clock = () => now;
  let applied = 0.75;
  const sink = { setThrottle: (t: number) => { applied = t; } };
  const sc = new SmartController(sink, { dwellMs: 1000, step: 0.05, start: 0.4 }, clock);
  // simulate 200 dwell windows; each window feed the machine's H/s at the applied throttle
  for (let i = 0; i < 200; i++) {
    for (let s = 0; s < 5; s++) { sc.onHashrate(machine()(applied)); now += 200; }
    sc.tick();
  }
  assert.ok(applied >= 0.6 && applied <= 0.75, `settled at ${applied}, expected near knee 0.7`);
});

test('rejects noise without chasing it', () => {
  let now = 0; const clock = () => now;
  let applied = 0.75;
  const sink = { setThrottle: (t: number) => { applied = t; } };
  const sc = new SmartController(sink, { dwellMs: 1000, step: 0.05, start: 0.4 }, clock);
  const jitter = [0.97, 1.03, 0.99, 1.01, 1.0, 1.02, 0.98];

  for (let i = 0; i < 200; i++) {
    const noisyHps = machine()(applied) * jitter[i % jitter.length]!;
    runWindow(sc, noisyHps, (ms) => { now += ms; });
  }

  assert.ok(applied >= 0.6 && applied <= 0.75, `settled at ${applied}, expected near knee 0.7`);
});

test('re-probes after reprobeEveryMs', () => {
  let now = 0; const clock = () => now;
  let applied = 0.75;
  let knee = 0.55;
  const sink = { setThrottle: (t: number) => { applied = t; } };
  const sc = new SmartController(
    sink,
    { dwellMs: 1000, step: 0.05, start: 0.4, reprobeEveryMs: 12_000 },
    clock,
  );

  for (let i = 0; i < 60; i++) {
    runWindow(sc, machine(knee)(applied), (ms) => { now += ms; });
  }
  assert.ok(applied >= 0.5 && applied <= 0.65, `settled at ${applied}, expected near first knee 0.55`);

  knee = 0.8;
  for (let i = 0; i < 80; i++) {
    runWindow(sc, machine(knee)(applied), (ms) => { now += ms; });
  }

  assert.ok(applied >= 0.7 && applied <= 0.85, `re-probed to ${applied}, expected near shifted knee 0.8`);
});

test('considerate backs off when idle drops below headroom, recovers when it rises', () => {
  let idleFrac = 0.5; const demand = { cpuIdleFraction: () => idleFrac };
  let applied = 1; const sink = { setThrottle: (t: number) => { applied = t; } };
  let now = 0;
  const sc = new SmartController(sink, { dwellMs: 1000, start: 0.9 }, () => now,
    { demand, headroom: 0.25 });
  for (let i = 0; i < 30; i++) { for (let s = 0; s < 5; s++){ sc.onHashrate(600); now += 200; } sc.tick(); }
  const high = applied;
  idleFrac = 0.02; // your work eats the CPU -> idle below headroom
  for (let i = 0; i < 30; i++) { for (let s = 0; s < 5; s++){ sc.onHashrate(600); now += 200; } sc.tick(); }
  assert.ok(applied < high, `backed off under demand: ${applied} < ${high}`);
  idleFrac = 0.6; // work subsides
  for (let i = 0; i < 40; i++) { for (let s = 0; s < 5; s++){ sc.onHashrate(600); now += 200; } sc.tick(); }
  assert.ok(applied > 0.5, `recovered when idle returned: ${applied}`);
});

test('applied throttle exposes considerate demand clamp', () => {
  let idleFrac = 0.02; const demand = { cpuIdleFraction: () => idleFrac };
  const sink = { setThrottle: (_t: number) => {} };
  let now = 0;
  const sc = new SmartController(sink, { dwellMs: 300_000, start: 0.9, step: 0.05 }, () => now,
    { demand, headroom: 0.25 });

  for (let i = 0; i < 20; i++) { now += 1000; sc.tick(); }

  assert.ok(sc.appliedThrottle() < sc.currentThrottle());
  assert.equal(sc.isClamped(), true);
});

test('applied throttle matches thermal target in max mode', () => {
  const sink = { setThrottle: (_t: number) => {} };
  let now = 0;
  const sc = new SmartController(sink, { dwellMs: 300_000, start: 0.9, step: 0.05 }, () => now);

  now += 1000; sc.tick();

  assert.equal(sc.appliedThrottle(), sc.currentThrottle());
  assert.equal(sc.isClamped(), false);
});

test('null demand signal => behaves as Max (never demand-limited)', () => {
  let appliedMax = 1; const maxSink = { setThrottle: (t: number) => { appliedMax = t; } };
  let appliedNull = 1; const nullSink = { setThrottle: (t: number) => { appliedNull = t; } };
  let now = 0; const clock = () => now;
  const max = new SmartController(maxSink, { dwellMs: 1000, step: 0.05, start: 0.4 }, clock);
  const considerate = new SmartController(
    nullSink,
    { dwellMs: 1000, step: 0.05, start: 0.4 },
    clock,
    { demand: { cpuIdleFraction: () => null } },
  );

  for (let i = 0; i < 80; i++) {
    for (let s = 0; s < 5; s++) {
      max.onHashrate(machine()(appliedMax));
      considerate.onHashrate(machine()(appliedNull));
      now += 200;
    }
    max.tick();
    considerate.tick();
    assert.equal(appliedNull, appliedMax);
  }
});

test('demand reacts every tick, not gated by the (large) thermal dwell', () => {
  // Huge dwell so the slow thermal loop never runs here — isolates the fast loop.
  // (Regression: demand handling used to sit behind the dwell early-return.)
  let idleFrac = 0.9;
  const demand = { cpuIdleFraction: () => idleFrac };
  let applied = 1; const sink = { setThrottle: (t: number) => { applied = t; } };
  let now = 0;
  const sc = new SmartController(sink, { dwellMs: 300_000, start: 0.9, step: 0.05 }, () => now,
    { demand, headroom: 0.25 });

  idleFrac = 0.0; // CPU demand spikes: backs off within one tick, not one dwell
  now += 1000; sc.tick();
  // Reacts on the TICK (this is the regression this test guards). The size of the step
  // is no longer a magic number: it used to require BACKOFF_GAIN=3, which is past the
  // loop's stability bound (G·λ < 2) and made the throttle hunt ±5% forever on a normal
  // desktop. The gain is now normalized by the plant slope — so assert it moves down
  // immediately and converges quickly, not that it jumps a specific distance.
  assert.ok(applied < 0.9, `fast demand back-off within 1 tick: ${applied}`);
  for (let i = 0; i < 4; i++) { now += 1000; sc.tick(); }
  assert.ok(applied <= 0.2, `converges out of the way in a few ticks: ${applied}`);

  idleFrac = 0.9; // CPU idle returns: recovers gently
  for (let i = 0; i < 20; i++) { now += 1000; sc.tick(); }
  assert.ok(applied > 0.5, `recovered after idle returned: ${applied}`);
});

// ─── phase() tests ────────────────────────────────────────────────────────────

test('phase() returns ramping while still climbing toward the thermal knee', () => {
  let now = 0;
  const sink = { setThrottle: (_t: number) => {} };
  // Large dwell so the slow thermal loop never fires here — isolates ramping state.
  const sc = new SmartController(sink, { dwellMs: 300_000, start: 0.4 }, () => now);
  // On first construction holding=false, applied==t → ramping
  assert.equal(sc.phase(), 'ramping');
  now += 500; sc.tick();
  assert.equal(sc.phase(), 'ramping');
});

test('phase() returns easing when demand clamps applied below the thermal target', () => {
  let idleFrac = 0.0; // CPU fully busy — demand will backoff hard
  const demand = { cpuIdleFraction: () => idleFrac };
  const sink = { setThrottle: (_t: number) => {} };
  let now = 0;
  // Large dwell so the slow thermal loop never fires; isolates the fast demand path.
  const sc = new SmartController(
    sink,
    { dwellMs: 300_000, start: 0.9, step: 0.05 },
    () => now,
    { demand, headroom: 0.25 },
  );
  now += 1000; sc.tick(); // demand spike → demandAllowed drops well below t
  assert.equal(sc.isClamped(), true, 'precondition: should be clamped');
  assert.equal(sc.phase(), 'easing');
});

test('phase() returns holding after the hill-climb settles at the thermal knee', () => {
  let now = 0; const clock = () => now;
  let applied = 0.75;
  const sink = { setThrottle: (t: number) => { applied = t; } };
  const sc = new SmartController(sink, { dwellMs: 1000, step: 0.05, start: 0.4 }, clock);
  // Drive many windows so the slow loop converges
  for (let i = 0; i < 200; i++) {
    for (let s = 0; s < 5; s++) { sc.onHashrate(machine()(applied)); now += 200; }
    sc.tick();
  }
  // After convergence holding should be true (applied==t, holding==true)
  assert.equal(sc.phase(), 'holding', `expected holding after convergence, applied=${applied}`);
});

test('smartStartDuty: the start comes from the mode, not the leftover manual throttle', () => {
  // A lowered manual throttle must NOT seed a Smart run.
  assert.equal(smartStartDuty('max', 0.3), 1);
  assert.equal(smartStartDuty('considerate', 0.3), 0.5);
  // Manual passes the user's value through unchanged.
  assert.equal(smartStartDuty('off', 0.3), 0.3);
  assert.equal(smartStartDuty('off', 0.85), 0.85);
});

test('Smart Max starts full-tilt and holds (no slow ramp from a low manual throttle)', () => {
  let now = 0; const clock = () => now;
  let applied = 0;
  const sink = { setThrottle: (t: number) => { applied = t; } };
  // Max = no demand signal; start derived from the mode despite a low manual 0.3.
  const sc = new SmartController(sink, { dwellMs: 1000, step: 0.05, start: smartStartDuty('max', 0.3) }, clock);
  assert.equal(applied, 1, 'starts at 100% immediately, not the 0.3 manual leftover');
  // Flat machine (no thermal knee): it must stay pinned at full, never ramp.
  for (let i = 0; i < 50; i++) { for (let s = 0; s < 5; s++) { sc.onHashrate(700); now += 200; } sc.tick(); }
  assert.equal(applied, 1, 'holds at 100%');
  assert.equal(sc.phase(), 'holding');
});

test('applyPriorityPolicy: considerate nices, others do not', () => {
  const calls: number[] = [];
  assert.deepEqual(applyPriorityPolicy('considerate', { set: (p) => { calls.push(p); }, get: () => 0 }), { niced: true });
  assert.deepEqual(calls, [10]);
  assert.deepEqual(applyPriorityPolicy('max', { set: (p) => { calls.push(p); }, get: () => 0 }), { niced: false });
  assert.deepEqual(applyPriorityPolicy('off', { set: (p) => { calls.push(p); }, get: () => 0 }), { niced: false });
  assert.deepEqual(calls, [10], 'non-considerate modes never touch priority');
});

test('applyPriorityPolicy: a leftover nice in a non-considerate session yields the restart note', () => {
  const r = applyPriorityPolicy('max', { set: () => {}, get: () => 10 });
  assert.equal(r.niced, false);
  assert.match(r.note!, /restart/i);
  // Considerate itself never notes — it WANTS the nice.
  assert.equal(applyPriorityPolicy('considerate', { set: () => {}, get: () => 10 }).note, undefined);
  // A throwing set (unsupported platform) is silent, not fatal.
  assert.deepEqual(applyPriorityPolicy('considerate', { set: () => { throw new Error('EPERM'); }, get: () => 0 }), { niced: false });
  // A throwing get likewise.
  assert.deepEqual(applyPriorityPolicy('max', { set: () => {}, get: () => { throw new Error('EPERM'); } }), { niced: false });
});
