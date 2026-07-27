// src/minerd/config.ts
import { addressFromHex } from '../crypto/keys.js';
import { cpuBudget, resolveWorkers } from './cpuBudget.js';
import { canonicalisePoolUrl } from './pools.js';

export interface MinerConfig {
  minerPubkeyHex: string;
  minerPubkey: Uint8Array;
  helpers: string[];
  workers: number;
  syncWorkers: number;
  tipPollMs: number;
  throttle: number; // duty cycle in (0.05, 1]: fraction of wall-time spent hashing
  smart: 'off' | 'max' | 'considerate';
  poolUrl?: string; // set via MINER_POOL; enables pool-client mode
}

export const DEFAULT_SYNC_WORKER_CAP = 8;

/**
 * Chain sync verifies already-mined blocks. It benefits from parallelism, but it
 * also boots one V8 worker heap per verifier; on large VPS/container hosts that
 * can exhaust a constrained Node heap before mining even starts. Keep bootstrap
 * modest by default, while letting operators raise/lower it explicitly.
 */
export function resolveSyncWorkers(raw: string | undefined, miningWorkers: number): number {
  const max = Math.max(1, Math.floor(miningWorkers) || 1);
  const v = (raw ?? '').trim();
  if (v === '') return Math.min(DEFAULT_SYNC_WORKER_CAP, max);
  const n = Number(v);
  if (!Number.isFinite(n)) return Math.min(DEFAULT_SYNC_WORKER_CAP, max);
  return Math.min(max, Math.max(1, Math.floor(n)));
}

// The official BrowserCoin API helper set. Reads try them in rotation and take the
// first that answers, and every fetched block is independently validated, so adding
// community-run helpers costs no trust and only adds failover headroom. Keeping only
// the two browsercoin.org hosts stranded solo miners with "all helpers failed" when
// that origin had an outage (both down at once) — the community helpers keep the tip
// reachable through it. Override with MINER_HELPERS.
const DEFAULT_HELPERS = [
  'https://api1.browsercoin.org',
  'https://api2.browsercoin.org',
  'https://api1.taitech.eu',
  'https://api1.cryptec.tech',
];

// FulgurPool — the default mining target. FULGURPOOL_URL is the default pool
// endpoint (the live, deployed API base); miners that haven't opted out route
// there. Set 2026-06-17 now that the pool is live + synced; opt out per-run with
// MINER_POOL=solo (or off/none). The website link is FULGURPOOL_PAGE below.
export const FULGURPOOL_NAME = 'FulgurPool';
export const FULGURPOOL_URL = 'https://pool.fulgurpool.xyz';
// Website for the default pool (used for the clickable host link in the UI).
export const FULGURPOOL_PAGE = 'https://fulgurpool.xyz';
export const DEFAULT_POOL = FULGURPOOL_URL;

// The public source repo. The miner runs from source (git clone → npm install →
// npm start), so updates are a `git pull` from here — this is the always-visible
// "where to get updates" link.
export const REPO_URL = 'https://github.com/alpenmilch411/FulgurMiner';

// Latest-release endpoint for the update check. Derived from REPO_URL so there is
// one source of truth for the repo. The miner reads `tag_name` here (e.g. "v0.2.3")
// to learn the newest published version — authoritative + self-maintaining (no
// hand-maintained version field), and it reaches solo miners too (who never hit
// the pool). Fail-silent: offline / rate-limited / parse errors just skip the check.
export const GITHUB_LATEST_RELEASE_API =
  REPO_URL.replace('https://github.com/', 'https://api.github.com/repos/') + '/releases/latest';

/**
 * Resolve the pool target from MINER_POOL:
 *   MINER_POOL=<url>        → mine at that pool
 *   MINER_POOL=solo|off|none → force solo mining (opt out of the default pool)
 *   MINER_POOL unset/blank   → the default pool (DEFAULT_POOL) if set, else solo
 */
export function resolvePoolUrl(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim();
  if (v === '') return DEFAULT_POOL || undefined;
  if (/^(solo|off|none)$/i.test(v)) return undefined;
  // Canonicalise exactly like the TUI/settings/pools.json path: prepend https://
  // to a scheme-less value (.env.example documents that https:// may be omitted),
  // drop a trailing slash, reject control chars/credentials/non-http(s). A malformed
  // value is a clear config error, not a silently-broken pool URL the miner then
  // POSTs /register to forever.
  const canon = canonicalisePoolUrl(v);
  if (!canon.ok) throw new Error(`invalid MINER_POOL "${v}": ${canon.reason}`);
  return canon.url;
}

/** Resolve the helper list from MINER_HELPERS (comma-separated), falling back to
 *  the defaults. A malformed value (e.g. "," or all-whitespace) filters to [] and
 *  also falls back, so callers always get >=1 helper (HelperPool requires one).
 *  Used by loadConfig and by negotiated pool mode (which needs helpers for its
 *  own chain view even though the pool path otherwise ignores them). */
export function resolveHelpers(env: Record<string, string | undefined> = process.env): string[] {
  const parsed = (env.MINER_HELPERS
    ? env.MINER_HELPERS.split(',')
    : DEFAULT_HELPERS
  )
    .map((h) => h.trim().replace(/\/+$/, ''))
    .filter((h) => h.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_HELPERS;
}

/** Load + validate miner config from an env-like record (defaults to process.env). */
export function loadConfig(env: Record<string, string | undefined> = process.env): MinerConfig {
  const minerPubkeyHex = (env.MINER_PUBKEY ?? '').trim().toLowerCase();
  if (!minerPubkeyHex) throw new Error('MINER_PUBKEY is required (64-hex Ed25519 pubkey)');
  // addressFromHex throws "address must be 32 bytes" on the wrong length.
  const minerPubkey = addressFromHex(minerPubkeyHex);

  const helpers = resolveHelpers(env);

  // Auto-sizing runs off what we're ACTUALLY allowed to use, not what os.cpus()
  // claims — inside a CPU-limited container the latter is the whole host, which is
  // how a 2-CPU allowance ended up spawning 127 workers. Unset → leave one core free
  // on a real machine, take the full allowance under a quota. A hand-set
  // MINER_WORKERS is still honored as written (bounded only by the host). See
  // cpuBudget.ts.
  const workers = resolveWorkers(env.MINER_WORKERS, cpuBudget());
  const syncWorkers = resolveSyncWorkers(env.MINER_SYNC_WORKERS, workers);

  // A blank value ('') must count as unset (-> 3000), matching the old truthiness
  // check: Number('') === 0, so a blank MINER_TIP_POLL_MS used to silently floor
  // to the 500ms minimum instead of the 3000ms default.
  const tpRaw = env.MINER_TIP_POLL_MS;
  const tipPollRaw = tpRaw !== undefined && tpRaw.trim() !== '' ? Number(tpRaw) : 3000;
  const tipPollMs = Number.isFinite(tipPollRaw) ? Math.max(500, Math.floor(tipPollRaw)) : 3000;

  // Duty cycle: fraction of wall-time spent hashing vs sleeping. Balanced default
  // 0.75 keeps heat/fan/power in check while staying productive. Clamp to (0.05, 1].
  const throttleRaw = env.MINER_THROTTLE !== undefined ? Number(env.MINER_THROTTLE) : 0.75;
  const throttle = Math.min(1, Math.max(0.05, Number.isFinite(throttleRaw) ? throttleRaw : 0.75));

  const rawSmart = (env.MINER_SMART ?? '').trim().toLowerCase();
  const smart: 'off' | 'max' | 'considerate' =
    rawSmart === 'max' ? 'max' : rawSmart === 'considerate' ? 'considerate' : 'off';

  const poolUrl = resolvePoolUrl(env.MINER_POOL);

  return { minerPubkeyHex, minerPubkey, helpers, workers, syncWorkers, tipPollMs, throttle, smart, poolUrl };
}
