// src/minerd/demand.ts
//
// The CPU-demand signal behind Smart: Considerate — "how much of the machine is
// idle right now?" — measured in OUR OWN scheduling domain.
//
// The old version asked os.cpus(), which is wrong in two environments and right in
// none of the interesting ones:
//
//   * In a CONTAINER, os.cpus() reports the HOST's processors, so the idle fraction
//     is the host's. Our throttle barely moves it — the control loop's feedback was
//     decoupled from its own action, which is what made Considerate oscillate
//     0-100-0-100 on a VPS and throw extra stale shares.
//   * On a VM, Node's CpuTimes has no `steal` field, so time the hypervisor took
//     from us lands in NEITHER idle nor busy: it silently vanishes from the totals
//     and the resulting fraction is a fiction.
//
// So we pick the narrowest domain we can PROVE, and fall back to the old behavior
// rather than guess:
//
//   quota + readable cgroup usage  -> 'cgroup'    capacity = the quota
//   not in a container + /proc/stat -> 'procstat'  capacity = cores × (1 − steal)
//   otherwise (macOS, Windows, …)   -> 'oscpus'    capacity = cores   (the old law)
//
// THE INVARIANT THAT MATTERS: never pair a host-wide numerator with a quota-sized
// capacity. If a quota exists but the cgroup usage file is unreadable (cgroup v1 with
// a split cpuacct mount, gVisor, …) we do NOT fall through to /proc/stat — inside a
// container that file describes the whole host, and dividing a 32-core host's busy
// time by a 2-core allowance yields "the box is 100% busy with someone else's work"
// forever, pinning the miner at the 5% floor on a machine that is actually idle. We
// fall back to os.cpus() (today's behavior) instead: over-polite, never wedged.
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { cgroupCpuUsageUsec, cpuBudget, type ReadText } from './cpuBudget.js';

/** Where the reading came from, and what it is relative to. */
export type CpuSource = 'cgroup' | 'procstat' | 'oscpus';

export interface CpuReading {
  /** Fraction of the capacity available to us that is idle, 0…1. */
  idleShare: number;
  /** Cores we can actually use (a quota, or cores net of steal). Used for loop gain. */
  capacityCores: number;
  source: CpuSource;
}

export interface DemandSignal {
  /** Legacy scalar: the idle fraction, or null if unknown. */
  cpuIdleFraction(): number | null;
  /** Richer reading, when the sampler can prove its domain. */
  read?(): CpuReading | null;
}

type CpuTimes = os.CpuInfo['times'];

/** Cumulative jiffies from the aggregate `cpu ` line of /proc/stat. */
export interface ProcStat {
  /** user+nice+system+irq+softirq — work that actually ran. */
  busy: number;
  /** idle+iowait — capacity that was available and unused. */
  idle: number;
  /** Time the hypervisor took. NOT ours, and NOT idle. */
  steal: number;
}

/**
 * Parse the aggregate `cpu` line: cpu user nice system idle iowait irq softirq steal …
 * Pre-2.6.11 kernels have no steal column — treated as 0, never NaN.
 */
export function parseProcStat(text: string): ProcStat | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  return {
    busy: user + nice + system + irq + softirq,
    idle: idle + iowait,
    steal,
  };
}

/**
 * Idle share from two /proc/stat samples.
 *
 * STEAL IS EXCLUDED FROM THE DENOMINATOR, deliberately. Stolen time is capacity we
 * never had — it is not idle (we couldn't use it) and it is not competition (no
 * process in this guest ran). Dividing by (busy + idle) therefore asks "of the CPU we
 * actually got, how much went unused?", which is linear in our own duty cycle and
 * invariant to the steal level. Counting steal as busy would instead make a 50%-stolen
 * VM look permanently half-loaded and throttle us to half of what we can have.
 */
export function idleShareFromProcStat(prev: ProcStat, next: ProcStat): number | null {
  const busy = next.busy - prev.busy;
  const idle = next.idle - prev.idle;
  // A counter that went BACKWARDS is a broken sample, not a busy machine. The kernel's
  // `iowait` is explicitly documented as able to decrease, so this is reachable in
  // normal operation — and treating it as "zero idle" would slam the throttle down for
  // no reason. Reject the sample; the caller holds.
  if (busy < 0 || idle < 0) return null;
  const available = busy + idle;
  if (!(available > 0)) return null;
  return clamp01(idle / available);
}

/** Steal as a fraction of nominal capacity, for sizing what we can actually use. */
export function stealFractionFromProcStat(prev: ProcStat, next: ProcStat): number {
  const busy = next.busy - prev.busy;
  const idle = next.idle - prev.idle;
  const steal = next.steal - prev.steal;
  const total = busy + idle + steal;
  if (!(total > 0)) return 0;
  return clamp01(steal / total);
}

/** The pre-existing os.cpus() law. Kept verbatim — it is the fallback, and it is fine
 *  on a real machine, which is the only place it now runs. */
export function idleFractionFromCpuDeltas(prev: CpuTimes[], next: CpuTimes[]): number | null {
  let idle = 0, total = 0;
  for (let i = 0; i < next.length; i++) {
    const p = prev[i], n = next[i];
    if (!p || !n) continue;
    // A BACKWARDS counter (cpu hot-plug, a core going offline and returning, a
    // host-side counter reset) yields negative deltas that quietly corrupt the
    // ratio — one core reading backwards can cancel another's real work and make
    // a busy box look idle, which is exactly when Considerate must NOT ramp up.
    // The cgroup and /proc/stat readers in this file already reject-and-hold on
    // that; this fallback silently did not. Returning null makes the caller HOLD
    // its current duty, matching them.
    const dIdle = n.idle - p.idle;
    const dTotal = (n.user - p.user) + (n.nice - p.nice) + (n.sys - p.sys) + dIdle + (n.irq - p.irq);
    if (dIdle < 0 || dTotal < 0) return null;
    idle += dIdle;
    total += dTotal;
  }
  return total > 0 ? idle / total : null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

const PROC_STAT = '/proc/stat';

const defaultRead: ReadText = (path) => {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
};

export interface DemandDeps {
  read?: ReadText;
  exists?: (path: string) => boolean;
  osCpus?: () => os.CpuInfo[];
  /** Affinity-aware core count (cpuset/taskset) — the other half of the allowance. */
  parallelism?: number;
  /** MONOTONIC milliseconds; used to turn a cgroup µs counter into cores. */
  now?: () => number;
  /** One-time note when we cannot prove a domain and fall back. */
  onWarn?: (msg: string) => void;
}

export function createDemandSignal(deps: DemandDeps = {}): DemandSignal {
  const read = deps.read ?? defaultRead;
  const exists = deps.exists ?? existsSync;
  const osCpus = deps.osCpus ?? (() => os.cpus());
  // MONOTONIC, not Date.now(): the cgroup rate is usage-microseconds over ELAPSED time,
  // so an NTP step (or any clock adjustment) would corrupt the denominator and hand the
  // controller a fictitious idle reading.
  const now = deps.now ?? (() => performance.now());
  const onWarn = deps.onWarn ?? (() => {});

  const budget = cpuBudget({
    read,
    exists,
    ...(deps.osCpus ? { hostCores: osCpus().length } : {}),
    ...(deps.parallelism !== undefined ? { parallelism: deps.parallelism } : {}),
  });
  const contained = budget.container;

  // Resolve the domain ONCE: these facts don't change while the process lives.
  //
  // Note what gates the cgroup rung: BEING IN A CONTAINER, not having a quota. RunPod
  // (and k8s' static CPU manager, and LXC pinning) limit by CPUSET and publish no quota
  // at all — a quota-gated check falls straight through to a host-wide reading of a
  // 256-core machine, which is the very bug this is meant to fix. Conversely a plain VM
  // is NOT a container, so we never read its cgroup root (whose usage_usec would fold in
  // steal and invent a phantom competitor).
  let source: CpuSource;
  if (contained && cgroupCpuUsageUsec(read) !== null) {
    source = 'cgroup';
  } else if (!contained && parseProcStat(read(PROC_STAT) ?? '') !== null) {
    source = 'procstat';
  } else {
    source = 'oscpus';
    if (contained) {
      // Boxed in, but we cannot read our own usage — so we cannot separate our load
      // from the host's. Stay on the old law rather than mis-scope the signal.
      onWarn(
        '[minerd] running in a container whose CPU usage is unreadable; '
        + 'Smart: Considerate falls back to host-wide CPU readings and may be imprecise. '
        + 'Use Smart: Max or Manual for a steady rate.',
      );
    }
  }

  const hostCores = Math.max(1, osCpus().length);

  let prevStat: ProcStat | null = source === 'procstat' ? parseProcStat(read(PROC_STAT) ?? '') : null;
  let prevUsage: number | null = source === 'cgroup' ? cgroupCpuUsageUsec(read) : null;
  let prevAt = now();
  let prevTimes: CpuTimes[] = source === 'oscpus' ? osCpus().map((c) => c.times) : [];

  function readCgroup(): CpuReading | null {
    const usage = cgroupCpuUsageUsec(read);
    const at = now();
    // The capacity is the EFFECTIVE allowance — the tighter of the quota and the cpuset.
    // Using the quota alone reads a cpuset-limited container (RunPod: 2 of 256 CPUs, no
    // quota) as unlimited; using the cpuset alone misses `docker --cpus=1.5`.
    const capacity = Math.max(0.01, Math.min(budget.allowanceCores, hostCores));
    if (usage === null || prevUsage === null) { prevUsage = usage; prevAt = at; return null; }
    const elapsedUsec = (at - prevAt) * 1000;
    const usedUsec = usage - prevUsage;
    prevUsage = usage;
    prevAt = at;
    // A counter that went backwards (cgroup migration, reset) is a broken sample, not
    // an idle machine: return null so the loop HOLDS instead of lurching.
    if (!(elapsedUsec > 0) || usedUsec < 0) return null;
    // Cores consumed by EVERYTHING in our cgroup — us, plus any co-tenant beside us.
    const usedCores = usedUsec / elapsedUsec;
    return { idleShare: clamp01(1 - usedCores / capacity), capacityCores: capacity, source: 'cgroup' };
  }

  function readProcStat(): CpuReading | null {
    const next = parseProcStat(read(PROC_STAT) ?? '');
    if (!next || !prevStat) { prevStat = next; return null; }
    const idleShare = idleShareFromProcStat(prevStat, next);
    const steal = stealFractionFromProcStat(prevStat, next);
    prevStat = next;
    if (idleShare === null) return null;
    // Steal is lost capacity: it shrinks what we can use, so the loop gain must see
    // the smaller number. (It does NOT enter idleShare — see idleShareFromProcStat.)
    return {
      idleShare,
      capacityCores: Math.max(0.01, hostCores * (1 - steal)),
      source: 'procstat',
    };
  }

  function readOsCpus(): CpuReading | null {
    const next = osCpus().map((c) => c.times);
    const f = idleFractionFromCpuDeltas(prevTimes, next);
    prevTimes = next;
    if (f === null) return null;
    return { idleShare: clamp01(f), capacityCores: hostCores, source: 'oscpus' };
  }

  const read1 = (): CpuReading | null =>
    source === 'cgroup' ? readCgroup()
      : source === 'procstat' ? readProcStat()
        : readOsCpus();

  return {
    read: read1,
    cpuIdleFraction(): number | null {
      return read1()?.idleShare ?? null;
    },
  };
}
