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

test('EVERY hint variant is ASCII-only (ConsoleReporter invariant: no em-dash, no SGR, no unicode)', () => {
  // Cover all three config phrasings plus the Node hint - an em-dash slipping
  // into the duty-only or workers-only branch would corrupt piped logs.
  const variants: PerfInputs[] = [
    { ...maxed, throttle: 0.75, workers: 9, nodeMajor: PERF_NODE_MAJOR - 2 }, // both + node
    { ...maxed, throttle: 0.5 },                                              // duty only
    { ...maxed, workers: 6 },                                                 // workers only
  ];
  let seen = 0;
  for (const v of variants) {
    for (const line of perfHints(v)) {
      seen++;
      assert.ok(/^[\r\n\t\x20-\x7e]*$/.test(line), `not ASCII-only: ${JSON.stringify(line)}`);
    }
  }
  assert.equal(seen, 4, 'expected 4 lines across the variants (both+node, duty, workers)');
});

test('the worker remedy is phrased as something to TRY, not a guaranteed maximum', () => {
  // usableCores counts LOGICAL cpus; on an SMT box the physical count often
  // mines faster, so promising "full speed" would contradict the README.
  const out = perfHints({ ...maxed, workers: 4 });
  assert.match(out[0]!, /try Workers up to 10/);
  assert.ok(!/full speed/.test(out[0]!), `must not promise full speed: ${out[0]}`);
});

test('perfHints stays silent on nonsensical numeric input instead of advising nonsense', () => {
  // Production clamps these, but the seam is exported.
  assert.deepEqual(perfHints({ ...maxed, throttle: -0.5 }), [], 'negative duty');
  assert.deepEqual(perfHints({ ...maxed, workers: -1, usableCores: 1 }), [], 'negative workers');
  assert.deepEqual(perfHints({ ...maxed, throttle: Number.NaN }), [], 'NaN duty');
  assert.deepEqual(perfHints({ ...maxed, workers: Number.NaN }), [], 'NaN workers');
  assert.deepEqual(perfHints({ ...maxed, throttle: 1.5 }), [], 'duty above 1 is not "slow"');
  assert.deepEqual(perfHints({ ...maxed, workers: 12 }), [], 'more workers than cores is not "spare"');
  // A duty that rounds to 0% would render the meaningless "running at 0% duty".
  assert.deepEqual(perfHints({ ...maxed, throttle: 0.001 }), [], 'duty rounding to 0%');
  // Resolved worker counts are always whole; a fractional one would render
  // "running on 1.5 of 10 cores".
  assert.deepEqual(perfHints({ ...maxed, workers: 1.5 }), [], 'fractional workers');
  assert.deepEqual(perfHints({ ...maxed, workers: 2, usableCores: 10.5 }), [], 'fractional core allowance');
});

test('a small-but-renderable duty still gets honest advice', () => {
  // The gate is the RENDERED percentage, not config's 0.05 floor: 3% is
  // unusual but truthful, so it must still be advised rather than swallowed.
  const out = perfHints({ ...maxed, throttle: 0.03 });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /3% duty/);
});

test('nodeMajorOf parses a version string and survives junk', () => {
  assert.equal(nodeMajorOf('26.0.0'), 26);
  assert.equal(nodeMajorOf('24.18.0'), 24);
  assert.equal(nodeMajorOf('v22.1.0'), 22); // tolerate a leading v
  assert.equal(nodeMajorOf(''), 0);         // unparseable -> 0
  assert.equal(nodeMajorOf('garbage'), 0);
  // A partially-malformed string must NOT yield a confident, wrong major.
  assert.equal(nodeMajorOf('24garbage'), 0);
  assert.equal(nodeMajorOf('v24x'), 0);
  assert.equal(nodeMajorOf('26'), 26);       // bare major, no dot
});

test('an unparseable Node version does not produce a bogus warning', () => {
  // nodeMajorOf('') === 0, which is < PERF_NODE_MAJOR. Callers pass a real
  // process.versions.node, but a 0 must not render as "you are on Node 0".
  const out = perfHints({ ...maxed, nodeMajor: 0 });
  assert.deepEqual(out, []);
});
