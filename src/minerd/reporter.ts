// src/minerd/reporter.ts
//
// Reporter abstraction. The mining core (miner.ts / poolClient.ts) routes all of
// its user-facing output through a MinerReporter instead of writing to the
// console directly. ConsoleReporter reproduces today's plain-log output exactly,
// so `npm run mine` / `mine:dryrun` are unchanged. DashboardReporter (tui.ts) is
// an alternate implementation that renders a full-screen numbers dashboard.
import { blockReward, COIN } from '../chain/genesis.js';

/** Group an integer with thousands separators (e.g. 11772 → '11,772'). */
function grp(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** Sum the halving-accurate coinbase reward (BRC) for the given accepted block heights. */
export function soloEarnedBrc(heights: number[]): number {
  let wei = 0n;
  for (const h of heights) wei += blockReward(h);
  return Number(wei) / Number(COIN);
}

export interface ReporterStatus {
  mode: 'solo' | 'pool';
  /** Human label for the target: 'FulgurPool' | a pool URL | 'solo'. */
  target: string;
  /** Canonical mining/site URL whose host is shown next to the label (default pool). */
  targetUrl?: string;
  /** Website to hyperlink the shown host to (OSC 8). Falls back to targetUrl. */
  targetPage?: string;
  backend: 'wasm' | 'native';
  /** Optional one-line note about the backend choice, e.g. why native fell back to
   *  wasm. Shown persistently so the user doesn't have to quit to discover it. */
  backendNote?: string;
  workers: number;
  throttle: number;
  /** Full 64-hex payout address. */
  address: string;
}

export interface FoundInfo {
  height: number;
  hash: string;
  accepted: boolean;
  detail: string;
}

export interface SmartInfo {
  mode: 'max' | 'considerate';
  throttle: number;
  clamped: boolean;
  phase: 'ramping' | 'holding' | 'easing';
}

// ─── Optional KPI payloads ────────────────────────────────
// These types + the optional reporter methods below are the locked interface
// seam for the pool-integration KPIs (Earnings/Jackpot/update nudge).
// Both reporters accept the calls and render NOTHING unless a caller emits
// the data. Defining them keeps the MinerReporter shape stable; adding data later is
// a pure fill-in (data + rendering).

/** Earnings KPI. solo = blockReward × blocksFound (local); pool = GET /balance. */
export interface EarningsInfo {
  kind: 'solo' | 'pool-balance' | 'pool-shares';
  /** solo: blocksFound × blockReward (BRC). pool-balance: earnedBrc. */
  earnedBrc?: number;
  pendingBrc?: number; // pool-balance only
  paidBrc?: number;    // pool-balance only
  shares?: number;     // pool-shares (other pools)
  pageUrl?: string;    // pool-shares: link to the pool's stats page
}

/** Jackpot KPI (FulgurPool finder-bonus). From GET /jackpot. */
export interface JackpotInfo {
  /** Finder-bonus fraction, e.g. 0.03. */
  finderBonusPct: number;
  /** Block-strikes credited to this miner. */
  yourBlockStrikes: number;
  lastWinner?: string;       // address/label of the last jackpot winner
  lastStrikeHeight?: number; // height of the last strike
}

/** One-line update nudge. The latest version comes from the repo's GitHub release;
 *  the miner updates via `git pull` from the public repo. */
export interface UpdateNotice {
  currentVersion: string;
  latestVersion?: string;
  /** true ⇒ a newer version exists (currentVersion < latestVersion). Only then is
   *  an "update available" line shown; a bare `notice` while current must not. */
  available?: boolean;
  /** true ⇒ 426 / minMinerVersion gate: must update before mining continues. */
  mustUpdate: boolean;
  /** Free-form pool 'notice' string from /register or GET /version. */
  notice?: string;
}

export interface MinerReporter {
  /** Called once, after the backend is chosen. */
  status(s: ReporterStatus): void;
  /**
   * Sync progress while bootstrapping the chain. `current` is the height applied
   * so far, `target` the tip height we're catching up to. Implementations should
   * clamp `current ≤ target` and treat `target ≤ 0` as indeterminate. Called
   * after each page; reporters throttle their own output.
   */
  syncProgress(current: number, target: number): void;
  /** Called once, after bootstrap/registration completes. */
  synced(height: number): void;
  /** Called ~1×/sec with the number of hashes in the last window. */
  hashrate(hps: number): void;
  /** Latest chain tip height + difficulty (hex). `netHeight` (optional) is the
   *  best-known NETWORK height from the helper poll, verbatim — reporters show
   *  it only while we are BEHIND it, so a lagging local chain is visible without
   *  the routine noise of being momentarily ahead (we just mined a block, or the
   *  canonical fork is heavier-but-shorter than where we were). */
  chain(height: number, difficultyHex: string, netHeight?: number): void;
  /** A solo block was found and submitted. */
  found(info: FoundInfo): void;
  /** A pool share result came back. */
  share(accepted: boolean, result: string): void;
  /** A free-form event line (info/warn/error). */
  event(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Live smart-mode throttle. Optional so non-smart callers can ignore it. */
  smart?(info: SmartInfo): void;
  /** Earnings KPI. Optional — renders nothing when not provided. */
  earnings?(e: EarningsInfo): void;
  /** Canonical-tip reorg delta, used to prune orphaned solo rewards. */
  reorg?(connectedHashes: string[], disconnectedHashes: string[]): void;
  /** A deep-reorg chain reset (reset() fires no tip-change): orphan all recorded solo
   *  rewards; the replay re-connects survivors via reorg(). */
  soloReorgReset?(): void;
  /** Jackpot KPI / FulgurPool. Optional — renders nothing when not provided. */
  jackpot?(j: JackpotInfo): void;
  /** Update-available nudge. Optional — renders nothing when not provided. */
  updateNotice?(n: UpdateNotice): void;
  /** Optional teardown — the TUI restores the screen here. */
  close?(): void;
}

/**
 * ConsoleReporter — plain-log reporter that reproduces the miner's pre-TUI
 * output. Same `[minerd]` / `[pool-miner]` prefixes; keeps the familiar
 * carriage-return status line refreshed on every hashrate tick.
 *
 * INVARIANT: ConsoleReporter must NEVER emit colour/SGR (`\x1b[…m`), OSC 8
 * hyperlinks (the `link()` helper / `\x1b]8;;…` wrappers), or any other ANSI
 * control sequence. It is the reporter for plain mode AND for piped/non-TTY
 * output, where escape codes would corrupt greppable logs and downstream tools.
 * All clickable-host / colour rendering lives only in the DashboardReporter (TUI).
 * The lone `\r` carriage return below is plain ASCII, not an ANSI escape.
 */
export class ConsoleReporter implements MinerReporter {
  private height = 0;
  private netHeight?: number;
  private difficultyHex = '0';
  private status_: ReporterStatus | null = null;
  // Sync-progress throttling: emit at most ~1/sec or on a ≥2% jump so plain logs
  // show steady progress without flooding. -1 = no line emitted yet this sync.
  private lastSyncLogAt = 0;
  private lastSyncPct = -1;
  private soloBlocks: { height: number; hash: string }[] = [];
  private orphanedSoloHashes = new Set<string>();
  private smart_: SmartInfo | null = null;
  // Session-end guard for the jackpot panel: once a session has ended, a late
  // jackpot() call (e.g. a /jackpot response that was already in flight when the
  // pool stopped) must not print a stale finder-bonus line into what now reads as
  // a new session's log.
  private closed_ = false;

  private canonicalSolo(): { heights: number[]; earnedBrc: number; count: number } {
    const heights = this.soloBlocks
      .filter((b) => !this.orphanedSoloHashes.has(b.hash))
      .map((b) => b.height);
    return { heights, earnedBrc: soloEarnedBrc(heights), count: heights.length };
  }

  status(s: ReporterStatus): void {
    this.status_ = s;
    if (s.backendNote) console.log(`[${s.mode === 'pool' ? 'pool-miner' : 'minerd'}] ${s.backendNote}`);
    if (s.mode === 'pool') {
      // Pool + negotiated printed NOTHING about the effective configuration in
      // plain mode - the silence that hid a 0.75 duty from headless users (and
      // produced a wrong conclusion in the 2026-07-24 measurement session). The
      // registration/engine lines are emitted separately by the pool clients.
      console.log(`[pool-miner] mining with ${s.workers} workers, throttle ${s.throttle}`);
      return;
    }
    const backend = s.backend === 'native' ? 'native (Rust)' : 'wasm (worker_threads)';
    // Mirror miner.ts's old startup lines so plain mode looks unchanged.
    console.log(`[minerd] mining to ${s.address.slice(0, 16)}… (${s.workers} workers, throttle ${s.throttle})`);
    console.log(`[minerd] grind backend: ${backend}`);
  }

  syncProgress(current: number, target: number): void {
    // Indeterminate target: still surface that we're advancing so there's never a
    // long silent gap during bootstrap, just without a percentage. The wording
    // makes plain WHAT is happening — we download + verify BrowserCoin's chain so
    // the miner builds on the correct one.
    if (!Number.isFinite(target) || target <= 0) {
      const now = Date.now();
      // Throttle indeterminate updates a bit tighter (500ms) so a slow burst of
      // pages still shows visible progress and never a long silent gap.
      if (now - this.lastSyncLogAt < 500) return;
      this.lastSyncLogAt = now;
      console.log(`[minerd] verifying BrowserCoin blockchain ${grp(current)} blocks…`);
      return;
    }
    const cur = Math.max(0, Math.min(current, target));
    const pct = Math.floor((cur / target) * 100);
    const now = Date.now();
    // Throttle: at most ~1/sec, but always allow a ≥2% change through so progress
    // is visible even if pages land faster than once per second.
    const enoughTime = now - this.lastSyncLogAt >= 1000;
    const enoughChange = this.lastSyncPct < 0 || pct - this.lastSyncPct >= 2;
    if (!enoughTime && !enoughChange) return;
    this.lastSyncLogAt = now;
    this.lastSyncPct = pct;
    console.log(`[minerd] verifying BrowserCoin blockchain ${grp(cur)} / ${grp(target)} (${pct}%)`);
  }

  synced(height: number): void {
    this.height = height;
    const prefix = this.status_?.mode === 'pool' ? '[pool-miner]' : '[minerd]';
    console.log(`${prefix} synced to height ${height}`);
  }

  hashrate(hps: number): void {
    let smartSuffix = '';
    if (this.smart_) {
      const pct = Math.round(this.smart_.throttle * 100);
      let label: string;
      switch (this.smart_.phase) {
        case 'ramping': label = 'ramping'; break;
        case 'holding': label = 'max'; break;
        default: label = this.smart_.throttle <= 0.15 ? 'yielding' : 'easing off'; break;
      }
      smartSuffix = ` auto ${pct}% ${label}`;
    }
    if (this.status_?.mode === 'pool') {
      process.stdout.write(`\r[pool-miner] ${hps} H/s${smartSuffix}   `);
    } else {
      const net = this.netHeight !== undefined && this.netHeight > this.height ? ` net=${this.netHeight}` : '';
      process.stdout.write(`\r[minerd] h=${this.height}${net} diff=${this.difficultyHex} hps:${hps}${smartSuffix}   `);
    }
  }

  chain(height: number, difficultyHex: string, netHeight?: number): void {
    this.height = height;
    this.difficultyHex = difficultyHex;
    this.netHeight = netHeight;
  }

  found(info: FoundInfo): void {
    console.log(`\n[minerd] FOUND height=${info.height} hash=${info.hash} ${info.detail}`);
    if (info.accepted && this.status_?.mode !== 'pool') {
      this.soloBlocks.push({ height: info.height, hash: info.hash });
      this.earnings({ kind: 'solo', earnedBrc: this.canonicalSolo().earnedBrc });
    }
  }

  reorg(connectedHashes: string[], disconnectedHashes: string[]): void {
    let changed = false;
    for (const h of disconnectedHashes) {
      if (this.soloBlocks.some((b) => b.hash === h) && !this.orphanedSoloHashes.has(h)) {
        this.orphanedSoloHashes.add(h);
        changed = true;
      }
    }
    for (const h of connectedHashes) {
      if (this.orphanedSoloHashes.has(h)) {
        this.orphanedSoloHashes.delete(h);
        changed = true;
      }
    }
    if (changed) this.earnings({ kind: 'solo', earnedBrc: this.canonicalSolo().earnedBrc });
  }

  soloReorgReset(): void {
    let changed = false;
    for (const b of this.soloBlocks) {
      if (!this.orphanedSoloHashes.has(b.hash)) {
        this.orphanedSoloHashes.add(b.hash);
        changed = true;
      }
    }
    if (changed) this.earnings({ kind: 'solo', earnedBrc: this.canonicalSolo().earnedBrc });
  }

  share(accepted: boolean, result: string): void {
    process.stdout.write(`\n[pool-miner] share ${accepted ? 'accepted' : 'rejected'}: ${result}\n`);
  }

  event(level: 'info' | 'warn' | 'error', msg: string): void {
    if (level === 'error') console.error(`\n${msg}`);
    else if (level === 'warn') console.warn(`\n${msg}`);
    else console.log(msg);
  }

  smart(info: SmartInfo): void {
    this.smart_ = info;
  }

  // ─── Optional KPI channel ──────────────────────────────
  // Concrete no-op homes for the optional KPI methods. Filled with
  // ASCII-only plain lines (earnings / jackpot / update nudge) — never SGR or
  // OSC-8 per the INVARIANT above (this is also the piped/non-TTY path).
  earnings(e: EarningsInfo): void {
    if (e.kind === 'pool-balance') {
      console.log(`[pool-miner] earnings: ${e.earnedBrc} BRC (pending ${e.pendingBrc}, paid ${e.paidBrc})`);
    } else if (e.kind === 'pool-shares') {
      console.log(`[pool-miner] shares: ${e.shares}${e.pageUrl ? ` (stats: ${e.pageUrl})` : ''}`);
    } else {
      console.log(`[minerd] earnings (est): ${e.earnedBrc} BRC (${this.canonicalSolo().count} blocks)`);
    }
  }

  jackpot(j: JackpotInfo): void {
    if (this.closed_) return; // the session has ended — never print a stale panel
    const last = j.lastWinner ? ` - last ${j.lastWinner.slice(0, 12)}...@${j.lastStrikeHeight ?? '?'}` : '';
    console.log(`[pool-miner] jackpot: ${Math.round(j.finderBonusPct * 100)}% finder bonus - blocks found: ${j.yourBlockStrikes}${last}`);
  }

  /** Session end. Plain mode has no persistent panel to erase, but this closes
   *  the door on any late jackpot() call (e.g. from an in-flight /jackpot request
   *  that was already underway when the session stopped) — TUI/plain parity. */
  close(): void {
    this.closed_ = true;
  }

  updateNotice(n: UpdateNotice): void {
    if (n.mustUpdate) {
      console.log(`[minerd] UPDATE REQUIRED: v${n.currentVersion} -> v${n.latestVersion ?? '?'} - ${n.notice ?? 'run the update command'}`);
    } else if (n.available && n.latestVersion) {
      console.log(`[minerd] update available: v${n.currentVersion} -> v${n.latestVersion} (press 'u' for the command)`);
    } else if (n.notice) {
      console.log(`[minerd] notice: ${n.notice}`);
    }
  }
}
