// src/minerd/start.ts
// Friendly interactive launcher. On first run it asks for your wallet address,
// remembers it in .env.local, and starts mining at FulgurPool (the default).
// No environment variables required — `npm start` is all a normal user needs.
//
// By default (when stdout is a TTY) `npm start` shows a full-screen numbers
// dashboard. Use `npm start -- --no-tui` or `FULGUR_TUI=0 npm start` for plain
// logs. Press `s` in the dashboard to open settings, or run `npm run settings`.
//
// Advanced: to mine somewhere other than FulgurPool, register extra pools in
// `pools.json` (see pools.example.json). Once you've added at least one, the
// launcher shows a chooser so you can pick FulgurPool, one of your pools, or
// solo. Without any registered pools there is no prompt — it just uses the
// default. Solo is also always reachable via `MINER_POOL=solo` in `.env.local`.
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from './config.js';
import { runMiner, type WarmChain } from './miner.js';
import { runPoolClient } from './poolClient.js';
import { ConsoleReporter, type MinerReporter, type ReporterStatus } from './reporter.js';
import { DashboardReporter } from './tui.js';
import { runStartMenu } from './menu.js';
import { runSettings } from './settings.js';
import { loadEnvLocal, persist, dropBlankPoolEnv } from './envLocal.js';
import { buildTargetModel, persistTarget, type Target, type TargetModel } from './targets.js';
import { resolveEngine } from './engine.js';
import { currentEngine } from './selectors.js';
import { checkForUpdate } from './updateCheck.js';
import { assertNodeVersion } from './version.js';
import { installCrashGuard, installStdioErrorSink } from './crashGuard.js';

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * The one method these prompts need from a readline interface. A plain object
 * with just `question` satisfies this too (structurally) — that is what
 * start.test.ts uses to drive firstRunSetup() without a real TTY (via the
 * `customInput` Readable it feeds into createInterface), mirroring the same
 * narrow-interface trick settings.ts uses for its own editors.
 */
interface RL {
  question(prompt: string): Promise<string>;
}

async function promptWallet(rl: RL): Promise<string> {
  console.log('\n  FulgurMiner — first-time setup');
  console.log('  Open the BrowserCoin app → Wallet → Copy, then paste your address below.');
  console.log('  (Your address is where mining rewards are paid. No password or key is needed.)\n');
  for (;;) {
    const v = (await rl.question('  Your wallet address (64 hex chars): ')).trim().toLowerCase();
    if (HEX64.test(v)) return v;
    console.log("  That doesn't look right — an address is exactly 64 hex characters (0-9, a-f). Try again.\n");
  }
}

/**
 * Show the pool chooser. Only called when the shared model (targets.ts) has at
 * least one custom pool. Renders the SAME rows as before the migration —
 * FulgurPool, the custom pools from pools.json, then Solo — just sourced from
 * buildTargetModel() instead of a hand-built list. brcpool (a built-in like
 * FulgurPool) is deliberately NOT offered here: this first-run chooser has
 * never listed it, and this migration is a pure sourcing change, not a new
 * menu item — `npm run settings` / the arrow menu are where brcpool is picked.
 */
async function promptPool(rl: RL, model: TargetModel): Promise<Target> {
  const fulgurpool = model.targets.find((t) => t.kind === 'builtin' && t.key === 'fulgurpool')!;
  const solo = model.targets.find((t) => t.kind === 'solo')!;
  const customs = model.targets.filter((t) => t.kind === 'custom');

  console.log('\n  Where do you want to mine?');
  console.log(`    [1] ${fulgurpool.label} — the default`);
  customs.forEach((t, i) => console.log(`    [${i + 2}] ${t.label} — ${t.value}`));
  console.log('    [s] Solo — mine on your own\n');

  for (;;) {
    const ans = (await rl.question('  Choose [1]: ')).trim().toLowerCase() || '1';
    if (ans === '1') return fulgurpool;
    if (ans === 's') return solo;
    const idx = Number(ans) - 2;
    if (Number.isInteger(idx) && idx >= 0 && idx < customs.length) return customs[idx]!;
    console.log('  Please enter one of the numbers above, or "s" for solo.\n');
  }
}

/**
 * First-run setup: ensure a wallet is set (+ pool chooser if the shared model
 * has a custom pool to offer). `customInput` defaults to the real
 * process.stdin; start.test.ts passes a scripted Readable instead so this can
 * be driven end to end without a real TTY (same trick settings.ts's
 * runSettings uses).
 */
export async function firstRunSetup(customInput: NodeJS.ReadableStream = input): Promise<void> {
  const needWallet = !HEX64.test((process.env.MINER_PUBKEY ?? '').trim().toLowerCase());
  const poolUnset = (process.env.MINER_POOL ?? '').trim() === '';
  const model = poolUnset ? buildTargetModel() : undefined;
  const needPoolMenu = !!model && model.targets.some((t) => t.kind === 'custom');
  if (!needWallet && !needPoolMenu) return;

  const rl = createInterface({ input: customInput, output });
  if (needWallet) {
    const pubkey = await promptWallet(rl);
    persist({ MINER_PUBKEY: pubkey });
    process.env.MINER_PUBKEY = pubkey;
  }
  if (needPoolMenu && model) {
    const target = await promptPool(rl, model);
    // The ONE MINER_POOL writer (targets.ts). FulgurPool's Target.value is
    // undefined, and persistTarget deletes the key on undefined — so choosing
    // FulgurPool still writes NO MINER_POOL, exactly as before this migration.
    persistTarget(target);
  }
  rl.close();
  console.log('  Saved to .env.local — edit that file (or pools.json) to change settings.\n');
}

/** Decide whether to run the full-screen TUI for this iteration. */
function wantTui(argv: string[]): boolean {
  if (process.env.FULGUR_TUI === '0') return false;
  if (argv.includes('--no-tui')) return false;
  // The TUI emits ANSI control codes (alt-screen, cursor, colors). Writing
  // those to a non-TTY pipe corrupts tools like grep, and the spec requires
  // plain mode to never emit ANSI. So a real TTY is a hard gate even when
  // FULGUR_TUI=1 forces the dashboard on: if forced on without a TTY, warn once
  // and fall back to plain logs rather than spraying escape codes into a pipe.
  if (!process.stdout.isTTY) {
    if (process.env.FULGUR_TUI === '1') {
      console.warn('  [FulgurMiner] FULGUR_TUI=1 ignored: stdout is not a TTY — using plain logs.');
    }
    return false;
  }
  return true;
}

/**
 * Build the reporter status from config (target label + canonical URL).
 * Solo aside, the label/page come from the shared model's matching target —
 * the same row menu.ts/settings.ts would show as active for this MINER_POOL —
 * so the "mining at ..." line can never name a different destination than the
 * pickers do.
 */
export function buildStatus(cfg: ReturnType<typeof loadConfig>): ReporterStatus {
  const backend: 'wasm' | 'native' = currentEngine(process.env.MINER_NATIVE);
  if (!cfg.poolUrl) {
    return { mode: 'solo', target: 'solo', backend, workers: cfg.workers, throttle: cfg.throttle, address: cfg.minerPubkeyHex };
  }
  const model = buildTargetModel();
  const target = model.targets[model.activeIndex]!;
  return {
    mode: 'pool',
    target: target.label,
    targetUrl: cfg.poolUrl,
    targetPage: target.page,
    backend,
    workers: cfg.workers,
    throttle: cfg.throttle,
    address: cfg.minerPubkeyHex,
  };
}

/** Run one mining session with the TUI dashboard. Resolves with why it stopped. */
async function runDashboardSession(warm?: WarmChain): Promise<{ reason: 'menu' | 'quit' | 'fallback'; warm?: WarmChain }> {
  const cfg = loadConfig();
  const status = buildStatus(cfg);
  const ac = new AbortController();
  // Boxed so TS doesn't narrow it to its initializer across the keypress closures.
  const control: { reason: 'menu' | 'quit' | 'fallback' } = { reason: 'quit' };

  // Construct the dashboard guarded: if the constructor throws AFTER it has
  // entered the alternate screen / hidden the cursor but before its own teardown
  // listeners are wired, restore the terminal here so we never strand the user in
  // a dirty alt-screen. (DashboardReporter also registers its exit/SIGINT
  // handlers before entering alt-screen, but this is the belt-and-braces sync
  // guarantee for a synchronous construction failure.)
  let reporter: MinerReporter;
  try {
    reporter = new DashboardReporter({
      // `s` returns to the arrow menu (the settings screen); `q`/Ctrl+C quits.
      onSettings: () => { control.reason = 'menu'; ac.abort(); },
      onQuit: () => { control.reason = 'quit'; ac.abort(); },
      // The dashboard's terminal went away (EPIPE) — end this session and let the
      // launcher continue in plain mode instead of crashing.
      onTerminalLost: () => { control.reason = 'fallback'; ac.abort(); },
    });
  } catch (e) {
    // Best-effort terminal restore (show cursor + leave alt-screen) before
    // re-throwing so the control loop can surface the failure and return to menu.
    try { process.stdout.write('\x1b[?25h\x1b[?1049l'); } catch { /* ignore */ }
    throw e;
  }
  // Solo only: runPoolClient runs its own check (with the pool's notice/min fields),
  // so guarding here avoids a duplicate GitHub fetch + a render race in pool mode.
  if (!cfg.poolUrl) void checkForUpdate({ reporter, signal: ac.signal }).catch(() => {});

  // Solo keeps the synced chain in memory across settings restarts (item G); pool
  // mode holds no local chain, so the warm handle passes through untouched.
  let nextWarm = warm;
  try {
    if (cfg.poolUrl) {
      await runPoolClient(cfg.poolUrl, cfg.minerPubkeyHex, cfg.workers, cfg.throttle, reporter, ac.signal, status, cfg.smart);
    } else {
      nextWarm = await runMiner(cfg, reporter, ac.signal, warm);
    }
  } finally {
    // runMiner/runPoolClient call reporter.close?.() on abort, but ensure the
    // terminal is restored even if they threw before reaching teardown. close()
    // is idempotent and removes the dashboard's stdin listeners so the menu can
    // safely take over raw mode on the next loop iteration.
    reporter.close?.();
  }
  return { reason: control.reason, warm: nextWarm };
}

/** Run one plain (no-TUI) mining session to completion / Ctrl+C. */
/** `warm` carries an already-synced solo chain across a mid-session switch to
 *  plain mode. Without it the terminal-lost fallback throws away a chain this
 *  process already verified and cold-starts a full replay — minutes of downtime
 *  for exactly the failure this path exists to survive. Pool mode holds no
 *  chain, so it is solo-only by nature. */
async function runPlainSession(warm?: WarmChain): Promise<void> {
  const cfg = loadConfig();
  const status = buildStatus(cfg);
  const reporter: MinerReporter = new ConsoleReporter();
  // Solo only — runPoolClient runs its own check with the pool's version fields.
  if (!cfg.poolUrl) void checkForUpdate({ reporter }).catch(() => {});
  // Keep the friendly one-line intro the launcher always printed.
  if (cfg.poolUrl) {
    console.log(`  Mining to ${status.target} with ${cfg.workers} worker(s). Press Ctrl+C to stop.\n`);
  } else {
    console.log(`  Solo-mining with ${cfg.workers} worker(s) → rewards to ${cfg.minerPubkeyHex.slice(0, 16)}…  Press Ctrl+C to stop.\n`);
  }
  try {
    if (cfg.poolUrl) {
      await runPoolClient(cfg.poolUrl, cfg.minerPubkeyHex, cfg.workers, cfg.throttle, reporter, undefined, status, cfg.smart);
    } else {
      await runMiner(cfg, reporter, undefined, warm);
    }
  } finally {
    reporter.close?.();
  }
}

/**
 * Drop a blank real-env MINER_POOL, then merge .env.local into process.env.
 * Exported so this ordering is a small, directly testable step rather than
 * only pinned by a source grep: without the drop FIRST, a real-env
 * `MINER_POOL=` (defined but blank — e.g. exported by Docker/systemd) shadows
 * whatever was stored in .env.local by the menu/settings forever, since both
 * loaders only fill keys that are `undefined` (see envLocal.ts's
 * dropBlankPoolEnv doc comment).
 */
export function loadLauncherEnv(): void {
  dropBlankPoolEnv();
  loadEnvLocal();
}

async function main(): Promise<void> {
  // Last-resort guard: turn an otherwise-silent uncaught error (any stray async
  // throw) into a restored terminal + a readable message instead of a vanished
  // window. Paired with a permanent stdout/stderr error sink so a dying console
  // pipe (EPIPE) is absorbed at the stream level and the miner keeps grinding +
  // submitting shares instead of crashing — its work is network-bound and needs
  // no console. The sink must be installed BEFORE the first write so no early
  // output can race an unguarded pipe.
  installStdioErrorSink();
  installCrashGuard();
  assertNodeVersion();
  loadLauncherEnv();

  const argv = process.argv.slice(2);
  if (argv.includes('settings')) {
    await runSettings();
    return;
  }

  if (wantTui(argv)) {
    // TUI control loop. The arrow menu is the launcher AND the settings screen.
    // It fully owns stdin while open and tears down before the dashboard starts;
    // the dashboard does likewise before returning here. So menu and dashboard
    // never both hold raw mode / keypress listeners at once.
    //   menu → (Start) → dashboard → (`s`) → menu → … ; q/Quit breaks the loop.
    // The synced chain is held here so workers/throttle/engine/target/wallet
    // changes apply on restart WITHOUT re-syncing (item G, solo only).
    let warm: WarmChain | undefined;
    for (;;) {
      const action = await runStartMenu();
      if (action === 'quit') break;
      // action === 'start' → the menu has already persisted config to .env.local
      // and process.env, so loadConfig() inside the session picks it up.
      //
      // Resolve the engine selection while the terminal is back in normal mode
      // (the menu fully restored it before resolving). If native is selected but
      // not built, this may offer to build it — a normal readline prompt is safe
      // here because the dashboard hasn't taken over stdin yet. resolveEngine
      // never blocks: a decline / failure falls back to wasm.
      await resolveEngine();
      //
      // Hard sync handoff: the menu's finish() restores raw mode before resolving,
      // but make the off-state a synchronous guarantee before the dashboard takes
      // over stdin. If anything left raw mode on (or a late keypress re-armed it),
      // force it off here so the menu and dashboard can never both own raw mode.
      // Bounded (single conditional call, not an unbounded while) so a misbehaving
      // isRaw getter can never spin.
      try {
        const tin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
        if (tin.isTTY && tin.isRaw) tin.setRawMode(false);
      } catch { /* not a TTY / setRawMode unavailable — nothing to undo */ }
      let reason: 'menu' | 'quit' | 'fallback';
      try {
        const res = await runDashboardSession(warm);
        reason = res.reason;
        warm = res.warm;
      } catch (e) {
        // A session-level failure (e.g. bad config / network) must not strand the
        // user in a dirty terminal — surface it and drop back to the menu so they
        // can fix settings. The dashboard already restored the terminal in close().
        console.error(`\n  Mining stopped: ${(e as Error).message}\n`);
        reason = 'menu';
        // Discard any in-memory chain on a session error so the next run cold-
        // starts cleanly rather than reusing a possibly-inconsistent chain.
        warm = undefined;
      }
      if (reason === 'quit') break;
      if (reason === 'fallback') {
        // The dashboard couldn't write to this terminal (e.g. an EPIPE on a
        // Windows console). Switch to plain (no-TUI) mode for the rest of this
        // process: it does no alternate-screen work and writes simple lines, so
        // it survives consoles the full-screen dashboard can't drive. One-way —
        // we don't bounce back to the dashboard on a terminal we know is broken.
        process.env.FULGUR_TUI = '0';
        console.log("\n  The live dashboard isn't supported by this terminal — switching to plain text mode.\n");
        // Hand the synced chain over: this process already verified it, and the
        // whole point of the fallback is to keep mining through a broken console.
        await runPlainSession(warm);
        return;
      }
      // reason === 'menu' → loop back to the arrow menu (settings).
    }
    return;
  }

  // Plain (non-TTY / --no-tui / FULGUR_TUI=0): readline first-run prompt, then a
  // single mining session. No arrow menu; `npm run settings` covers reconfigure.
  await firstRunSetup();
  // Resolve the engine before mining. In a non-interactive plain run (a pipe / no
  // TTY) we never prompt — auto-decline the build and fall back to wasm so the
  // run can never block waiting for input that won't come.
  if (process.stdin.isTTY) {
    await resolveEngine();
  } else {
    // Explicit non-interactive contract: a pipe / no-TTY plain run must never
    // block waiting for build confirmation, so the offer is auto-declined → wasm.
    await resolveEngine('non-interactive');
  }
  await runPlainSession();
}

// Allow this file to be imported (e.g. by start.test.ts) without launching the
// miner: only run main() when invoked directly, exactly as `npm start`
// (`tsx src/minerd/start.ts`) does — the same guard settings.ts and index.ts
// use for the same reason.
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
