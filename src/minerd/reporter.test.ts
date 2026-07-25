// src/minerd/reporter.test.ts
//
// Tests for ConsoleReporter — specifically the ASCII-only smart-mode status line.
// The INVARIANT: ConsoleReporter must never emit colour/SGR, OSC-8 links, or any
// non-ASCII control sequence (it runs in piped/non-TTY mode too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleReporter } from './reporter.js';
import type { JackpotInfo, SmartInfo } from './reporter.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Capture all bytes written to process.stdout.write during fn(). */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: string) => { chunks.push(s); return true; };
  try { fn(); } finally { (process.stdout as any).write = orig; }
  return chunks.join('');
}

/** True when a string contains ONLY plain ASCII (no ANSI escapes, no unicode). */
function isAsciiOnly(s: string): boolean {
  // Allow \r, \n, \t, and printable 0x20–0x7e; reject everything else.
  return /^[\r\n\t\x20-\x7e]*$/.test(s);
}

/** Build a minimal SmartInfo for tests. */
function smartInfo(phase: 'ramping' | 'holding' | 'easing', throttle: number): SmartInfo {
  return { mode: 'considerate', throttle, clamped: phase === 'easing', phase };
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('ConsoleReporter.smart(ramping) appends "ramping" ASCII label on the status line', () => {
  const r = new ConsoleReporter();
  r.status({ mode: 'pool', target: 'FulgurPool', backend: 'wasm', workers: 2, throttle: 0.75, address: 'a'.repeat(64) });
  r.smart(smartInfo('ramping', 0.75));
  const out = captureStdout(() => r.hashrate(100));
  assert.ok(out.includes('auto 75% ramping'), `expected "auto 75% ramping" in: ${JSON.stringify(out)}`);
  assert.ok(isAsciiOnly(out), `status line must be ASCII-only, got: ${JSON.stringify(out)}`);
});

test('ConsoleReporter.smart(holding) appends "max" ASCII label on the status line', () => {
  const r = new ConsoleReporter();
  r.status({ mode: 'pool', target: 'FulgurPool', backend: 'wasm', workers: 2, throttle: 0.80, address: 'a'.repeat(64) });
  r.smart(smartInfo('holding', 0.80));
  const out = captureStdout(() => r.hashrate(200));
  assert.ok(out.includes('auto 80% max'), `expected "auto 80% max" in: ${JSON.stringify(out)}`);
  assert.ok(isAsciiOnly(out), `status line must be ASCII-only, got: ${JSON.stringify(out)}`);
});

test('ConsoleReporter.smart(easing, throttle>15%) appends "easing off" ASCII label', () => {
  const r = new ConsoleReporter();
  r.status({ mode: 'pool', target: 'FulgurPool', backend: 'wasm', workers: 2, throttle: 0.50, address: 'a'.repeat(64) });
  r.smart(smartInfo('easing', 0.50));
  const out = captureStdout(() => r.hashrate(50));
  assert.ok(out.includes('auto 50% easing off'), `expected "auto 50% easing off" in: ${JSON.stringify(out)}`);
  assert.ok(isAsciiOnly(out), `status line must be ASCII-only, got: ${JSON.stringify(out)}`);
});

test('ConsoleReporter.smart(easing, throttle<=15%) appends "yielding" ASCII label', () => {
  const r = new ConsoleReporter();
  r.status({ mode: 'pool', target: 'FulgurPool', backend: 'wasm', workers: 2, throttle: 0.10, address: 'a'.repeat(64) });
  r.smart(smartInfo('easing', 0.10));
  const out = captureStdout(() => r.hashrate(10));
  assert.ok(out.includes('auto 10% yielding'), `expected "auto 10% yielding" in: ${JSON.stringify(out)}`);
  assert.ok(isAsciiOnly(out), `status line must be ASCII-only, got: ${JSON.stringify(out)}`);
});

// ─── jackpot / session-end parity (FIX 3) ────────────────────────────────────

const jp = (): JackpotInfo => ({ finderBonusPct: 0.03, yourBlockStrikes: 1 });

test('ConsoleReporter: jackpot() renders a line while the session is open', () => {
  const r = new ConsoleReporter();
  const out = captureStdout(() => r.jackpot(jp()));
  assert.match(out, /jackpot: 3% finder bonus - blocks found: 1/);
});

test('ConsoleReporter: jackpot() after close() prints nothing — a stale panel must not survive session end', () => {
  const r = new ConsoleReporter();
  r.close?.();
  const out = captureStdout(() => r.jackpot(jp()));
  assert.equal(out, '', `expected no output after close(), got: ${JSON.stringify(out)}`);
});

test('ConsoleReporter status line is always ASCII-only (no SGR/unicode) in smart mode', () => {
  for (const phase of ['ramping', 'holding', 'easing'] as const) {
    for (const throttle of [0.05, 0.15, 0.50, 0.80, 1.0]) {
      const r = new ConsoleReporter();
      r.status({ mode: 'pool', target: 'FulgurPool', backend: 'wasm', workers: 2, throttle, address: 'a'.repeat(64) });
      r.smart(smartInfo(phase, throttle));
      const out = captureStdout(() => r.hashrate(100));
      assert.ok(isAsciiOnly(out), `phase=${phase} throttle=${throttle}: not ASCII-only: ${JSON.stringify(out)}`);
    }
  }
});

// ─── network-tip visibility (net=) ──────────────────────────────────────────

test('ConsoleReporter renders net= only when the network tip differs from local', () => {
  const r = new ConsoleReporter();
  r.chain(100, 'ff', 103);
  let out = captureStdout(() => r.hashrate(50));
  assert.ok(out.includes('h=100 net=103'), `expected "h=100 net=103" in: ${JSON.stringify(out)}`);
  assert.ok(isAsciiOnly(out));
  r.chain(103, 'ff', 103);
  out = captureStdout(() => r.hashrate(50));
  assert.ok(!out.includes('net='), `no net= when in sync: ${JSON.stringify(out)}`);
});

test('ConsoleReporter omits net= when netHeight is not provided (back-compat)', () => {
  const r = new ConsoleReporter();
  r.chain(100, 'ff');
  const out = captureStdout(() => r.hashrate(50));
  assert.ok(out.includes('h=100 ') && !out.includes('net='));
});

test('ConsoleReporter omits net= when the local chain is AHEAD of the observed network tip', () => {
  // Reorg onto a heavier-but-SHORTER fork, or a block we just mined: the network
  // tip is genuinely below us. Truthful to record, but not worth a status flag.
  const r = new ConsoleReporter();
  r.chain(205, 'ff', 190);
  const out = captureStdout(() => r.hashrate(50));
  assert.ok(out.includes('h=205 ') && !out.includes('net='), `unexpected net= while ahead: ${JSON.stringify(out)}`);
});
