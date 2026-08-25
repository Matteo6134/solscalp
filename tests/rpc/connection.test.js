import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../src/config.js';
import { RPC_ERROR, rpcError } from '../../src/rpc/rpc-errors.js';
import { createRpcClient } from '../../src/rpc/connection.js';

const MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const HOLDER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIGNATURE =
  '5h4mFsBpZHKmfBRJ4M1sVpmBBWMMDMwvUsRRcQ5wRxpEQEEgtQ4NBv4YSgpzmwJmoLZbjKMzX6dQ4dCTQzKzUf4y';

const SECRET = 'SUPER_SECRET_KEY';
const PRIMARY = `https://mainnet.helius-rpc.com/?api-key=${SECRET}`;
const PRIMARY_REDACTED = 'https://mainnet.helius-rpc.com/<redacted>';
const FALLBACK = 'https://api.mainnet-beta.solana.com';

/** Requests per minute the client must derive from LIMITS.rpc.requestsPerSecond. */
const RPC_PER_MINUTE = LIMITS.rpc.requestsPerSecond * 60;

/**
 * Virtual clock: sleep() advances time instead of arming a real timer, so every
 * backoff and rate-limit wait in this file is instantaneous AND deterministic.
 */
function fakeClock() {
  let t = 0;
  /** @type {number[]} */
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    at: () => t,
  };
}

/** A connectionFactory over a url -> connection map, recording every call. */
function factoryFor(map) {
  return vi.fn((endpoint) => {
    if (!(endpoint in map)) throw new Error(`test factory: unexpected endpoint ${endpoint}`);
    return map[endpoint];
  });
}

/** Client wired to a single fake connection on the primary endpoint. */
function clientWith(connection, over = {}) {
  const clock = over.clock ?? fakeClock();
  const factory = factoryFor({ [PRIMARY]: connection });
  const client = createRpcClient({
    url: PRIMARY,
    clock,
    connectionFactory: factory,
    ...over,
  });
  return { client, clock, factory };
}

const transient = () => new Error('503 Service Unavailable');
const nonRetryable = () =>
  Object.assign(new Error('Invalid param: unrecognized Token program id'), { code: -32602 });

const accountInfo = (over = {}) => ({
  data: new Uint8Array([1, 2, 3]),
  owner: TOKEN_PROGRAM,
  lamports: 1_461_600,
  executable: false,
  rentEpoch: 361,
  ...over,
});

const supplyEnvelope = (over = {}) => ({
  context: { slot: 1 },
  value: { amount: '1000000000', decimals: 9, uiAmount: 1, uiAmountString: '1', ...over },
});

const err = (p) => p.then((v) => ({ notThrown: v }), (e) => e);

beforeEach(() => {
  // The developer's real environment must never decide a test's outcome.
  vi.stubEnv('SOLANA_RPC_URL', '');
  vi.stubEnv('SOLANA_RPC_URL_FALLBACK', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createRpcClient construction', () => {
  it('exposes a frozen client whose endpoint is redacted', () => {
    const { client } = clientWith({});
    expect(client.endpoint).toBe(PRIMARY_REDACTED);
    expect(client.endpoint).not.toContain(SECRET);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.stats())).toBe(true);
    expect(() => {
      client.call = null;
    }).toThrow();
  });

  it('reads SOLANA_RPC_URL / SOLANA_RPC_URL_FALLBACK when no url is passed', () => {
    vi.stubEnv('SOLANA_RPC_URL', PRIMARY);
    vi.stubEnv('SOLANA_RPC_URL_FALLBACK', FALLBACK);
    const client = createRpcClient({ connectionFactory: () => ({}), clock: fakeClock() });
    expect(client.endpoint).toBe(PRIMARY_REDACTED);
    expect(client.stats().fallbackEndpoint).toBe(FALLBACK);
  });

  it('refuses to guess an endpoint when none is configured', () => {
    expect(() => createRpcClient({ connectionFactory: () => ({}) })).toThrow(/url is required/);
    expect(() => createRpcClient()).toThrow(/url is required/);
  });

  it('rejects a url that is not http(s), never echoing the raw value', () => {
    expect(() => createRpcClient({ url: 'not a url' })).toThrow(/not a parseable URL/);
    expect(() => createRpcClient({ url: `ftp://evil/${SECRET}` })).toThrow(/must be http\(s\)/);
    const thrown = (() => {
      try {
        createRpcClient({ url: `wss://node.example/${SECRET}` });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(thrown.message).not.toContain(SECRET);
  });

  it('rejects a bad maxAttempts, clock or connectionFactory', () => {
    const base = { url: PRIMARY, connectionFactory: () => ({}) };
    expect(() => createRpcClient({ ...base, maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => createRpcClient({ ...base, maxAttempts: 2.5 })).toThrow(/maxAttempts/);
    expect(() => createRpcClient({ ...base, maxAttempts: '3' })).toThrow(/maxAttempts/);
    expect(() => createRpcClient({ ...base, clock: { now: () => 0 } })).toThrow(/clock/);
    expect(() => createRpcClient({ url: PRIMARY, connectionFactory: {} })).toThrow(
      /connectionFactory/,
    );
  });

  it('treats a fallback identical to the primary as no fallback at all', () => {
    const client = createRpcClient({
      url: PRIMARY,
      fallbackUrl: PRIMARY,
      connectionFactory: () => ({}),
      clock: fakeClock(),
    });
    expect(client.stats().fallbackEndpoint).toBe(null);
  });

  it('derives the rate limit from LIMITS.rpc.requestsPerSecond', () => {
    const { client } = clientWith({});
    expect(client.stats().rateLimit.requestsPerMinute).toBe(RPC_PER_MINUTE);
  });
});

describe('call() retry policy', () => {
  it('retries a transient error with deterministic 2**attempt * 250ms backoff, then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue('ok');
    const { client, clock } = clientWith({});

    await expect(client.call('probe', fn)).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([250, 500]);
    const s = client.stats();
    expect(s.retries).toBe(2);
    expect(s.succeeded).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.byMethod).toEqual({ probe: 1 });
  });

  it('does NOT retry a non-transient error, and does not touch the fallback', async () => {
    const fn = vi.fn().mockRejectedValue(nonRetryable());
    const factory = factoryFor({ [PRIMARY]: {}, [FALLBACK]: {} });
    const clock = fakeClock();
    const client = createRpcClient({
      url: PRIMARY,
      fallbackUrl: FALLBACK,
      clock,
      connectionFactory: factory,
    });

    const thrown = await err(client.call('probe', fn));

    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
    expect(thrown.code).toBe(RPC_ERROR.TRANSPORT);
    expect(thrown.message).toMatch(/not retryable/);
    expect(thrown.retryable).toBe(false);
    expect(thrown.cause.code).toBe(-32602);
    expect(factory.mock.calls.map(([u]) => u)).toEqual([PRIMARY]);
    expect(client.stats().fallbackAttempts).toBe(0);
  });

  it('after maxAttempts on the primary, tries the fallback once and then throws EXHAUSTED', async () => {
    const primaryFn = vi.fn().mockRejectedValue(transient());
    const factory = factoryFor({ [PRIMARY]: { tag: 'primary' }, [FALLBACK]: { tag: 'fallback' } });
    const clock = fakeClock();
    const client = createRpcClient({
      url: PRIMARY,
      fallbackUrl: FALLBACK,
      maxAttempts: 2,
      clock,
      connectionFactory: factory,
    });

    const thrown = await err(client.call('probe', primaryFn));

    expect(primaryFn).toHaveBeenCalledTimes(3); // 2 primary attempts + 1 fallback
    expect(primaryFn.mock.calls.map(([c]) => c.tag)).toEqual(['primary', 'primary', 'fallback']);
    expect(clock.sleeps).toEqual([250]); // only between primary attempts
    expect(thrown.code).toBe(RPC_ERROR.EXHAUSTED);
    expect(thrown.attempts).toBe(3);
    expect(thrown.cause).toBeInstanceOf(Error);
    expect(thrown.message).toContain(PRIMARY_REDACTED);
    expect(thrown.message).toContain(FALLBACK);
    const s = client.stats();
    expect(s.exhausted).toBe(1);
    expect(s.fallbackAttempts).toBe(1);
    expect(s.failed).toBe(1);
  });

  it('returns the fallback result when the primary is exhausted but the fallback answers', async () => {
    const fn = vi.fn(async (connection) => {
      if (connection.tag === 'primary') throw transient();
      return 'from-fallback';
    });
    const client = createRpcClient({
      url: PRIMARY,
      fallbackUrl: FALLBACK,
      maxAttempts: 2,
      clock: fakeClock(),
      connectionFactory: factoryFor({
        [PRIMARY]: { tag: 'primary' },
        [FALLBACK]: { tag: 'fallback' },
      }),
    });

    await expect(client.call('probe', fn)).resolves.toBe('from-fallback');
    expect(client.stats().fallbackAttempts).toBe(1);
    expect(client.stats().exhausted).toBe(0);
  });

  it('with maxAttempts 1 and no distinct fallback, fails after exactly one attempt', async () => {
    const fn = vi.fn().mockRejectedValue(transient());
    const { client, clock } = clientWith({}, { maxAttempts: 1 });

    const thrown = await err(client.call('probe', fn));

    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
    expect(thrown.code).toBe(RPC_ERROR.EXHAUSTED);
    expect(thrown.attempts).toBe(1);
    expect(thrown.message).toMatch(/no distinct fallback configured/);
  });

  it('rejects usage errors without consuming an attempt', async () => {
    const { client } = clientWith({});
    await expect(client.call('', async () => 1)).rejects.toThrow(/non-empty string/);
    await expect(client.call('probe', 'nope')).rejects.toThrow(/must be a function/);
    expect(client.stats().calls).toBe(0);
  });

  it('rethrows an already-classified rpcError from the callback untouched', async () => {
    const own = rpcError('this account is not a mint', { code: RPC_ERROR.NOT_A_MINT });
    const fn = vi.fn().mockRejectedValue(own);
    const { client, clock } = clientWith({});

    const thrown = await err(client.call('unpackMint', fn));

    expect(thrown).toBe(own);
    expect(thrown.code).toBe(RPC_ERROR.NOT_A_MINT);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('counts every method it was asked for, for logging only', async () => {
    const { client } = clientWith({
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getTokenSupply: vi.fn().mockResolvedValue(supplyEnvelope()),
    });

    await client.getAccountInfo(MINT);
    await client.getAccountInfo(MINT);
    await client.getTokenSupply(MINT);

    expect(client.stats().byMethod).toEqual({ getAccountInfo: 2, getTokenSupply: 1 });
    expect(client.stats().succeeded).toBe(3);
  });

  it('surfaces a connectionFactory that returns a non-object, redacted', async () => {
    const client = createRpcClient({
      url: PRIMARY,
      clock: fakeClock(),
      connectionFactory: () => null,
    });

    const thrown = await err(client.call('probe', async () => 'never'));

    expect(thrown.code).toBe(RPC_ERROR.TRANSPORT);
    expect(thrown.message).toContain(PRIMARY_REDACTED);
    expect(thrown.message).not.toContain(SECRET);
  });

  it('does not cache a failed connection construction', async () => {
    let attempt = 0;
    const factory = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw transient();
      return {};
    });
    const client = createRpcClient({ url: PRIMARY, clock: fakeClock(), connectionFactory: factory });

    await expect(client.call('probe', async () => 'ok')).resolves.toBe('ok');
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('credential redaction', () => {
  it('never leaks the api key through an exhausted-attempts message', async () => {
    const leaky = () => new Error(`503 Service Unavailable while calling ${PRIMARY}`);
    const { client } = clientWith({}, { maxAttempts: 2 });

    const thrown = await err(client.call('getSlot', vi.fn().mockRejectedValue(leaky())));

    expect(thrown.code).toBe(RPC_ERROR.EXHAUSTED);
    expect(thrown.message).not.toContain(SECRET);
    expect(thrown.message).not.toContain('api-key');
    expect(thrown.message).toContain(PRIMARY_REDACTED);
    expect(client.stats().lastError).not.toContain(SECRET);
    expect(client.stats().endpoint).not.toContain(SECRET);
  });

  it('never leaks the api key through a non-retryable message', async () => {
    const leaky = Object.assign(new Error(`Invalid param at ${PRIMARY}`), { code: -32602 });
    const { client } = clientWith({});

    const thrown = await err(client.call('getSlot', vi.fn().mockRejectedValue(leaky)));

    expect(thrown.code).toBe(RPC_ERROR.TRANSPORT);
    expect(thrown.message).not.toContain(SECRET);
    expect(thrown.message).toContain(PRIMARY_REDACTED);
  });

  it('never leaks the api key nested inside a cause chain', async () => {
    const inner = new Error(`fetch failed for ${PRIMARY}`);
    const outer = new Error('socket hang up', { cause: inner });
    const { client } = clientWith({}, { maxAttempts: 1 });

    const thrown = await err(client.call('getSlot', vi.fn().mockRejectedValue(outer)));

    expect(thrown.message).not.toContain(SECRET);
    expect(thrown.cause).toBe(outer); // the raw cause is preserved for debugging
  });
});

describe('rate limiting', () => {
  it('caps request starts at LIMITS.rpc.requestsPerSecond * 60 per window', async () => {
    const { client, clock } = clientWith({});
    const fn = async () => 'ok';

    await Promise.all(Array.from({ length: RPC_PER_MINUTE }, () => client.call('probe', fn)));

    expect(clock.sleeps).toEqual([]); // a full window's worth fits without waiting
    expect(client.stats().rateLimit.usedInWindow).toBe(RPC_PER_MINUTE);
    expect(clock.at()).toBe(0);

    await client.call('probe', fn);

    // The extra start had to wait for the oldest slot to leave the window.
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThan(60_000);
    expect(clock.at()).toBeGreaterThan(60_000);
    expect(client.stats().calls).toBe(RPC_PER_MINUTE + 1);
  });

  it('makes retries pay the rate limit too', async () => {
    const { client } = clientWith({});
    const fn = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue('ok');

    await client.call('probe', fn);

    expect(client.stats().rateLimit.usedInWindow).toBe(2);
  });
});

describe('getAccountInfo', () => {
  it('returns null when the account does not exist -- a value, not an error', async () => {
    const getAccountInfoFn = vi.fn().mockResolvedValue(null);
    const { client } = clientWith({ getAccountInfo: getAccountInfoFn });

    await expect(client.getAccountInfo(MINT)).resolves.toBe(null);
    expect(getAccountInfoFn).toHaveBeenCalledTimes(1);
  });

  it('passes a PublicKey and returns a frozen copy of the account', async () => {
    const raw = accountInfo();
    const getAccountInfoFn = vi.fn().mockResolvedValue(raw);
    const { client } = clientWith({ getAccountInfo: getAccountInfoFn });

    const info = await client.getAccountInfo(MINT);

    const [key] = getAccountInfoFn.mock.calls[0];
    expect(typeof key.toBase58).toBe('function');
    expect(key.toBase58()).toBe(MINT);
    expect(info).not.toBe(raw);
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false); // the library's object is untouched
    expect(info.owner).toBe(TOKEN_PROGRAM);
    expect(info.lamports).toBe(1_461_600);
    expect(info.data).toBe(raw.data);
  });

  it('rejects an invalid address before opening anything', async () => {
    const getAccountInfoFn = vi.fn();
    const { client, factory } = clientWith({ getAccountInfo: getAccountInfoFn });

    for (const bad of ['', 'not-base58-0OIl', 'abc', null, 42, MINT + MINT]) {
      const thrown = await err(client.getAccountInfo(bad));
      expect(thrown.code).toBe(RPC_ERROR.INVALID_ADDRESS);
    }
    expect(getAccountInfoFn).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(client.stats().calls).toBe(0);
  });

  it('throws UNPARSEABLE on a half-read account rather than returning holes', async () => {
    const cases = [
      accountInfo({ data: undefined }),
      accountInfo({ data: 'AQID' }),
      accountInfo({ lamports: null }),
      accountInfo({ owner: undefined }),
      undefined,
      'nope',
      [],
    ];
    for (const value of cases) {
      const { client } = clientWith({ getAccountInfo: vi.fn().mockResolvedValue(value) });
      const thrown = await err(client.getAccountInfo(MINT));
      expect(thrown.code).toBe(RPC_ERROR.UNPARSEABLE);
    }
  });
});

describe('getTokenSupply', () => {
  it('validates the envelope and returns a frozen supply', async () => {
    const { client } = clientWith({
      getTokenSupply: vi.fn().mockResolvedValue(supplyEnvelope()),
    });

    const supply = await client.getTokenSupply(MINT);

    expect(supply).toEqual({ amount: '1000000000', decimals: 9, uiAmount: 1 });
    expect(Object.isFrozen(supply)).toBe(true);
  });

  it('accepts uiAmount === null (unknown), and decimals exactly at the u8 boundary', async () => {
    const { client } = clientWith({
      getTokenSupply: vi.fn().mockResolvedValue(supplyEnvelope({ uiAmount: null, decimals: 255 })),
    });

    const supply = await client.getTokenSupply(MINT);
    expect(supply.uiAmount).toBe(null);
    expect(supply.decimals).toBe(255);
  });

  it('throws UNPARSEABLE instead of half-reading the envelope', async () => {
    const cases = [
      { context: { slot: 1 } }, // no value field
      { context: { slot: 1 }, value: null },
      { value: { amount: 1000, decimals: 9, uiAmount: 1 } }, // amount not a string
      { value: { amount: '10', decimals: 9.5, uiAmount: 1 } },
      { value: { amount: '10', decimals: 256, uiAmount: 1 } },
      { value: { amount: '10', decimals: -1, uiAmount: 1 } },
      { value: { amount: '10', decimals: 9 } }, // uiAmount absent, not null
      { value: { amount: '10', decimals: 9, uiAmount: 'a lot' } },
      { value: { amount: '10', decimals: 9, uiAmount: Number.NaN } },
      { amount: '10', decimals: 9, uiAmount: 1 }, // value returned unwrapped
      null,
      [],
    ];
    for (const value of cases) {
      const { client } = clientWith({ getTokenSupply: vi.fn().mockResolvedValue(value) });
      const thrown = await err(client.getTokenSupply(MINT));
      expect(thrown.code).toBe(RPC_ERROR.UNPARSEABLE);
      expect(thrown.message).toContain(MINT);
    }
  });

  it('still retries a transient failure before validating', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValue(supplyEnvelope());
    const { client, clock } = clientWith({ getTokenSupply: fn });

    await expect(client.getTokenSupply(MINT)).resolves.toMatchObject({ decimals: 9 });
    expect(clock.sleeps).toEqual([250]);
  });
});

describe('getTokenLargestAccounts', () => {
  it('normalises PublicKey addresses and freezes the list and its entries', async () => {
    const envelope = {
      context: { slot: 1 },
      value: [
        { address: { toBase58: () => HOLDER }, amount: '900', decimals: 6, uiAmount: 0.0009 },
        { address: MINT, amount: '100', decimals: 6, uiAmount: null },
      ],
    };
    const { client } = clientWith({
      getTokenLargestAccounts: vi.fn().mockResolvedValue(envelope),
    });

    const holders = await client.getTokenLargestAccounts(MINT);

    expect(holders).toHaveLength(2);
    expect(holders[0]).toEqual({ address: HOLDER, amount: '900', decimals: 6, uiAmount: 0.0009 });
    expect(holders[1].uiAmount).toBe(null);
    expect(Object.isFrozen(holders)).toBe(true);
    expect(Object.isFrozen(holders[0])).toBe(true);
  });

  it('treats an empty list as a fact, not a failure', async () => {
    const { client } = clientWith({
      getTokenLargestAccounts: vi.fn().mockResolvedValue({ context: {}, value: [] }),
    });
    await expect(client.getTokenLargestAccounts(MINT)).resolves.toEqual([]);
  });

  it('throws UNPARSEABLE naming the bad entry', async () => {
    const { client } = clientWith({
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          { address: HOLDER, amount: '900', decimals: 6, uiAmount: 1 },
          { address: HOLDER, amount: 900, decimals: 6, uiAmount: 1 },
        ],
      }),
    });

    const thrown = await err(client.getTokenLargestAccounts(MINT));

    expect(thrown.code).toBe(RPC_ERROR.UNPARSEABLE);
    expect(thrown.message).toContain('value[1]');
  });

  it('throws UNPARSEABLE when value is not an array or an address is junk', async () => {
    const cases = [
      { value: {} },
      { value: 'nope' },
      { value: [null] },
      { value: [{ address: 'not base58 0OIl', amount: '1', decimals: 0, uiAmount: 1 }] },
      { value: [{ amount: '1', decimals: 0, uiAmount: 1 }] },
    ];
    for (const value of cases) {
      const { client } = clientWith({
        getTokenLargestAccounts: vi.fn().mockResolvedValue(value),
      });
      const thrown = await err(client.getTokenLargestAccounts(MINT));
      expect(thrown.code).toBe(RPC_ERROR.UNPARSEABLE);
    }
  });
});

describe('getSignaturesForAddress', () => {
  it('passes a copy of opts through and freezes every entry', async () => {
    const fn = vi.fn().mockResolvedValue([{ signature: SIGNATURE, blockTime: 1 }]);
    const { client } = clientWith({ getSignaturesForAddress: fn });
    const opts = { limit: 5 };

    const list = await client.getSignaturesForAddress(MINT, opts);

    const [, received] = fn.mock.calls[0];
    expect(received).not.toBe(opts);
    expect(received).toEqual({ limit: 5 });
    expect(Object.isFrozen(opts)).toBe(false); // the caller's object is untouched
    expect(list).toHaveLength(1);
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
  });

  it('omits the options argument entirely when none was given', async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const { client } = clientWith({ getSignaturesForAddress: fn });

    await expect(client.getSignaturesForAddress(MINT)).resolves.toEqual([]);
    expect(fn.mock.calls[0]).toHaveLength(1);
  });

  it('rejects non-object opts and unparseable answers', async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const { client } = clientWith({ getSignaturesForAddress: fn });
    await expect(client.getSignaturesForAddress(MINT, 5)).rejects.toThrow(/opts must be an object/);
    await expect(client.getSignaturesForAddress(MINT, null)).rejects.toThrow(/opts/);

    for (const value of [null, undefined, { signatures: [] }, ['sig']]) {
      const { client: c } = clientWith({
        getSignaturesForAddress: vi.fn().mockResolvedValue(value),
      });
      const thrown = await err(c.getSignaturesForAddress(MINT));
      expect(thrown.code).toBe(RPC_ERROR.UNPARSEABLE);
    }
  });
});

describe('getParsedTransaction', () => {
  it('returns null for an unknown signature and asks for versioned transactions', async () => {
    const fn = vi.fn().mockResolvedValue(null);
    const { client } = clientWith({ getParsedTransaction: fn });

    await expect(client.getParsedTransaction(SIGNATURE)).resolves.toBe(null);
    const [sig, options] = fn.mock.calls[0];
    expect(sig).toBe(SIGNATURE);
    expect(options.maxSupportedTransactionVersion).toBe(0);
  });

  it('freezes the transaction it returns', async () => {
    const raw = { slot: 7, meta: { err: null }, transaction: {} };
    const { client } = clientWith({ getParsedTransaction: vi.fn().mockResolvedValue(raw) });

    const tx = await client.getParsedTransaction(SIGNATURE);

    expect(tx).not.toBe(raw);
    expect(Object.isFrozen(tx)).toBe(true);
    expect(tx.slot).toBe(7);
  });

  it('rejects a non-base58 signature and an unparseable answer', async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const { client } = clientWith({ getParsedTransaction: fn });

    for (const bad of ['', 'not base58!', null, 7]) {
      const thrown = await err(client.getParsedTransaction(bad));
      expect(thrown.code).toBe(RPC_ERROR.INVALID_ADDRESS);
    }
    expect(fn).not.toHaveBeenCalled();

    const thrown = await err(client.getParsedTransaction(SIGNATURE));
    expect(thrown.code).toBe(RPC_ERROR.UNPARSEABLE);

    const { client: undef } = clientWith({
      getParsedTransaction: vi.fn().mockResolvedValue(undefined),
    });
    expect((await err(undef.getParsedTransaction(SIGNATURE))).code).toBe(RPC_ERROR.UNPARSEABLE);
  });
});

describe('module invariants', () => {
  /** Code only: the header comments legitimately NAME what is forbidden. */
  const source = ['connection.js', 'rpc-validate.js']
    .map((f) => readFileSync(new URL(`../../src/rpc/${f}`, import.meta.url), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it('contains no signing, no keypair and no randomness', () => {
    for (const forbidden of [
      'Keypair',
      'sendTransaction',
      'signTransaction',
      'simulateTransaction',
      'secretKey',
      'privateKey',
      'Math.random',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('reads its rate limit from config rather than hardcoding it', () => {
    expect(source).toContain('LIMITS.rpc.requestsPerSecond');
  });
});
