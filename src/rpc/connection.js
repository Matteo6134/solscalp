/**
 * Rate-limited, bounded-retry wrapper around a Solana JSON-RPC `Connection`.
 *
 * What this module PROVES:
 *  - a call either returned a value whose shape rpc-validate.js checked, or it
 *    threw. There is no third outcome and no default-shaped payload;
 *  - a retry happened only where `isTransientRpcError` said another attempt
 *    could plausibly succeed;
 *  - at most `LIMITS.rpc.requestsPerSecond * 60` request STARTS entered any 60s
 *    window, retries and fallback attempts included;
 *  - nothing it throws or reports carries a provider API key.
 *
 * What it does NOT prove:
 *  - that the answering node was honest, synced or unforked. One read is one
 *    node's opinion; nothing here cross-checks two providers;
 *  - that `null` (absent account or transaction) or an empty list means "safe":
 *    those are FACTS handed to the caller, which must decide;
 *  - that a value still holds a slot later. Freshness is the caller's problem.
 *
 * READ ONLY: no `Keypair`, no private key, no signing, no `sendTransaction`,
 * no `simulateTransaction`. This module cannot spend anything.
 *
 * The chained `cause` is the untouched upstream error and may itself embed a
 * credentialed URL: log `err.message` (always redacted here), never the cause.
 */

import { LIMITS } from '../config.js';
import { createRateLimiter } from '../data/rateLimiter.js';
import { RPC_ERROR, isTransientRpcError, redactRpcUrl, rpcError } from './rpc-errors.js';
import {
  describeValue,
  isBase58,
  requireAccountInfo,
  requireEnvelopeValue,
  requireHttpUrl,
  requireNullableObject,
  requireObjectArray,
  requireTokenAccount,
  requireTokenAmount,
  safeDetail,
  toPublicKey,
  unparseable,
} from './rpc-validate.js';

/** Unit conversion: `createRateLimiter` counts per MINUTE, `LIMITS.rpc` per SECOND. */
const SECONDS_PER_MINUTE = 60;

/**
 * `LIMITS.rpc.requestsPerSecond * 60`, because the shared limiter's window is a
 * minute. The per-second ceiling is therefore held ON AVERAGE: in principle a
 * whole minute's worth of starts could burst inside one second. Stated rather
 * than silently assumed -- the quota that actually bites on the tiers we use is
 * the windowed one (credits per month), not an instantaneous rate.
 */
const RPC_REQUESTS_PER_MINUTE = LIMITS.rpc.requestsPerSecond * SECONDS_PER_MINUTE;

/** Contract default (docs/specs/2026-08-24-module-contracts.md); config.js has no rpc key. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Backoff base: attempt n sleeps `2**n * 250ms`. Deterministic, no jitter, ever. */
const BACKOFF_BASE_MS = 250;

/** Read commitment. A string, not a tunable threshold. */
const DEFAULT_COMMITMENT = 'confirmed';

/** A version number, not a threshold: without it web3.js throws on a versioned tx. */
const MAX_SUPPORTED_TRANSACTION_VERSION = 0;
const PARSED_TX_OPTIONS = Object.freeze({
  maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
  commitment: DEFAULT_COMMITMENT,
});

/** Real clock. Overridable purely as a test seam; production never passes one. */
const defaultClock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
});

/**
 * The ONLY place a real `Connection` is constructed. Imported dynamically so a
 * test that injects `connectionFactory` never loads (or depends on) web3.js.
 * `disableRetryOnRateLimit` because the retry policy lives in this module: two
 * retry loops stacked on one quota is how a bot gets itself throttled.
 * @param {string} endpoint
 * @returns {Promise<object>} a web3.js Connection
 */
async function defaultConnectionFactory(endpoint) {
  const { Connection } = await import('@solana/web3.js');
  return new Connection(endpoint, {
    commitment: DEFAULT_COMMITMENT,
    disableRetryOnRateLimit: true,
  });
}

/** Codes this layer owns; such an error is already classified AND redacted. */
const OWN_CODES = new Set(Object.values(RPC_ERROR));

/** @param {unknown} err */
const isOwnRpcError = (err) =>
  Boolean(err) &&
  typeof err === 'object' &&
  /** @type {any} */ (err).name === 'RpcError' &&
  OWN_CODES.has(/** @type {any} */ (err).code);

/**
 * @typedef {object} RpcClient
 * @property {string} endpoint redacted primary endpoint
 * @property {<T>(name: string, fn: (connection: any) => Promise<T>) => Promise<T>} call
 * @property {(address: string) => Promise<object|null>} getAccountInfo
 * @property {(address: string) => Promise<Readonly<{amount: string, decimals: number,
 *   uiAmount: number|null}>>} getTokenSupply
 * @property {(address: string) => Promise<readonly object[]>} getTokenLargestAccounts
 * @property {(address: string, opts?: object) => Promise<readonly object[]>} getSignaturesForAddress
 * @property {(signature: string) => Promise<object|null>} getParsedTransaction
 * @property {() => Readonly<object>} stats
 */

/**
 * Build a frozen RPC client.
 *
 * @param {object} [p]
 * @param {string} [p.url] primary endpoint; defaults to `SOLANA_RPC_URL`. There
 *   is no built-in default endpoint: guessing one is a silent misconfiguration.
 * @param {string} [p.fallbackUrl] second endpoint; defaults to
 *   `SOLANA_RPC_URL_FALLBACK`. Ignored when identical to `url` -- retrying the
 *   same node is not a fallback.
 * @param {number} [p.maxAttempts] attempts on the primary before the fallback
 * @param {{now: () => number, sleep: (ms: number) => Promise<void>}} [p.clock] test seam
 * @param {(endpoint: string) => any} [p.connectionFactory] replaces `new Connection(url)`
 * @returns {RpcClient} frozen
 */
export function createRpcClient({
  url,
  fallbackUrl,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  clock = defaultClock,
  connectionFactory = defaultConnectionFactory,
} = {}) {
  const rawPrimary = url ?? process.env.SOLANA_RPC_URL;
  if (rawPrimary === undefined || rawPrimary === null || rawPrimary === '') {
    throw new TypeError(
      'createRpcClient: url is required (pass loadEnv().rpcUrl or set SOLANA_RPC_URL). ' +
        'Refusing to guess an endpoint.',
    );
  }
  const primary = requireHttpUrl(rawPrimary, 'createRpcClient: url');

  const rawFallback = fallbackUrl ?? process.env.SOLANA_RPC_URL_FALLBACK;
  const configuredFallback =
    rawFallback === undefined || rawFallback === null || rawFallback === ''
      ? null
      : requireHttpUrl(rawFallback, 'createRpcClient: fallbackUrl');
  const fallback = configuredFallback === primary ? null : configuredFallback;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(
      `createRpcClient: maxAttempts must be an integer >= 1, got ${describeValue(maxAttempts)}`,
    );
  }
  if (typeof clock?.now !== 'function' || typeof clock?.sleep !== 'function') {
    throw new TypeError('createRpcClient: clock must provide now() and sleep(ms)');
  }
  if (typeof connectionFactory !== 'function') {
    throw new TypeError(
      `createRpcClient: connectionFactory must be a function, got ${typeof connectionFactory}`,
    );
  }

  const endpoint = redactRpcUrl(primary);
  const fallbackEndpoint = fallback === null ? null : redactRpcUrl(fallback);
  const limiter = createRateLimiter({
    requestsPerMinute: RPC_REQUESTS_PER_MINUTE,
    label: 'rpc',
    clock,
  });

  /** @type {Map<string, Promise<any>>} one connection per endpoint, built on first use. */
  const connections = new Map();

  /** @param {string} target */
  function connectionFor(target) {
    const cached = connections.get(target);
    if (cached !== undefined) return cached;
    const created = Promise.resolve()
      .then(() => connectionFactory(target))
      .then((connection) => {
        if (connection === null || typeof connection !== 'object') {
          throw rpcError(
            `connectionFactory returned ${describeValue(connection)} for ${redactRpcUrl(target)}`,
            { code: RPC_ERROR.TRANSPORT, endpoint: redactRpcUrl(target) },
          );
        }
        return connection;
      });
    // A failed construction must not be cached forever: one DNS blip would
    // otherwise blind the gate for the rest of the process's life.
    created.catch(() => connections.delete(target));
    connections.set(target, created);
    return created;
  }

  let calls = 0;
  let succeeded = 0;
  let failed = 0;
  let retries = 0;
  let fallbackAttempts = 0;
  let exhausted = 0;
  /** @type {string|null} redacted text of the most recent failure. */
  let lastError = null;
  /** @type {Readonly<Record<string, number>>} */
  let byMethod = Object.freeze({});

  /** Every request start -- first try, retry, fallback -- pays the rate limit. */
  const attemptOn = (target, fn) => limiter.schedule(async () => fn(await connectionFor(target)));

  /** @param {number} attempt zero-based */
  const backoffMs = (attempt) => 2 ** attempt * BACKOFF_BASE_MS;

  /**
   * Run `fn(connection)` with bounded retry, deterministic backoff and one
   * fallback attempt. Non-transient failures surface immediately.
   * @template T
   * @param {string} name method name, for stats and error messages
   * @param {(connection: any) => Promise<T>} fn
   * @returns {Promise<T>}
   * @throws {Error} `.code` is `RPC_ERROR.TRANSPORT` (not retryable) or
   *   `RPC_ERROR.EXHAUSTED` (every attempt failed). Messages are always redacted.
   */
  async function call(name, fn) {
    if (typeof name !== 'string' || name === '') {
      throw new TypeError(`rpc call: name must be a non-empty string, got ${describeValue(name)}`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError(`rpc call(${name}): fn must be a function, got ${typeof fn}`);
    }
    calls += 1;
    byMethod = Object.freeze({ ...byMethod, [name]: (byMethod[name] ?? 0) + 1 });

    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const value = await attemptOn(primary, fn);
        succeeded += 1;
        return value;
      } catch (err) {
        lastErr = err;
        lastError = safeDetail(err);
        if (!isTransientRpcError(err)) {
          failed += 1;
          // Already one of ours: classified and redacted, so do not re-wrap it.
          if (isOwnRpcError(err)) throw err;
          throw rpcError(
            `rpc ${name} failed on ${endpoint} ` +
              `(attempt ${attempt + 1}/${maxAttempts}, not retryable): ${safeDetail(err)}`,
            {
              code: RPC_ERROR.TRANSPORT,
              cause: err,
              method: name,
              endpoint,
              attempts: attempt + 1,
              retryable: false,
            },
          );
        }
        if (attempt + 1 < maxAttempts) {
          retries += 1;
          await clock.sleep(backoffMs(attempt));
        }
      }
    }

    // Primary exhausted. The fallback is one last chance on a DIFFERENT node,
    // so there is nothing to back off from before trying it.
    if (fallback !== null) {
      fallbackAttempts += 1;
      try {
        const value = await attemptOn(fallback, fn);
        succeeded += 1;
        return value;
      } catch (err) {
        lastErr = err;
        lastError = safeDetail(err);
      }
    }

    failed += 1;
    exhausted += 1;
    throw rpcError(
      `rpc ${name} exhausted ${maxAttempts} attempt(s) on ${endpoint}` +
        (fallbackEndpoint === null
          ? ' (no distinct fallback configured)'
          : ` and 1 fallback attempt on ${fallbackEndpoint}`) +
        `: ${safeDetail(lastErr)}`,
      {
        code: RPC_ERROR.EXHAUSTED,
        cause: lastErr,
        method: name,
        endpoint,
        fallbackEndpoint,
        attempts: maxAttempts + (fallback === null ? 0 : 1),
      },
    );
  }

  /**
   * @param {string} address
   * @returns {Promise<object|null>} frozen AccountInfo, or `null` when the
   *   account does not exist -- a fact for the caller, not an error
   */
  async function getAccountInfo(address) {
    const key = await toPublicKey(address, 'getAccountInfo');
    const info = await call('getAccountInfo', (connection) => connection.getAccountInfo(key));
    return requireAccountInfo(info, `getAccountInfo(${address})`);
  }

  /**
   * @param {string} address mint address
   * @returns {Promise<Readonly<{amount: string, decimals: number, uiAmount: number|null}>>}
   * @throws rpcError `UNPARSEABLE` when the envelope is not the documented shape
   */
  async function getTokenSupply(address) {
    const key = await toPublicKey(address, 'getTokenSupply');
    const what = `getTokenSupply(${address})`;
    const envelope = await call('getTokenSupply', (connection) => connection.getTokenSupply(key));
    return requireTokenAmount(requireEnvelopeValue(envelope, what), `${what}.value`);
  }

  /**
   * @param {string} address mint address
   * @returns {Promise<readonly Readonly<{address: string, amount: string,
   *   decimals: number, uiAmount: number|null}>[]>} frozen; empty is a valid answer
   * @throws rpcError `UNPARSEABLE` on any entry that is not fully readable
   */
  async function getTokenLargestAccounts(address) {
    const key = await toPublicKey(address, 'getTokenLargestAccounts');
    const what = `getTokenLargestAccounts(${address})`;
    const envelope = await call('getTokenLargestAccounts', (connection) =>
      connection.getTokenLargestAccounts(key),
    );
    const value = requireEnvelopeValue(envelope, what);
    if (!Array.isArray(value)) {
      throw unparseable(what, `value must be an array, got ${describeValue(value)}`);
    }
    return Object.freeze(value.map((entry, i) => requireTokenAccount(entry, `${what}.value[${i}]`)));
  }

  /**
   * @param {string} address
   * @param {object} [opts] web3.js SignaturesForAddressOptions (limit/before/until)
   * @returns {Promise<readonly object[]>} frozen entries, in the order the node sent them
   */
  async function getSignaturesForAddress(address, opts) {
    const key = await toPublicKey(address, 'getSignaturesForAddress');
    if (opts !== undefined && (opts === null || typeof opts !== 'object' || Array.isArray(opts))) {
      throw new TypeError(
        `getSignaturesForAddress: opts must be an object, got ${describeValue(opts)}`,
      );
    }
    // Copy, so the connection can neither see nor alter the caller's object.
    const options = opts === undefined ? undefined : Object.freeze({ ...opts });
    const list = await call('getSignaturesForAddress', (connection) =>
      options === undefined
        ? connection.getSignaturesForAddress(key)
        : connection.getSignaturesForAddress(key, options),
    );
    return requireObjectArray(list, `getSignaturesForAddress(${address})`);
  }

  /**
   * @param {string} signature
   * @returns {Promise<object|null>} `null` = this node has no such transaction
   *   (public nodes routinely refuse deep history), which is a fact, not an
   *   error. Frozen shallowly otherwise: nested values include `PublicKey`
   *   instances, whose internals must stay writable.
   */
  async function getParsedTransaction(signature) {
    if (!isBase58(signature)) {
      throw rpcError(
        `getParsedTransaction: signature must be a base58 string, got ${describeValue(signature)}`,
        { code: RPC_ERROR.INVALID_ADDRESS },
      );
    }
    const tx = await call('getParsedTransaction', (connection) =>
      connection.getParsedTransaction(signature, PARSED_TX_OPTIONS),
    );
    return requireNullableObject(tx, `getParsedTransaction(${signature})`);
  }

  /** Snapshot for LOGGING ONLY. Never branch on these numbers. */
  const stats = () =>
    Object.freeze({
      endpoint,
      fallbackEndpoint,
      maxAttempts,
      calls,
      succeeded,
      failed,
      retries,
      fallbackAttempts,
      exhausted,
      lastError,
      byMethod,
      rateLimit: limiter.stats(),
    });

  return Object.freeze({
    endpoint,
    call,
    getAccountInfo,
    getTokenSupply,
    getTokenLargestAccounts,
    getSignaturesForAddress,
    getParsedTransaction,
    stats,
  });
}
