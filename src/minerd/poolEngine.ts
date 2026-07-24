// src/minerd/poolEngine.ts
//
// Which grind engine does a POOL-mode session actually use? One shared answer
// for the classic path (poolClient.ts) and the negotiated path
// (negotiatedClient.ts) — the gate must never drift between them, and the
// negotiated client cannot import it from poolClient (poolClient already
// imports the negotiated hand-off; that would be an import cycle).
//
// Native pool grinding needs a binary that (a) exists, (b) understands the
// `continuous` grind arg (an older build rejects it and would crash-loop), and
// (c) GRINDS the current PoW at the fork boundary. Post the Sandglass v3 fork a
// binary built before the fork (or against the earlier 34,800 fork constant)
// still grinds Argon2id in the live range — it passes (a) and (b) but produces
// 100% invalid shares — so nativePowIsCurrent() grinds one nonce at exactly the
// fork height and checks the digest. Any failure → fall back to wasm.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { NATIVE_BIN } from './nativeGrindPool.js';
import { nativePowIsCurrent } from './nativeParity.js';
import { currentEngine } from './selectors.js';

/** One-time probe: does the installed native binary accept the `continuous` grind
 *  arg? An older brc-pow build rejects it (usage exit 2). Returns true only on a
 *  clean exit 0, so pool mode falls back to wasm for a stale/incompatible binary
 *  instead of crash-looping children. Easy target over a single-nonce range. */
export function nativeContinuousOk(): boolean {
  try {
    const r = spawnSync(
      NATIVE_BIN,
      ['grind', '0'.repeat(296), 'f'.repeat(64), '0', '1', '1', '1'],
      { timeout: 5000, stdio: 'ignore' },
    );
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface PoolEngineChoice {
  useNative: boolean;
  /** Set ONLY when native was selected but demoted — the persistent, actionable
   *  reason (both reporters render it via status.backendNote). */
  backendNote?: string;
}

/** Probes injectable for tests; production callers pass nothing. */
export interface PoolEngineDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  continuousOk?: () => boolean;
  powIsCurrent?: () => boolean;
}

/** The four-condition engine gate, short-circuit on purpose: the subprocess
 *  probes only run when native is selected AND the binary exists. */
export function resolvePoolEngine(deps: PoolEngineDeps = {}): PoolEngineChoice {
  const {
    env = process.env,
    exists = existsSync,
    continuousOk = nativeContinuousOk,
    powIsCurrent = nativePowIsCurrent,
  } = deps;
  if (currentEngine(env.MINER_NATIVE) !== 'native') return { useNative: false };
  if (!exists(NATIVE_BIN)) {
    return {
      useNative: false,
      backendNote: 'native engine not built — install Rust (https://rustup.rs) and build it; using wasm',
    };
  }
  if (!continuousOk() || !powIsCurrent()) {
    return {
      useNative: false,
      backendNote: 'native engine outdated — rebuild: cd native/brc-pow && cargo build --release; using wasm',
    };
  }
  return { useNative: true };
}
