// src/minerd/tui.ts
//
// DashboardReporter — a numbers-only full-screen terminal dashboard implemented
// in pure ANSI (no dependencies). It is one implementation of MinerReporter; the
// mining core does not know it exists. It enters the alternate screen buffer,
// hides the cursor, and renders an aggregate view (no per-worker rows) that
// refreshes ~2×/sec. Keypresses (when stdin is a TTY): `s` opens settings, `q`
// or Ctrl+C quits. The terminal is always restored on close / SIGINT / exit.
import * as readline from 'node:readline';
import type {
  MinerReporter, ReporterStatus, FoundInfo, EarningsInfo, JackpotInfo, UpdateNotice, SmartInfo,
} from './reporter.js';
import { soloEarnedBrc } from './reporter.js';
import { link, STRIP_OSC8 } from './link.js';
import { getLastNotice, updateCommand } from './updateCheck.js';
import { VERSION } from './version.js';

// --- ANSI helpers ----------------------------------------------------------
const ESC = '\x1b[';
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const HOME = `${ESC}H`;
const CLEAR_LINE = `${ESC}K`; // clear from cursor to end of line
const CLEAR_DOWN = `${ESC}J`; // clear from cursor to end of screen
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;

const RENDER_MS = 500;
const EVENT_RING = 15; // in-memory history; the panel renders as many as fit
// Aggregate-hashrate ring buffer feeding the sparkline. Sized so the spark is a
// meaningful recent window even on wide terminals; the renderer shows the most
// recent `cols`-worth of samples.
const SPARK_RING = 120;
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
// Minimum interior width before we drop the box frame for the compact layout.
const MIN_FRAME_COLS = 44;

export interface DashboardCallbacks {
  onSettings: () => void;
  onQuit: () => void;
  /** Fired when the dashboard's output terminal goes away mid-session (an EPIPE
   *  on stdout — seen on some Windows consoles). The launcher should continue in
   *  plain (no-TUI) mode rather than crash, since the dashboard can no longer
   *  draw to this terminal. */
  onTerminalLost?: () => void;
}

/** The slice of a writable terminal stream the dashboard touches. process.stdout
 *  satisfies it; tests pass a fake so construction never hits the real terminal. */
export interface DashboardOutput {
  write(s: string): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  columns?: number;
  rows?: number;
}

interface EventLine {
  level: 'info' | 'warn' | 'error';
  msg: string;
  at: number;
}

/** Group an integer with thousands separators. NaN/Infinity → '0'. */
function group(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** Compact hashrate / hash counts: 1.24M, 12.3k, 945. Guards NaN. */
function compact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return String(Math.round(n));
}

/** Format a duration in seconds as 1h 02m 03s / 02m 03s / 03s. */
function dur(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}

export class DashboardReporter implements MinerReporter {
  private status_: ReporterStatus | null = null;
  private synced_ = false;
  // Sync-progress state (rendered by the dashboard's SYNC row). syncTarget ≤ 0
  // means indeterminate; once current ≥ target (or synced()) the bar is dropped.
  private syncCurrent = 0;
  private syncTarget = 0;
  private height = 0;
  private netHeight?: number;
  private difficultyHex = '0';
  private latestHps = 0;
  private peakHps = 0;
  private totalHashes = 0;
  // Recent aggregate-hps samples for the sparkline (ring buffer).
  private spark: number[] = [];
  private errored = false;
  private foundCount = 0;
  private acceptedCount = 0;
  private rejectedCount = 0;
  private shareCount = 0;
  private shareAccepted = 0;
  private soloBlocks: { height: number; hash: string }[] = [];
  private orphanedSoloHashes = new Set<string>();
  private earnings_: EarningsInfo | null = null;
  private jackpot_: JackpotInfo | null = null;
  private updateNotice_: UpdateNotice | null = null;
  private smart_: SmartInfo | null = null;
  private readonly startedAt = Date.now();
  private events: EventLine[] = [];

  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private rawModeOn = false;
  /** When true the full-screen help overlay is shown; any key closes it. */
  private showHelp = false;
  private readonly cbs: DashboardCallbacks;
  private readonly out: DashboardOutput;
  private outErrored = false;
  private readonly onKeypress = (str: string, key: readline.Key): void => this.handleKey(key, str);
  private readonly onResize = (): void => this.render();
  private readonly onProcExit = (): void => this.restoreTerminal();
  // The output stream emits 'error' (e.g. write EPIPE when the console/pipe goes
  // away) — with no listener Node treats that as an UNHANDLED error event and
  // kills the process (on Windows the console window just vanishes). ANY error on
  // this stream means we can no longer reliably draw, so restore the terminal and
  // hand off to plain mode once, rather than crash or silently freeze.
  private readonly onOutError = (): void => {
    if (this.outErrored || this.closed) return;
    this.outErrored = true;
    this.restoreTerminal();
    this.cbs.onTerminalLost?.();
  };

  constructor(cbs: DashboardCallbacks, out: DashboardOutput = process.stdout) {
    this.cbs = cbs;
    this.out = out;
    // Register the signal/exit teardown handlers FIRST, before entering the
    // alternate screen. A SIGINT (or a throw that triggers `exit`) in the narrow
    // window between writing ALT_ON and wiring these listeners would otherwise
    // let Node's default handler exit immediately, stranding the terminal in
    // alt-screen with the cursor hidden. With the handlers up front, any signal
    // or exit during the rest of construction still restores the terminal.
    process.on('SIGINT', this.handleSigint);
    process.on('SIGTERM', this.handleSigint);
    process.on('exit', this.onProcExit);
    this.out.on('resize', this.onResize);
    // Wire the stream 'error' handler BEFORE the first write, so even an EPIPE on
    // the very first frame is caught (graceful plain-mode fallback) not fatal.
    this.out.on('error', this.onOutError as (...args: unknown[]) => void);

    // Enter the alternate screen + hide the cursor up front so the scrollback is
    // never polluted and the dashboard owns the whole viewport.
    this.out.write(ALT_ON + CURSOR_HIDE + HOME + CLEAR_DOWN);

    // Wire keypresses ONLY when stdin is a real TTY. In a pipe (tests) there is
    // no raw mode, so we skip key handling but still render frames.
    if (process.stdin.isTTY) {
      try {
        readline.emitKeypressEvents(process.stdin);
        // Register the keypress listener ONLY after raw mode is on. If
        // setRawMode throws we never attach the listener, so it can't leak
        // across TUI instances in a restart loop (close() only removes it when
        // rawModeOn is true). resume() also happens only on the success path.
        process.stdin.setRawMode(true);
        this.rawModeOn = true;
        process.stdin.resume();
        process.stdin.on('keypress', this.onKeypress);
      } catch {
        // If raw mode fails for any reason, carry on render-only.
        this.rawModeOn = false;
      }
    }

    this.renderTimer = setInterval(() => this.render(), RENDER_MS);
    this.render();
  }

  private canonicalSolo(): { heights: number[]; earnedBrc: number; count: number } {
    const heights = this.soloBlocks
      .filter((b) => !this.orphanedSoloHashes.has(b.hash))
      .map((b) => b.height);
    return { heights, earnedBrc: soloEarnedBrc(heights), count: heights.length };
  }

  private sigintSeen = false;
  private handleSigint = (): void => {
    // We register our own SIGINT/SIGTERM handler, which suppresses Node's
    // default "terminate immediately" behavior for these signals. That removes
    // the race the default handler would otherwise create (Node exiting while
    // we're mid-teardown, leaving the terminal dirty): once a custom listener
    // exists, WE own the shutdown sequence and decide when to exit.
    //
    // Sequence: ask the launcher to abort gracefully (its abort path calls
    // close() → restoreTerminal), then restore the terminal right now too
    // (idempotent) because a signal can arrive during bootstrap before the
    // abort listener is wired, in which case onQuit fires into the void. Then
    // disable raw mode and exit hard. We do NOT rely on the graceful path to
    // call process.exit — we own it here so there's no window where the alt
    // screen stays up.
    this.cbs.onQuit();
    this.restoreTerminal();
    if (this.rawModeOn) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    if (this.sigintSeen) {
      process.exit(130); // second Ctrl+C → leave now
    }
    this.sigintSeen = true;
    // The terminal is already restored above, so exiting on a short fixed delay
    // is safe and deterministic: it gives the graceful abort a brief moment to
    // flush in-flight work, then guarantees we leave (no indefinite hang, no
    // dependence on the launcher reaching its own exit path).
    const t = setTimeout(() => process.exit(130), 1500);
    t.unref?.();
  };

  private handleKey(key: readline.Key | undefined, str?: string): void {
    // A keypress event can be queued before close() runs but dispatched after
    // (event delivery is async). Once closed, the listener may already be
    // removed, but guard here too so a late keypress can never fire onQuit/
    // onSettings after teardown (which would double-abort or trigger callbacks
    // against a stopped miner).
    if (this.closed || !key) return;
    // Ctrl+C always quits, even from the help overlay.
    if (key.ctrl && key.name === 'c') { this.cbs.onQuit(); return; }
    // While the help overlay is up, ANY key (incl. Esc) closes it and returns to
    // the dashboard. It does not fall through to q/s, so help is a safe pause.
    if (this.showHelp) { this.showHelp = false; this.render(); return; }
    if (str === '?') { this.showHelp = true; this.render(); return; }
    if (key.name === 'u') { this.showUpdateCommand(); return; }
    if (key.name === 'q') { this.cbs.onQuit(); return; }
    if (key.name === 's') { this.cbs.onSettings(); return; }
  }

  private showUpdateCommand(): void {
    const n = getLastNotice();
    // Only offer the update command when there is a real update (behind / 426
    // gate). A bare notice while current must not tell the user to "git pull".
    if (!n || !(n.available || n.mustUpdate)) {
      this.event('info', n?.notice ?? `you're on the latest version (v${VERSION})`);
      return;
    }
    const notes = (n as UpdateNotice & { releaseNotesUrl?: string }).releaseNotesUrl;
    this.event('info', `to update: ${updateCommand()}${notes ? `  (notes: ${notes})` : ''}`);
  }

  // --- MinerReporter ------------------------------------------------------
  status(s: ReporterStatus): void {
    this.status_ = s;
    this.render();
  }

  syncProgress(current: number, target: number): void {
    // Minimal state storage — the SYNC row renderer reads these. Clamp current ≤
    // target and treat target ≤ 0 as indeterminate (per the MinerReporter
    // contract). Render so the bar advances live.
    this.syncTarget = Number.isFinite(target) && target > 0 ? target : 0;
    this.syncCurrent = this.syncTarget > 0
      ? Math.max(0, Math.min(current, this.syncTarget))
      : Math.max(0, current);
    if (this.syncTarget > 0 && this.syncCurrent >= this.syncTarget) this.synced_ = true;
    this.render();
  }

  synced(height: number): void {
    this.synced_ = true;
    this.height = height;
    this.pushEvent('info', `synced to height ${group(height)}`);
    this.render();
  }

  hashrate(hps: number): void {
    const v = Number.isFinite(hps) && hps > 0 ? hps : 0;
    this.latestHps = v;
    if (v > this.peakHps) this.peakHps = v;
    this.totalHashes += v;
    this.spark.push(v);
    if (this.spark.length > SPARK_RING) this.spark.splice(0, this.spark.length - SPARK_RING);
  }

  chain(height: number, difficultyHex: string, netHeight?: number): void {
    this.height = height;
    this.difficultyHex = difficultyHex;
    this.netHeight = netHeight;
  }

  found(info: FoundInfo): void {
    this.foundCount++;
    if (info.accepted) this.acceptedCount++;
    else this.rejectedCount++;
    this.pushEvent(
      info.accepted ? 'info' : 'warn',
      `FOUND h=${group(info.height)} ${info.hash.slice(0, 16)}… ${info.detail}`,
    );
    if (info.accepted && this.status_?.mode !== 'pool') {
      this.soloBlocks.push({ height: info.height, hash: info.hash });
      this.earnings({ kind: 'solo', earnedBrc: this.canonicalSolo().earnedBrc });
    }
    this.render();
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
    this.shareCount++;
    if (accepted) this.shareAccepted++;
    this.pushEvent(accepted ? 'info' : 'warn', `share ${accepted ? 'accepted' : 'rejected'}: ${result}`);
    this.render();
  }

  event(level: 'info' | 'warn' | 'error', msg: string): void {
    if (level === 'error') this.errored = true;
    this.pushEvent(level, msg.replace(/^\s*\n/, '').trim());
    this.render();
  }

  // ─── Optional KPI channel ──────────────────────────────
  // Stores these and renders an Earnings panel, a
  // Jackpot panel, and a one-line update nudge (all width-safe via row()).
  earnings(e: EarningsInfo): void {
    this.earnings_ = e;
    this.render();
  }

  jackpot(j: JackpotInfo): void {
    if (this.closed) return; // the session has ended — never repaint a stale panel
    this.jackpot_ = j;
    this.render();
  }

  updateNotice(n: UpdateNotice): void {
    this.updateNotice_ = n;
    this.render();
  }

  smart(info: SmartInfo): void {
    this.smart_ = info;
    this.render();
  }

  close(): void {
    if (this.closed) return;
    // Clear the render interval FIRST so no further tick can be scheduled, then
    // flip the closed flag. render() also early-returns on `closed`, but
    // stopping the timer up front means an already-queued tick can't even start
    // a render pass (and wastes no CPU rebuilding lines we'd discard).
    if (this.renderTimer) { clearInterval(this.renderTimer); this.renderTimer = null; }
    // Drop the jackpot panel's data at session end — it's FulgurPool-only and
    // must never bleed into whatever this reporter instance renders next (the
    // jackpot() guard above also refuses any late update once closed).
    this.jackpot_ = null;
    this.closed = true;
    // Order matters: timer cleared, then `closed` set, THEN listeners removed.
    // A resize event firing between here and removeListener fires onResize →
    // render(), but render() early-returns on `closed`, so no work is scheduled
    // against a torn-down dashboard.
    this.out.removeListener('resize', this.onResize);
    this.out.removeListener('error', this.onOutError as (...args: unknown[]) => void);
    process.removeListener('SIGINT', this.handleSigint);
    process.removeListener('SIGTERM', this.handleSigint);
    process.removeListener('exit', this.onProcExit);
    if (this.rawModeOn) {
      try { process.stdin.removeListener('keypress', this.onKeypress); } catch { /* ignore */ }
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      try { process.stdin.pause(); } catch { /* ignore */ }
      this.rawModeOn = false;
    }
    this.restoreTerminal();
  }

  /** Wipe the alternate screen, restore the cursor, then leave it. Idempotent;
   *  safe on exit. The wipe (HOME + CLEAR_DOWN) matters because some terminals
   *  preserve the alt-screen buffer's last frame across an ALT_OFF/ALT_ON cycle —
   *  without it, a KPI panel (e.g. jackpot) from THIS session could still be
   *  sitting in the buffer when the next session re-enters it, however briefly. */
  private restoreTerminal(): void {
    try { this.out.write(HOME + CLEAR_DOWN + CURSOR_SHOW + ALT_OFF); } catch { /* ignore */ }
  }

  private pushEvent(level: 'info' | 'warn' | 'error', msg: string): void {
    if (!msg) return;
    this.events.push({ level, msg, at: Date.now() });
    if (this.events.length > EVENT_RING) this.events.splice(0, this.events.length - EVENT_RING);
  }

  // --- Rendering ----------------------------------------------------------
  private avgHps(): number {
    const upSec = (Date.now() - this.startedAt) / 1000;
    // Guard the first second (divide-by-near-zero) AND a backward clock jump
    // (NTP/DST), which would make upSec negative and the average nonsensical.
    if (upSec < 1) return 0;
    return this.totalHashes / upSec;
  }

  private render(): void {
    if (this.closed) return;
    const cols = Math.max(20, this.out.columns || 80);
    const rows = Math.max(8, this.out.rows || 24);
    const lines = this.buildLines(cols);

    // Cursor home, then write each line padded to clear leftovers. We cap at the
    // terminal height so a tiny window never scrolls the dashboard off.
    let out = HOME;
    const max = Math.min(lines.length, rows - 1);
    for (let i = 0; i < max; i++) {
      out += this.fit(lines[i] ?? '', cols) + CLEAR_LINE;
      if (i < max - 1) out += '\n';
    }
    out += CLEAR_DOWN; // wipe anything below the last line we wrote
    this.out.write(out);
  }

  /** Strip OSC 8 hyperlink wrappers AND CSI/SGR codes — both are zero-width. */
  private plain(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(STRIP_OSC8, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  }

  /** Truncate a line (ignoring ANSI codes for width) to fit the terminal width. */
  private fit(line: string, cols: number): string {
    // Strip OSC 8 hyperlinks + any CSI sequence (ESC [ … final-byte) to measure
    // the visible width, so a clickable host can never be miscounted.
    const visible = this.plain(line);
    if (visible.length <= cols) return line;
    // Truncate conservatively: rebuild without color/links if it overflows.
    return visible.slice(0, cols - 1) + '…';
  }

  // --- width-aware string helpers -----------------------------------------
  /** Visible width of a string, ignoring OSC 8 + CSI/SGR escapes. */
  private vlen(s: string): number {
    return this.plain(s).length;
  }

  /** Pad a (possibly colored) string with spaces to a visible width. */
  private padTo(s: string, width: number): string {
    const pad = width - this.vlen(s);
    return pad > 0 ? s + ' '.repeat(pad) : s;
  }

  /** Truncate a colored/linked string to a visible width, appending a reset. */
  private clampVisible(s: string, width: number): string {
    if (this.vlen(s) <= width) return s;
    const plain = this.plain(s);
    return plain.slice(0, Math.max(0, width - 1)) + '…';
  }

  // --- state-dot + state label --------------------------------------------
  private stateLabel(): string {
    if (this.errored) return 'ERROR';
    return this.synced_ ? 'MINING' : 'SYNCING';
  }

  private stateColor(): string {
    if (this.errored) return RED;
    return this.synced_ ? GREEN : YELLOW;
  }

  // --- sparkline ----------------------------------------------------------
  /**
   * Render the aggregate-hps ring buffer as a sparkline of the given visible
   * width. Scales to the window max; guards all-zero (renders the baseline
   * block) and an empty buffer.
   */
  private sparkline(width: number): string {
    if (width <= 0) return '';
    const data = this.spark.slice(-width);
    if (data.length === 0) return DIM + SPARK_CHARS[0]!.repeat(width) + RESET;
    let max = 0;
    for (const v of data) if (v > max) max = v;
    // hashrate() already filters out non-finite/negative samples before they
    // reach the ring, so max is always a finite ≥ 0. Re-assert it defensively so
    // a future change upstream can never feed Infinity/NaN into the index math
    // (which would yield NaN/out-of-range indices into SPARK_CHARS).
    if (!Number.isFinite(max) || max < 0) max = 0;
    let out = '';
    for (const v of data) {
      if (max <= 0) {
        out += SPARK_CHARS[0]!; // all-zero → flat baseline, never NaN
      } else {
        const idx = Math.min(SPARK_CHARS.length - 1, Math.max(0, Math.round((v / max) * (SPARK_CHARS.length - 1))));
        out += SPARK_CHARS[idx]!;
      }
    }
    // Left-pad with baseline blocks if we have fewer samples than the width.
    if (out.length < width) out = SPARK_CHARS[0]!.repeat(width - out.length) + out;
    return GREEN + out + RESET;
  }

  /** A progress bar of `width` cells filled to `frac` (0..1). */
  private bar(frac: number, width: number): string {
    const w = Math.max(1, width);
    const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
    const filled = Math.round(f * w);
    return GREEN + '█'.repeat(filled) + RESET + DIM + '░'.repeat(w - filled) + RESET;
  }

  // --- top-level renderer -------------------------------------------------
  private buildLines(cols: number): string[] {
    // The help overlay takes over the whole viewport when open.
    if (this.showHelp) return this.buildHelp(cols);
    // Decide framed vs compact. The frame needs room for two side-by-side
    // columns; below MIN_FRAME_COLS we fall back to a flat, unframed list that
    // can never overflow a narrow terminal.
    if (cols < MIN_FRAME_COLS) return this.buildCompact(cols);
    return this.buildFramed(cols);
  }

  /**
   * Full-screen help overlay (§5). Compact, plain-language, scannable. Uses the
   * same framed/compact safety as the dashboard: a box when there's room, an
   * unframed list on a narrow terminal, every line width-clamped by render().
   */
  private buildHelp(cols: number): string[] {
    const B = (s: string): string => `${BOLD}${s}${RESET}`;
    const D = (s: string): string => `${DIM}${s}${RESET}`;
    const body: string[] = [
      B('What FulgurMiner does'),
      `  Mines BrowserCoin from your terminal. Rewards go to your wallet`,
      `  ${D('address')} — public, no password or private key.`,
      '',
      B('Syncing / verifying'),
      `  First run downloads + verifies the chain so you mine on the right`,
      `  one. ${D('Restarts are fast')}: the chain is saved under ~/.fulgurminer/`,
      `  and only new blocks are fetched.`,
      '',
      B('Dashboard panels'),
      `  ${D('●')} status dot · SYNC bar · HASHRATE (now/avg/peak + sparkline)`,
      `  · SESSION (uptime, finds/shares, work, height) · EVENTS.`,
      '',
      B('Settings'),
      `  Wallet · Where to mine · Workers · Mode · Throttle · Engine.`,
      `  ${D('Mode')}: Manual sets the duty cycle by hand; Smart auto-tunes it`,
      `  (Considerate keeps the CPU free for your work). ${D('native')} (Rust)`,
      `  engine is faster than ${D('wasm')}; more workers = faster but hotter.`,
      '',
      B('Where to mine'),
      `  Default is ${B('FulgurPool')} ${D('(the project’s own pool)')}. Pick Solo`,
      `  or a pool under Where to mine.`,
      '',
      B('Keys'),
      `  Dashboard: ${D('q')} quit · ${D('s')} settings · ${D('u')} update · ${D('?')} this help`,
      `  Menu: ${D('↑/↓')} move · ${D('Enter')} select · ${D('←/→')} change a value`,
    ];

    if (cols < MIN_FRAME_COLS) {
      // Narrow: unframed list (render() clamps each line to the width).
      const out = [`${BOLD}${CYAN}How FulgurMiner works${RESET}`, ...body, '', `${DIM}press any key to close${RESET}`];
      return out;
    }
    const width = Math.min(cols - 1, 80);
    const inner = width - 2;
    const top = `${DIM}┌${'─'.repeat(inner)}┐${RESET}`;
    const bottom = `${DIM}└${'─'.repeat(inner)}┘${RESET}`;
    const sep = `${DIM}├${'─'.repeat(inner)}┤${RESET}`;
    const row = (content: string): string =>
      `${DIM}│${RESET} ${this.padTo(this.clampVisible(content, inner - 2), inner - 2)} ${DIM}│${RESET}`;
    const lines: string[] = [top];
    lines.push(row(`${BOLD}${CYAN}How FulgurMiner works${RESET}`));
    lines.push(sep);
    for (const b of body) lines.push(row(b));
    lines.push(sep);
    lines.push(row(`${DIM}press any key to close${RESET}`));
    lines.push(bottom);
    return lines;
  }

  // --- framed (Bloomberg) layout ------------------------------------------
  private buildFramed(cols: number): string[] {
    const width = Math.min(cols - 1, 100); // leave a margin; cap so it's not absurd on huge terminals
    const inner = width - 2; // interior between the two │ bars
    const lines: string[] = [];
    const s = this.status_;

    // ── frame helpers ──
    const top = `${DIM}┌${'─'.repeat(inner)}┐${RESET}`;
    const bottom = `${DIM}└${'─'.repeat(inner)}┘${RESET}`;
    const sep = `${DIM}├${'─'.repeat(inner)}┤${RESET}`;
    const row = (content: string): string =>
      `${DIM}│${RESET} ${this.padTo(this.clampVisible(content, inner - 2), inner - 2)} ${DIM}│${RESET}`;

    lines.push(top);

    // ── title row ──
    lines.push(row(`${BOLD}${CYAN}FulgurMiner${RESET}${DIM}  ·  terminal miner for BrowserCoin${RESET}`));
    lines.push(sep);

    // ── status bar: ● STATE  target · host   backend · n cores   clock ──
    const dot = `${this.stateColor()}●${RESET}`;
    const state = `${BOLD}${this.stateColor()}${this.stateLabel()}${RESET}`;
    let targetTxt: string;
    if (!s) targetTxt = `${DIM}starting…${RESET}`;
    else if (s.targetUrl) {
      // Show "Label · host" with the host DIM and (when a website is known)
      // wrapped as an OSC 8 hyperlink. Host only — no banners/promo.
      const host = this.hostOf(s.targetUrl);
      const page = s.targetPage ?? s.targetUrl;
      targetTxt = `${GREEN}${s.target}${RESET} ${DIM}· ${link(host, page)}${RESET}`;
    } else if (s.mode === 'pool') targetTxt = `${GREEN}${s.target}${RESET}`;
    else targetTxt = `${YELLOW}solo${RESET}`;
    const backendTxt = s
      ? `${DIM}${s.backend === 'native' ? 'native' : 'wasm'} · ${group(s.workers)} cores${RESET}`
      : '';
    const clk = `${DIM}${this.clock(Date.now())}${RESET}`;
    // Left cluster, then right-align the clock within the row.
    const left = `${dot} ${state}   ${targetTxt}   ${backendTxt}`;
    const gap = Math.max(1, inner - 2 - this.vlen(left) - this.vlen(clk));
    lines.push(row(`${left}${' '.repeat(gap)}${clk}`));

    if (this.smart_) {
      const pct = `${Math.round(this.smart_.throttle * 100)}%`;
      const label = this.smart_.mode === 'considerate' ? 'Considerate' : 'Max';
      let phaseLabel: string;
      switch (this.smart_.phase) {
        case 'ramping': phaseLabel = '↑ ramping…'; break;
        case 'holding': phaseLabel = '· at max'; break;
        default: phaseLabel = this.smart_.throttle <= 0.15 ? '· yielding to your apps' : '· easing off (CPU busy)'; break;
      }
      lines.push(row(`${DIM}auto throttle${RESET} ${BOLD}${pct}${RESET} ${DIM}${label}${RESET} ${CYAN}${phaseLabel}${RESET}`));
    } else if (s) {
      // Manual mode: confirm the configured throttle so the user can see their
      // setting is applied. Any decline below this is the OS/thermals, not the miner.
      lines.push(row(`${DIM}throttle${RESET} ${BOLD}${Math.round(s.throttle * 100)}%${RESET} ${DIM}· manual${RESET}`));
    }
    if (s?.backendNote) lines.push(row(`${YELLOW}${s.backendNote}${RESET}`));

    // ── update banner ──
    if (this.updateNotice_ && this.updateNoticeText(this.updateNotice_)) {
      const color = this.updateNotice_.mustUpdate ? RED : YELLOW;
      lines.push(row(`${BOLD}${color}${this.updateNoticeText(this.updateNotice_)}${RESET}`));
      lines.push(sep);
    }

    // ── sync row (only while syncing) ──
    // Label spells out what's happening: we download + verify BrowserCoin's chain
    // so the miner builds on the correct one. A dim one-line hint sits under it.
    if (!this.synced_) {
      const target = this.syncTarget;
      const cur = this.syncCurrent;
      const label = 'Verifying blockchain';
      // Reserve space for the label + numeric suffix, give the rest to the bar.
      const labelW = label.length + 2; // label + two trailing spaces
      let suffix: string;
      let frac: number;
      if (target > 0) {
        const pct = Math.floor((Math.min(cur, target) / target) * 100);
        suffix = `${group(cur)} / ${group(target)} blocks   ${pct}%`;
        frac = Math.min(cur, target) / target;
      } else {
        suffix = `${group(cur)} blocks…`;
        frac = 0; // indeterminate — show an empty/animated baseline bar
      }
      const barW = Math.max(8, inner - 2 - labelW - this.vlen(suffix) - 3);
      const barStr = target > 0 ? this.bar(frac, barW) : `${DIM}${'░'.repeat(barW)}${RESET}`;
      lines.push(row(`${DIM}${label}${RESET}  ${barStr}  ${BOLD}${suffix}${RESET}`));
      lines.push(row(`${DIM}downloading + checking the chain so you mine on the right one${RESET}`));
      lines.push(sep);
    }

    // ── two columns: HASHRATE | SESSION ──
    const colGap = 3;
    const colW = Math.floor((inner - 2 - colGap) / 2);
    const leftCol = this.hashrateColumn(colW);
    const rightCol = this.sessionColumn(colW);
    const colRows = Math.max(leftCol.length, rightCol.length);
    for (let i = 0; i < colRows; i++) {
      const l = this.padTo(leftCol[i] ?? '', colW);
      const r = this.padTo(rightCol[i] ?? '', colW);
      lines.push(row(`${l}${' '.repeat(colGap)}${r}`));
    }

    const kpiRows = this.kpiRows();
    if (kpiRows.length > 0) {
      lines.push(sep);
      for (const line of kpiRows) lines.push(row(line));
    }

    lines.push(sep);

    // ── events panel (fills the remaining vertical height) ──
    lines.push(row(`${BOLD}EVENTS${RESET}`));
    if (this.events.length === 0) {
      lines.push(row(`${DIM}  (no events yet)${RESET}`));
    } else {
      // Show the most recent events that fit, always keeping the footer
      // (separator + keys + bottom border = 3 lines) visible. Grows on tall
      // terminals, shrinks on short ones.
      const rows = Math.max(8, this.out.rows || 24);
      const budget = Math.max(1, rows - 1 - lines.length - 3);
      for (const e of this.events.slice(-budget)) {
        const color = e.level === 'error' ? RED : e.level === 'warn' ? YELLOW : DIM;
        lines.push(row(`  ${DIM}${this.clock(e.at)}${RESET} ${color}${e.msg}${RESET}`));
      }
    }

    lines.push(sep);
    // ── footer ──
    lines.push(row(`${DIM}q${RESET} quit ${DIM}·${RESET} ${DIM}s${RESET} settings ${DIM}·${RESET} ${DIM}u${RESET} update ${DIM}·${RESET} ${DIM}?${RESET} help`));
    lines.push(bottom);
    return lines;
  }

  /** Left column body lines (HASHRATE panel + sparkline). */
  private hashrateColumn(w: number): string[] {
    const out: string[] = [];
    out.push(`${BOLD}HASHRATE${RESET}`);
    out.push(`${DIM}now  ${RESET}${BOLD}${compact(this.latestHps)}${RESET}${DIM} H/s${RESET}`);
    out.push(`${DIM}avg  ${RESET}${compact(this.avgHps())}${DIM} H/s${RESET}`);
    out.push(`${DIM}peak ${RESET}${compact(this.peakHps)}${DIM} H/s${RESET}`);
    out.push(this.sparkline(Math.max(1, w)));
    return out;
  }

  /** Right column body lines (SESSION panel). */
  private sessionColumn(w: number): string[] {
    const s = this.status_;
    const out: string[] = [];
    out.push(`${BOLD}SESSION${RESET}`);
    out.push(`${DIM}up   ${RESET}${dur((Date.now() - this.startedAt) / 1000)}`);
    if (s?.mode === 'pool') {
      out.push(`${DIM}shrs ${RESET}${group(this.shareCount)} ${DIM}(${group(this.shareAccepted)} ok)${RESET}`);
    } else {
      out.push(`${DIM}fnd  ${RESET}${group(this.foundCount)} ${DIM}(${group(this.acceptedCount)}✓ ${group(this.rejectedCount)}✗)${RESET}`);
    }
    out.push(`${DIM}work ${RESET}${compact(this.totalHashes)}`);
    const net = this.netHeight !== undefined && this.netHeight > this.height ? ` ${DIM}net  ${RESET}${group(this.netHeight)}` : '';
    out.push(`${DIM}hgt  ${RESET}${group(this.height)}${net} ${DIM}diff ${this.difficultyHex}${RESET}`);
    return out;
  }

  private earningsText(e: EarningsInfo): string {
    if (e.kind === 'pool-balance') {
      return `earnings: ${e.earnedBrc} BRC (pending ${e.pendingBrc}, paid ${e.paidBrc})`;
    }
    if (e.kind === 'pool-shares') {
      const stats = e.pageUrl ? ` (stats: ${link(e.pageUrl, e.pageUrl)})` : '';
      return `shares: ${e.shares}${stats}`;
    }
    return `earnings (est): ${e.earnedBrc} BRC (${this.canonicalSolo().count} blocks)`;
  }

  private jackpotText(j: JackpotInfo): string {
    const last = j.lastWinner ? ` - last ${j.lastWinner.slice(0, 12)}...@${j.lastStrikeHeight ?? '?'}` : '';
    return `jackpot: ${Math.round(j.finderBonusPct * 100)}% finder bonus - blocks found: ${j.yourBlockStrikes}${last}`;
  }

  private updateNoticeText(n: UpdateNotice): string {
    if (n.mustUpdate) {
      return `UPDATE REQUIRED: v${n.currentVersion} -> v${n.latestVersion ?? '?'} - ${n.notice ?? 'run the update command'}`;
    }
    // Only show the version arrow when genuinely behind; otherwise surface the
    // pool's notice text (e.g. a fork heads-up) without a misleading "update".
    if (n.available && n.latestVersion) {
      return `update available: v${n.currentVersion} -> v${n.latestVersion} (press 'u' for the command)`;
    }
    return n.notice ?? '';
  }

  private kpiRows(): string[] {
    const out: string[] = [];
    if (this.earnings_) out.push(`${BOLD}${CYAN}EARNINGS${RESET} ${this.earningsText(this.earnings_)}`);
    if (this.jackpot_) out.push(`${BOLD}${CYAN}JACKPOT${RESET} ${this.jackpotText(this.jackpot_)}`);
    return out;
  }

  // --- compact (narrow / tiny terminal) layout ----------------------------
  private buildCompact(cols: number): string[] {
    const s = this.status_;
    const lines: string[] = [];
    const dot = `${this.stateColor()}●${RESET}`;
    lines.push(`${dot} ${BOLD}${this.stateColor()}${this.stateLabel()}${RESET} ${DIM}FulgurMiner${RESET}`);
    if (s) {
      const tgt = s.targetUrl ? s.target : s.mode === 'pool' ? s.target : 'solo';
      lines.push(`${DIM}tgt ${RESET}${tgt}`);
    }
    if (this.smart_) {
      const pct = `${Math.round(this.smart_.throttle * 100)}%`;
      let phaseLabel: string;
      switch (this.smart_.phase) {
        case 'ramping': phaseLabel = ' ↑ ramping…'; break;
        case 'holding': phaseLabel = ' · at max'; break;
        default: phaseLabel = this.smart_.throttle <= 0.15 ? ' · yielding to your apps' : ' · easing off (CPU busy)'; break;
      }
      lines.push(this.clampVisible(`${DIM}auto ${RESET}${pct}${phaseLabel}`, cols));
    } else if (s) {
      lines.push(this.clampVisible(`${DIM}thr ${RESET}${Math.round(s.throttle * 100)}% ${DIM}manual${RESET}`, cols));
    }
    if (s?.backendNote) lines.push(this.clampVisible(`${YELLOW}${s.backendNote}${RESET}`, cols));
    if (!this.synced_ && this.syncTarget > 0) {
      const pct = Math.floor((Math.min(this.syncCurrent, this.syncTarget) / this.syncTarget) * 100);
      lines.push(`${DIM}sync ${RESET}${group(this.syncCurrent)}/${group(this.syncTarget)} ${pct}%`);
    } else if (!this.synced_) {
      lines.push(`${DIM}sync ${RESET}${group(this.syncCurrent)}…`);
    }
    lines.push(`${DIM}h/s ${RESET}${BOLD}${compact(this.latestHps)}${RESET} ${DIM}peak ${RESET}${compact(this.peakHps)}`);
    lines.push(this.sparkline(Math.max(1, Math.min(cols - 1, 24))));
    if (s?.mode === 'pool') {
      lines.push(`${DIM}shrs ${RESET}${group(this.shareCount)}`);
    } else {
      lines.push(`${DIM}fnd ${RESET}${group(this.foundCount)}`);
    }
    const netNarrow = this.netHeight !== undefined && this.netHeight > this.height ? ` ${DIM}net ${RESET}${group(this.netHeight)}` : '';
    lines.push(`${DIM}hgt ${RESET}${group(this.height)}${netNarrow}`);
    if (this.updateNotice_ && this.updateNoticeText(this.updateNotice_)) {
      const color = this.updateNotice_.mustUpdate ? RED : YELLOW;
      lines.push(this.clampVisible(`${color}${this.updateNoticeText(this.updateNotice_)}${RESET}`, cols));
    }
    if (this.earnings_) lines.push(this.clampVisible(`${CYAN}${this.earningsText(this.earnings_)}${RESET}`, cols));
    if (this.jackpot_) lines.push(this.clampVisible(`${CYAN}${this.jackpotText(this.jackpot_)}${RESET}`, cols));
    const last = this.events[this.events.length - 1];
    if (last) {
      const color = last.level === 'error' ? RED : last.level === 'warn' ? YELLOW : DIM;
      lines.push(`${color}${last.msg}${RESET}`);
    }
    lines.push(`${DIM}q quit · s settings · u update · ? help${RESET}`);
    return lines;
  }

  private clock(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  private hostOf(url: string): string {
    try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, ''); }
  }
}
