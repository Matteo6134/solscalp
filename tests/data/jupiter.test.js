import { describe, expect, it, vi } from 'vitest';
import { ENDPOINTS, KNOWN, SAFETY } from '../../src/config.js';
import { NO_ROUTE, getQuote, getRoundTrip, isNoRouteError } from '../../src/data/jupiter.js';

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SLIPPAGE = SAFETY.layer1.quoteSlippageBps;

/** Minimal stand-in for undici request(). */
const fakeHttp = (statusCode, payload) =>
  vi.fn(async () => ({
    statusCode,
    body: { text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) },
  }));

const quoteBody = (over = {}) =>
  Object.freeze({
    inputMint: KNOWN.WSOL,
    outputMint: MINT,
    inAmount: '50000000',
    outAmount: '987654321',
    otherAmountThreshold: '957024291',
    swapMode: 'ExactIn',
    slippageBps: SLIPPAGE,
    priceImpactPct: '0.0042',
    routePlan: [{ swapInfo: { label: 'Raydium', ammKey: 'amm1' }, percent: 100 }],
    ...over,
  });

describe('getQuote', () => {
  it('calls GET /quote with the configured endpoint and params, and normalises the body', async () => {
    const httpRequest = fakeHttp(200, quoteBody());

    const q = await getQuote(
      { inputMint: KNOWN.WSOL, outputMint: MINT, amount: '50000000', slippageBps: SLIPPAGE },
      { httpRequest },
    );

    const [url, options] = httpRequest.mock.calls[0];
    expect(url.startsWith(`${ENDPOINTS.jupiterQuote}/quote?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('inputMint')).toBe(KNOWN.WSOL);
    expect(params.get('outputMint')).toBe(MINT);
    expect(params.get('amount')).toBe('50000000');
    expect(params.get('slippageBps')).toBe(String(SLIPPAGE));
    expect(options.method).toBe('GET');

    expect(q.inAmount).toBe('50000000');
    expect(q.outAmount).toBe('987654321');
    expect(q.otherAmountThreshold).toBe('957024291');
    expect(q.priceImpactPct).toBeCloseTo(0.0042, 10);
    expect(q.routePlan).toHaveLength(1);
    expect(q.raw.swapMode).toBe('ExactIn');
    expect(Object.isFrozen(q)).toBe(true);
    expect(Object.isFrozen(q.raw)).toBe(true);
    expect(Object.isFrozen(q.routePlan)).toBe(true);
  });

  it('throws a NO_ROUTE error when jupiter reports no route', async () => {
    const httpRequest = fakeHttp(400, {
      error: 'Could not find any route',
      errorCode: 'COULD_NOT_FIND_ANY_ROUTE',
    });

    const err = await getQuote(
      { inputMint: MINT, outputMint: KNOWN.WSOL, amount: '1000', slippageBps: SLIPPAGE },
      { httpRequest },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(NO_ROUTE);
    expect(isNoRouteError(err)).toBe(true);
    expect(err.message).toMatch(/no route/i);
  });

  it('treats an empty routePlan as no route', async () => {
    const httpRequest = fakeHttp(200, quoteBody({ routePlan: [] }));

    const err = await getQuote(
      { inputMint: MINT, outputMint: KNOWN.WSOL, amount: '1000', slippageBps: SLIPPAGE },
      { httpRequest },
    ).catch((e) => e);

    expect(isNoRouteError(err)).toBe(true);
  });

  it('throws a non-NO_ROUTE error on HTTP failure, unparseable JSON or a bad shape', async () => {
    const args = {
      inputMint: KNOWN.WSOL,
      outputMint: MINT,
      amount: '50000000',
      slippageBps: SLIPPAGE,
    };

    const http500 = await getQuote(args, { httpRequest: fakeHttp(500, '<html>oops</html>') }).catch(
      (e) => e,
    );
    expect(http500).toBeInstanceOf(Error);
    expect(isNoRouteError(http500)).toBe(false);

    const garbage = await getQuote(args, { httpRequest: fakeHttp(200, 'not json') }).catch((e) => e);
    expect(garbage.message).toMatch(/unparseable/i);

    const badAmount = await getQuote(args, {
      httpRequest: fakeHttp(200, quoteBody({ outAmount: 987654321 })),
    }).catch((e) => e);
    expect(badAmount.message).toMatch(/outAmount/);

    const badImpact = await getQuote(args, {
      httpRequest: fakeHttp(200, quoteBody({ priceImpactPct: undefined })),
    }).catch((e) => e);
    expect(badImpact.message).toMatch(/priceImpactPct/);

    const wrongMint = await getQuote(args, {
      httpRequest: fakeHttp(200, quoteBody({ outputMint: KNOWN.USDC })),
    }).catch((e) => e);
    expect(wrongMint.message).toMatch(/mismatch/);

    const transportError = await getQuote(args, {
      httpRequest: async () => {
        throw new Error('socket hang up');
      },
    }).catch((e) => e);
    expect(transportError.message).toMatch(/socket hang up/);
  });

  it('rejects invalid arguments before touching the network', async () => {
    const httpRequest = fakeHttp(200, quoteBody());
    const base = { inputMint: KNOWN.WSOL, outputMint: MINT, slippageBps: SLIPPAGE };

    await expect(getQuote({ ...base, amount: '0' }, { httpRequest })).rejects.toThrow(/> 0/);
    await expect(getQuote({ ...base, amount: 1.5 }, { httpRequest })).rejects.toThrow(/integer/);
    await expect(getQuote({ ...base, amount: '12.5' }, { httpRequest })).rejects.toThrow(/integer/);
    await expect(
      getQuote({ ...base, amount: '1000', slippageBps: -1 }, { httpRequest }),
    ).rejects.toThrow(/slippageBps/);
    await expect(
      getQuote({ inputMint: MINT, outputMint: MINT, amount: '1000', slippageBps: 1 }, { httpRequest }),
    ).rejects.toThrow(/identical/);
    expect(httpRequest).not.toHaveBeenCalled();
  });
});

describe('getRoundTrip', () => {
  const buy = Object.freeze({
    inputMint: KNOWN.WSOL,
    outputMint: MINT,
    inAmount: '50000000',
    outAmount: '1000000000',
    otherAmountThreshold: '970000000',
    priceImpactPct: 0.4,
    routePlan: Object.freeze([{}]),
    raw: Object.freeze({}),
  });
  const sell = (outAmount) =>
    Object.freeze({ ...buy, inputMint: MINT, outputMint: KNOWN.WSOL, outAmount, priceImpactPct: 0.5 });

  it('sells the ENTIRE proceeds of the buy leg and computes the round-trip loss', async () => {
    const quote = vi.fn(async ({ inputMint }) =>
      inputMint === KNOWN.WSOL ? buy : sell('49000000'),
    );

    const rt = await getRoundTrip(
      { mint: MINT, probeLamports: 50_000_000, slippageBps: SLIPPAGE },
      { quote },
    );

    expect(quote).toHaveBeenCalledTimes(2);
    expect(quote.mock.calls[0][0]).toEqual({
      inputMint: KNOWN.WSOL,
      outputMint: MINT,
      amount: '50000000',
      slippageBps: SLIPPAGE,
    });
    expect(quote.mock.calls[1][0]).toEqual({
      inputMint: MINT,
      outputMint: KNOWN.WSOL,
      amount: buy.outAmount,
      slippageBps: SLIPPAGE,
    });
    expect(rt.sellRouteExists).toBe(true);
    expect(rt.returnedLamports).toBe(49_000_000);
    expect(rt.roundTripLossPct).toBeCloseTo(2, 10);
    expect(Object.isFrozen(rt)).toBe(true);
  });

  it('reports a missing sell route as a finding, not an exception', async () => {
    const quote = vi.fn(async ({ inputMint }) => {
      if (inputMint === KNOWN.WSOL) return buy;
      throw Object.assign(new Error('jupiter has no route'), { code: NO_ROUTE });
    });

    const rt = await getRoundTrip(
      { mint: MINT, probeLamports: 50_000_000, slippageBps: SLIPPAGE },
      { quote },
    );

    expect(rt.sellRouteExists).toBe(false);
    expect(rt.sellQuote).toBeNull();
    expect(rt.returnedLamports).toBe(0);
    expect(rt.roundTripLossPct).toBe(100);
  });

  it('propagates a non-route failure on either leg (fail closed)', async () => {
    const buyFailed = vi.fn(async () => {
      throw new Error('jupiter quote HTTP 503');
    });
    await expect(
      getRoundTrip({ mint: MINT, probeLamports: 50_000_000, slippageBps: SLIPPAGE }, {
        quote: buyFailed,
      }),
    ).rejects.toThrow(/503/);

    const sellFailed = vi.fn(async ({ inputMint }) => {
      if (inputMint === KNOWN.WSOL) return buy;
      throw new Error('jupiter quote returned unparseable JSON');
    });
    await expect(
      getRoundTrip({ mint: MINT, probeLamports: 50_000_000, slippageBps: SLIPPAGE }, {
        quote: sellFailed,
      }),
    ).rejects.toThrow(/unparseable/);
  });

  it('refuses a WSOL self round trip and a non-positive probe', async () => {
    const quote = vi.fn(async () => buy);

    await expect(
      getRoundTrip({ mint: KNOWN.WSOL, probeLamports: 50_000_000, slippageBps: SLIPPAGE }, { quote }),
    ).rejects.toThrow(/WSOL/);
    await expect(
      getRoundTrip({ mint: MINT, probeLamports: 0, slippageBps: SLIPPAGE }, { quote }),
    ).rejects.toThrow(/probeLamports/);
    expect(quote).not.toHaveBeenCalled();
  });
});
