import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePoolEngine } from './poolEngine.js';

const NOT_BUILT = 'native engine not built — install Rust (https://rustup.rs) and build it; using wasm';
const OUTDATED = 'native engine outdated — rebuild: cd native/brc-pow && cargo build --release; using wasm';

/** Probe counters: the gate must short-circuit — a probe that runs when an
 *  earlier condition already failed would spawn subprocesses for nothing. */
function probes(exists: boolean, continuous: boolean, current: boolean) {
  const calls = { exists: 0, continuous: 0, current: 0 };
  return {
    calls,
    deps: {
      exists: (): boolean => { calls.exists++; return exists; },
      continuousOk: (): boolean => { calls.continuous++; return continuous; },
      powIsCurrent: (): boolean => { calls.current++; return current; },
    },
  };
}

test('native not selected (unset) — wasm, no note, NO probes run', () => {
  const p = probes(true, true, true);
  const r = resolvePoolEngine({ env: {} as NodeJS.ProcessEnv, ...p.deps });
  assert.equal(r.useNative, false);
  assert.equal(r.backendNote, undefined);
  assert.deepEqual(p.calls, { exists: 0, continuous: 0, current: 0 });
});

test('MINER_NATIVE=0 means wasm (currentEngine contract)', () => {
  const p = probes(true, true, true);
  const r = resolvePoolEngine({ env: { MINER_NATIVE: '0' } as NodeJS.ProcessEnv, ...p.deps });
  assert.equal(r.useNative, false);
  assert.equal(r.backendNote, undefined);
  assert.deepEqual(p.calls, { exists: 0, continuous: 0, current: 0 });
});

test('selected but not built — "not built" note, binary probes NOT run', () => {
  const p = probes(false, true, true);
  const r = resolvePoolEngine({ env: { MINER_NATIVE: '1' } as NodeJS.ProcessEnv, ...p.deps });
  assert.equal(r.useNative, false);
  assert.equal(r.backendNote, NOT_BUILT);
  assert.deepEqual(p.calls, { exists: 1, continuous: 0, current: 0 });
});

test('selected, built, continuous probe fails — "outdated" note, PoW probe NOT run', () => {
  const p = probes(true, false, true);
  const r = resolvePoolEngine({ env: { MINER_NATIVE: '1' } as NodeJS.ProcessEnv, ...p.deps });
  assert.equal(r.useNative, false);
  assert.equal(r.backendNote, OUTDATED);
  assert.deepEqual(p.calls, { exists: 1, continuous: 1, current: 0 });
});

test('selected, built, continuous ok, PoW stale — "outdated" note', () => {
  const p = probes(true, true, false);
  const r = resolvePoolEngine({ env: { MINER_NATIVE: '1' } as NodeJS.ProcessEnv, ...p.deps });
  assert.equal(r.useNative, false);
  assert.equal(r.backendNote, OUTDATED);
  assert.deepEqual(p.calls, { exists: 1, continuous: 1, current: 1 });
});

test('all four conditions green — native, no note', () => {
  const p = probes(true, true, true);
  const r = resolvePoolEngine({ env: { MINER_NATIVE: '1' } as NodeJS.ProcessEnv, ...p.deps });
  assert.equal(r.useNative, true);
  assert.equal(r.backendNote, undefined);
  assert.deepEqual(p.calls, { exists: 1, continuous: 1, current: 1 });
});
