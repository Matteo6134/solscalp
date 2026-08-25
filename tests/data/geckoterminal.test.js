/**
 * GeckoTerminal client tests.
 *
 * Three things this file is really about:
 *   1. Candles are only candles if they have prices -- a row without a close
 *      MUST throw, never become 0 or be silently skipped.
 *   2. Timestamps leave this module in epoch MILLISECONDS, ascending.
 *   3. The cache actually prevents the second identical fetch, because 30
 *      req/min is the scarcest resource in the project -- while a LIVE feed
 *      still goes stale after one strategy tick rather than being remembered
 *      forever.
 *
 * `getJson` is injected everywhere, so no socket is opened; `schedule` is
 * injected in all but one test so the module limiter is still exercised once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENDPOINTS, KNOWN, STRATEGY } from '../../src/config.js';
import {
  TIMEFRAMES,
  clearCache,
  getNewPools,
  getOhlcv,
  getPoolsForToken,
} from '../../src/data/geckoterminal.js';
import { createResponseCache } from '../../src/data/responseCache.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** 36 chars, every one of them in the base58 alphabet (no 0, O, I or l). */
const addr = (tag, i) => `${tag}${B58[i]}${'q'.repeat(36 - tag.length - 1)}`;

const POOL = addr('Pooo', 0);
const MINT = addr('Mint', 1);
const CREATED_ISO = '2026-08-24T10:00:00.000Z';
const CREATED_MS = Date.parse(CREATED_ISO);
const NOW = CREATED_MS + 90 * 60_000;
/** One strategy tick: the live-snapshot TTL, derived from config, not invented. */
const TICK_MS = STRATEGY.tickSeconds * 1_000;
const passthrough = (fn) => fn();

/** ohlcv rows arrive newest-first from the API: [ts_seconds, o, h, l, c, volume]. */
const CANDLE_ROWS = Object.freeze([
  [1_700_000_120, '1.3', '1.4', '1.25', '1.35', '900.5'],
  [1_700_000_060, '1.1', '1.35', '1.05', '1.3', '1200'],
  [1_700_000_000, 1, 1.2, 0.9, 1.1, 500],
]);

const ohlcvPayload = (rows = CANDLE_ROWS) => ({
  data: { id: 'x', type: 'ohlcv_request_response', attributes: { ohlcv_list: rows } },
});

const poolEntry = (over = {}, attrOver = {}) => ({
  id: `solana_${POOL}`,
  type: 'pool',
  attributes: {
    address: POOL,
    name: 'ALPHA / SOL',
    base_token_price_usd: '0.0042',
    quote_token_price_usd: '210.5',
    reserve_in_usd: '55000.5',
    fdv_usd: '1200000',
    market_cap_usd: '900000',
    pool_created_at: CREATED_ISO,
    volume_usd: { m5: '10', h1: '2500', h24: '123456.78' },
    ...attrOver,
  },
  relationships: {
    base_token: { data: { id: `solana_${MINT}`, type: 'token' } },
    quote_token: { data: { id: `solana_${KNOWN.WSOL}`, type: 'token' } },
    dex: { data: { id: 'raydium', type: 'dex' } },
  },
  ...over,
});

const fakeGet = (payload) => vi.fn(async () => payload);
const deps = (payload, over = {}) => ({
  getJson: fakeGet(payload),
  schedule: passthrough,
  now: () => NOW,
  ...over,
});

const httpStatusError = (status) =>
  Object.assign(new Error(`geckoterminal: HTTP ${status} [GET url]`), {
    kind: 'status',
    status,
    label: 'geckoterminal',
  });

// The cache is module-level on purpose (the quota is per IP), so each test
// starts from a clean one.
beforeEach(() => {
  clearCache();
});

describe('getOhlcv', () => {
  it('builds the documented url with aggregate, limit and before_timestamp', async () => {
    const d = deps(ohlcvPayload());
    await getOhlcv(
      { poolAddress: POOL, timeframe: 'hour', aggregate: 4, limit: 50, beforeTimestamp: 1_700_000_500 },
      d,
    );

    const url = new URL(d.getJson.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${ENDPOINTS.geckoterminal}/networks/solana/pools/${POOL}/ohlcv/hour`,
    );
    expect(url.searchParams.get('aggregate')).toBe('4');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('before_timestamp')).toBe('1700000500');
  });

  it('omits before_timestamp when it was not asked for', async () => {
    const d = deps(ohlcvPayload());
    await getOhlcv({ poolAddress: POOL }, d);
    const url = new URL(d.getJson.mock.calls[0][0]);
    expect(url.searchParams.has('before_timestamp')).toBe(false);
    expect(url.pathname.endsWith('/ohlcv/minute')).toBe(true);
    expect(url.searchParams.get('aggregate')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('returns candles ASCENDING with millisecond timestamps', async () => {
    const candles = await getOhlcv({ poolAddress: POOL }, deps(ohlcvPayload()));

    expect(candles.map((c) => c.ts)).toEqual([
      1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000,
    ]);
    // Ascending, strictly.
    expect(candles.every((c, i) => i === 0 || c.ts > candles[i - 1].ts)).toBe(true);
    expect(candles[0]).toEqual({
      ts: 1_700_000_000_000,
      open: 1,
      high: 1.2,
      low: 0.9,
      close: 1.1,
      volumeUsd: 500,
    });
    expect(Object.isFrozen(candles)).toBe(true);
    expect(Object.isFrozen(candles[0])).toBe(true);
  });

  it('parses candles sent as strings', async () => {
    const candles = await getOhlcv({ poolAddress: POOL }, deps(ohlcvPayload()));
    const last = candles.at(-1);
    expect(last.open).toBe(1.3);
    expect(last.close).toBe(1.35);
    expect(last.volumeUsd).toBe(900.5);
  });

  it('reports a missing volume as null, never 0', async () => {
    const candles = await getOhlcv(
      { poolAddress: POOL },
      deps(ohlcvPayload([[1_700_000_000, 1, 2, 0.5, 1.5]])),
    );
    expect(candles[0].volumeUsd).toBeNull();
    expect(candles[0].volumeUsd).not.toBe(0);
    expect(candles[0].close).toBe(1.5);
  });

  it('throws when a candle has no close price (that is not a candle)', async () => {
    await expect(
      getOhlcv({ poolAddress: POOL }, deps(ohlcvPayload([[1_700_000_000, 1, 2, 0.5, null, 10]]))),
    ).rejects.toThrow(/ohlcv_list\[0\]\[4\] close was not a finite number/);
  });

  it('throws when a candle omits close entirely (too few fields)', async () => {
    await expect(
      getOhlcv({ poolAddress: POOL }, deps(ohlcvPayload([[1_700_000_000, 1, 2, 0.5]]))),
    ).rejects.toThrow(/must be an array of at least 5 fields/);
  });

  it('throws when a candle has an unparseable open/high/low', async () => {
    const rows = [
      [1_700_000_000, 'abc', 2, 0.5, 1.5, 1],
      [1_700_000_000, 1, undefined, 0.5, 1.5, 1],
      [1_700_000_000, 1, 2, {}, 1.5, 1],
    ];
    // A distinct `limit` per case, so each one is its own request rather than a
    // cache hit on the first -- the cache is keyed by the exact url.
    for (const [i, row] of rows.entries()) {
      await expect(
        getOhlcv({ poolAddress: POOL, limit: 10 + i }, deps(ohlcvPayload([row]))),
      ).rejects.toThrow(/was not a finite number/);
    }
  });

  it('throws when a candle row is not an array', async () => {
    await expect(
      getOhlcv({ poolAddress: POOL }, deps(ohlcvPayload([{ ts: 1, close: 2 }]))),
    ).rejects.toThrow(/must be an array of at least 5 fields/);
  });

  it('throws on a non-positive or unparseable timestamp', async () => {
    await expect(
      getOhlcv({ poolAddress: POOL, limit: 21 }, deps(ohlcvPayload([[0, 1, 2, 0.5, 1.5, 1]]))),
    ).rejects.toThrow(/positive epoch second/);
    await expect(
      getOhlcv({ poolAddress: POOL, limit: 22 }, deps(ohlcvPayload([[null, 1, 2, 0.5, 1.5, 1]]))),
    ).rejects.toThrow(/timestamp was not a finite number/);
    await expect(
      getOhlcv({ poolAddress: POOL, limit: 23 }, deps(ohlcvPayload([[-5, 1, 2, 0.5, 1.5, 1]]))),
    ).rejects.toThrow(/positive epoch second/);
  });

  it('throws when ohlcv_list is missing or not an array', async () => {
    const payloads = [{ data: {} }, { data: { attributes: { ohlcv_list: {} } } }, 'nope', {}];
    for (const [i, payload] of payloads.entries()) {
      await expect(
        getOhlcv({ poolAddress: POOL, limit: 31 + i }, deps(payload)),
      ).rejects.toThrow(/ohlcv_list must be an array/);
    }
  });

  it('rejects an invalid timeframe without touching the network', async () => {
    const getJson = vi.fn();
    for (const timeframe of ['second', 'week', '', null, 5, 'MINUTE']) {
      await expect(
        getOhlcv({ poolAddress: POOL, timeframe }, { getJson, schedule: passthrough }),
      ).rejects.toThrow(/timeframe must be one of minute\|hour\|day/);
    }
    expect(getJson).not.toHaveBeenCalled();
  });

  it('accepts every documented timeframe', async () => {
    // Each timeframe is a different url, so none of these is a cache hit.
    for (const timeframe of TIMEFRAMES) {
      const candles = await getOhlcv({ poolAddress: POOL, timeframe }, deps(ohlcvPayload()));
      expect(candles).toHaveLength(CANDLE_ROWS.length);
    }
  });

  it('rejects an invalid pool address, aggregate, limit or beforeTimestamp', async () => {
    const getJson = vi.fn();
    const base = { poolAddress: POOL };
    await expect(
      getOhlcv({ poolAddress: 'short' }, { getJson, schedule: passthrough }),
    ).rejects.toThrow(/must be a base58 address/);
    await expect(
      getOhlcv({ ...base, aggregate: 0 }, { getJson, schedule: passthrough }),
    ).rejects.toThrow(/aggregate\) must be a positive integer/);
    await expect(
      getOhlcv({ ...base, limit: 1.5 }, { getJson, schedule: passthrough }),
    ).rejects.toThrow(/limit\) must be a positive integer/);
    await expect(
      getOhlcv({ ...base, beforeTimestamp: -1 }, { getJson, schedule: passthrough }),
    ).rejects.toThrow(/beforeTimestamp\) must be a positive integer/);
    await expect(
      getOhlcv({ ...base, beforeTimestamp: 'yesterday' }, { getJson, schedule: passthrough }),
    ).rejects.toThrow(/beforeTimestamp\) must be a positive integer/);
    expect(getJson).not.toHaveBeenCalled();
  });

  it('propagates an HTTP failure', async () => {
    const getJson = vi.fn(async () => {
      throw httpStatusError(429);
    });
    await expect(
      getOhlcv({ poolAddress: POOL }, { getJson, schedule: passthrough, now: () => NOW }),
    ).rejects.toMatchObject({ status: 429, kind: 'status' });
  });

  it('works through the real module-level rate limiter when no schedule is injected', async () => {
    const candles = await getOhlcv(
      { poolAddress: POOL },
      { getJson: fakeGet(ohlcvPayload()), now: () => NOW },
    );
    expect(candles).toHaveLength(CANDLE_ROWS.length);
  });
});

describe('getOhlcv caching (30 req/min is the scarcest resource)', () => {
  it('does not re-fetch an identical request', async () => {
    const d = deps(ohlcvPayload());
    const first = await getOhlcv({ poolAddress: POOL, beforeTimestamp: 1_700_000_500 }, d);
    const second = await getOhlcv({ poolAddress: POOL, beforeTimestamp: 1_700_000_500 }, d);

    expect(d.getJson).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('fetches again for a different window, limit or timeframe', async () => {
    const d = deps(ohlcvPayload());
    await getOhlcv({ poolAddress: POOL, limit: 10 }, d);
    await getOhlcv({ poolAddress: POOL, limit: 20 }, d);
    await getOhlcv({ poolAddress: POOL, limit: 20, timeframe: 'hour' }, d);
    await getOhlcv({ poolAddress: POOL, limit: 20, beforeTimestamp: 1_700_000_500 }, d);
    expect(d.getJson).toHaveBeenCalledTimes(4);
  });

  it('never expires a CLOSED historical window', async () => {
    let nowMs = NOW;
    const d = deps(ohlcvPayload(), { now: () => nowMs });
    await getOhlcv({ poolAddress: POOL, beforeTimestamp: 1_700_000_500 }, d);
    nowMs = NOW + 365 * 24 * 60 * 60_000;
    await getOhlcv({ poolAddress: POOL, beforeTimestamp: 1_700_000_500 }, d);
    expect(d.getJson).toHaveBeenCalledTimes(1);
  });

  it('expires a LIVE window after exactly one strategy tick (boundary)', async () => {
    let nowMs = NOW;
    const d = deps(ohlcvPayload(), { now: () => nowMs });

    await getOhlcv({ poolAddress: POOL }, d);
    nowMs = NOW + TICK_MS - 1;
    await getOhlcv({ poolAddress: POOL }, d);
    expect(d.getJson).toHaveBeenCalledTimes(1);

    nowMs = NOW + TICK_MS;
    await getOhlcv({ poolAddress: POOL }, d);
    expect(d.getJson).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure: the next call tries again', async () => {
    let calls = 0;
    const getJson = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw httpStatusError(500);
      return ohlcvPayload();
    });
    const d = { getJson, schedule: passthrough, now: () => NOW };

    await expect(getOhlcv({ poolAddress: POOL }, d)).rejects.toMatchObject({ status: 500 });
    const candles = await getOhlcv({ poolAddress: POOL }, d);
    expect(candles).toHaveLength(CANDLE_ROWS.length);
    expect(getJson).toHaveBeenCalledTimes(2);
  });

  it('clearCache() forces the next identical request back onto the network', async () => {
    const d = deps(ohlcvPayload());
    await getOhlcv({ poolAddress: POOL }, d);
    clearCache();
    await getOhlcv({ poolAddress: POOL }, d);
    expect(d.getJson).toHaveBeenCalledTimes(2);
  });
});

describe('getNewPools', () => {
  it('normalises a JSON:API page into frozen pools', async () => {
    const d = deps({ data: [poolEntry()] });
    const pools = await getNewPools({ page: 2 }, d);

    const url = new URL(d.getJson.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${ENDPOINTS.geckoterminal}/networks/solana/new_pools`,
    );
    expect(url.searchParams.get('page')).toBe('2');

    expect(pools).toHaveLength(1);
    const pool = pools[0];
    expect(pool.poolAddress).toBe(POOL);
    expect(pool.dexId).toBe('raydium');
    expect(pool.name).toBe('ALPHA / SOL');
    // The `solana_` prefix belongs to the API, never to our domain objects.
    expect(pool.baseMint).toBe(MINT);
    expect(pool.quoteMint).toBe(KNOWN.WSOL);
    expect(pool.priceUsd).toBe(0.0042);
    expect(pool.liquidityUsd).toBe(55000.5);
    expect(pool.fdv).toBe(1_200_000);
    expect(pool.volumeUsd24h).toBe(123456.78);
    expect(pool.createdAtMs).toBe(CREATED_MS);
    expect(pool.ageMinutes).toBe(90);
    expect(pool.fetchedAtMs).toBe(NOW);
    expect(Object.isFrozen(pools)).toBe(true);
    expect(Object.isFrozen(pool)).toBe(true);
    expect(Object.isFrozen(pool.raw)).toBe(true);
  });

  it('defaults to page 1', async () => {
    const d = deps({ data: [] });
    await getNewPools(undefined, d);
    expect(new URL(d.getJson.mock.calls[0][0]).searchParams.get('page')).toBe('1');
  });

  it('reports missing reserve, fdv, price and volume as null, never 0', async () => {
    const stripped = poolEntry();
    delete stripped.attributes.reserve_in_usd;
    delete stripped.attributes.fdv_usd;
    delete stripped.attributes.market_cap_usd;
    delete stripped.attributes.base_token_price_usd;
    delete stripped.attributes.volume_usd;
    delete stripped.attributes.pool_created_at;

    const [pool] = await getNewPools({}, deps({ data: [stripped] }));
    expect(pool.liquidityUsd).toBeNull();
    expect(pool.liquidityUsd).not.toBe(0);
    expect(pool.fdv).toBeNull();
    expect(pool.priceUsd).toBeNull();
    expect(pool.volumeUsd24h).toBeNull();
    expect(pool.createdAtMs).toBeNull();
    expect(pool.ageMinutes).toBeNull();
  });

  it('falls back to market_cap_usd when fdv_usd is absent', async () => {
    const noFdv = poolEntry();
    delete noFdv.attributes.fdv_usd;
    const [pool] = await getNewPools({}, deps({ data: [noFdv] }));
    expect(pool.fdv).toBe(900_000);
  });

  it('falls back to the entity id when attributes.address is absent', async () => {
    const noAddress = poolEntry();
    delete noAddress.attributes.address;
    const [pool] = await getNewPools({}, deps({ data: [noAddress] }));
    expect(pool.poolAddress).toBe(POOL);
  });

  it('throws when a pool has no address at all (never silently skipped)', async () => {
    const broken = poolEntry({ id: undefined });
    delete broken.attributes.address;
    await expect(getNewPools({}, deps({ data: [broken] }))).rejects.toThrow(/has no pool address/);
  });

  it('throws when a pool is missing its base or quote token relationship', async () => {
    const noBase = poolEntry({ relationships: { dex: { data: { id: 'raydium' } } } });
    await expect(getNewPools({}, deps({ data: [noBase] }))).rejects.toThrow(
      /missing relationships.base_token \/ quote_token/,
    );
  });

  it('throws when an entry is not an object', async () => {
    await expect(getNewPools({}, deps({ data: ['nope'] }))).rejects.toThrow(
      /data\[0\] is not an object/,
    );
  });

  it('throws on an envelope that is not JSON:API', async () => {
    await expect(getNewPools({}, deps({ pools: [] }))).rejects.toThrow(/expected a JSON:API/);
    await expect(getNewPools({}, deps('nope'))).rejects.toThrow(/expected a JSON:API/);
  });

  it('returns [] for an empty live feed -- a fact, not an error', async () => {
    expect(await getNewPools({}, deps({ data: [] }))).toEqual([]);
  });

  it('rejects an invalid page without touching the network', async () => {
    const getJson = vi.fn();
    for (const page of [0, -1, 1.5, '2', null]) {
      await expect(getNewPools({ page }, { getJson, schedule: passthrough })).rejects.toThrow(
        /page\) must be a positive integer/,
      );
    }
    expect(getJson).not.toHaveBeenCalled();
  });

  it('serves a second identical page from cache, then refetches after a tick', async () => {
    let nowMs = NOW;
    const d = deps({ data: [poolEntry()] }, { now: () => nowMs });
    await getNewPools({ page: 1 }, d);
    await getNewPools({ page: 1 }, d);
    expect(d.getJson).toHaveBeenCalledTimes(1);

    nowMs = NOW + TICK_MS;
    await getNewPools({ page: 1 }, d);
    expect(d.getJson).toHaveBeenCalledTimes(2);
  });

  it('a cache hit keeps the ORIGINAL fetchedAtMs so staleness stays visible', async () => {
    let nowMs = NOW;
    const d = deps({ data: [poolEntry()] }, { now: () => nowMs });
    const [first] = await getNewPools({ page: 1 }, d);
    nowMs = NOW + 5_000;
    const [second] = await getNewPools({ page: 1 }, d);
    expect(second.fetchedAtMs).toBe(first.fetchedAtMs);
    expect(second.fetchedAtMs).toBe(NOW);
  });
});

describe('getPoolsForToken', () => {
  it('GETs the token pools path and normalises the page', async () => {
    const d = deps({ data: [poolEntry()] });
    const pools = await getPoolsForToken(MINT, d);

    expect(d.getJson.mock.calls[0][0]).toBe(
      `${ENDPOINTS.geckoterminal}/networks/solana/tokens/${MINT}/pools`,
    );
    expect(pools[0].baseMint).toBe(MINT);
  });

  it('returns [] when the token has no pools', async () => {
    expect(await getPoolsForToken(MINT, deps({ data: [] }))).toEqual([]);
  });

  it('rejects an invalid mint without touching the network', async () => {
    const getJson = vi.fn();
    for (const bad of ['', 'short', null, undefined, 42, {}]) {
      await expect(getPoolsForToken(bad, { getJson, schedule: passthrough })).rejects.toThrow(
        /must be a base58 address/,
      );
    }
    expect(getJson).not.toHaveBeenCalled();
  });

  it('propagates an HTTP failure', async () => {
    const getJson = vi.fn(async () => {
      throw httpStatusError(503);
    });
    await expect(
      getPoolsForToken(MINT, { getJson, schedule: passthrough, now: () => NOW }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('TIMEFRAMES', () => {
  it('is the frozen documented enumeration', () => {
    expect(TIMEFRAMES).toEqual(['minute', 'hour', 'day']);
    expect(Object.isFrozen(TIMEFRAMES)).toBe(true);
  });
});

describe('the response cache seam', () => {
  it('uses an injected cache and evicts by insertion order at maxEntries', async () => {
    const cache = createResponseCache({ maxEntries: 1 });
    const d = deps(ohlcvPayload(), { cache });

    await getOhlcv({ poolAddress: POOL, limit: 1 }, d);
    expect(cache.size()).toBe(1);

    // A different window evicts the first, so asking for the first again refetches.
    await getOhlcv({ poolAddress: POOL, limit: 2 }, d);
    expect(cache.size()).toBe(1);
    await getOhlcv({ poolAddress: POOL, limit: 1 }, d);
    expect(d.getJson).toHaveBeenCalledTimes(3);

    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('refuses a nonsense cache size rather than growing without bound', () => {
    for (const maxEntries of [0, -1, 1.5, '10', null]) {
      expect(() => createResponseCache({ maxEntries })).toThrow(/positive integer/);
    }
  });

  it('falls back to the real clock when no clock seam is injected', async () => {
    const before = Date.now();
    const pools = await getNewPools(
      {},
      { getJson: fakeGet({ data: [poolEntry()] }), schedule: passthrough },
    );
    expect(pools[0].fetchedAtMs).toBeGreaterThanOrEqual(before);
  });

  it('rejects a clock seam that is not a function', async () => {
    // `null`/`undefined` mean "not supplied" and fall back to the real clock;
    // anything else is a wiring bug and must not be papered over.
    await expect(getNewPools({}, deps({ data: [] }, { now: 'noon' }))).rejects.toThrow(
      /deps.now must be a function/,
    );
  });
});
