import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  idleFractionFromCpuDeltas,
  parseProcStat,
  idleShareFromProcStat,
  stealFractionFromProcStat,
  createDemandSignal,
} from './demand.js';
import type { ReadText } from './cpuBudget.js';

// --- the legacy os.cpus() law (still the fallback on macOS/Windows) ---------

test('idleFractionFromCpuDeltas = idle share of total tick delta', () => {
  const prev = [{ user: 100, nice: 0, sys: 50, idle: 850, irq: 0 }];
  const next = [{ user: 200, nice: 0, sys: 100, idle: 1700, irq: 0 }]; // d: user100 sys50 idle850 => total 1000
  assert.equal(idleFractionFromCpuDeltas(prev as any, next as any), 0.85);
});
test('returns null when no time elapsed', () => {
  const same = [{ user: 1, nice: 0, sys: 1, idle: 1, irq: 0 }];
  assert.equal(idleFractionFromCpuDeltas(same as any, same as any), null);
});

// --- /proc/stat ------------------------------------------------------------

test('parseProcStat: modern line with steal', () => {
  const s = parseProcStat('cpu  100 10 50 800 20 5 5 30 0 0\ncpu0 1 2 3 4\n')!;
  assert.equal(s.busy, 100 + 10 + 50 + 5 + 5); // user+nice+system+irq+softirq
  assert.equal(s.idle, 800 + 20);              // idle+iowait
  assert.equal(s.steal, 30);
});

test('parseProcStat: pre-2.6.11 line without a steal column → steal 0, no NaN', () => {
  const s = parseProcStat('cpu  100 10 50 800\n')!;
  assert.equal(s.steal, 0);
  assert.equal(s.busy, 160);
  assert.equal(s.idle, 800);
});

test('parseProcStat: junk / missing cpu line → null', () => {
  assert.equal(parseProcStat(''), null);
  assert.equal(parseProcStat('intr 123\nctxt 456\n'), null);
  assert.equal(parseProcStat('cpu  x y z w\n'), null);
});

test('STEAL IS EXCLUDED from the idle denominator (it is lost capacity, not load)', () => {
  // 50% of the box was stolen. Of the CPU we ACTUALLY got, half went unused. The right
  // answer is 0.5 — "half of what I can have is idle" — not 0.25, which is what counting
  // steal as busy would say, and which would throttle us to half the hashrate we're
  // entitled to on a stolen VM.
  const prev = { busy: 0, idle: 0, steal: 0 };
  const next = { busy: 100, idle: 100, steal: 200 };
  assert.equal(idleShareFromProcStat(prev, next), 0.5);
  assert.equal(stealFractionFromProcStat(prev, next), 0.5);
});

test('idleShareFromProcStat: no elapsed ticks → null', () => {
  const same = { busy: 5, idle: 5, steal: 0 };
  assert.equal(idleShareFromProcStat(same, same), null);
});

// --- the source ladder + the domain-safety rule -----------------------------

const V2_MAX = '/sys/fs/cgroup/cpu.max';
const V2_STAT = '/sys/fs/cgroup/cpu.stat';
const PROC_STAT = '/proc/stat';
/** Fake os.cpus() whose tick counters actually ADVANCE between calls (a constant
 *  counter yields a zero delta, i.e. no reading at all). Half busy, half idle. */
const cpus = (n: number) => {
  let t = 0;
  return () => {
    t += 1000;
    return Array.from({ length: n }, () => ({
      times: { user: t / 2, nice: 0, sys: 0, idle: t / 2, irq: 0 },
    })) as any;
  };
};

test('container + quota → cgroup domain, capacity = the quota', () => {
  let usec = 0;
  const read: ReadText = (p) => {
    if (p === V2_MAX) return '200000 100000';            // 2 CPUs
    if (p === V2_STAT) return `usage_usec ${usec}\n`;
    return null;
  };
  let t = 0;
  const d = createDemandSignal({ read, exists: (p) => p === '/.dockerenv', osCpus: cpus(64), now: () => t });

  // One second passes; the cgroup burned 1 CPU-second of its 2-core allowance.
  t = 1000; usec = 1_000_000;
  const r = d.read!()!;
  assert.equal(r.source, 'cgroup');
  assert.equal(r.capacityCores, 2);
  assert.ok(Math.abs(r.idleShare - 0.5) < 1e-6, `half the allowance idle, got ${r.idleShare}`);
});

test('CPUSET container, NO quota (RunPod — measured on a real pod) → cgroup domain', () => {
  // The case the first cut missed entirely. cpu.max says "max" (no quota), the container
  // is pinned to 2 of 256 host CPUs, and /sys/fs/cgroup/cpu.stat DOES carry our own
  // usage. Gating the cgroup rung on "has a quota" fell through to a host-wide reading
  // of a 256-core machine — i.e. the original bug, unfixed, on our own fleet's platform.
  let usec = 0;
  let t = 0;
  const read: ReadText = (p) => {
    if (p === V2_MAX) return 'max 100000';               // NO quota — RunPod's real value
    if (p === V2_STAT) return `usage_usec ${usec}\nuser_usec 0\n`;
    if (p === PROC_STAT) return 'cpu 999999 0 999999 10 0 0 0 0\n'; // the HOST's, meaningless here
    return null;
  };
  const d = createDemandSignal({
    read,
    exists: (p) => p === '/.dockerenv',
    osCpus: cpus(256),                 // os.cpus() reports the HOST
    parallelism: 2,                    // the cpuset is what we actually have
    now: () => t,
  });
  t = 1000; usec = 1_500_000;          // burned 1.5 CPU-seconds of our 2-core allowance
  const r = d.read!()!;
  assert.equal(r.source, 'cgroup', 'must NOT fall back to the host-wide signal');
  assert.equal(r.capacityCores, 2, 'capacity is the cpuset, not the 256-core host');
  assert.ok(Math.abs(r.idleShare - 0.25) < 1e-6, `1.5 of 2 cores used → 25% idle, got ${r.idleShare}`);
});

test('FAIL-SAFE: container but cgroup usage UNREADABLE → old law, never host-wide /proc/stat', () => {
  // cgroup v1 with a split cpuacct mount, gVisor, and friends. If we paired the HOST's
  // busy time (from /proc/stat, which inside a container describes the whole host) with
  // our 2-core capacity, we would conclude "someone else is using 30 of my 2 cores" and
  // pin the miner at the 5% floor forever — on a box that is completely idle. That is a
  // ~20x regression versus doing nothing at all. So: fall back to os.cpus().
  const read: ReadText = (p) => {
    if (p === V2_MAX) return '200000 100000';                  // quota exists…
    if (p === PROC_STAT) return 'cpu 999 0 999 10 0 0 0 0\n';  // …and the host looks busy
    return null;                                               // …but cpu.stat is unreadable
  };
  const warns: string[] = [];
  const d = createDemandSignal({
    read,
    exists: (p) => p === '/.dockerenv',
    osCpus: cpus(64),
    onWarn: (m) => warns.push(m),
  });
  const r = d.read!();
  assert.equal(r?.source, 'oscpus', 'must NOT be procstat — that would cross scheduling domains');
  assert.equal(warns.length, 1, 'and it must say so once, rather than silently mis-steer');
  assert.match(warns[0], /container/);
});

test('bare-metal Linux (no quota, not a container) → /proc/stat, steal-aware', () => {
  let ticks = { busy: 0, idle: 0, steal: 0 };
  const read: ReadText = (p) => (p === PROC_STAT
    ? `cpu ${ticks.busy} 0 0 ${ticks.idle} 0 0 0 ${ticks.steal}\n`
    : null);
  const d = createDemandSignal({ read, exists: () => false, osCpus: cpus(8) });
  ticks = { busy: 200, idle: 800, steal: 0 };
  const r = d.read!()!;
  assert.equal(r.source, 'procstat');
  assert.equal(r.capacityCores, 8);         // no steal → the full 8 cores
  assert.ok(Math.abs(r.idleShare - 0.8) < 1e-6);
});

test('a container without a readable quota stays on the old law (never trusts host /proc/stat)', () => {
  const read: ReadText = (p) => (p === PROC_STAT ? 'cpu 100 0 0 900 0 0 0 0\n' : null);
  const d = createDemandSignal({
    read,
    exists: (p) => p === '/.dockerenv',   // we ARE in a container…
    osCpus: cpus(64),                     // …on a 64-core host
  });
  assert.equal(d.read!()?.source, 'oscpus', 'host-wide /proc/stat is meaningless in here');
});

test('macOS/Windows (no /proc, no cgroup) → os.cpus(), exactly as before', () => {
  const d = createDemandSignal({ read: () => null, exists: () => false, osCpus: cpus(10) });
  const r = d.read!();
  assert.equal(r?.source, 'oscpus');
  assert.equal(r?.capacityCores, 10);
});

test('unreadable files never crash and never invent load', () => {
  assert.doesNotThrow(() => {
    const d = createDemandSignal({
      read: () => null,          // every read fails (EACCES/ENOENT swallowed upstream)
      exists: () => false,
      osCpus: cpus(4),
    });
    d.read!();
    d.cpuIdleFraction();
  });
});

test('idleFractionFromCpuDeltas HOLDS (null) when one core reads BACKWARDS while another advances', () => {
  // The real failure needs two cores: a single backwards core makes the summed
  // total non-positive, which the old code already rejected. But a backwards
  // core ALONGSIDE a busy one leaves total > 0 with the idle sum intact, so the
  // ratio exceeds 1 - a box reading as MORE than fully idle, which is exactly
  // when Considerate must not ramp up. cpu hot-plug / a core going offline and
  // returning / a host counter reset all produce this.
  const prev = [
    { user: 100, nice: 0, sys: 0, idle: 1000, irq: 0 }, // core A
    { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 },   // core B
  ];
  const next = [
    { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 },   // A: user counter went BACKWARDS
    { user: 0, nice: 0, sys: 0, idle: 1200, irq: 0 },   // B: advanced normally
  ];
  // Pre-fix this summed to idle=200 / total=100 => 2.0, a nonsensical fraction.
  assert.equal(idleFractionFromCpuDeltas(prev, next), null);
});

test('idleFractionFromCpuDeltas still computes normally on forward counters', () => {
  const prev = [{ user: 100, nice: 0, sys: 50, idle: 1000, irq: 0 }];
  const next = [{ user: 110, nice: 0, sys: 50, idle: 1090, irq: 0 }];
  // 90 idle of 100 total
  assert.equal(idleFractionFromCpuDeltas(prev, next), 0.9);
});
