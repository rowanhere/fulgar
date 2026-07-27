// src/minerd/start.test.ts
//
// The launcher's first-run flow (`npm start`) — the LAST surface migrated onto
// the shared targets.ts model. Before this, start.ts hand-built its own pool
// list and read pools.json through the legacy readExtraPools() bridge; now it
// renders the same buildTargetModel() menu.ts/settings.ts do, and writes
// MINER_POOL through the same persistTarget().
//
// What is pinned here:
//   - the SAME trigger as before the migration: the pool chooser only appears
//     when MINER_POOL is unset AND the model has a custom (pools.json) pool.
//     No custom pool => no prompt, exactly as today.
//   - the chooser is genuinely sourced from buildTargetModel(), not a second
//     hand-written list (source-grep parity test + a model-shape test).
//   - choosing FulgurPool still writes NO MINER_POOL key (absence = FulgurPool);
//     Solo writes 'solo'; a pool writes its canonical url — all via
//     persistTarget(), never a direct persist({ MINER_POOL... }).
//   - a valid MINER_PUBKEY already set skips the wallet prompt.
//   - buildStatus() names the right destination for unset / solo / a built-in /
//     a custom pool / an unrecognised url, sourced from the same model.
//
// TEMP CWD, AND WHY THE IMPORT IS DYNAMIC: start.ts pulls in targets.ts, which
// pulls in envLocal.ts, which resolves ENV_FILE/POOLS_FILE from process.cwd()
// at MODULE LOAD time. So we chdir into a temp dir BEFORE importing start.js —
// a static import would bind the developer's real .env.local / pools.json
// (the same trap targets.test.ts / menu.test.ts / settings.test.ts document).
// `node --test` runs each test FILE in its own child process, so the chdir
// cannot leak into another suite.
//
// IMPORTING start.js DOES NOT LAUNCH THE MINER: start.ts only calls main()
// when it is the direct CLI entry point (process.argv[1] === this file), which
// is false under `node --test` — so importing it here just defines the
// exported firstRunSetup()/buildStatus() functions.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import type { MinerConfig } from './config.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'fulgur-start-'));
process.chdir(TMP);

const ENV_LOCAL = path.join(TMP, '.env.local');
const POOLS = path.join(TMP, 'pools.json');

const S = await import('./start.js');
const T = await import('./targets.js');
const P = await import('./pools.js');
const C = await import('./config.js');

const ADDR = 'aa'.repeat(32); // 64 hex chars — a valid MINER_PUBKEY

beforeEach(() => {
  for (const f of [ENV_LOCAL, `${ENV_LOCAL}.bak`, POOLS, `${POOLS}.bak`]) if (existsSync(f)) rmSync(f);
  delete process.env.MINER_PUBKEY;
  delete process.env.MINER_POOL;
  delete process.env.MINER_NATIVE;
});

/** Write pools.json — an object is JSON-stringified, a string is written verbatim (for broken files). */
function writePools(json: unknown): void {
  writeFileSync(POOLS, typeof json === 'string' ? json : JSON.stringify(json, null, 2) + '\n');
}

/** The non-empty lines of .env.local ([] when the file was never written, or is empty). */
function envLines(): string[] {
  if (!existsSync(ENV_LOCAL)) return [];
  return readFileSync(ENV_LOCAL, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * A Readable that feeds one scripted answer per line, in the exact order
 * firstRunSetup will `question()` for them. Paced with setImmediate — see
 * settings.test.ts's own copy of this helper for the full explanation of why
 * a single big push would deadlock readline's one-shot 'line' listener.
 */
function scriptedInput(lines: string[]): Readable {
  const rs = new Readable({ read() { /* fed asynchronously below */ } });
  void (async () => {
    for (const line of lines) {
      rs.push(`${line}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();
  return rs;
}

/** Run firstRunSetup() against a scripted answer list, and return everything it printed. */
async function runFirstRunSetup(answers: string[]): Promise<string> {
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    await S.firstRunSetup(scriptedInput(answers));
  } finally {
    process.stdout.write = realWrite;
  }
  return chunks.join('');
}

function fakeCfg(poolUrl: string | undefined): MinerConfig {
  return {
    minerPubkeyHex: ADDR,
    minerPubkey: new Uint8Array(32),
    helpers: [],
    workers: 1,
    syncWorkers: 1,
    tipPollMs: 3000,
    throttle: 0.75,
    smart: 'off',
    poolUrl,
  };
}

// -- sourcing: no second hand-written pool list --------------------------------

test('start.ts sources "where to mine" from the shared targets model, not a hand-built list', () => {
  const src = readFileSync(new URL('./start.ts', import.meta.url), 'utf8');
  assert.match(src, /buildTargetModel\(/, 'expected a buildTargetModel( call');
  assert.match(src, /persistTarget\(/, 'expected a persistTarget( call');
  assert.doesNotMatch(src, /readExtraPools/, 'must not call the retired readExtraPools bridge');
  assert.doesNotMatch(
    src,
    /persist\(\s*\{\s*MINER_POOL/,
    'must not persist MINER_POOL directly — persistTarget is the only writer',
  );
});

test('the retired readExtraPools bridge is gone from the tree entirely', () => {
  const src = readFileSync(new URL('./envLocal.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /readExtraPools/, 'envLocal.ts must no longer define readExtraPools');
});

test('the chooser is genuinely sourced from buildTargetModel(): Solo, FulgurPool, brcpool, then pools.json', () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://mypool.example.org' }] });
  const model = T.buildTargetModel();
  assert.deepEqual(model.targets.map((t) => t.kind), ['solo', 'builtin', 'builtin', 'custom']);
  assert.deepEqual(model.targets.map((t) => t.label), ['Solo', 'FulgurPool', 'brcpool', 'MyPool']);
});

// -- trigger: unchanged from before the migration -------------------------------

test('unset MINER_POOL + a custom pool in pools.json: the chooser is shown and offers it', async () => {
  process.env.MINER_PUBKEY = ADDR;
  writePools({ pools: [{ name: 'MyPool', url: 'https://mypool.example.org' }] });
  const out = await runFirstRunSetup(['1']); // FulgurPool, just to complete the prompt
  assert.match(out, /Where do you want to mine\?/);
  assert.match(out, /\[1\] FulgurPool — the default/);
  assert.match(out, /\[2\] MyPool — https:\/\/mypool\.example\.org/);
  assert.match(out, /\[s\] Solo/);
});

test('unset MINER_POOL + NO custom pool: the chooser is not shown (unchanged trigger)', async () => {
  process.env.MINER_PUBKEY = ADDR;
  // no pools.json at all
  const out = await runFirstRunSetup([]);
  assert.equal(out, '', 'nothing should be printed — firstRunSetup must return immediately');
  assert.deepEqual(envLines(), []);
});

test('MINER_POOL already set: the chooser is never shown, even with a custom pool registered', async () => {
  process.env.MINER_PUBKEY = ADDR;
  process.env.MINER_POOL = 'solo';
  writePools({ pools: [{ name: 'MyPool', url: 'https://mypool.example.org' }] });
  const out = await runFirstRunSetup([]);
  assert.equal(out, '');
  assert.deepEqual(envLines(), []); // a stored choice is never re-persisted
});

// -- persistence: FulgurPool writes nothing, Solo writes 'solo', a pool writes its url --

test('choosing FulgurPool ("1") writes NO MINER_POOL key — absence still means FulgurPool', async () => {
  process.env.MINER_PUBKEY = ADDR;
  writePools({ pools: [{ name: 'MyPool', url: 'https://mypool.example.org' }] });
  await runFirstRunSetup(['1']);
  assert.deepEqual(envLines().filter((l) => l.startsWith('MINER_POOL')), []);
  assert.equal(process.env.MINER_POOL, undefined);
});

test('choosing Solo ("s") writes MINER_POOL=solo', async () => {
  process.env.MINER_PUBKEY = ADDR;
  writePools({ pools: [{ name: 'MyPool', url: 'https://mypool.example.org' }] });
  await runFirstRunSetup(['s']);
  assert.ok(envLines().includes('MINER_POOL=solo'), JSON.stringify(envLines()));
  assert.equal(process.env.MINER_POOL, 'solo');
});

test('choosing the custom pool ("2") writes its canonical url', async () => {
  process.env.MINER_PUBKEY = ADDR;
  writePools({ pools: [{ name: 'MyPool', url: 'https://mypool.example.org' }] });
  await runFirstRunSetup(['2']);
  assert.ok(envLines().includes('MINER_POOL=https://mypool.example.org'), JSON.stringify(envLines()));
  assert.equal(process.env.MINER_POOL, 'https://mypool.example.org');
});

// -- wallet prompt --------------------------------------------------------------

test('a valid MINER_PUBKEY already set: no wallet prompt', async () => {
  process.env.MINER_PUBKEY = ADDR;
  writePools({ pools: [{ name: 'MyPool', url: 'https://mypool.example.org' }] });
  const out = await runFirstRunSetup(['1']);
  assert.doesNotMatch(out, /first-time setup/);
  assert.doesNotMatch(out, /wallet address/);
  assert.match(out, /Where do you want to mine\?/);
});

test('missing wallet + a custom pool available: prompts wallet first, then the pool chooser', async () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://mypool.example.org' }] });
  const out = await runFirstRunSetup([ADDR, '2']);
  assert.match(out, /first-time setup/);
  assert.ok(out.indexOf('first-time setup') < out.indexOf('Where do you want to mine?'), out);
  assert.ok(envLines().includes(`MINER_PUBKEY=${ADDR}`), JSON.stringify(envLines()));
  assert.ok(envLines().includes('MINER_POOL=https://mypool.example.org'), JSON.stringify(envLines()));
  assert.equal(process.env.MINER_PUBKEY, ADDR);
});

// -- buildStatus: names the right destination, sourced from the same model -----

test('buildStatus: unset MINER_POOL names FulgurPool', () => {
  const poolUrl = C.resolvePoolUrl(process.env.MINER_POOL);
  const status = S.buildStatus(fakeCfg(poolUrl));
  assert.equal(status.mode, 'pool');
  assert.equal(status.target, 'FulgurPool');
  assert.equal(status.targetUrl, poolUrl);
  assert.equal(status.targetPage, C.FULGURPOOL_PAGE);
});

test('buildStatus: MINER_POOL=solo names solo, without touching the pool model', () => {
  process.env.MINER_POOL = 'solo';
  const poolUrl = C.resolvePoolUrl(process.env.MINER_POOL);
  assert.equal(poolUrl, undefined);
  const status = S.buildStatus(fakeCfg(poolUrl));
  assert.equal(status.mode, 'solo');
  assert.equal(status.target, 'solo');
});

test('buildStatus: a built-in (brcpool) url names its label', () => {
  const brcUrl = P.BUILTIN_POOLS[1]!.url;
  process.env.MINER_POOL = brcUrl;
  const poolUrl = C.resolvePoolUrl(process.env.MINER_POOL);
  const status = S.buildStatus(fakeCfg(poolUrl));
  assert.equal(status.target, 'brcpool');
  assert.equal(status.targetUrl, poolUrl);
});

test('buildStatus: a custom pool from pools.json names its pools.json name + page', () => {
  writePools({ pools: [{ name: 'MyPool', url: 'https://mypool.example.org', page: 'https://mypool.example.org/site' }] });
  process.env.MINER_POOL = 'https://mypool.example.org';
  const poolUrl = C.resolvePoolUrl(process.env.MINER_POOL);
  const status = S.buildStatus(fakeCfg(poolUrl));
  assert.equal(status.target, 'MyPool');
  assert.equal(status.targetPage, 'https://mypool.example.org/site');
});

test('buildStatus: an unrecognised url is shown as itself, never silently relabelled', () => {
  process.env.MINER_POOL = 'https://random.example.org';
  const poolUrl = C.resolvePoolUrl(process.env.MINER_POOL);
  const status = S.buildStatus(fakeCfg(poolUrl));
  assert.equal(status.target, 'https://random.example.org');
});

// -- FIX 1(b): loadLauncherEnv drops a blank real-env MINER_POOL FIRST --------
// start.ts called loadEnvLocal() directly, with no dropBlankPoolEnv() first —
// so a real-env `MINER_POOL=` (defined but blank, e.g. from Docker/systemd)
// shadowed whatever the menu/settings had stored in .env.local forever, since
// loadEnvLocal only fills keys that are `undefined`.

test('loadLauncherEnv: a blank real-env MINER_POOL= no longer shadows a stored solo choice', () => {
  writeFileSync(ENV_LOCAL, 'MINER_POOL=solo\n');
  process.env.MINER_POOL = ''; // e.g. an exported empty var, or `MINER_POOL= npm start`

  S.loadLauncherEnv();

  assert.equal(process.env.MINER_POOL, 'solo');
});

test('loadLauncherEnv: a REAL (non-blank) env MINER_POOL still wins over .env.local', () => {
  writeFileSync(ENV_LOCAL, 'MINER_POOL=solo\n');
  process.env.MINER_POOL = 'https://custom.example';

  S.loadLauncherEnv();

  assert.equal(process.env.MINER_POOL, 'https://custom.example');
});

test('start.ts: main() calls loadLauncherEnv() — the blank-MINER_POOL drop can never be skipped by calling loadEnvLocal() directly', () => {
  const src = readFileSync(new URL('./start.ts', import.meta.url), 'utf8');
  assert.match(src, /\bloadLauncherEnv\(\)/, 'expected main() to call loadLauncherEnv()');
  const mainStart = src.indexOf('async function main(');
  assert.ok(mainStart >= 0);
  const mainBody = src.slice(mainStart);
  assert.doesNotMatch(mainBody, /\bloadEnvLocal\(\)/, 'main() must not call loadEnvLocal() directly, bypassing the drop');
});
