import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolvePoolUrl, resolveSyncWorkers } from './config.js';

test('MINER_SMART parses off|max|considerate, defaults off', () => {
  assert.equal(loadConfig({ MINER_PUBKEY: 'aa'.repeat(32) }).smart, 'off');
  assert.equal(loadConfig({ MINER_PUBKEY: 'aa'.repeat(32), MINER_SMART: 'max' }).smart, 'max');
  assert.equal(loadConfig({ MINER_PUBKEY: 'aa'.repeat(32), MINER_SMART: 'CONSIDERATE' }).smart, 'considerate');
  assert.equal(loadConfig({ MINER_PUBKEY: 'aa'.repeat(32), MINER_SMART: 'garbage' }).smart, 'off');
});

test('loadConfig falls back to default helpers when MINER_HELPERS is malformed/empty', () => {
  const cfg = loadConfig({ MINER_PUBKEY: 'aa'.repeat(32), MINER_HELPERS: ' , ,  ' });
  assert.deepEqual(cfg.helpers, [
    'https://api1.browsercoin.org',
    'https://api2.browsercoin.org',
    'https://api1.taitech.eu',
    'https://api1.cryptec.tech',
  ]);
});

test('resolvePoolUrl: scheme-less value is canonicalised to https:// (.env.example says https:// may be omitted)', () => {
  assert.equal(resolvePoolUrl('pool.example.org'), 'https://pool.example.org');
  assert.equal(resolvePoolUrl('https://pool.example.org/'), 'https://pool.example.org');
  assert.equal(resolvePoolUrl('http://localhost:3333'), 'http://localhost:3333');
});

test('resolvePoolUrl: solo/off/none and blank keep their meaning', () => {
  assert.equal(resolvePoolUrl('solo'), undefined);
  assert.equal(resolvePoolUrl('off'), undefined);
  assert.equal(resolvePoolUrl('none'), undefined);
  assert.equal(resolvePoolUrl(''), 'https://pool.fulgurpool.xyz'); // DEFAULT_POOL
  assert.equal(resolvePoolUrl(undefined), 'https://pool.fulgurpool.xyz');
});

test('resolvePoolUrl: a malformed pool value throws a clear error, never a broken URL', () => {
  assert.throws(() => resolvePoolUrl('has spaces'), /pool/i);
});

test('loadConfig: non-numeric MINER_TIP_POLL_MS falls back to the 3000ms default, never NaN', () => {
  const cfg = loadConfig({ MINER_PUBKEY: '00'.repeat(32), MINER_TIP_POLL_MS: 'abc' });
  assert.equal(cfg.tipPollMs, 3000);
  const cfg2 = loadConfig({ MINER_PUBKEY: '00'.repeat(32), MINER_TIP_POLL_MS: '500' });
  assert.equal(cfg2.tipPollMs, 500);
  const cfg3 = loadConfig({ MINER_PUBKEY: '00'.repeat(32), MINER_TIP_POLL_MS: '100' });
  assert.equal(cfg3.tipPollMs, 500); // floored at 500 minimum
});

test('loadConfig: a blank MINER_TIP_POLL_MS (=\'\') is treated as unset, not Number(\'\')=0', () => {
  const cfg = loadConfig({ MINER_PUBKEY: '00'.repeat(32), MINER_TIP_POLL_MS: '' });
  assert.equal(cfg.tipPollMs, 3000);
});

test('resolveSyncWorkers: defaults to a modest verifier cap without reducing mining workers', () => {
  assert.equal(resolveSyncWorkers(undefined, 64), 8);
  assert.equal(resolveSyncWorkers('', 64), 8);
  assert.equal(resolveSyncWorkers(undefined, 4), 4);
  assert.equal(resolveSyncWorkers('junk', 64), 8);
});

test('resolveSyncWorkers: explicit value is floored and capped by mining workers', () => {
  assert.equal(resolveSyncWorkers('2', 64), 2);
  assert.equal(resolveSyncWorkers('2.9', 64), 2);
  assert.equal(resolveSyncWorkers('0', 64), 1);
  assert.equal(resolveSyncWorkers('999', 64), 64);
});

test('loadConfig: MINER_SYNC_WORKERS controls sync only; MINER_WORKERS still controls mining', () => {
  const cfg = loadConfig({ MINER_PUBKEY: '00'.repeat(32), MINER_WORKERS: '4', MINER_SYNC_WORKERS: '3' });
  assert.equal(cfg.workers, 4);
  assert.equal(cfg.syncWorkers, 3);
});
