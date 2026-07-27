import os from 'node:os';
import type { CpuReading, DemandSignal } from './demand.js';

export interface ThrottleSink { setThrottle(t: number): void }
export interface SmartConfig {
  dwellMs?: number; step?: number; improveMargin?: number;
  ewmaAlpha?: number; reprobeEveryMs?: number; start?: number;
}
export interface SmartDemandOptions {
  demand?: DemandSignal;
  headroom?: number;
  /** Grind workers. With the sampler's capacity this gives the plant slope λ = W/C. */
  workers?: number;
  /**
   * Where the DEMAND allowance starts (Considerate: eased, at CONSIDERATE_START).
   *
   * This is separate from SmartConfig.start (the thermal ceiling) on purpose. The
   * applied duty is min(thermal, demand), so seeding the THERMAL ceiling at 0.5 for
   * Considerate — as the first cut did — caps the demand loop at 0.5 and leaves it
   * unable to climb: only the thermal hill-climb can lift the ceiling, at 5% per 25s,
   * so an idle machine took ~2 minutes to reach the duty it should have found in a few
   * seconds (and, if no hashrate arrived in the first window, it latched there until the
   * 4-minute reprobe). Considerate's authority is the demand loop; give it the room.
   */
  demandStart?: number;
}
interface ResolvedSmartDemandOptions {
  demand?: DemandSignal;
  headroom: number;
  workers?: number;
  demandStart?: number;
}
const CLAMP = (t: number) => Math.min(1, Math.max(0.05, t));

/**
 * Demand-loop tuning.
 *
 * The plant: with W workers at duty d against C usable cores, the CPU we consume is
 * ≈ W·d/C of the capacity, so the idle we measure moves with slope λ = W/C against
 * our own duty. A fixed-step controller on that plant is stable only while
 * |1 − G·λ| < 1, i.e. G·λ < 2.
 *
 * The old BACKOFF_GAIN of 3 ignored λ entirely: on a normal desktop (7 workers of 8
 * cores, λ = 0.875) it ran at G·λ = 2.6 — over the bound — so the throttle hunted
 * ±5% forever instead of settling. Normalizing by λ (which we know exactly: we chose
 * W, and the sampler reports C) holds the loop gain at GAIN_NOM on every machine.
 * GAIN_NOM = 1 yields a one-tick correction with a 2× stability margin.
 */
const GAIN_NOM = 1;
/**
 * Only the UPPER clamp exists. A lower clamp would defeat the whole point: with
 * G = GAIN_NOM/λ the loop gain G·λ is exactly 1 at every λ, but flooring G at (say) 0.5
 * makes G·λ = 2 once λ ≥ 4 — at the instability bound, on precisely the oversubscribed
 * boxes the normalization was introduced to protect. The upper clamp is a guard for a
 * very small λ, where the plant model is least trustworthy.
 */
const GAIN_MAX = 6;
/** Ignore an error this small: measurement noise, not a real demand change. Without
 *  it the loop dithers around the setpoint by ±1 step forever. */
const DEADBAND = 0.02;

/** Considerate starts eased; the demand signal yields further from there. */
export const CONSIDERATE_START = 0.5;

/**
 * Starting duty cycle for the grind pool + SmartController, chosen by the SMART
 * MODE — not the leftover MINER_THROTTLE. This is the fix for: lowering the manual
 * throttle, then switching to Smart Max, made Max *start* at that low value and
 * crawl up at step/dwell (e.g. 0.05 / 25s) instead of going full-tilt.
 *
 *   max         → 1   (straight to 100%, and it STAYS there: the hill-climb only
 *                      ever steps UP and 1 is the ceiling, so Max holds full tilt.
 *                      It does not hunt for a lower, cooler-but-faster setpoint —
 *                      use Considerate, or Manual, if you want less than everything.)
 *   considerate → 0.5 (eased; the demand loop — not the climb — is what yields
 *                      below this when the box is busy)
 *   off         → the user's manual throttle, verbatim
 */
export function smartStartDuty(smart: 'off' | 'max' | 'considerate', manualThrottle: number): number {
  if (smart === 'max') return 1;
  if (smart === 'considerate') return CONSIDERATE_START;
  return manualThrottle;
}

/** Considerate is the only mode allowed to lower the process priority (nice 10):
 *  Manual/Max users asked for speed, and a nice is STICKY — an unprivileged
 *  process can never raise its priority back, so a Considerate session's nice
 *  survives a mode switch until the process restarts. For non-Considerate modes
 *  this detects a leftover nice and returns a one-line note so the session can
 *  say why it is slower and how to fix it. All three mining paths (solo,
 *  classic pool, negotiated) call this — one policy, one place. os hooks
 *  injectable for tests. */
export function applyPriorityPolicy(
  smart: 'off' | 'max' | 'considerate',
  hooks: { set?: (prio: number) => void; get?: () => number } = {},
): { niced: boolean; note?: string } {
  const set = hooks.set ?? ((p: number): void => { os.setPriority(p); });
  const get = hooks.get ?? ((): number => os.getPriority());
  if (smart === 'considerate') {
    try { set(10); return { niced: true }; } catch { return { niced: false }; }
  }
  try {
    if (get() > 0) {
      return { niced: false, note: 'process priority is still lowered from an earlier Considerate session — restart the miner to restore full priority' };
    }
  } catch { /* unreadable priority — nothing to report */ }
  return { niced: false };
}

export class SmartController {
  private t: number; private bestT: number; private bestHps = 0;
  private applied: number;
  private ewma = 0; private seeded = false;
  private dir = 1; private holding = false;
  private windowStart: number; private lastReprobe: number;
  private readonly cfg: Required<SmartConfig>;
  private readonly opts: ResolvedSmartDemandOptions;
  private demandAllowed = 1;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sink: ThrottleSink,
    cfg: SmartConfig = {},
    private now: () => number = Date.now,
    opts: SmartDemandOptions = {},
  ) {
    this.cfg = {
      dwellMs: cfg.dwellMs ?? 25_000, step: cfg.step ?? 0.05,
      improveMargin: cfg.improveMargin ?? 0.01, ewmaAlpha: cfg.ewmaAlpha ?? 0.3,
      reprobeEveryMs: cfg.reprobeEveryMs ?? 240_000, start: cfg.start ?? 0.75,
    };
    this.opts = {
      demand: opts.demand,
      headroom: opts.headroom ?? 0.25,
      workers: opts.workers,
      demandStart: opts.demandStart,
    };
    this.t = CLAMP(this.cfg.start); this.bestT = this.t;
    this.demandAllowed = opts.demandStart !== undefined ? CLAMP(opts.demandStart) : 1;
    // Apply min(thermal, demand) from the very first moment — seeding the sink with the
    // raw thermal ceiling would run a Considerate miner at full tilt for the first tick.
    this.applied = Math.min(this.t, this.demandAllowed);
    this.windowStart = this.now(); this.lastReprobe = this.now();
    this.sink.setThrottle(this.applied);
  }

  currentThrottle(): number { return this.t; }
  appliedThrottle(): number { return this.applied; }
  isClamped(): boolean { return this.applied < this.t - 1e-9; }

  /** Coarse live phase for the UI: 'easing' = demand is holding it below the thermal
   *  target (Considerate yielding); 'ramping' = still climbing toward the max;
   *  'holding' = settled at the sustainable max/knee. */
  phase(): 'ramping' | 'holding' | 'easing' {
    if (this.applied < this.t - 1e-9) return 'easing';
    return this.holding ? 'holding' : 'ramping';
  }

  /**
   * λ = workers / usable cores: how much the measured idle moves per unit of our own
   * duty. Falls back to 1 (the gain is then GAIN_NOM) whenever we can't prove it —
   * an unknown λ must not turn into an aggressive gain.
   */
  private plantSlope(reading: CpuReading | null): number {
    const workers = this.opts.workers;
    if (!reading || !workers || !(reading.capacityCores > 0)) return 1;
    return Math.min(GAIN_MAX, Math.max(0.1, workers / reading.capacityCores));
  }

  onHashrate(hps: number): void {
    if (!this.seeded) { this.ewma = hps; this.seeded = true; }
    else this.ewma = this.cfg.ewmaAlpha * hps + (1 - this.cfg.ewmaAlpha) * this.ewma;
  }

  tick(): void {
    const now = this.now();

    // ── Fast loop (EVERY tick): demand headroom. ──
    // This must react on the ~1s tick cadence, NOT the slow thermal dwell.
    //
    // The reading is scoped to OUR OWN cpu domain (our cgroup under a quota, the
    // guest's own /proc/stat on a VM, os.cpus() on a real machine) — see demand.ts.
    // Reading the host's idle from inside a container is what decoupled this loop
    // from its own action and made it oscillate.
    const reading = this.opts.demand?.read?.() ?? null;
    const idleFrac = reading ? reading.idleShare : (this.opts.demand?.cpuIdleFraction() ?? null);
    // A missing reading means we don't KNOW — which is not the same as "the box is free".
    // Holding is the safe response: a broken sample (counter reset, unreadable file) used
    // to reset demandAllowed to 1, i.e. jump from a polite 10% straight to full tilt for
    // a tick, right on top of whatever the user was doing.
    if (idleFrac !== null) {
      const err = idleFrac - this.opts.headroom;                  // >0 surplus idle, <0 over budget
      const lambda = this.plantSlope(reading);
      if (err > DEADBAND) {
        // Ramp back up gently. Scaled by λ for the same reason as the down-step: on an
        // oversubscribed box (λ≫1) a fixed 5% duty step swings the measured idle far
        // past the deadband and the loop cycles up-down forever.
        this.demandAllowed = CLAMP(this.demandAllowed + this.cfg.step / Math.max(1, lambda));
      } else if (err < -DEADBAND) {
        // Back off fast, proportional to how far idle is below the headroom target, so a
        // sudden CPU spike yields in ~1 tick instead of ~15s. The gain is normalized by
        // the plant slope λ = workers/capacity so one constant is stable on every machine
        // (see GAIN_NOM). NO minimum step: a floor larger than the error is exactly what
        // makes the loop overshoot and hunt.
        const gain = Math.min(GAIN_MAX, GAIN_NOM / lambda);
        this.demandAllowed = CLAMP(this.demandAllowed + err * gain); // err<0 → steps down
      }
      // else: inside the deadband — hold. This is what stops the ±step dither.
    }

    // ── Slow loop (every dwell window): thermal hill-climb on smoothed H/s. ──
    // Skip learning when demand held the throttle below the thermal target:
    // that window's hashrate doesn't reflect this.t, so it must not corrupt the climb.
    if (now - this.windowStart >= this.cfg.dwellMs) {
      this.windowStart = now;
      const limited = this.demandAllowed < this.t - 1e-9;
      if (!limited) {
        const hps = this.ewma;
        if (now - this.lastReprobe >= this.cfg.reprobeEveryMs) {
          this.lastReprobe = now; this.holding = false; this.dir = 1; // resume climbing
        }
        if (!this.holding) {
          const improved = hps > this.bestHps * (1 + this.cfg.improveMargin);
          if (improved) {
            this.bestHps = hps; this.bestT = this.t;
            this.t = CLAMP(this.t + this.dir * this.cfg.step);
            if (this.t === this.bestT) this.holding = true; // hit a clamp
          } else {
            // knee: revert to best and hold with hysteresis
            this.t = this.bestT; this.bestHps = hps; this.holding = true;
          }
        }
      }
    }

    const applied = Math.min(this.t, this.demandAllowed);
    this.applied = applied;
    this.sink.setThrottle(applied);
  }

  start(): void { if (!this.timer) this.timer = setInterval(() => this.tick(), 1000); }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
