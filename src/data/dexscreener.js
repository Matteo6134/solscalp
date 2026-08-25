/**
 * Dexscreener client -- READ ONLY, LIVE SNAPSHOTS ONLY.
 *
 * WHAT THIS MODULE PROVES
 *   What Dexscreener reports *right now* about the pools trading a mint: pool
 *   address, dex, quote token, price, liquidity depth, fdv / market cap, and the
 *   rolling 5m/1h/6h/24h volume, price-change and buy/sell counters. That is the
 *   input layer 2 sizes a position against and the universe filter screens on.
 *
 * WHAT IT DOES NOT PROVE
 *   - **There is NO history endpoint.** Every call returns "now". A window that
 *     was not sampled while it was live is gone for good. That is exactly why the
 *     design record rejects candle backtesting ("the universe is not
 *     retroactively enumerable") and why scripts/record.js exists: the only way
 *     to own history here is to write it down as it happens.
 *   - The figures are SELF-REPORTED aggregates over on-chain swaps. The design
 *     record's sources put up to 93% of Solana volume at non-organic, and one
 *     project bought #7 trending for 4 SOL. So `volumeUsd` / `txns` describe
 *     activity, never demand, and never safety.
 *   - A pair existing says nothing about whether the position could be exited:
 *     that is layer 1's sell simulation, not this module's business.
 *
 * FAIL CLOSED
 *   An HTTP failure, an envelope this module does not recognise, or a pair
 *   missing its structural fields (pairAddress, baseToken.address,
 *   quoteToken.address) THROWS. A mint that simply has no pools is a FACT: it
 *   yields `[]` / `null`. Every optional figure that is absent becomes `null`,
 *   never 0 -- `liquidityUsd: 0` reads to layer 2 as "no tradeable pool", which
 *   is a different claim from "Dexscreener did not tell us".
 *
 * Rate limited to LIMITS.dexscreener.requestsPerMinute through ONE module-level
 * limiter, because the quota is per IP and not per call site. Batched at
 * LIMITS.dexscreener.maxMintsPerCall.
 */

import { ENDPOINTS, LIMITS, STRATEGY } from '../config.js';
import { asObject, describeValue, isoToEpochMs, toNumberOrNull } from './coerce.js';
import { buildUrl, getJson as httpGetJson } from './httpJson.js';
import {
  assertBase58Address,
  frozenClone,
  isPlainObject,
  minutesSince,
  readNowMs,
  stringOrNull,
} from './payload.js';
import { createRateLimiter } from './rateLimiter.js';

/** Prefixes every error this module raises, and every http error under it. */
const LABEL = 'dexscreener';
/** We only ever ask for Solana; a pair on another chain means we misread the response. */
const CHAIN_ID = 'solana';
/** Batch endpoint: a flat ARRAY of pairs for up to maxMintsPerCall mints. */
const PATH_BATCH = `/tokens/v1/${CHAIN_ID}`;
/** Legacy endpoint for a single mint: payload is an object with a `pairs` array. */
const PATH_LATEST = '/latest/dex/tokens';
/** The rolling windows Dexscreener reports, in its own key names. */
const WINDOWS = Object.freeze(['m5', 'h1', 'h6', 'h24']);

/** One limiter for the whole process: the free-tier quota is per IP. */
const limiter = createRateLimiter({
  requestsPerMinute: LIMITS.dexscreener.requestsPerMinute,
  label: LABEL,
});

/**
 * @typedef {Readonly<{address: string, name: string|null, symbol: string|null}>} TokenSide
 */
/**
 * @typedef {Readonly<{mint: string, pairAddress: string, dexId: string|null,
 *   chainId: string|null, url: string|null, baseToken: TokenSide, quoteToken: TokenSide,
 *   priceUsd: number|null, priceNative: number|null, liquidityUsd: number|null,
 *   fdv: number|null, marketCap: number|null,
 *   volumeUsd: Readonly<Record<string, number|null>>,
 *   priceChangePct: Readonly<Record<string, number|null>>,
 *   txns: Readonly<Record<string, Readonly<{buys: number|null, sells: number|null}>>>,
 *   pairCreatedAtMs: number|null, ageMinutes: number|null, fetchedAtMs: number,
 *   raw: object}>} Pair
 */

/* -------------------------------------------------------------------------- */
/* primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** @param {unknown} value @param {string} what @returns {string} validated mint */
const assertMint = (value, what) => assertBase58Address(value, `${LABEL}: ${what}`);

/** Which quote tokens we are willing to trade against. Config-driven; deps is a test seam. */
const quoteMintsFrom = (deps) => new Set(deps.quoteMints ?? STRATEGY.universe.quoteMints);

/* -------------------------------------------------------------------------- */
/* normalisation                                                              */
/* -------------------------------------------------------------------------- */

/** Every window key present, each value a number or null. Missing is never 0. */
function windowNumbers(source) {
  const out = {};
  for (const w of WINDOWS) out[w] = toNumberOrNull(source[w]);
  return Object.freeze(out);
}

/** buys/sells per window. A missing counter is null, not "zero trades". */
function normaliseTxns(source) {
  const out = {};
  for (const w of WINDOWS) {
    const bucket = asObject(source[w]);
    out[w] = Object.freeze({
      buys: toNumberOrNull(bucket.buys),
      sells: toNumberOrNull(bucket.sells),
    });
  }
  return Object.freeze(out);
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {TokenSide}
 */
function normaliseTokenSide(value, what) {
  const side = asObject(value);
  const address = stringOrNull(side.address);
  if (address === null) {
    throw new TypeError(
      `${LABEL}: ${what}.address is missing or not a string (${describeValue(value)})`,
    );
  }
  return Object.freeze({
    address,
    name: stringOrNull(side.name),
    symbol: stringOrNull(side.symbol),
  });
}

/**
 * Project one untrusted pair object onto the frozen Pair shape.
 * @param {unknown} raw
 * @param {string} mint the REQUESTED mint this pair was returned for
 * @param {number} fetchedAtMs
 * @returns {Pair}
 */
function normalisePair(raw, mint, fetchedAtMs) {
  if (!isPlainObject(raw)) {
    throw new TypeError(`${LABEL}: expected a pair object, got ${describeValue(raw)}`);
  }
  const pairAddress = stringOrNull(raw.pairAddress);
  if (pairAddress === null) {
    throw new TypeError(
      `${LABEL}: pair for ${mint} has no pairAddress (${describeValue(raw.pairAddress)})`,
    );
  }
  const chainId = stringOrNull(raw.chainId);
  if (chainId !== null && chainId !== CHAIN_ID) {
    throw new TypeError(
      `${LABEL}: asked for ${CHAIN_ID} but pair ${pairAddress} reports ` +
        `chainId ${describeValue(chainId)}`,
    );
  }

  const liquidity = asObject(raw.liquidity);
  const fdv = toNumberOrNull(raw.fdv);
  // fdv is the fallback and is the CONSERVATIVE choice for layer 2: a larger cap
  // lowers liquidity/marketCap, so it can only tighten the gate, never loosen it.
  const marketCap = toNumberOrNull(raw.marketCap) ?? fdv;
  // Dexscreener sends epoch MILLISECONDS here; an ISO string is accepted defensively.
  const pairCreatedAtMs = toNumberOrNull(raw.pairCreatedAt) ?? isoToEpochMs(raw.pairCreatedAt);

  return Object.freeze({
    mint,
    pairAddress,
    dexId: stringOrNull(raw.dexId),
    chainId,
    url: stringOrNull(raw.url),
    baseToken: normaliseTokenSide(raw.baseToken, `pair ${pairAddress} baseToken`),
    quoteToken: normaliseTokenSide(raw.quoteToken, `pair ${pairAddress} quoteToken`),
    // Dexscreener sends numbers as STRINGS; toNumberOrNull is why coerce.js exists.
    priceUsd: toNumberOrNull(raw.priceUsd),
    priceNative: toNumberOrNull(raw.priceNative),
    liquidityUsd: toNumberOrNull(liquidity.usd),
    fdv,
    marketCap,
    volumeUsd: windowNumbers(asObject(raw.volume)),
    priceChangePct: windowNumbers(asObject(raw.priceChange)),
    txns: normaliseTxns(asObject(raw.txns)),
    pairCreatedAtMs,
    ageMinutes: minutesSince(pairCreatedAtMs, fetchedAtMs),
    fetchedAtMs,
    raw: frozenClone(raw),
  });
}

/** Deepest liquidity first. Unknown depth sorts LAST: null is not "deep". */
function byLiquidityDesc(a, b) {
  if (a.liquidityUsd === b.liquidityUsd) return 0;
  if (a.liquidityUsd === null) return 1;
  if (b.liquidityUsd === null) return -1;
  return b.liquidityUsd - a.liquidityUsd;
}

/**
 * Accept BOTH documented envelopes: the batch path returns a bare array, while
 * `/latest/dex/tokens/{mint}` wraps them in a `pairs` array -- and `pairs` is
 * `null` for a mint Dexscreener has never indexed, which is a fact, not an error.
 * @returns {readonly unknown[]}
 */
function readPairArray(payload, url) {
  if (Array.isArray(payload)) return payload;
  if (isPlainObject(payload)) {
    if (Array.isArray(payload.pairs)) return payload.pairs;
    // `{ pairs: null }` is Dexscreener's answer for a mint it never indexed: a
    // fact, not an error. An object with NO `pairs` key at all is a payload we do
    // not understand, so it throws rather than silently reading as "no pools".
    if ('pairs' in payload && payload.pairs == null) return [];
  }
  throw new TypeError(
    `${LABEL}: expected an array of pairs or a { pairs } envelope, got ` +
      `${describeValue(payload)} [GET ${url}]`,
  );
}

/**
 * Group raw entries by the requested mint they belong to.
 * A pair whose base AND quote are both unrequested is IGNORED (Dexscreener may
 * echo extra pairs); a pair with no readable token addresses THROWS, so
 * malformed data is never silently dropped.
 * @param {readonly unknown[]} entries
 * @param {Set<string>} requested
 * @param {number} fetchedAtMs
 * @param {string} url
 * @returns {Map<string, readonly Pair[]>}
 */
function groupPairs(entries, requested, fetchedAtMs, url) {
  /** @type {Map<string, Pair[]>} */
  const groups = new Map();
  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new TypeError(
        `${LABEL}: pairs[${index}] is not an object (${describeValue(entry)}) [GET ${url}]`,
      );
    }
    const base = stringOrNull(asObject(entry.baseToken).address);
    const quote = stringOrNull(asObject(entry.quoteToken).address);
    if (base === null || quote === null) {
      throw new TypeError(
        `${LABEL}: pairs[${index}] is missing baseToken.address or quoteToken.address ` +
          `[GET ${url}]`,
      );
    }
    // Attribute to the base side first: a pair we might trade has the token we
    // asked about as its BASE and an allowed quote token opposite it.
    const mint = requested.has(base) ? base : requested.has(quote) ? quote : null;
    if (mint === null) return; // a mint we did not ask about: ignored, not an error
    const pair = normalisePair(entry, mint, fetchedAtMs);
    const bucket = groups.get(mint);
    if (bucket === undefined) groups.set(mint, [pair]);
    else bucket.push(pair);
  });

  /** @type {Map<string, readonly Pair[]>} */
  const sorted = new Map();
  for (const [mint, pairs] of groups) {
    sorted.set(mint, Object.freeze([...pairs].sort(byLiquidityDesc)));
  }
  return sorted;
}

/* -------------------------------------------------------------------------- */
/* transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One rate-limited GET. Every network seam is injectable and has a real default,
 * so a test never opens a socket.
 * @param {string} path
 * @param {object} deps
 * @returns {Promise<{url: string, entries: readonly unknown[], fetchedAtMs: number}>}
 */
async function fetchPairs(path, deps) {
  const get = deps.getJson ?? httpGetJson;
  const schedule = deps.schedule ?? ((fn) => limiter.schedule(fn));
  const url = buildUrl(ENDPOINTS.dexscreener, path);
  const payload = await schedule(() => get(url, { label: LABEL, timeoutMs: deps.timeoutMs }));
  // Read the clock AFTER the response lands: fetchedAtMs describes the snapshot.
  const fetchedAtMs = readNowMs(deps, LABEL);
  return { url, entries: readPairArray(payload, url), fetchedAtMs };
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every pair Dexscreener currently reports for `mint`, deepest liquidity first.
 *
 * @param {string} mint base58 mint address
 * @param {object} [deps] seams: `getJson`, `schedule`, `now`, `timeoutMs`,
 *   `useLatestEndpoint` (query `/latest/dex/tokens/{mint}` instead of the batch path)
 * @returns {Promise<readonly Pair[]>} frozen; `[]` means "no pools", which is a fact
 * @throws on HTTP failure, an unrecognised envelope, or a structurally invalid pair
 */
export async function getPairsForMint(mint, deps = {}) {
  assertMint(mint, 'getPairsForMint(mint)');
  const path = deps.useLatestEndpoint === true ? `${PATH_LATEST}/${mint}` : `${PATH_BATCH}/${mint}`;
  const { url, entries, fetchedAtMs } = await fetchPairs(path, deps);
  const groups = groupPairs(entries, new Set([mint]), fetchedAtMs, url);
  return groups.get(mint) ?? Object.freeze([]);
}

/** Pairs arrive deepest-first, so the first acceptable quote token wins. */
function pickBest(pairs, quoteMints) {
  return pairs.find((p) => quoteMints.has(p.quoteToken.address)) ?? null;
}

/**
 * The deepest-liquidity pair whose quote token is in STRATEGY.universe.quoteMints.
 * An exotic quote token hides its own rug risk, so such pairs are never chosen
 * even when they are deeper.
 *
 * @param {string} mint
 * @param {object} [deps] as `getPairsForMint`, plus `quoteMints` (test/strategy seam)
 * @returns {Promise<Pair|null>} `null` = no acceptable pair, which is a fact
 */
export async function getBestPair(mint, deps = {}) {
  const pairs = await getPairsForMint(mint, deps);
  return pickBest(pairs, quoteMintsFrom(deps));
}

/**
 * Validate and de-duplicate a requested mint list, preserving first-seen order.
 * @param {unknown} mints
 * @returns {readonly string[]}
 */
function uniqueMints(mints) {
  if (!Array.isArray(mints)) {
    throw new TypeError(
      `${LABEL}: getBestPairs(mints) requires an array, got ${describeValue(mints)}`,
    );
  }
  const seen = new Set();
  const out = [];
  mints.forEach((mint, index) => {
    assertMint(mint, `getBestPairs(mints)[${index}]`);
    if (seen.has(mint)) return;
    seen.add(mint);
    out.push(mint);
  });
  return Object.freeze(out);
}

/**
 * Best pair for many mints, batched at LIMITS.dexscreener.maxMintsPerCall.
 *
 * The returned Map contains EVERY requested mint as a key, with value `null`
 * when Dexscreener returned no acceptable pair for it, so a caller can never
 * mistake "not returned" for "not requested". Key order is the de-duplicated
 * request order. Chunks are fetched sequentially: the limiter would queue them
 * anyway, and sequential requests keep a failure attributable to one batch.
 *
 * Object.freeze cannot seal a Map's entries -- it only seals its own properties.
 * The Map is returned frozen and must be treated as read-only by callers; the
 * Pair values inside it are deeply frozen.
 *
 * @param {readonly string[]} mints
 * @param {object} [deps] as `getBestPair`
 * @returns {Promise<Map<string, Pair|null>>}
 * @throws if `mints` is not an array of base58 mints, or if any batch fails
 */
export async function getBestPairs(mints, deps = {}) {
  const requested = uniqueMints(mints);
  const quoteMints = quoteMintsFrom(deps);
  /** @type {Map<string, Pair|null>} */
  const result = new Map(requested.map((mint) => [mint, null]));
  const batchSize = LIMITS.dexscreener.maxMintsPerCall;

  for (let i = 0; i < requested.length; i += batchSize) {
    const chunk = requested.slice(i, i + batchSize);
    // base58 contains no url-reserved characters, so a plain comma join is safe.
    const { url, entries, fetchedAtMs } = await fetchPairs(
      `${PATH_BATCH}/${chunk.join(',')}`,
      deps,
    );
    const groups = groupPairs(entries, new Set(chunk), fetchedAtMs, url);
    for (const [mint, pairs] of groups) result.set(mint, pickBest(pairs, quoteMints));
  }

  return Object.freeze(result);
}
