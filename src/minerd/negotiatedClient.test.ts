import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNegotiatedTemplate, classifyCatchUpRound, classifyTemplateResult, decodeMempool,
  headerMatchesTemplate, isHexTarget, mempoolEntryAcceptable, negotiatedRequired, parseFrame,
  poolWsUrl, pruneOutstanding, settleOutstanding, shouldWarnStaleSource,
  negotiatedColdStart, type NegotiatedColdStartDeps,
  negotiatedBackendNote, NEGOTIATED_BANNER,
} from './negotiatedClient.js';
import type { RestoreOutcome } from './persistence.js';
import type { SnapshotConfirmResult } from './miner.js';
import { Blockchain } from '../chain/blockchain.js';
import { computeTxRoot, encodeHeader, type Block } from '../chain/block.js';
import { bytesToHex, compareBytes } from '../util/binary.js';
import { smartStartDuty, CONSIDERATE_START } from './smartController.js';

test('negotiatedRequired: 410 is the definitive signal, regardless of body', () => {
  assert.equal(negotiatedRequired(410, null), true);
  assert.equal(negotiatedRequired(410, { error: 'anything' }), true);
});

test('negotiatedRequired: error-text fallback (proxy rewrote the status)', () => {
  assert.equal(negotiatedRequired(400, { error: 'This pool requires Negotiated mining mode' }), true);
  assert.equal(negotiatedRequired(400, { error: 'bad payoutAddress' }), false);
  assert.equal(negotiatedRequired(426, null), false);
  assert.equal(negotiatedRequired(400, 'not-an-object'), false);
  assert.equal(negotiatedRequired(400, null), false);
});

test('negotiatedRequired: the text fallback is bounded to 400 — it cannot hijack another fatal', () => {
  // 426 has its own handler (upgrade required / minMinerVersion). A body that
  // merely mentions the mode must not divert it into the negotiated hand-off.
  assert.equal(negotiatedRequired(426, { error: 'upgrade required for negotiated mode' }), false);
  assert.equal(negotiatedRequired(403, { error: 'negotiated' }), false);
  assert.equal(negotiatedRequired(500, { error: 'negotiated' }), false);
  // 410 stays unconditional.
  assert.equal(negotiatedRequired(410, { error: 'anything at all' }), true);
});

test('poolWsUrl: http(s) -> ws(s), trailing slashes stripped, /ws appended', () => {
  assert.equal(poolWsUrl('https://brcpool.example.com'), 'wss://brcpool.example.com/ws');
  assert.equal(poolWsUrl('http://localhost:3333'), 'ws://localhost:3333/ws');
  assert.equal(poolWsUrl('https://pool.example.com///'), 'wss://pool.example.com/ws');
});

test('decodeMempool: malformed / non-hex entries are skipped, never thrown', () => {
  assert.deepEqual(decodeMempool([]), []);
  assert.deepEqual(decodeMempool(['zz', '', 'deadbeef', '00'.repeat(3)]), []);
});

test('buildNegotiatedTemplate: empty block off genesis, coinbase pays the pool', () => {
  const chain = new Blockchain();
  const poolPub = new Uint8Array(32).fill(7);
  const before = Math.floor(Date.now() / 1000);

  const block = buildNegotiatedTemplate(chain, poolPub, []);

  assert.equal(block.header.height, 1);
  assert.equal(compareBytes(block.header.prevHash, chain.tip.hash), 0);
  assert.equal(compareBytes(block.header.miner, poolPub), 0);
  assert.equal(block.header.nonce, 0);
  assert.equal(block.transactions.length, 0);
  assert.equal(compareBytes(block.header.txRoot, computeTxRoot([])), 0);
  // Fork-#3-aware difficulty: must match what the validator expects for this timestamp.
  assert.equal(block.header.difficulty, chain.expectedNextDifficulty(block.header.timestamp));
  // Timestamp: honest clock, strictly above the parent MTP.
  assert.ok(block.header.timestamp >= before);
  assert.ok(block.header.timestamp > chain.nextBlockScriptContext().blockMtp);
});

test('headerMatchesTemplate: accepts the pool echoing back exactly the header we built', () => {
  const chain = new Blockchain();
  const block = buildNegotiatedTemplate(chain, new Uint8Array(32).fill(7), []);
  const ours = bytesToHex(encodeHeader(block.header));

  assert.equal(headerMatchesTemplate(block, ours), true);
  assert.equal(headerMatchesTemplate(block, ours.toUpperCase()), true, 'case-insensitive');
});

test('headerMatchesTemplate: rejects a header the pool changed — this is the whole security property', () => {
  const chain = new Blockchain();
  const block = buildNegotiatedTemplate(chain, new Uint8Array(32).fill(7), []);

  // A pool steering us onto a parent of ITS choosing: same header, other prevHash.
  const steered = { ...block, header: { ...block.header, prevHash: new Uint8Array(32).fill(0xab) } };
  assert.equal(headerMatchesTemplate(block, bytesToHex(encodeHeader(steered.header))), false);

  // A pool censoring / swapping the transaction set.
  const censored = { ...block, header: { ...block.header, txRoot: new Uint8Array(32).fill(0xcd) } };
  assert.equal(headerMatchesTemplate(block, bytesToHex(encodeHeader(censored.header))), false);

  // Garbage / missing / wrong-typed fields are never a match.
  assert.equal(headerMatchesTemplate(block, undefined), false);
  assert.equal(headerMatchesTemplate(block, null), false);
  assert.equal(headerMatchesTemplate(block, ''), false);
  assert.equal(headerMatchesTemplate(block, 'deadbeef'), false);
  assert.equal(headerMatchesTemplate(block, { headerHex: 'x' }), false);
});

// Two templates in flight: the pool was slower than the result watchdog, so a
// second template was registered while the first was still pending. Treating a
// result as "must be the last one I sent" made the two cancel each other out
// forever and the miner never started grinding.
function entryFor(block: Block, at: number): { headerHex: string; at: number } {
  return { headerHex: bytesToHex(encodeHeader(block.header)), at };
}
function twoInFlight(): { a: { headerHex: string; at: number }; b: { headerHex: string; at: number } } {
  const chain = new Blockchain();
  return {
    a: entryFor(buildNegotiatedTemplate(chain, new Uint8Array(32).fill(1), []), 1_000),
    b: entryFor(buildNegotiatedTemplate(chain, new Uint8Array(32).fill(2), []), 2_000),
  };
}
const hexOf = (e: { headerHex: string }): string => e.headerHex;

test('settleOutstanding: a result for the OLDER template does not discard the newer one', () => {
  const { a, b } = twoInFlight();

  // A's result arrives first: A is matched, B stays in flight.
  const first = settleOutstanding([a, b], hexOf(a));
  assert.ok(first);
  assert.equal(first.matched, a);
  assert.deepEqual(first.rest, [b], 'the newer template must survive');

  // B's result then still correlates — this is the step that used to find
  // nothing pending and livelock.
  const second = settleOutstanding(first.rest, hexOf(b));
  assert.ok(second);
  assert.equal(second.matched, b);
  assert.deepEqual(second.rest, []);
});

test('settleOutstanding: out-of-order results both settle (newer answered first)', () => {
  const { a, b } = twoInFlight();

  // The pool answers B before A. B must NOT take A down with it — dropping
  // "everything older than the match" made A's own valid result read as foreign
  // and kill the good grind B had just started.
  const first = settleOutstanding([a, b], hexOf(b));
  assert.ok(first);
  assert.equal(first.matched, b);
  assert.deepEqual(first.rest, [a], 'the older template is still awaiting its own result');

  const second = settleOutstanding(first.rest, hexOf(a));
  assert.ok(second, 'A must still correlate after B settled first');
  assert.equal(second.matched, a);
  assert.deepEqual(second.rest, []);
});

test('settleOutstanding: a header matching nothing in flight is refused', () => {
  const { a, b } = twoInFlight();
  const foreign = entryFor(buildNegotiatedTemplate(new Blockchain(), new Uint8Array(32).fill(3), []), 0);
  assert.equal(settleOutstanding([a, b], hexOf(foreign)), null);
  assert.equal(settleOutstanding([], hexOf(a)), null);
  assert.equal(settleOutstanding([a], 'not-a-header'), null);
  assert.equal(settleOutstanding([a], undefined), null);
});

test('classifyTemplateResult: an acceptance correlates itself, a rejection only when it is the sole answer', () => {
  // Accepted results carry the header, so they correlate however many are in
  // flight.
  assert.equal(classifyTemplateResult(true, 0), 'match-accepted');
  assert.equal(classifyTemplateResult(true, 3), 'match-accepted');

  // A rejection carries nothing. Unambiguous only when it answered the sole
  // unanswered send.
  assert.equal(classifyTemplateResult(false, 0), 'settle-and-retry');

  // Ambiguous: another send is still unanswered. Settling here would clear a
  // registration this rejection was never about — including across a tip change,
  // where the list was cleared while the pool's answer was still in transit.
  assert.equal(classifyTemplateResult(false, 1), 'ignore-ambiguous');
  assert.equal(classifyTemplateResult(false, 9), 'ignore-ambiguous');
});

test('classifyCatchUpRound: reaching the announced tip is converged regardless of change', () => {
  assert.equal(classifyCatchUpRound({ changed: true, reachedTip: true }), 'converged');
  assert.equal(classifyCatchUpRound({ changed: false, reachedTip: true }), 'converged');
});

test('classifyCatchUpRound: progress without convergence is progressing (stays silent)', () => {
  assert.equal(classifyCatchUpRound({ changed: true, reachedTip: false }), 'progressing');
});

test('classifyCatchUpRound: no change while short of the announced tip is the stale-source signature', () => {
  assert.equal(classifyCatchUpRound({ changed: false, reachedTip: false }), 'stalled');
});

test('shouldWarnStaleSource: stalled + a real gap, once per episode — a 1-block gap is a propagation race', () => {
  assert.equal(shouldWarnStaleSource('stalled', 2, false), true);
  assert.equal(shouldWarnStaleSource('stalled', 1, false), false); // the pool's own fresh block, not yet at the helpers
  assert.equal(shouldWarnStaleSource('stalled', 5, true), false);  // already warned this episode
  assert.equal(shouldWarnStaleSource('progressing', 9, false), false);
  assert.equal(shouldWarnStaleSource('converged', 0, false), false);
});

test('pruneOutstanding: retires by AGE, so a slow pool cannot be evicted by count alone', () => {
  const now = 1_000_000;
  const fresh = { at: now - 1_000 };
  // Inside the 30-minute TTL: a pool this slow is still answered, not evicted.
  const slow = { at: now - 25 * 60_000 };
  const old = { at: now - 31 * 60_000 };
  assert.deepEqual(pruneOutstanding([old, fresh], now), [fresh], 'aged-out entry dropped');
  assert.deepEqual(pruneOutstanding([slow, fresh], now), [slow, fresh], 'a slow pool is still correlatable');
  assert.deepEqual(pruneOutstanding([fresh], now), [fresh]);

  // No count eviction at all: a live registration must never be pushed out by
  // volume, however fast a pool streams results. Every accumulation bug in this
  // state machine ended with a count cap evicting an entry whose answer was
  // still coming.
  const many = Array.from({ length: 5_000 }, (_, i) => ({ at: now - (5_000 - i) }));
  assert.equal(pruneOutstanding(many, now).length, 5_000, 'nothing is evicted by count');
});

test('buildNegotiatedTemplate: rejects a pool address that is not 32 bytes', () => {
  const chain = new Blockchain();
  assert.throws(() => buildNegotiatedTemplate(chain, new Uint8Array(31), []), /32 bytes/);
  assert.throws(() => buildNegotiatedTemplate(chain, new Uint8Array(0), []), /32 bytes/);
});

test('mempoolEntryAcceptable: bounds pool input BEFORE it is decoded', () => {
  const TX_BYTE_BUDGET = 256 * 1024 - 1_024; // MAX_BLOCK_BYTES - 1024
  const ok = 'ab'.repeat(100);

  assert.equal(mempoolEntryAcceptable(ok, 0), true);
  // Per-entry cap: one entry may not exceed a block's worth of hex.
  assert.equal(mempoolEntryAcceptable('a'.repeat(TX_BYTE_BUDGET * 2 + 1), 0), false);
  // Aggregate cap: many mid-sized entries must not add up without limit. This is
  // the half the per-entry cap alone does not cover, because `bytes` in
  // decodeMempool only counts entries that successfully decode.
  assert.equal(mempoolEntryAcceptable(ok, TX_BYTE_BUDGET * 4), false);
  assert.equal(mempoolEntryAcceptable(ok, TX_BYTE_BUDGET * 4 - ok.length), true);
  // Non-strings and empties never reach the decoder.
  assert.equal(mempoolEntryAcceptable(undefined, 0), false);
  assert.equal(mempoolEntryAcceptable(12345, 0), false);
  assert.equal(mempoolEntryAcceptable('', 0), false);
});

test('decodeMempool: an oversized pool entry is skipped rather than decoded', () => {
  const huge = 'ab'.repeat(1_000_000); // 2 MB — well past the block budget
  assert.deepEqual(decodeMempool([huge]), []);
  // The bound itself is asserted in the mempoolEntryAcceptable test above; this
  // only pins that an oversized entry cannot throw its way out of the loop.
  assert.deepEqual(decodeMempool([huge, huge, 'zz']), []);
});

test('poolWsUrl: an uppercase scheme still rewrites (headless MINER_POOL is not canonicalised)', () => {
  assert.equal(poolWsUrl('HTTPS://pool.example.com'), 'wss://pool.example.com/ws');
  assert.equal(poolWsUrl('Http://localhost:3333'), 'ws://localhost:3333/ws');
});

test('buildNegotiatedTemplate: a mempool set that conflicts with our state falls back to an empty block', () => {
  const chain = new Blockchain();
  const poolPub = new Uint8Array(32).fill(9);
  // Structurally invalid/garbage entries are dropped by decodeMempool, so the
  // build still succeeds with zero txs.
  const block = buildNegotiatedTemplate(chain, poolPub, ['nonsense', 'ffff']);
  assert.equal(block.transactions.length, 0);
  assert.equal(block.header.height, 1);
});

// ── negotiatedColdStart: restore → confirm → bootstrap → integrity gate ──

/** Dep doubles with a call log + mutable state the tests flip mid-flow. */
function coldDeps(opts: {
  restore?: RestoreOutcome;
  confirm?: SnapshotConfirmResult;
  integrity?: boolean;
} = {}) {
  const calls: string[] = [];
  const state = { invalidated: false, aborted: false };
  const deps: NegotiatedColdStartDeps = {
    restore: () => { calls.push('restore'); return opts.restore ?? { restored: false }; },
    confirm: async (h) => { calls.push(`confirm:${h}`); return opts.confirm ?? { ok: true }; },
    bootstrap: async () => { calls.push('bootstrap'); },
    integrityOK: () => { calls.push('integrity'); return opts.integrity ?? true; },
    invalidated: () => state.invalidated,
    clearInvalidated: () => { calls.push('clearInvalidated'); state.invalidated = false; },
    discardSnapshot: () => { calls.push('discard'); },
    resetChain: () => { calls.push('reset'); },
    aborted: () => state.aborted,
    height: () => 4_242,
    info: (m) => { calls.push(`info:${m.split(' ')[0]}`); },
  };
  return { deps, calls, state };
}

test('coldStart: no snapshot → one full bootstrap, nothing confirmed or discarded', async () => {
  const { deps, calls } = coldDeps();
  assert.deepEqual(await negotiatedColdStart(deps), { ok: true, warm: false });
  assert.deepEqual(calls, ['restore', 'bootstrap']);
});

test('coldStart: warm restore, confirmed, integrity ok → delta bootstrap, stays warm', async () => {
  const { deps, calls } = coldDeps({ restore: { restored: true, anchorHeight: 100 } });
  assert.deepEqual(await negotiatedColdStart(deps), { ok: true, warm: true });
  assert.deepEqual(calls, ['restore', 'confirm:100', 'info:resuming', 'bootstrap', 'integrity']);
});

test('coldStart: forged confirm → file DISCARDED (not just reset), full sync, not warm', async () => {
  const { deps, calls } = coldDeps({
    restore: { restored: true, anchorHeight: 7 },
    confirm: { ok: false, kind: 'forged', reason: 'anchor-not-canonical' },
  });
  assert.deepEqual(await negotiatedColdStart(deps), { ok: true, warm: false });
  assert.deepEqual(calls, ['restore', 'confirm:7', 'discard', 'info:saved', 'bootstrap']);
});

test('coldStart: indeterminate confirm → file KEPT (reset only), full sync this session', async () => {
  const { deps, calls } = coldDeps({
    restore: { restored: true, anchorHeight: 7 },
    confirm: { ok: false, kind: 'indeterminate', reason: 'helper-unreachable: x' },
  });
  assert.deepEqual(await negotiatedColdStart(deps), { ok: true, warm: false });
  assert.deepEqual(calls, ['restore', 'confirm:7', 'reset', 'info:could', 'bootstrap']);
});

test('coldStart: integrity gate fails → discard + ONE full re-bootstrap, not warm', async () => {
  const { deps, calls } = coldDeps({ restore: { restored: true, anchorHeight: 9 }, integrity: false });
  assert.deepEqual(await negotiatedColdStart(deps), { ok: true, warm: false });
  const i = calls.indexOf('integrity');
  assert.ok(i > calls.indexOf('bootstrap'));     // gate runs AFTER the first bootstrap
  assert.deepEqual(calls.slice(i + 1), ['discard', 'clearInvalidated', 'info:re-syncing', 'bootstrap']);
});

test('coldStart: snapshot invalidated during bootstrap → treated as gate failure', async () => {
  const { deps, calls, state } = coldDeps({ restore: { restored: true, anchorHeight: 9 } });
  deps.bootstrap = async () => {
    calls.push('bootstrap');
    if (calls.filter((c) => c === 'bootstrap').length === 1) state.invalidated = true;
  };
  assert.deepEqual(await negotiatedColdStart(deps), { ok: true, warm: false });
  assert.ok(calls.includes('discard'));
  assert.ok(calls.includes('clearInvalidated'));
  assert.ok(!calls.includes('integrity'));       // invalidated short-circuits the check
  assert.equal(calls.filter((c) => c === 'bootstrap').length, 2);
});

test('coldStart: aborted before confirm → ok:false, nothing confirmed, nothing bootstrapped', async () => {
  const { deps, calls, state } = coldDeps({ restore: { restored: true, anchorHeight: 9 } });
  state.aborted = true;
  assert.deepEqual(await negotiatedColdStart(deps), { ok: false, warm: false });
  assert.deepEqual(calls, ['restore']);
});

test('coldStart: aborted during confirm → ok:false, never trusts or bootstraps the restore', async () => {
  const { deps, calls, state } = coldDeps({ restore: { restored: true, anchorHeight: 9 } });
  deps.confirm = async (h) => { calls.push(`confirm:${h}`); state.aborted = true; return { ok: true }; };
  assert.deepEqual(await negotiatedColdStart(deps), { ok: false, warm: false });
  assert.ok(!calls.includes('bootstrap'));
});

test('coldStart: abort racing a FORGED confirm still deletes the file, never bootstraps', async () => {
  const { deps, calls, state } = coldDeps({ restore: { restored: true, anchorHeight: 9 } });
  deps.confirm = async (h) => {
    calls.push(`confirm:${h}`);
    state.aborted = true;
    return { ok: false, kind: 'forged', reason: 'anchor-not-canonical' };
  };
  assert.deepEqual(await negotiatedColdStart(deps), { ok: false, warm: false });
  assert.ok(calls.includes('discard'));
  assert.ok(!calls.includes('bootstrap'));
});

test('coldStart: bootstrap rejection propagates to the caller (existing error handling)', async () => {
  const { deps } = coldDeps();
  deps.bootstrap = async () => { throw new Error('all helpers failed'); };
  await assert.rejects(() => negotiatedColdStart(deps), /all helpers failed/);
});

test('coldStart: abort landing during bootstrap → ok:false (the final gate decides)', async () => {
  const { deps, calls, state } = coldDeps();
  deps.bootstrap = async () => { calls.push('bootstrap'); state.aborted = true; };
  assert.deepEqual(await negotiatedColdStart(deps), { ok: false, warm: false });
  assert.equal(calls.filter((c) => c === 'bootstrap').length, 1);
});

test('coldStart: a throw from the gate-failure re-bootstrap propagates too', async () => {
  const { deps, calls } = coldDeps({ restore: { restored: true, anchorHeight: 9 }, integrity: false });
  let boots = 0;
  deps.bootstrap = async () => {
    calls.push('bootstrap');
    if (++boots === 2) throw new Error('helpers gone');
  };
  await assert.rejects(() => negotiatedColdStart(deps), /helpers gone/);
  assert.equal(boots, 2);
});

// ─── #12: the negotiated path now wires the SAME adaptive SmartController as
// the classic pool path (poolClient.ts), instead of a fixed duty forever. The
// wiring itself (grind setup / startGrind hashrate callback / connect() /
// teardown) is integration-level and closes over WebSocket session state, so
// it is not unit-testable in isolation — verification is code review (this
// diff mirrors poolClient.ts:682-698,921-923,993,958 site-for-site) plus the
// live hashrate A/B against brcpool in the release gate. This pins the one
// PURE invariant the wiring depends on: the mode → start-duty mapping.

test('smartStartDuty drives the negotiated start duty per mode', () => {
  assert.equal(smartStartDuty('max', 0.75), 1);
  assert.equal(smartStartDuty('considerate', 0.75), CONSIDERATE_START);
  assert.equal(smartStartDuty('off', 0.6), 0.6);
});

// ─── #6/#7: non-object frames + a malformed share/template target must never
// reach the grind workers (BigInt('0xundefined') crash-respawn storm) ────────

test('isHexTarget: only accepts non-empty hex of a sane length', () => {
  assert.equal(isHexTarget('0'.repeat(64)), true);
  assert.equal(isHexTarget('00000002dd4ea'), true);
  assert.equal(isHexTarget('undefined'), false);
  assert.equal(isHexTarget(''), false);
  assert.equal(isHexTarget(undefined), false);
  assert.equal(isHexTarget(null), false);
  assert.equal(isHexTarget('0xdeadbeef'), false); // no 0x prefix expected
  assert.equal(isHexTarget('zzzz'), false);
});

test('parseFrame: a JSON null / non-object frame is rejected, not returned', () => {
  assert.equal(parseFrame('null'), null);
  assert.equal(parseFrame('123'), null);
  assert.equal(parseFrame('"a string"'), null);
  assert.equal(parseFrame('not json'), null);
  const ok = parseFrame('{"type":"chain_info"}');
  assert.deepEqual(ok, { type: 'chain_info' });
});

test('negotiatedBackendNote: an actionable fallback reason wins the rendered line', () => {
  const note = 'native engine outdated — rebuild: cd native/brc-pow && cargo build --release; using wasm';
  assert.equal(negotiatedBackendNote({ useNative: false, backendNote: note }), note);
});

test('negotiatedBackendNote: the mode banner otherwise (native running, or wasm chosen)', () => {
  assert.equal(negotiatedBackendNote({ useNative: true }), NEGOTIATED_BANNER);
  assert.equal(negotiatedBackendNote({ useNative: false }), NEGOTIATED_BANNER);
});
