// src/minerd/perfAdvice.ts
//
// Turns the already-resolved mining configuration into at most two lines of
// ADVICE. Pure: no I/O, no env reads, no side effects, and it never changes a
// setting — the pickers in menu.ts/settings.ts stay the only writers. The
// 2026-07-24 measurements found no engine deficit at all (the client beats a
// browser tab at matched settings); the entire real-world gap is configuration:
// an old Node major (-16%, measured v24.18.0 vs v26 on one box), the silent
// 0.75 headless duty (-13-15%), and autoWorkers leaving a core free (-3.7%).
//
// INVARIANT: every string here is ASCII-only. These lines are emitted through
// ConsoleReporter, which must never carry SGR/OSC-8/unicode (piped logs) - so
// use a plain '-', never an em-dash.

/** The newest Node major we have actually benchmarked. Below this we advise an
 *  upgrade; we never quote a percentage for a version nobody measured. Bump this
 *  (and the copy below) when a newer major is benchmarked. */
export const PERF_NODE_MAJOR = 26;

export interface PerfInputs {
  /** Smart mode. Only 'off' (manual) gets configuration advice. */
  smart: 'off' | 'max' | 'considerate';
  /** The EFFECTIVE start duty, exactly as displayed in the status line. */
  throttle: number;
  /** The resolved worker count. */
  workers: number;
  /** cpuBudget().usableCores - whole workers this box may actually run. */
  usableCores: number;
  /** Major version of the running Node. 0 when unparseable. */
  nodeMajor: number;
}

/** Major version number from a `process.versions.node`-style string; 0 if
 *  unparseable. The major must be followed by a dot or the end of the string,
 *  so junk like '24garbage' yields 0 rather than a confident, wrong "Node 24". */
export function nodeMajorOf(version: string): number {
  const m = /^v?(\d+)(?:\.|$)/.exec(version);
  return m ? Number(m[1]) : 0;
}

/**
 * Zero, one, or two advice lines: a configuration hint (manual mode only) and a
 * Node-version hint (every mode). Empty when there is nothing worth saying.
 *
 * Smart modes get NO configuration hint by design: 'max' already runs at 100%
 * and holds, and 'considerate' is deliberately below max - telling it to speed
 * up would fight the user's own choice.
 */
export function perfHints(i: PerfInputs): string[] {
  const hints: string[] = [];

  if (i.smart === 'off') {
    // Guard the exported seam against values production never produces (config
    // resolution clamps the duty to >= 0.05 and resolves whole workers): a
    // negative duty renders "-50% duty", a duty under 0.005 rounds to the
    // meaningless "0% duty", and a fractional worker count renders "1.5 of 10
    // cores". Advice built on nonsense is worse than silence. The duty gate is
    // the RENDERED percentage rather than config's 0.05 floor, so a hand-built
    // 0.03 still gets honest "3% duty" advice.
    const dutyOk = Number.isFinite(i.throttle) && Math.round(i.throttle * 100) >= 1;
    const coresOk = Number.isInteger(i.workers) && i.workers > 0 && Number.isInteger(i.usableCores) && i.usableCores > 0;
    const slowDuty = dutyOk && i.throttle < 1;
    const spareCores = coresOk && i.workers < i.usableCores;
    if (slowDuty || spareCores) {
      const pct = Math.round(i.throttle * 100);
      const state = slowDuty && spareCores
        ? `running at ${pct}% duty on ${i.workers} of ${i.usableCores} cores`
        : slowDuty
          ? `running at ${pct}% duty`
          : `running on ${i.workers} of ${i.usableCores} cores`;
      // Name each lever BOTH ways: a headless `npm run mine` user has no menu,
      // and a TUI user does not think in environment variables.
      //
      // The worker remedy is "try ... up to N", never "N is the maximum":
      // usableCores counts LOGICAL cpus, and on an SMT/hyper-threaded box the
      // physical-core count usually mines faster (the threads contend for the
      // same execution units). Node cannot portably read the physical count, so
      // promising that the logical count is "full speed" would contradict our
      // own README advice on exactly the machines where it matters most.
      const workerFix = `try Workers up to ${i.usableCores} (MINER_WORKERS=${i.usableCores})`;
      const fix = slowDuty && spareCores
        ? `set Throttle to 100% (MINER_THROTTLE=1) and ${workerFix}`
        : slowDuty
          ? 'set Throttle to 100% (MINER_THROTTLE=1)'
          : workerFix;
      hints.push(`[perf] ${state} - for more speed ${fix}`);
    }
  }

  // A 0 means we could not parse the version; stay quiet rather than print
  // "you are on Node 0".
  if (i.nodeMajor > 0 && i.nodeMajor < PERF_NODE_MAJOR) {
    hints.push(
      `[perf] you are on Node ${i.nodeMajor} - the miner's hash is pure JavaScript, so a newer Node runs it faster ` +
      `(we measured 16% on Node 24 vs 26). Install the current release from nodejs.org`,
    );
  }

  return hints;
}
