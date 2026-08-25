/**
 * Dexscreener client tests.
 *
 * The failure paths ARE the feature here, so most of this file is about what
 * happens when the payload is wrong: a missing liquidity figure must arrive as
 * null (not 0), a non-2xx must throw, an unknown envelope must throw, and every
 * requested mint must come back as a key so "not returned" can never be read as
 * "not requested".
 *
 * No socket is ever opened: `getJson` is injected. `schedule` is injected too in
 * every test but one, so the module-level rate limiter is exercised at least
 * once without letting a 60-request test file sleep on its window.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENDPOINTS, KNOWN, LIMITS, STRATEGY } from '../../src/config.js';
import { getBestPair, getBestPairs, getPairsForMint } from '../../src/data/dexscreener.js';

/** base58 alphabet, so generated test mints pass the address guard. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** 36 chars, all base58: `MintA...q`. */
const mintN = (i) => `Mint${B58[i]}${'q'.repeat(31)}`;

const MINT = mintN(0);
const OTHER_MINT = mintN(1);
const EXOTIC_QUOTE = mintN(2);
const NOW = 1_700_000_000_000;
/** Straight through the limiter seam: these tests assert call counts, not timing. */
const passthrough = (fn) => fn();

const rawPair = (over = {}) => ({
  chainId: 'solana',
  dexId: 'raydium',
  url: 'https://dexscreener.com/solana/pair1',
  pairAddress: 'pair-1',
  baseToken: { address: MINT, name: 'Alpha', symbol: 'ALPHA' },
  quoteToken: { address: KNOWN.WSOL, name: 'Wrapped SOL', symbol: 'SOL' },
  // Dexscreener sends numbers as STRINGS. That is the whole point of coerce.js.
  priceNative: '0.0000123',
  priceUsd: '0.0042',
  txns: {
    m5: { buys: 12, sells: 5 },
    h1: { buys: 100, sells: 60 },
    h6: { buys: 400, sells: 380 },
    h24: { buys: 1200, sells: 1150 },
  },
  volume: { m5: '3000.25', h1: '25000.5', h6: '90000', h24: '123456.78' },
  priceChange: { m5: '4.2', h1: '11.7', h6: '-3', h24: '80' },
  liquidity: { usd: '55000.5', base: '1000000', quote: '210' },
  fdv: '1200000',
  marketCap: '900000',
  pairCreatedAt: NOW - 120 * 60_000,
  ...over,
});

/** Fake getJson that always answers with the same payload. */
const fakeGet = (payload) => vi.fn(async () => payload);

const deps = (payload, over = {}) => ({
  getJson: fakeGet(payload),
  schedule: passthrough,
  now: () => NOW,
  ...over,
});

/** The shape httpJson.js throws on a non-2xx response. */
const httpStatusError = (status) =>
  Object.assign(new Error(`dexscreener: HTTP ${status} [GET url]`), {
    kind: 'status',
    status,
    label: 'dexscreener',
  });

describe('getPairsForMint', () => {
  it('GETs the batch endpoint and parses Dexscreener string numbers into numbers', async () => {
    const d = deps([rawPair()]);
    const pairs = await getPairsForMint(MINT, d);

    expect(d.getJson).toHaveBeenCalledTimes(1);
    const [url, opts] = d.getJson.mock.calls[0];
    expect(url).toBe(`${ENDPOINTS.dexscreener}/tokens/v1/solana/${MINT}`);
    expect(opts.label).toBe('dexscreener');

    expect(pairs).toHaveLength(1);
    const pair = pairs[0];
    expect(pair.mint).toBe(MINT);
    expect(pair.pairAddress).toBe('pair-1');
    expect(pair.dexId).toBe('raydium');
    expect(pair.chainId).toBe('solana');
    expect(pair.priceUsd).toBe(0.0042);
    expect(pair.priceNative).toBe(0.0000123);
    expect(pair.liquidityUsd).toBe(55000.5);
    expect(pair.fdv).toBe(1_200_000);
    expect(pair.marketCap).toBe(900_000);
    expect(pair.volumeUsd).toEqual({ m5: 3000.25, h1: 25000.5, h6: 90000, h24: 123456.78 });
    expect(pair.priceChangePct).toEqual({ m5: 4.2, h1: 11.7, h6: -3, h24: 80 });
    expect(pair.txns.m5).toEqual({ buys: 12, sells: 5 });
    expect(pair.baseToken).toEqual({ address: MINT, name: 'Alpha', symbol: 'ALPHA' });
    expect(pair.quoteToken.address).toBe(KNOWN.WSOL);
  });

  it('freezes the pair, its nested objects and the raw payload clone', async () => {
    const fixture = rawPair();
    const [pair] = await getPairsForMint(MINT, deps([fixture]));

    expect(Object.isFrozen(pair)).toBe(true);
    expect(Object.isFrozen(pair.baseToken)).toBe(true);
    expect(Object.isFrozen(pair.volumeUsd)).toBe(true);
    expect(Object.isFrozen(pair.txns.h1)).toBe(true);
    expect(Object.isFrozen(pair.raw)).toBe(true);
    expect(Object.isFrozen(pair.raw.liquidity)).toBe(true);
    // raw is a CLONE: the caller's fixture is never frozen or aliased.
    expect(pair.raw).not.toBe(fixture);
    expect(Object.isFrozen(fixture)).toBe(false);
  });

  it('reports a missing liquidity field as null, NEVER 0', async () => {
    const bare = rawPair();
    delete bare.liquidity;
    delete bare.volume;
    delete bare.priceChange;
    delete bare.txns;
    delete bare.priceUsd;

    const [pair] = await getPairsForMint(MINT, deps([bare]));

    expect(pair.liquidityUsd).toBeNull();
    expect(pair.liquidityUsd).not.toBe(0);
    expect(pair.priceUsd).toBeNull();
    expect(pair.volumeUsd).toEqual({ m5: null, h1: null, h6: null, h24: null });
    expect(pair.priceChangePct.h1).toBeNull();
    expect(pair.txns.m5).toEqual({ buys: null, sells: null });
  });

  it('treats an empty-string and a non-numeric liquidity as unknown, not zero', async () => {
    const [pair] = await getPairsForMint(
      MINT,
      deps([rawPair({ liquidity: { usd: '' }, fdv: 'n/a' })]),
    );
    expect(pair.liquidityUsd).toBeNull();
    expect(pair.fdv).toBeNull();
  });

  it('falls back to fdv for marketCap (a larger cap can only tighten layer 2)', async () => {
    const withoutCap = rawPair();
    delete withoutCap.marketCap;

    const [pair] = await getPairsForMint(MINT, deps([withoutCap]));
    expect(pair.marketCap).toBe(1_200_000);
    expect(pair.fdv).toBe(1_200_000);
  });

  it('leaves marketCap null when neither marketCap nor fdv is reported', async () => {
    const naked = rawPair();
    delete naked.marketCap;
    delete naked.fdv;

    const [pair] = await getPairsForMint(MINT, deps([naked]));
    expect(pair.marketCap).toBeNull();
    expect(pair.fdv).toBeNull();
  });

  it('derives pairCreatedAtMs and ageMinutes from the injected clock', async () => {
    const [pair] = await getPairsForMint(MINT, deps([rawPair()]));
    expect(pair.pairCreatedAtMs).toBe(NOW - 120 * 60_000);
    expect(pair.ageMinutes).toBe(120);
    expect(pair.fetchedAtMs).toBe(NOW);
  });

  it('leaves ageMinutes null when the creation time is unknown (never 0)', async () => {
    const undated = rawPair();
    delete undated.pairCreatedAt;

    const [pair] = await getPairsForMint(MINT, deps([undated]));
    expect(pair.pairCreatedAtMs).toBeNull();
    expect(pair.ageMinutes).toBeNull();
  });

  it('sorts deepest liquidity first and puts unknown depth last', async () => {
    const payload = [
      rawPair({ pairAddress: 'mid', liquidity: { usd: '5000' } }),
      rawPair({ pairAddress: 'unknown', liquidity: {} }),
      rawPair({ pairAddress: 'deep', liquidity: { usd: '90000' } }),
    ];
    const pairs = await getPairsForMint(MINT, deps(payload));
    expect(pairs.map((p) => p.pairAddress)).toEqual(['deep', 'mid', 'unknown']);
    expect(Object.isFrozen(pairs)).toBe(true);
  });

  it('accepts the { pairs: [...] } envelope from /latest/dex/tokens', async () => {
    const d = deps({ schemaVersion: '1.0.0', pairs: [rawPair()] }, { useLatestEndpoint: true });
    const pairs = await getPairsForMint(MINT, d);

    expect(d.getJson.mock.calls[0][0]).toBe(`${ENDPOINTS.dexscreener}/latest/dex/tokens/${MINT}`);
    expect(pairs).toHaveLength(1);
  });

  it('treats { pairs: null } as "no pools" -- a fact, not an error', async () => {
    const pairs = await getPairsForMint(MINT, deps({ schemaVersion: '1.0.0', pairs: null }));
    expect(pairs).toEqual([]);
  });

  it('treats an empty array as "no pools"', async () => {
    expect(await getPairsForMint(MINT, deps([]))).toEqual([]);
  });

  it('throws on an envelope it does not recognise', async () => {
    await expect(getPairsForMint(MINT, deps({ message: 'nope' }))).rejects.toThrow(
      /expected an array of pairs/,
    );
    await expect(getPairsForMint(MINT, deps('nope'))).rejects.toThrow(/expected an array of pairs/);
    await expect(getPairsForMint(MINT, deps(42))).rejects.toThrow(/expected an array of pairs/);
  });

  it('propagates an HTTP failure instead of returning an empty list', async () => {
    const getJson = vi.fn(async () => {
      throw httpStatusError(429);
    });
    await expect(
      getPairsForMint(MINT, { getJson, schedule: passthrough, now: () => NOW }),
    ).rejects.toMatchObject({ status: 429, kind: 'status' });
  });

  it('throws when a pair entry is not an object', async () => {
    await expect(getPairsForMint(MINT, deps(['not-a-pair']))).rejects.toThrow(
      /pairs\[0\] is not an object/,
    );
  });

  it('throws when a pair is missing its token addresses rather than dropping it', async () => {
    const broken = rawPair({ baseToken: { symbol: 'ALPHA' } });
    await expect(getPairsForMint(MINT, deps([broken]))).rejects.toThrow(
      /missing baseToken.address or quoteToken.address/,
    );
  });

  it('throws when a pair has no pairAddress', async () => {
    const broken = rawPair();
    delete broken.pairAddress;
    await expect(getPairsForMint(MINT, deps([broken]))).rejects.toThrow(/has no pairAddress/);
  });

  it('throws when the pair is on another chain (we asked for solana)', async () => {
    await expect(getPairsForMint(MINT, deps([rawPair({ chainId: 'base' })]))).rejects.toThrow(
      /reports chainId/,
    );
  });

  it('ignores a pair for a mint that was not requested', async () => {
    const foreign = rawPair({
      pairAddress: 'foreign',
      baseToken: { address: OTHER_MINT, symbol: 'BETA' },
    });
    const pairs = await getPairsForMint(MINT, deps([rawPair(), foreign]));
    expect(pairs.map((p) => p.pairAddress)).toEqual(['pair-1']);
  });

  it('attributes a pair where the requested mint is the QUOTE side', async () => {
    const quoted = rawPair({
      pairAddress: 'quoted',
      baseToken: { address: OTHER_MINT, symbol: 'BETA' },
      quoteToken: { address: MINT, symbol: 'ALPHA' },
    });
    const pairs = await getPairsForMint(MINT, deps([quoted]));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].mint).toBe(MINT);
  });

  it('rejects an invalid mint before opening anything', async () => {
    const getJson = vi.fn();
    for (const bad of ['', 'short', null, undefined, 42, {}, `${MINT}0`]) {
      await expect(getPairsForMint(bad, { getJson, schedule: passthrough })).rejects.toThrow(
        /must be a base58 address/,
      );
    }
    expect(getJson).not.toHaveBeenCalled();
  });

  it('rejects a broken clock seam instead of inventing a timestamp', async () => {
    await expect(
      getPairsForMint(MINT, deps([rawPair()], { now: () => Number.NaN })),
    ).rejects.toThrow(/expected epoch ms/);
  });

  it('rejects a non-function clock seam', async () => {
    await expect(getPairsForMint(MINT, deps([rawPair()], { now: 123 }))).rejects.toThrow(
      /deps.now must be a function/,
    );
  });

  it('falls back to the real clock when no clock seam is injected', async () => {
    const before = Date.now();
    const [pair] = await getPairsForMint(MINT, {
      getJson: fakeGet([rawPair()]),
      schedule: passthrough,
    });
    expect(pair.fetchedAtMs).toBeGreaterThanOrEqual(before);
  });

  it('works through the real module-level rate limiter when no schedule is injected', async () => {
    const pairs = await getPairsForMint(MINT, { getJson: fakeGet([rawPair()]), now: () => NOW });
    expect(pairs).toHaveLength(1);
  });
});

describe('getBestPair', () => {
  it('picks the deepest pair whose quote is in STRATEGY.universe.quoteMints', async () => {
    const payload = [
      rawPair({ pairAddress: 'sol-shallow', liquidity: { usd: '40000' } }),
      rawPair({
        pairAddress: 'exotic-deep',
        liquidity: { usd: '900000' },
        quoteToken: { address: EXOTIC_QUOTE, symbol: 'WAT' },
      }),
      rawPair({
        pairAddress: 'usdc-deeper',
        liquidity: { usd: '75000' },
        quoteToken: { address: KNOWN.USDC, symbol: 'USDC' },
      }),
    ];
    const best = await getBestPair(MINT, deps(payload));
    expect(best.pairAddress).toBe('usdc-deeper');
    expect(STRATEGY.universe.quoteMints).toContain(best.quoteToken.address);
  });

  it('returns null when every pair has an exotic quote token', async () => {
    const payload = [
      rawPair({ quoteToken: { address: EXOTIC_QUOTE, symbol: 'WAT' } }),
      rawPair({ pairAddress: 'p2', quoteToken: { address: mintN(3), symbol: 'HUH' } }),
    ];
    expect(await getBestPair(MINT, deps(payload))).toBeNull();
  });

  it('returns null when the mint has no pairs at all', async () => {
    expect(await getBestPair(MINT, deps([]))).toBeNull();
  });

  it('honours an injected quoteMints seam', async () => {
    const payload = [rawPair({ quoteToken: { address: EXOTIC_QUOTE, symbol: 'WAT' } })];
    const best = await getBestPair(MINT, deps(payload, { quoteMints: [EXOTIC_QUOTE] }));
    expect(best.quoteToken.address).toBe(EXOTIC_QUOTE);
  });
});

describe('getBestPairs', () => {
  /** Answers each batch with one WSOL-quoted pair per mint in the url. */
  const batchResponder = () =>
    vi.fn(async (url) => {
      const mints = url.split('/').pop().split(',');
      return mints.map((mint) =>
        rawPair({ pairAddress: `pair-${mint}`, baseToken: { address: mint, symbol: 'X' } }),
      );
    });

  let getJson;
  beforeEach(() => {
    getJson = batchResponder();
  });

  const mints = (count) => Array.from({ length: count }, (_, i) => mintN(i));

  it(`splits ${LIMITS.dexscreener.maxMintsPerCall + 1} mints into two calls at the batch limit`, async () => {
    const requested = mints(LIMITS.dexscreener.maxMintsPerCall + 1);
    const result = await getBestPairs(requested, { getJson, schedule: passthrough, now: () => NOW });

    expect(getJson).toHaveBeenCalledTimes(2);
    const chunks = getJson.mock.calls.map((c) => c[0].split('/').pop().split(','));
    expect(chunks[0]).toHaveLength(LIMITS.dexscreener.maxMintsPerCall);
    expect(chunks[1]).toHaveLength(1);
    expect([...chunks[0], ...chunks[1]]).toEqual(requested);
    expect(result.size).toBe(requested.length);
  });

  it('makes exactly one call at the batch limit (boundary)', async () => {
    const requested = mints(LIMITS.dexscreener.maxMintsPerCall);
    await getBestPairs(requested, { getJson, schedule: passthrough, now: () => NOW });
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it('returns EVERY requested mint as a key, with null where nothing came back', async () => {
    const requested = [MINT, OTHER_MINT, mintN(4)];
    const partial = vi.fn(async () => [
      rawPair({ pairAddress: 'only-one', baseToken: { address: MINT, symbol: 'X' } }),
    ]);

    const result = await getBestPairs(requested, {
      getJson: partial,
      schedule: passthrough,
      now: () => NOW,
    });

    expect([...result.keys()]).toEqual(requested);
    expect(result.get(MINT).pairAddress).toBe('only-one');
    expect(result.get(OTHER_MINT)).toBeNull();
    expect(result.get(mintN(4))).toBeNull();
    // "absent" must be a present key holding null, never a missing key.
    expect(result.has(OTHER_MINT)).toBe(true);
  });

  it('ignores a mint in the response that was never requested', async () => {
    const noisy = vi.fn(async () => [
      rawPair({ pairAddress: 'wanted', baseToken: { address: MINT, symbol: 'X' } }),
      rawPair({ pairAddress: 'unwanted', baseToken: { address: mintN(9), symbol: 'Z' } }),
    ]);

    const result = await getBestPairs([MINT], {
      getJson: noisy,
      schedule: passthrough,
      now: () => NOW,
    });

    expect([...result.keys()]).toEqual([MINT]);
    expect(result.get(MINT).pairAddress).toBe('wanted');
  });

  it('de-duplicates the requested list, preserving first-seen order', async () => {
    const result = await getBestPairs([MINT, OTHER_MINT, MINT], {
      getJson,
      schedule: passthrough,
      now: () => NOW,
    });
    expect([...result.keys()]).toEqual([MINT, OTHER_MINT]);
    expect(getJson.mock.calls[0][0].split('/').pop()).toBe(`${MINT},${OTHER_MINT}`);
  });

  it('returns an empty map and makes no request for an empty list', async () => {
    const result = await getBestPairs([], { getJson, schedule: passthrough });
    expect(result.size).toBe(0);
    expect(getJson).not.toHaveBeenCalled();
  });

  it('throws when the argument is not an array', async () => {
    for (const bad of [null, undefined, MINT, {}, 7]) {
      await expect(getBestPairs(bad, { getJson, schedule: passthrough })).rejects.toThrow(
        /requires an array/,
      );
    }
    expect(getJson).not.toHaveBeenCalled();
  });

  it('throws, naming the index, when the list holds something that is not a mint', async () => {
    await expect(
      getBestPairs([MINT, 'nope'], { getJson, schedule: passthrough }),
    ).rejects.toThrow(/getBestPairs\(mints\)\[1\] must be a base58 address/);
    expect(getJson).not.toHaveBeenCalled();
  });

  it('propagates a failed batch instead of returning a half-filled map', async () => {
    const failing = vi.fn(async () => {
      throw httpStatusError(500);
    });
    await expect(
      getBestPairs([MINT], { getJson: failing, schedule: passthrough, now: () => NOW }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('returns a frozen map whose pairs are frozen', async () => {
    const result = await getBestPairs([MINT], { getJson, schedule: passthrough, now: () => NOW });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.get(MINT))).toBe(true);
  });

  it('picks the deepest allowed-quote pair per mint inside a batch', async () => {
    const payload = [
      rawPair({ pairAddress: 'a-shallow', liquidity: { usd: '10' } }),
      rawPair({ pairAddress: 'a-deep', liquidity: { usd: '10000' } }),
      rawPair({
        pairAddress: 'b-only',
        baseToken: { address: OTHER_MINT, symbol: 'B' },
        liquidity: { usd: '20' },
      }),
    ];
    const result = await getBestPairs([MINT, OTHER_MINT], {
      getJson: fakeGet(payload),
      schedule: passthrough,
      now: () => NOW,
    });
    expect(result.get(MINT).pairAddress).toBe('a-deep');
    expect(result.get(OTHER_MINT).pairAddress).toBe('b-only');
  });
});
