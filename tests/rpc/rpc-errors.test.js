import { describe, expect, it } from 'vitest';
import {
  RPC_ERROR,
  causeChain,
  describeError,
  isTransientRpcError,
  redactRpcUrl,
  redactUrlsIn,
  rpcError,
} from '../../src/rpc/rpc-errors.js';

const KEY = 'abcdef01-2345-6789-abcd-ef0123456789';
const HELIUS = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const QUICKNODE = `https://silent-frosty.solana-mainnet.quiknode.pro/${KEY}/`;

describe('redactRpcUrl', () => {
  it('keeps the origin and drops a query-string key', () => {
    expect(redactRpcUrl(HELIUS)).toBe('https://mainnet.helius-rpc.com/<redacted>');
    expect(redactRpcUrl(HELIUS)).not.toContain(KEY);
  });

  it('drops a path-segment key', () => {
    expect(redactRpcUrl(QUICKNODE)).not.toContain(KEY);
  });

  it('says so plainly for an unset or unparseable url', () => {
    expect(redactRpcUrl(undefined)).toBe('<unset>');
    expect(redactRpcUrl('')).toBe('<unset>');
    expect(redactRpcUrl('not a url')).toBe('<invalid-rpc-url>');
  });

  it('leaves a keyless public endpoint recognisable', () => {
    expect(redactRpcUrl('https://api.mainnet-beta.solana.com')).toBe(
      'https://api.mainnet-beta.solana.com',
    );
  });
});

describe('redactUrlsIn', () => {
  it('redacts every url embedded in foreign text', () => {
    const text = `tried ${HELIUS} then ${QUICKNODE} and gave up`;

    expect(redactUrlsIn(text)).not.toContain(KEY);
    expect(redactUrlsIn(text)).toMatch(/<redacted>/);
  });

  it('leaves text with no url unchanged', () => {
    expect(redactUrlsIn('HTTP 429 Too Many Requests')).toBe('HTTP 429 Too Many Requests');
  });
});

describe('describeError -- must never leak a credential', () => {
  /**
   * The regression this file exists for. describeError walks `err.cause`, and an
   * upstream undici/web3.js error embeds the full request URL including the API
   * key. It used to redact nothing.
   *
   * The path was live, not theoretical: src/rpc/mint.js interpolates
   * describeError(err) into a THROWN message, which becomes a layer-0 errored()
   * reason, which reaches the gate result -- and from there into the append-only
   * JSONL that scripts/record.js writes and the Telegram messages scripts/bot.js
   * sends. A provider key could land in durable storage and in an outbound
   * message.
   */
  it('redacts a key carried in the CAUSE CHAIN, not just the top message', () => {
    const inner = new Error(`connect ECONNREFUSED ${HELIUS}`);
    const outer = rpcError('rpc getAccountInfo failed', { cause: inner });

    const text = describeError(outer);

    expect(text).not.toContain(KEY);
    expect(text).toContain('<redacted>');
  });

  it('redacts through several levels of nesting', () => {
    const deepest = new Error(`socket hang up ${QUICKNODE}`);
    const middle = new Error('transport failed', { cause: deepest });
    const outer = rpcError('exhausted', { cause: middle });

    expect(describeError(outer)).not.toContain(KEY);
  });

  it('redacts a bare string throwable', () => {
    expect(describeError(`failed on ${HELIUS}`)).not.toContain(KEY);
  });

  it('still describes the error usefully after redaction', () => {
    const text = describeError(rpcError('boom', { code: RPC_ERROR.EXHAUSTED }));

    expect(text).toMatch(/RpcError/);
    expect(text).toMatch(/boom/);
  });

  it('handles null, undefined and a cycle without throwing', () => {
    expect(describeError(null)).toBe('unknown error');
    expect(describeError(undefined)).toBe('unknown error');
    const a = new Error('a');
    a.cause = a;
    expect(() => describeError(a)).not.toThrow();
  });

  it('stays length-capped so a log line cannot be flooded', () => {
    const huge = new Error('x'.repeat(5_000));
    expect(describeError(huge).length).toBeLessThanOrEqual(500);
  });
});

describe('isTransientRpcError', () => {
  it('treats a 429 and a socket reset as retryable', () => {
    expect(isTransientRpcError(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(true);
    expect(isTransientRpcError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientRpcError(new Error('429 Too Many Requests: retry'))).toBe(true);
  });

  it('does NOT retry a permanent request error', () => {
    expect(isTransientRpcError(Object.assign(new Error('bad request'), { status: 400 }))).toBe(false);
    expect(isTransientRpcError(new Error('invalid param: not a base58 address'))).toBe(false);
  });

  it('looks through the cause chain', () => {
    const inner = Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
    expect(isTransientRpcError(new Error('wrapper', { cause: inner })).valueOf()).toBe(true);
  });
});

describe('causeChain', () => {
  it('flattens the chain with the error itself first', () => {
    const inner = new Error('inner');
    const outer = new Error('outer', { cause: inner });

    expect(causeChain(outer)).toHaveLength(2);
    expect(causeChain(outer)[0]).toBe(outer);
  });

  it('is cycle-safe', () => {
    const a = new Error('a');
    a.cause = a;

    expect(() => causeChain(a)).not.toThrow();
    expect(causeChain(a).length).toBeLessThanOrEqual(8);
  });
});
