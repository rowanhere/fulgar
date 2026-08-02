// src/minerd/http.ts
import { decodeBlock, encodeBlock, type Block } from '../chain/block.js';
import { MAX_BLOCK_BYTES } from '../chain/genesis.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import { fetchJsonWithTimeout } from './timedFetch.js';

// Parity-free DoS guard: a valid block is at most MAX_BLOCK_BYTES, so its hex is
// at most 2× that. `decodeBlock` parses an unbounded txCount from the buffer BEFORE the
// size cap is enforced, so a hostile/buggy helper could ship a giant hex and make us
// allocate (hexToBytes) + parse it before rejection. Cap the hex length at the FETCH
// boundary, in the miner — no change to the byte-identical consensus decodeBlock, so no
// parity-harness coordination needed.
export const MAX_BLOCK_HEX = MAX_BLOCK_BYTES * 2;

/** Decode one `/blocks` hex entry, rejecting an oversized/invalid entry BEFORE the
 *  costly allocate+parse. Exported for unit tests. */
export function decodeBlockHex(h: unknown, index = 0): Block {
  if (typeof h !== 'string') throw new Error(`/blocks[${index}]: non-string block entry`);
  if (h.length > MAX_BLOCK_HEX) {
    throw new Error(`/blocks[${index}]: oversized block hex (${h.length} > ${MAX_BLOCK_HEX}) — refusing to decode`);
  }
  return decodeBlock(hexToBytes(h));
}

export interface Tip {
  height: number;
  tipHash: string;
}

/** A /tip body is only usable if height is a real non-negative INTEGER (not merely
 *  Number(...)-coercible — `null`/`false`/`[]`/`''` all coerce to 0 and `1.5` would
 *  flap `tipAdvanced`) and tipHash is 64 hex chars. A malformed 200 body (missing
 *  height -> NaN, or a coercible-but-wrong-typed height) would otherwise flow into
 *  the tip poller as a bogus height and stop solo grinding with no rebuild, or make
 *  a bad helper look successful instead of failing over. Exported for tests. */
export function isValidTipBody(body: unknown): boolean {
  const b = body as { height?: unknown; tipHash?: unknown } | null;
  if (!b || typeof b !== 'object') return false;
  const h = b.height;
  return typeof h === 'number' && Number.isInteger(h) && h >= 0
    && typeof b.tipHash === 'string' && /^[0-9a-f]{64}$/i.test(b.tipHash);
}

// Bound every solo helper fetch so a half-open connection can't wedge sync/submit.
// Generous because /blocks can return up to 200 blocks; /tip and /block are quick.
const HTTP_TIMEOUT_MS = 30_000;
const GET_JSON_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = [500, 1_000, 2_000, 4_000];
const retryBackoffMs = (attempt: number): number => RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]!;

/** Sleep that rejects with AbortError the moment the signal aborts (no leaked listener). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    let t: ReturnType<typeof setTimeout>;
    const onAbort = (): void => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
    t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface GetJsonOpts {
  signal?: AbortSignal;
  attempts?: number;
  timeoutMs?: number;
  doFetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * GET + parse JSON with a BOUNDED retry. A 30s request timeout into the
 * solo sync path; a slow/cold-start /blocks then throws TimeoutError, and
 * ChainSync.bootstrap has no retry of its own → a headless run would crash to the
 * menu. Retry a TimeoutError, a transient network error, or a 5xx (a Render
 * cold-start/redeploy hiccup); a caller teardown (AbortError) propagates at once,
 * and a definitive 4xx is fatal. Cross-page sync progress is durable, so
 * re-fetching one page loses nothing. Exported for unit tests (deps injected).
 */
export async function getJsonWithRetry(url: string, opts: GetJsonOpts = {}): Promise<unknown> {
  const attempts = opts.attempts ?? GET_JSON_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  const doFetch = opts.doFetch ?? fetch;
  const sleep = opts.sleep ?? abortableSleep;
  for (let i = 0; ; i++) {
    let r: Awaited<ReturnType<typeof fetchJsonWithTimeout>>;
    try {
      // fetchJsonWithTimeout reads the body INSIDE the bounded scope, so a mid-body
      // stall / stream error throws here (and is retried) rather than hanging.
      r = await fetchJsonWithTimeout(url, { signal: opts.signal }, timeoutMs, doFetch);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e; // caller teardown — stop now
      if (i >= attempts - 1) throw e;                   // out of retries (timeout/network/stream)
      await sleep(retryBackoffMs(i), opts.signal);
      continue;
    }
    if (r.ok) {
      // A complete-but-unparseable 200 (e.g. an SPA HTML page) is not transient —
      // retrying won't help, so fail fast rather than loop.
      if (r.parseError) throw new Error(`GET ${url} -> 200 with invalid JSON body`);
      return r.body;
    }
    // 5xx is a transient server hiccup (cold start / redeploy) → retry; any other
    // non-2xx (4xx) is a definitive client/protocol error → fail without retrying.
    if (r.status >= 500 && r.status <= 599 && i < attempts - 1) {
      await sleep(retryBackoffMs(i), opts.signal);
      continue;
    }
    throw new Error(`GET ${url} -> HTTP ${r.status}`);
  }
}

export async function getTip(base: string, opts: GetJsonOpts = {}): Promise<Tip> {
  const body = await getJsonWithRetry(`${base}/tip`, opts);
  if (!isValidTipBody(body)) {
    throw new Error(`malformed /tip from ${base}`);
  }
  const b = body as { height: number; tipHash: string };
  return { height: Number(b.height), tipHash: String(b.tipHash) };
}

/** Canonical blocks from `fromHeight` (inclusive), oldest-first, up to `max` (server caps at 200). */
export async function getBlocks(
  base: string,
  fromHeight: number,
  max = 200,
  signal?: AbortSignal,
  opts: Omit<GetJsonOpts, 'signal'> = {},
): Promise<Block[]> {
  const body = (await getJsonWithRetry(`${base}/blocks?fromHeight=${fromHeight}&max=${max}`, { signal, ...opts })) as {
    blocks?: string[];
  };
  const hexes = Array.isArray(body.blocks) ? body.blocks : [];
  return hexes.map((h, i) => decodeBlockHex(h, i)); // bounded decode (reject oversized hex pre-allocate)
}

export interface SubmitResult {
  status: string;
  [k: string]: unknown;
}

export async function postBlock(base: string, block: Block): Promise<SubmitResult> {
  const r = await fetchJsonWithTimeout(`${base}/block`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ block: bytesToHex(encodeBlock(block)) }),
  }, HTTP_TIMEOUT_MS);
  // The endpoint replies 200 with {status:'added'|...} or 400 {status:'invalid'}.
  return (!r.parseError && r.body != null ? r.body : { status: `http_${r.status}` }) as SubmitResult;
}

/**
 * Does a helper `/block` submit status mean the block was accepted onto the helper's
 * canonical chain? The helper replies `{status:'added'}` on success (HTTP 200); be
 * lenient for variants (`accepted`/`ok`) and a bare 2xx with an unparseable body.
 *
 * the old solo check matched only `/ok|200|accept/i`, so `'added'` (the actual
 * success token) read as NOT accepted → solo earnings showed 0. This is the single
 * source of truth for "did the network take our block", used BOTH for solo earnings
 * accounting AND for the broadcast-first adoption gate (submitSolo) — a solo block is
 * adopted locally only once a helper confirms the network has it (no private fork).
 *
 * Requires an EXPLICIT parsed-JSON success token (`added`/`accepted`/`ok`). A bare
 * HTTP 2xx is deliberately NOT enough: postBlock maps any unparseable 2xx body to
 * `http_2xx`, but a proxy/helper can return 200 with an HTML error page or plain
 * `invalid` — treating that as acceptance would be a forged adoption permit. The real helper always replies `{status:'added'}` on success.
 */
export function isHelperAccept(status: string): boolean {
  const s = String(status).trim().toLowerCase();
  return s === 'added' || s === 'accepted' || s === 'ok';
}

/**
 * Submit signed transactions (hex-encoded) to a helper's mempool.
 * Body shape mirrors server/api.ts `POST /txs` → `{ txs: [<hex>, …] }`.
 * The endpoint replies `{ admitted: number, errors: string[] }`.
 */
export async function postTxs(
  base: string,
  txHexes: string[],
): Promise<{ admitted: number; errors: string[] }> {
  const r = await fetchJsonWithTimeout(`${base}/txs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txs: txHexes }),
  }, HTTP_TIMEOUT_MS);
  const body = (!r.parseError && r.body != null ? r.body : { admitted: 0, errors: [`http_${r.status}`] }) as {
    admitted?: number;
    errors?: string[];
  };
  return { admitted: Number(body.admitted ?? 0), errors: body.errors ?? [] };
}
