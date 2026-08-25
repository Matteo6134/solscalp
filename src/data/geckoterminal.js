/**
 * GeckoTerminal v2 client -- READ ONLY, keyless, and the SCARCEST resource in
 * the project at LIMITS.geckoterminal.requestsPerMinute (30/min for the whole
 * process, per IP). Everything here is shaped by that budget.
 *
 * WHAT THIS MODULE PROVES
 *   - `getOhlcv`: what GeckoTerminal recorded for one pool over one window,
 *     as candles with millisecond timestamps in ascending order.
 *   - `getNewPools` / `getPoolsForToken`: which pools GeckoTerminal is
 *     indexing right now, with reserve, fdv and 24h volume as reported.
 *
 * WHAT IT DOES NOT PROVE
 *   - **`new_pools` is LIVE-ONLY.** It is a rolling feed of what was created
 *     recently; there is no date parameter and no way to page back in time. So
 *     this module CANNOT enumerate a historical universe -- you cannot ask it
 *     which pools existed on 1 March with $50k liquidity. That is precisely why
 *     the design record rejects candle backtesting: selecting today's survivors
 *     and replaying their candles conditions on the 1.4% that lived, and every
 *     dip recovers by construction. Candles here are for live monitoring and
 *     forward recording, never for fitting parameters.
 *   - Volume and transaction counts are aggregates over swaps that up to 93% of
 *     Solana volume is estimated to fake. A candle is evidence of activity, not
 *     of demand and not of safety.
 *
 * FAIL CLOSED
 *   HTTP failure, an unrecognised envelope, an invalid timeframe, or a candle
 *   without a finite open/high/low/close THROWS (`requireFiniteNumber`): a
 *   candle without a close price is not a candle. Optional figures that are
 *   absent become `null`, never 0.
 *
 * CACHING (documented, deliberate)
 *   Every request is keyed by its exact url in an in-process response cache, so
 *   the same window is never re-fetched and a cache hit costs no rate-limit slot.
 *   Two TTL regimes, because staleness is not free either:
 *     - A CLOSED historical window (`beforeTimestamp` supplied) is cached with no
 *       expiry: that window cannot change.
 *     - A LIVE request (latest candles, `new_pools`, a token's pools) is cached
 *       for one strategy tick (`STRATEGY.tickSeconds`). Within a tick the answer
 *       is by definition the same snapshot; after it, the gate must see fresh
 *       liquidity rather than a remembered one.
 *   A cache hit reports the ORIGINAL `fetchedAtMs`, so a caller can always see the
 *   true age of the snapshot it is acting on. Only a successfully NORMALISED
 *   response is stored: an HTTP failure is never cached, and neither is a payload
 *   that failed validation -- remembering a malformed closed window would poison
 *   it for the life of the process.
 */

import { ENDPOINTS, LIMITS, STRATEGY } from '../config.js';
import {
  asObject,
  describeValue,
  isoToEpochMs,
  requireFiniteNumber,
  toNumberOrNull,
} from './coerce.js';
import { buildUrl, getJson as httpGetJson } from './httpJson.js';
import {
  MS_PER_SECOND,
  assertBase58Address,
  assertPositiveInteger as assertPositiveInt,
  frozenClone,
  isPlainObject,
  minutesSince,
  readNowMs,
  stringOrNull,
} from './payload.js';
import { createRateLimiter } from './rateLimiter.js';
import { createResponseCache } from './responseCache.js';

/** Prefixes every error this module raises. */
const LABEL = 'geckoterminal';
/** The only network this project trades. Also the prefix on every entity id. */
const NETWORK = 'solana';
/** Wire arity of an ohlcv_list row: [ts, open, high, low, close, volume]. */
const CANDLE_MIN_FIELDS = 5;
/** A live snapshot may be reused within one strategy tick, never across ticks. */
const LIVE_TTL_MS = STRATEGY.tickSeconds * MS_PER_SECOND;

/** The only timeframes the API defines. Anything else is a caller bug. */
export const TIMEFRAMES = Object.freeze(['minute', 'hour', 'day']);

/** One limiter for the whole process: 30 req/min is per IP, not per call site. */
const limiter = createRateLimiter({
  requestsPerMinute: LIMITS.geckoterminal.requestsPerMinute,
  label: LABEL,
});

/**
 * @typedef {Readonly<{ts: number, open: number, high: number, low: number,
 *   close: number, volumeUsd: number|null}>} Candle ts is epoch MILLISECONDS
 */
/**
 * @typedef {Readonly<{poolAddress: string, dexId: string|null, name: string|null,
 *   baseMint: string, quoteMint: string, priceUsd: number|null,
 *   liquidityUsd: number|null, fdv: number|null, volumeUsd24h: number|null,
 *   createdAtMs: number|null, ageMinutes: number|null, fetchedAtMs: number,
 *   raw: object}>} Pool
 */

/* -------------------------------------------------------------------------- */
/* primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** @param {unknown} v @param {string} what @returns {string} validated address */
const assertAddress = (v, what) => assertBase58Address(v, `${LABEL}: ${what}`);

/** @param {unknown} v @param {string} what @returns {number} validated integer */
const assertPositiveInteger = (v, what) => assertPositiveInt(v, `${LABEL}: ${what}`);

/** `solana_ABC...` -> `ABC...`. Ids for non-address entities (a dex) pass through. */
function stripNetworkPrefix(id) {
  const value = stringOrNull(id);
  if (value === null) return null;
  const prefix = `${NETWORK}_`;
  return value.startsWith(prefix) ? stringOrNull(value.slice(prefix.length)) : value;
}

/** JSON:API relationship -> its id, network prefix removed. */
const relationshipId = (node) => stripNetworkPrefix(asObject(asObject(node).data).id);

/* -------------------------------------------------------------------------- */
/* transport                                                                  */
/* -------------------------------------------------------------------------- */

/** One cache for the whole process, keyed by url: the quota is per IP. */
const defaultCache = createResponseCache();

/**
 * Drop every cached response, so the next call goes back to the network. For
 * tests and for an operator; never needed for correctness of the TTLs above.
 * @returns {void}
 */
export function clearCache() {
  defaultCache.clear();
}

/**
 * One cached, rate-limited GET, normalised by `parse` BEFORE it is cached, so a
 * cache hit costs no rate-limit slot and neither a transport failure nor an
 * unparseable payload is ever remembered (see the CACHING note in the header).
 *
 * @template T
 * @param {{path: string, params?: object, ttlMs: number,
 *   parse: (payload: unknown, url: string, fetchedAtMs: number) => T}} request
 * @param {object} deps `getJson`, `schedule`, `cache`, `now`, `timeoutMs`
 * @returns {Promise<T>}
 */
async function fetchCached({ path, params = {}, ttlMs, parse }, deps) {
  const get = deps.getJson ?? httpGetJson;
  const schedule = deps.schedule ?? ((fn) => limiter.schedule(fn));
  const cache = deps.cache ?? defaultCache;
  const url = buildUrl(ENDPOINTS.geckoterminal, path, params);

  const hit = cache.get(url, readNowMs(deps, LABEL));
  if (hit !== undefined) return hit;

  const payload = await schedule(() => get(url, { label: LABEL, timeoutMs: deps.timeoutMs }));
  // Clock read AFTER the response lands: fetchedAtMs describes the snapshot, and
  // a cache hit therefore keeps reporting the age of the ORIGINAL fetch.
  const fetchedAtMs = readNowMs(deps, LABEL);
  const value = parse(payload, url, fetchedAtMs);
  cache.set(
    url,
    value,
    ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : fetchedAtMs + ttlMs,
  );
  return value;
}

/* -------------------------------------------------------------------------- */
/* normalisation                                                              */
/* -------------------------------------------------------------------------- */

/** @returns {readonly unknown[]} the `ohlcv_list` rows, or throws. */
function readOhlcvList(payload, url) {
  const attributes = asObject(asObject(asObject(payload).data).attributes);
  const list = attributes.ohlcv_list;
  if (!Array.isArray(list)) {
    throw new TypeError(
      `${LABEL}: data.attributes.ohlcv_list must be an array, got ` +
        `${describeValue(list)} [GET ${url}]`,
    );
  }
  return list;
}

/** @returns {readonly unknown[]} the JSON:API `data` array, or throws. */
function readDataArray(payload, url) {
  if (Array.isArray(asObject(payload).data)) return asObject(payload).data;
  // Defensive: some endpoints have historically returned a bare array.
  if (Array.isArray(payload)) return payload;
  throw new TypeError(
    `${LABEL}: expected a JSON:API { data: [...] } envelope, got ` +
      `${describeValue(payload)} [GET ${url}]`,
  );
}

/**
 * One `[ts, o, h, l, c, volume]` row -> a frozen Candle with ts in MILLISECONDS.
 * open/high/low/close are STRUCTURAL: a candle without them is not a candle, so
 * they use requireFiniteNumber and a missing one throws. Volume is optional and
 * unknown volume is `null`, never 0.
 * @param {unknown} row
 * @param {number} index
 * @param {string} url
 * @returns {Candle}
 */
function normaliseCandle(row, index, url) {
  const what = `${LABEL}: ohlcv_list[${index}]`;
  if (!Array.isArray(row) || row.length < CANDLE_MIN_FIELDS) {
    throw new TypeError(
      `${what} must be an array of at least ${CANDLE_MIN_FIELDS} fields ` +
        `[ts, open, high, low, close], got ${describeValue(row)} [GET ${url}]`,
    );
  }
  const [ts, open, high, low, close, volume] = row;
  // The API documents this timestamp in unix SECONDS; the whole project speaks
  // milliseconds, so it is converted here and nowhere else.
  const tsSeconds = requireFiniteNumber(ts, `${what}[0] timestamp`);
  if (tsSeconds <= 0) {
    throw new RangeError(`${what}[0] timestamp must be a positive epoch second, got ${tsSeconds}`);
  }
  return Object.freeze({
    ts: Math.round(tsSeconds * MS_PER_SECOND),
    open: requireFiniteNumber(open, `${what}[1] open`),
    high: requireFiniteNumber(high, `${what}[2] high`),
    low: requireFiniteNumber(low, `${what}[3] low`),
    close: requireFiniteNumber(close, `${what}[4] close`),
    volumeUsd: toNumberOrNull(volume),
  });
}

/**
 * One JSON:API pool entity -> a frozen Pool.
 * poolAddress, baseMint and quoteMint are STRUCTURAL: a pool we cannot address
 * or whose sides we cannot name is unusable, so it throws rather than being
 * skipped. Silently dropping one entry from a page would be a silent data loss.
 * @param {unknown} entry
 * @param {number} index
 * @param {number} fetchedAtMs
 * @param {string} url
 * @returns {Pool}
 */
function normalisePool(entry, index, fetchedAtMs, url) {
  const what = `${LABEL}: data[${index}]`;
  if (!isPlainObject(entry)) {
    throw new TypeError(`${what} is not an object (${describeValue(entry)}) [GET ${url}]`);
  }
  const attributes = asObject(entry.attributes);
  const relationships = asObject(entry.relationships);

  const poolAddress = stringOrNull(attributes.address) ?? stripNetworkPrefix(entry.id);
  if (poolAddress === null) {
    throw new TypeError(`${what} has no pool address (attributes.address / id) [GET ${url}]`);
  }
  const baseMint = relationshipId(relationships.base_token);
  const quoteMint = relationshipId(relationships.quote_token);
  if (baseMint === null || quoteMint === null) {
    throw new TypeError(
      `${what} (${poolAddress}) is missing relationships.base_token / quote_token ` +
        `[GET ${url}]`,
    );
  }

  const createdAtMs = isoToEpochMs(attributes.pool_created_at);
  return Object.freeze({
    poolAddress,
    dexId: relationshipId(relationships.dex),
    name: stringOrNull(attributes.name),
    baseMint,
    quoteMint,
    priceUsd: toNumberOrNull(attributes.base_token_price_usd),
    liquidityUsd: toNumberOrNull(attributes.reserve_in_usd),
    // fdv first, market cap only as the fallback when fdv is absent.
    fdv: toNumberOrNull(attributes.fdv_usd) ?? toNumberOrNull(attributes.market_cap_usd),
    volumeUsd24h: toNumberOrNull(asObject(attributes.volume_usd).h24),
    createdAtMs,
    ageMinutes: minutesSince(createdAtMs, fetchedAtMs),
    fetchedAtMs,
    raw: frozenClone(entry),
  });
}

/** Every pool in a JSON:API page, frozen. Signature matches `fetchCached.parse`. */
function normalisePools(payload, url, fetchedAtMs) {
  return Object.freeze(
    readDataArray(payload, url).map((entry, index) =>
      normalisePool(entry, index, fetchedAtMs, url),
    ),
  );
}

/**
 * Every candle in an ohlcv payload, frozen and ASCENDING by ts (the API returns
 * newest-first; every consumer here reads forward in time).
 */
function normaliseCandles(payload, url) {
  const candles = readOhlcvList(payload, url).map((row, index) =>
    normaliseCandle(row, index, url),
  );
  return Object.freeze([...candles].sort((a, b) => a.ts - b.ts));
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /networks/solana/pools/{poolAddress}/ohlcv/{timeframe}
 *
 * @param {object} p
 * @param {string} p.poolAddress base58 POOL address (not a mint)
 * @param {'minute'|'hour'|'day'} [p.timeframe] anything else throws
 * @param {number} [p.aggregate] candles per bucket, e.g. 5 with 'minute' = 5m candles
 * @param {number} [p.limit] candles requested; the API caps this server-side
 * @param {number} [p.beforeTimestamp] **unix SECONDS**, matching the API's own
 *   `before_timestamp` (the one timestamp here that is not in ms, because it goes
 *   on the wire verbatim). Supplying it asks for a CLOSED window, cached forever.
 * @param {object} [deps] seams: `getJson`, `schedule`, `cache`, `now`, `timeoutMs`
 * @returns {Promise<readonly Candle[]>} frozen, ASCENDING by ts, ts in epoch ms
 * @throws on an invalid timeframe/aggregate/limit, HTTP failure, a missing
 *   ohlcv_list, or a candle without a finite open/high/low/close
 */
export async function getOhlcv(
  { poolAddress, timeframe = 'minute', aggregate = 1, limit = 100, beforeTimestamp } = {},
  deps = {},
) {
  assertAddress(poolAddress, 'getOhlcv(poolAddress)');
  if (!TIMEFRAMES.includes(timeframe)) {
    throw new TypeError(
      `${LABEL}: getOhlcv timeframe must be one of ${TIMEFRAMES.join('|')}, got ` +
        `${describeValue(timeframe)}`,
    );
  }
  assertPositiveInteger(aggregate, 'getOhlcv(aggregate)');
  assertPositiveInteger(limit, 'getOhlcv(limit)');
  const closedWindow = beforeTimestamp !== undefined && beforeTimestamp !== null;
  if (closedWindow) assertPositiveInteger(beforeTimestamp, 'getOhlcv(beforeTimestamp)');

  return fetchCached(
    {
      path: `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`,
      params: {
        aggregate,
        limit,
        before_timestamp: closedWindow ? beforeTimestamp : null,
      },
      // A closed historical window cannot change; a live one must not go stale.
      ttlMs: closedWindow ? Number.POSITIVE_INFINITY : LIVE_TTL_MS,
      parse: normaliseCandles,
    },
    deps,
  );
}

/**
 * GET /networks/solana/new_pools
 *
 * LIVE-ONLY: a rolling feed of recently created pools. There is no date
 * parameter, so this can never enumerate a historical universe -- see the header
 * and the design record's rejection of candle backtesting.
 *
 * @param {object} [p]
 * @param {number} [p.page] 1-based page of the live feed
 * @param {object} [deps] seams: `getJson`, `schedule`, `cache`, `now`, `timeoutMs`
 * @returns {Promise<readonly Pool[]>} frozen; `[]` means the feed is empty right now
 * @throws on HTTP failure, an unrecognised envelope, or an unusable pool entity
 */
export async function getNewPools({ page = 1 } = {}, deps = {}) {
  assertPositiveInteger(page, 'getNewPools(page)');
  return fetchCached(
    {
      path: `/networks/${NETWORK}/new_pools`,
      params: { page },
      ttlMs: LIVE_TTL_MS,
      parse: normalisePools,
    },
    deps,
  );
}

/**
 * GET /networks/solana/trending_pools
 *
 * WHY THIS EXISTS ALONGSIDE getNewPools
 *   `new_pools` returns pools that are MINUTES old with sub-$20k caps -- too raw
 *   even for UNIVERSE_PROFILES.early, which wants at least 15 minutes of trading
 *   and a floor of real float. Screening that feed yields an empty funnel almost
 *   every time, and for a structural reason rather than a tuning one.
 *
 *   This feed is pools with activity RIGHT NOW, which is the population the
 *   momentum rules were written against: already surviving, small enough to
 *   still multiply, and currently moving.
 *
 * WHAT "TRENDING" DOES NOT MEAN
 *   It is GeckoTerminal's own popularity ordering, and it is gameable -- the
 *   design record cites a project that bought #7 on Dexscreener trending for
 *   4 SOL of fake volume. Treat a high placement as "someone is spending money
 *   to be seen here", which is information, but never as demand or as safety.
 *
 * @param {object} [p]
 * @param {number} [p.page] 1-based page
 * @param {string} [p.duration] '5m' | '1h' | '6h' | '24h' -- the trend window
 * @param {object} [deps] seams: `getJson`, `schedule`, `cache`, `now`, `timeoutMs`
 * @returns {Promise<readonly Pool[]>} frozen
 */
export async function getTrendingPools({ page = 1, duration = '5m' } = {}, deps = {}) {
  assertPositiveInteger(page, 'getTrendingPools(page)');
  if (!TREND_DURATIONS.includes(duration)) {
    throw new TypeError(
      `getTrendingPools(duration) must be one of ${TREND_DURATIONS.join('|')}, got ${String(duration)}`,
    );
  }
  return fetchCached(
    {
      path: `/networks/${NETWORK}/trending_pools`,
      params: { page, duration },
      ttlMs: LIVE_TTL_MS,
      parse: normalisePools,
    },
    deps,
  );
}

/** Trend windows GeckoTerminal accepts for trending_pools. */
export const TREND_DURATIONS = Object.freeze(['5m', '1h', '6h', '24h']);

/**
 * GET /networks/solana/pools -- the network's pools, ordered by a chosen metric.
 *
 * The broadest live enumeration available on the free tier. Paired with the
 * universe screen this is how a small-cap-with-momentum candidate list is built:
 * order by 24h volume, then let the market-cap ceiling do the "small" part.
 *
 * @param {object} [p]
 * @param {number} [p.page]
 * @param {string} [p.sort] e.g. 'h24_volume_usd_desc', 'h24_tx_count_desc'
 * @param {object} [deps]
 * @returns {Promise<readonly Pool[]>} frozen
 */
export async function getTopPools({ page = 1, sort = 'h24_volume_usd_desc' } = {}, deps = {}) {
  assertPositiveInteger(page, 'getTopPools(page)');
  if (typeof sort !== 'string' || sort.length === 0) {
    throw new TypeError(`getTopPools(sort) must be a non-empty string, got ${String(sort)}`);
  }
  return fetchCached(
    {
      path: `/networks/${NETWORK}/pools`,
      params: { page, sort },
      ttlMs: LIVE_TTL_MS,
      parse: normalisePools,
    },
    deps,
  );
}

/**
 * GET /networks/solana/tokens/{mint}/pools -- the pools trading one mint.
 * Live snapshot, cached for one strategy tick.
 *
 * @param {string} mint base58 mint address
 * @param {object} [deps] seams: `getJson`, `schedule`, `cache`, `now`, `timeoutMs`
 * @returns {Promise<readonly Pool[]>} frozen; `[]` means "no pools", which is a fact
 */
export async function getPoolsForToken(mint, deps = {}) {
  assertAddress(mint, 'getPoolsForToken(mint)');
  return fetchCached(
    {
      path: `/networks/${NETWORK}/tokens/${mint}/pools`,
      ttlMs: LIVE_TTL_MS,
      parse: normalisePools,
    },
    deps,
  );
}
