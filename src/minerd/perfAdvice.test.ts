import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perfHints, nodeMajorOf, PERF_NODE_MAJOR, type PerfInputs } from './perfAdvice.js';

// A fully-maxed manual miner on a current Node — the silent baseline every other
// case is measured against.
const maxed: PerfInputs = { smart: 'off', throttle: 1, workers: 10, usableCores: 10, nodeMajor: PERF_NODE_MAJOR };

test('perfHints says nothing when the box is already maxed on a current Node', () => {
  assert.deepEqual(perfHints(maxed), []);
});

test('perfHints names BOTH factors when duty and workers are both below max', () => {
  const out = perfHints({ ...maxed, throttle: 0.75, workers: 9 });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /75% duty/);
  assert.match(out[0]!, /9 of 10 cores/);
  assert.match(out[0]!, /MINER_THROTTLE=1/);
  assert.match(out[0]!, /MINER_WORKERS=10/);
});

test('perfHints names ONLY the duty when the worker count is already maxed', () => {
  const out = perfHints({ ...maxed, throttle: 0.5 });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /50% duty/);
  assert.ok(!/cores/.test(out[0]!), `must not mention cores: ${out[0]}`);
  assert.ok(!/MINER_WORKERS/.test(out[0]!), `must not mention MINER_WORKERS: ${out[0]}`);
});

test('perfHints names ONLY the workers when the duty is already 1', () => {
  const out = perfHints({ ...maxed, workers: 6 });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /6 of 10 cores/);
  assert.ok(!/duty/.test(out[0]!), `must not mention duty: ${out[0]}`);
  assert.ok(!/MINER_THROTTLE/.test(out[0]!), `must not mention MINER_THROTTLE: ${out[0]}`);
});

test('perfHints is SILENT about config under Smart: Max (it already goes flat out)', () => {
  assert.deepEqual(perfHints({ ...maxed, smart: 'max', throttle: 0.5, workers: 4 }), []);
});

test('perfHints is SILENT about config under Considerate (being polite is the point)', () => {
  assert.deepEqual(perfHints({ ...maxed, smart: 'considerate', throttle: 0.5, workers: 4 }), []);
});

test('perfHints does not advise more workers than the box may use', () => {
  // usableCores is the cgroup/cpuset-aware allowance, not the host core count.
  assert.deepEqual(perfHints({ ...maxed, workers: 2, usableCores: 2 }), []);
});

test('perfHints warns about an old Node in EVERY mode, config hint or not', () => {
  for (const smart of ['off', 'max', 'considerate'] as const) {
    const out = perfHints({ ...maxed, smart, nodeMajor: PERF_NODE_MAJOR - 2 });
    assert.equal(out.length, 1, `expected exactly the Node hint for smart=${smart}: ${JSON.stringify(out)}`);
    assert.match(out[0]!, /Node 24/);
    assert.match(out[0]!, /nodejs\.org/);
  }
});

test('perfHints emits BOTH hints when an old Node meets a below-max manual config', () => {
  const out = perfHints({ ...maxed, throttle: 0.75, workers: 9, nodeMajor: PERF_NODE_MAJOR - 2 });
  assert.equal(out.length, 2);
  assert.match(out[0]!, /duty/);   // config hint first: it is the one they can fix in-app
  assert.match(out[1]!, /Node/);
});

test('perfHints stays silent on a NEWER Node than the pinned floor', () => {
  assert.deepEqual(perfHints({ ...maxed, nodeMajor: PERF_NODE_MAJOR + 4 }), []);
});

test('every hint is ASCII-only (ConsoleReporter invariant: no em-dash, no SGR, no unicode)', () => {
  const out = perfHints({ ...maxed, throttle: 0.75, workers: 9, nodeMajor: PERF_NODE_MAJOR - 2 });
  assert.equal(out.length, 2);
  for (const line of out) {
    assert.ok(/^[\r\n\t\x20-\x7e]*$/.test(line), `not ASCII-only: ${JSON.stringify(line)}`);
  }
});

test('nodeMajorOf parses a version string and survives junk', () => {
  assert.equal(nodeMajorOf('26.0.0'), 26);
  assert.equal(nodeMajorOf('24.18.0'), 24);
  assert.equal(nodeMajorOf('v22.1.0'), 22); // tolerate a leading v
  assert.equal(nodeMajorOf(''), 0);         // unparseable -> 0
  assert.equal(nodeMajorOf('garbage'), 0);
});

test('an unparseable Node version does not produce a bogus warning', () => {
  // nodeMajorOf('') === 0, which is < PERF_NODE_MAJOR. Callers pass a real
  // process.versions.node, but a 0 must not render as "you are on Node 0".
  const out = perfHints({ ...maxed, nodeMajor: 0 });
  assert.deepEqual(out, []);
});
