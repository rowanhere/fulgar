// src/minerd/watchdog.ts — shared grind-stall watchdog (classic pool + negotiated).
// Extracted from poolClient.ts so negotiatedClient can use it without the
// poolClient import cycle (the poolEngine.ts precedent).

/** Grind-watchdog tuning. A grind that HAS produced then goes silent for STALL_MS is a
 *  stall; a grind that has NOT produced yet (booting / just re-issued) is given
 *  BOOT_GRACE_MS since the episode (re)started before that counts — so a slow VPS
 *  worker isn't killed mid-boot, and a respawn's fresh workers get time to come up. */
export const WATCHDOG_STALL_MS = 12_000;
export const WATCHDOG_BOOT_GRACE_MS = 30_000;
/** Stall strikes before the heavy remedy. The 1st..(K-1)th stall re-applies the
 *  current job to the existing workers (cheap); the Kth respawns the worker pool. */
export const WATCHDOG_RESPAWN_AFTER_STRIKES = 2;
export const WATCHDOG_INTERVAL_MS = 3_000;

export type WatchdogAction = 'ok' | 're-apply' | 'respawn';

/**
 * Pure decision for the grind watchdog, evaluated on every WATCHDOG_INTERVAL_MS tick.
 *
 * The old watchdog respawned ALL workers on the FIRST STALL_MS with no hashes. On a
 * constrained / oversubscribed VPS a full respawn (fresh tsx workers + wasm init) can
 * itself take longer than STALL_MS, so it never recovers before the next check and
 * self-sustains — the user sees "no hashes for >12s — restarting grind" on repeat.
 *
 * This escalates and separates two states so ordinary job churn can't mask a real stall
 * and a slow boot isn't mistaken for one:
 *  - dormant while stopped or between jobs (no active job);
 *  - `producing` (the current grind episode has landed ≥1 hash): a stall is msSinceTick
 *    past STALL_MS — keyed on the last REAL hash, NOT reset by job changes;
 *  - not yet `producing` (booting / just re-issued): a stall is msSinceGrindStart past
 *    BOOT_GRACE_MS — the episode never produced within its grace;
 *  - on a stall → RE-APPLY the job to the existing workers (cheap; recovers a transient
 *    starvation / a briefly wedged grind) for the first (K-1) strikes, then RESPAWN on
 *    the Kth. `strikes` counts prior consecutive strikes; a real hash resets it to 0.
 */
export function watchdogDecision(args: {
  stopped: boolean;
  hasActiveJob: boolean;
  producing: boolean;
  msSinceTick: number;
  msSinceGrindStart: number;
  strikes: number;
}): WatchdogAction {
  if (args.stopped || !args.hasActiveJob) return 'ok';
  const stalled = args.producing
    ? args.msSinceTick > WATCHDOG_STALL_MS
    : args.msSinceGrindStart > WATCHDOG_BOOT_GRACE_MS;
  if (!stalled) return 'ok';
  return args.strikes + 1 >= WATCHDOG_RESPAWN_AFTER_STRIKES ? 'respawn' : 're-apply';
}
