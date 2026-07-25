// Snapshot persistence: the scripting hard-fork added script `locks` to State.
// The miner's snapshot stores MATERIALIZED state (unlike the pool, which stores
// block-hex and replays), so it must serialize locks too — otherwise a post-fork
// anchor restores locks-less and the restored stateRoot no longer matches the
// anchor block's committed root.
//
// Two layers of coverage:
//   1. Pure data-path: serializeState + serializeLocks → JSON → deserializeState.
//   2. The real restoreSnapshot() code path, exercising the v2 schema gate and
//      the anchor-stateRoot verification — HOME-isolated to a temp dir so it
//      never touches the user's real ~/.fulgurminer, and using a single mined
//      block as the anchor (no 100-deep chain needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import {
  emptyState,
  serializeState,
  serializeLocks,
  deserializeState,
  stateRoot,
  getLock,
} from '../chain/state.js';
import { bytesToHex } from '../util/binary.js';
import { Blockchain } from '../chain/blockchain.js';
import { GENESIS } from '../chain/genesis.js';
import { hashHeader, encodeBlock } from '../chain/block.js';
import { generateKeyPair } from '../crypto/keys.js';
import { emptyMine } from '../chain/testutil.js';
import { restoreSnapshot, snapshotPath, snapshotDir } from './persistence.js';

const ACCT = 'aa'.repeat(32);
const LOCK_ID = 'bb'.repeat(32);
const NETWORK_TAG = bytesToHex(hashHeader(GENESIS.header)).slice(0, 16);

// ── data path ──────────────────────────────────────────────────────────────

test('snapshot round-trip: a live lock survives serialize → JSON → deserialize and the stateRoot is preserved', () => {
  const s = emptyState();
  s.accounts.set(ACCT, { balance: 123n, nonce: 4 });
  const scriptHash = new Uint8Array(32).fill(7);
  s.locks.set(LOCK_ID, { amount: 10n, scriptHash, createdHeight: 9 });
  const rootBefore = bytesToHex(stateRoot(s));

  const onDisk = JSON.stringify({ state: serializeState(s), locks: serializeLocks(s) });
  const parsed = JSON.parse(onDisk) as { state: never; locks: never };
  const restored = deserializeState(parsed.state, parsed.locks);

  const lock = getLock(restored, LOCK_ID);
  assert.ok(lock, 'the lock must be present after restore');
  assert.equal(lock!.amount, 10n);
  assert.equal(lock!.createdHeight, 9);
  assert.equal(bytesToHex(lock!.scriptHash), bytesToHex(scriptHash));
  assert.equal(bytesToHex(stateRoot(restored)), rootBefore, 'restored stateRoot must equal the original');
});

test('snapshot round-trip: dropping locks (the v1 bug) changes the stateRoot — proving locks are load-bearing', () => {
  const s = emptyState();
  s.accounts.set(ACCT, { balance: 123n, nonce: 4 });
  s.locks.set(LOCK_ID, { amount: 10n, scriptHash: new Uint8Array(32).fill(7), createdHeight: 9 });
  const withLocks = bytesToHex(stateRoot(s));

  const locksLess = deserializeState(serializeState(s), []);
  assert.notEqual(
    bytesToHex(stateRoot(locksLess)),
    withLocks,
    'omitting locks must change the root — exactly why the v2 schema bump discards locks-less v1 files',
  );
});

test('snapshot round-trip: a no-lock (pre-fork) state round-trips unchanged', () => {
  const s = emptyState();
  s.accounts.set(ACCT, { balance: 50n, nonce: 1 });
  const before = bytesToHex(stateRoot(s));
  const restored = deserializeState(serializeState(s), serializeLocks(s));
  assert.equal(restored.locks.size, 0);
  assert.equal(bytesToHex(stateRoot(restored)), before);
});

// ── real restoreSnapshot() path (HOME-isolated, single mined anchor) ─────────

/** Run `fn` with HOME pointed at a throwaway temp dir so snapshotPath() never
 *  resolves to the user's real ~/.fulgurminer. Restored even on throw. */
async function withTempHome(fn: () => Promise<void> | void): Promise<void> {
  const orig = process.env.HOME;
  process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'fulgur-snap-'));
  try {
    mkdirSync(snapshotDir(), { recursive: true });
    await fn();
  } finally {
    if (orig === undefined) delete process.env.HOME;
    else process.env.HOME = orig;
  }
}

/** Build a syntactically valid schema-2 snapshot whose single anchor is a real
 *  mined block-1, with `mutate` applied to the payload before writing. */
async function makeAnchorSnapshot(mutate: (snap: Record<string, unknown>) => void): Promise<void> {
  const miner = generateKeyPair();
  const chain = new Blockchain();
  const block1 = await emptyMine(chain, miner.publicKey);
  await chain.addBlock(block1);
  const post = chain.tipState; // materialized post-block-1 state
  const snap: Record<string, unknown> = {
    schema: 2,
    network: NETWORK_TAG,
    anchorHeight: 1,
    anchorHashHex: bytesToHex(hashHeader(block1.header)),
    blocksHex: [bytesToHex(encodeBlock(block1))],
    state: serializeState(post),
    locks: serializeLocks(post),
  };
  mutate(snap);
  writeFileSync(snapshotPath(), JSON.stringify(snap));
}

test('restoreSnapshot: a well-formed schema-2 snapshot restores to its anchor', { timeout: 120_000 }, async () => {
  await withTempHome(async () => {
    await makeAnchorSnapshot(() => {});
    const outcome = restoreSnapshot(new Blockchain());
    assert.equal(outcome.restored, true, 'a consistent snapshot must restore');
    assert.equal(outcome.restored === true && outcome.anchorHeight, 1);
  });
});

test('restoreSnapshot: a tampered materialized state (root ≠ anchor header) is discarded, not mined', { timeout: 120_000 }, async () => {
  await withTempHome(async () => {
    // Corrupt the anchor state so its stateRoot no longer matches the anchor
    // block's committed root — the exact failure the new check must catch.
    await makeAnchorSnapshot((snap) => {
      (snap.state as [string, string, number][]).push(['cc'.repeat(32), '999999', 0]);
    });
    const outcome = restoreSnapshot(new Blockchain());
    assert.equal(outcome.restored, false, 'a state whose root ≠ the anchor header must be discarded (no wrong-state mining)');
    assert.equal(existsSync(snapshotPath()), false, 'the bad snapshot file must be removed');
  });
});

test('restoreSnapshot: a v1 (pre-bump) schema is discarded outright', { timeout: 120_000 }, async () => {
  await withTempHome(async () => {
    await makeAnchorSnapshot((snap) => { snap.schema = 1; });
    const outcome = restoreSnapshot(new Blockchain());
    assert.equal(outcome.restored, false, 'v1 schema must be rejected by the v2 gate');
  });
});

test('restoreSnapshot: a prefix whose length disagrees with anchorHeight is discarded', { timeout: 120_000 }, async () => {
  // blocksHex is heights 1..anchor inclusive, so length === anchorHeight always.
  // NOTE: this outcome held before the length pre-check too (the anchor-height
  // comparison caught it AFTER decoding every entry). The pre-check turns an
  // unbounded decode-then-reject into an O(1) rejection; this test pins the
  // OUTCOME so neither path can regress it.
  await withTempHome(async () => {
    await makeAnchorSnapshot((snap) => { snap.anchorHeight = 5; }); // still one block
    const outcome = restoreSnapshot(new Blockchain());
    assert.equal(outcome.restored, false, 'prefix length must match the declared anchor height');
  });
});

test('restoreSnapshot: a non-integer anchorHeight is discarded', { timeout: 120_000 }, async () => {
  // typeof x === 'number' admits NaN, negatives and fractions. Also already
  // rejected pre-check (via the height comparison); pinned so it stays rejected.
  await withTempHome(async () => {
    await makeAnchorSnapshot((snap) => { snap.anchorHeight = 1.5; });
    const outcome = restoreSnapshot(new Blockchain());
    assert.equal(outcome.restored, false, 'a fractional anchor height must be rejected');
  });
});
