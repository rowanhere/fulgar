// src/minerd/index.ts
import { loadConfig } from './config.js';
import { assertNodeVersion } from './version.js';
import { installStdioErrorSink } from './crashGuard.js';
import { dropBlankPoolEnv, loadEnvLocalKeys } from './envLocal.js';
import { runMiner } from './miner.js';
import { runPoolClient } from './poolClient.js';
import { Blockchain } from './../chain/blockchain.js';
import { ChainSync, STATE_RETAIN } from './sync.js';
import { getBlocks, getTip } from './http.js';
import { VerifierPool } from './verify.js';
import { buildTemplate, type Template } from './template.js';
import { compareBytes, bytesToHex } from '../util/binary.js';
import { hashHeader } from '../chain/block.js';
import { applyBlockTxs, cloneState, stateRoot, type State } from '../chain/state.js';

/**
 * Validate a built template against the live chain state.
 *
 * Both checks are computed from independent sources so either can fail:
 * - okPrev: template's prevHash must match the current tip hash.
 * - okStateRoot: template's stateRoot must match what we get by applying the
 *   coinbase independently from the live tipState (not from t.postState, which
 *   is derived from the same call to buildTemplate and would make the check
 *   tautological).
 *
 * @param template   - the template returned by buildTemplate
 * @param tipHash    - chain.tip.hash at the moment the template was built
 * @param tipState   - chain.tipState at the moment the template was built
 * @param minerPubkey - the miner's public key (same one passed to buildTemplate)
 * @param scriptCtx  - the script context the validator applies for this block's
 *   parent mtp (chain.nextBlockScriptContext()). Solo builds empty blocks, so ctx
 *   is inert here, but it's passed so the recompute matches the validator exactly.
 */
export function validateTemplate(
  template: Template,
  tipHash: Uint8Array,
  tipState: State,
  minerPubkey: Uint8Array,
  scriptCtx: { scriptsActive: boolean; blockMtp: number },
): { okPrev: boolean; okStateRoot: boolean } {
  // prevHash must point to the current chain tip.
  const okPrev = compareBytes(template.header.prevHash, tipHash) === 0;

  // Independently recompute the post-coinbase state from the live tipState
  // (NOT from template.postState — that would be circular, since both are
  // derived from the same applyBlockTxs call inside buildTemplate).
  const expected = cloneState(tipState);
  applyBlockTxs(expected, template.header.height, minerPubkey, [], scriptCtx);
  const okStateRoot = compareBytes(template.header.stateRoot, stateRoot(expected)) === 0;

  return { okPrev, okStateRoot };
}

/**
 * Headless `npm run mine` only: mirror a stored MINER_POOL / MINER_PUBKEY from
 * .env.local into process.env before loadConfig() reads it. Without this, a
 * choice saved via the arrow menu / `npm run settings` (e.g. MINER_POOL=solo,
 * or a wallet) is silently ignored by the headless path, which then falls
 * back to mining FulgurPool.
 *
 * Only these two keys are mirrored — every other .env.local setting
 * (MINER_WORKERS/THROTTLE/SMART/NATIVE/HELPERS/DEBUG, ...) stays env-var-only
 * on this path (D9): loading the whole file would let a stale .env.local line
 * silently change a headless/fleet box's hashrate on upgrade. dropBlankPoolEnv()
 * runs first so a real-env `MINER_POOL=` (defined but blank — e.g. from
 * Docker/systemd) can't shadow a stored choice forever.
 *
 * NEVER called by dryrun() below: the consensus gate reads no config file, by
 * design — see the file header on envLocal.ts's loadEnvLocalKeys/dropBlankPoolEnv.
 */
export function applyMineEnvOverrides(): void {
  dropBlankPoolEnv();
  loadEnvLocalKeys(['MINER_POOL', 'MINER_PUBKEY']);
}

async function dryrun(): Promise<void> {
  // dryrun is a solo-only consensus check — it builds its own template and never
  // talks to a pool, so a malformed/unused MINER_POOL must not fail the gate.
  // loadConfig() now validates MINER_POOL strictly (throws on a bad value), which
  // is correct for the mine/start paths below but would needlessly break dryrun
  // for a value it never reads. Strip it from the env this call sees instead of
  // reading the real one — the mine/start paths still validate as-is.
  const cfg = loadConfig({ ...process.env, MINER_POOL: 'solo' });
  const chain = new Blockchain();

  // Reuse one persistent VerifierPool across the whole bootstrap (workers created
  // once, not respawned per 200-block page) so dryrun benefits from the same sync
  // speed-up as the live miner. The pool owns its worker count, so the `cores`
  // arg from ChainSync is ignored while it's bound; we terminate it right after
  // bootstrap so no worker handles linger.
  const pool = new VerifierPool(cfg.syncWorkers);
  const sync = new ChainSync({
    chain,
    cores: cfg.syncWorkers,
    getBlocks: (from, max) => getBlocks(cfg.helpers[0]!, from, max),
    verifyBlocksParallel: (blocks) => pool.verify(blocks),
    stateRetain: STATE_RETAIN,
  });

  // Learn the tip up front so progress has a denominator. A failed read just
  // means indeterminate progress (block count only), not a failure.
  let target = 0;
  try { target = (await getTip(cfg.helpers[0]!)).height; } catch { target = 0; }
  console.log(
    target > 0
      ? `[dryrun] syncing from ${cfg.helpers[0]} (target height ${target.toLocaleString('en-US')}) ...`
      : `[dryrun] syncing from ${cfg.helpers[0]} ...`,
  );

  // Throttled progress so a long bootstrap shows steady movement (no silent gap).
  let lastLog = 0;
  try {
    await sync.bootstrap((h) => {
      const now = Date.now();
      if (now - lastLog < 1000 && (target <= 0 || h < target)) return;
      lastLog = now;
      if (target > 0) {
        const pct = Math.floor((Math.min(h, target) / target) * 100);
        console.log(`[dryrun] synced ${h.toLocaleString('en-US')} / ${target.toLocaleString('en-US')} (${pct}%)`);
      } else {
        console.log(`[dryrun] synced ${h.toLocaleString('en-US')} blocks…`);
      }
    });
  } finally {
    // Always dispose the workers, even if bootstrap threw, so dryrun never leaves
    // lingering worker threads/handles behind.
    await pool.terminate();
  }
  const t = buildTemplate(chain, cfg.minerPubkey);
  const { okPrev, okStateRoot } = validateTemplate(t, chain.tip.hash, chain.tipState, cfg.minerPubkey, chain.nextBlockScriptContext());
  console.log(`[dryrun] synced height=${chain.height} tip=${bytesToHex(chain.tip.hash).slice(0, 16)}…`);
  console.log(`[dryrun] template height=${t.header.height} difficulty=${t.header.difficulty.toString(16)} prevHashOK=${okPrev} stateRootOK=${okStateRoot}`);
  console.log(`[dryrun] candidate header hash=${bytesToHex(hashHeader(t.header)).slice(0, 16)}… — would mine against target ${t.targetHex.slice(0, 12)}…`);
  if (!okPrev || !okStateRoot) {
    console.error('[dryrun] FAIL — headless build disagrees with the live chain. Do NOT mine.');
    process.exit(1);
  }
  console.log('[dryrun] OK — headless build agrees with the live chain. No block submitted.');
}

async function main(): Promise<void> {
  assertNodeVersion();
  const cmd = process.argv[2];
  if (cmd === 'dryrun') {
    await dryrun();
    process.exit(0);
  }
  // Headless long-run `mine`: absorb a dying console/log pipe at the stream level
  // so the miner keeps grinding + submitting shares instead of dying on an
  // unhandled stdout error (matters for unattended/fleet runs piped to a log).
  // Installed AFTER the dryrun branch so the consensus-gate output stays pristine,
  // and the full crashGuard is intentionally NOT installed here (it would write
  // terminal-restore escapes into piped logs — see crashGuard.ts).
  installStdioErrorSink();
  applyMineEnvOverrides();
  const cfg = loadConfig();
  if (cfg.poolUrl) {
    await runPoolClient(cfg.poolUrl, cfg.minerPubkeyHex, cfg.workers, cfg.throttle, undefined, undefined, undefined, cfg.smart);
    return;
  }
  await runMiner(cfg);
}

// Only run main when this file is the direct CLI entry point (not when imported for tests).
// tsx resolves import.meta.url as a file URL; process.argv[1] is the resolved path.
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
