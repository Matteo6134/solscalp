/**
 * Shape validation and log-safe formatting for the RPC layer.
 *
 * Extracted from connection.js so the retry policy stays readable and so every
 * validator can be exercised without a socket, a Connection or a clock.
 *
 * What this module PROVES: a value that comes back from here had every field
 * this project depends on actually present and of the right type.
 *
 * What it does NOT prove: that the node was telling the truth. It checks
 * SHAPE, never semantics.
 *
 * FAIL CLOSED, twice over:
 *  - a half-readable payload throws `RPC_ERROR.UNPARSEABLE` instead of being
 *    returned with holes in it, because a caller reading a missing field as
 *    "nothing found" is the exact inversion this project exists to prevent;
 *  - "unknown" is `null` and never `0`/`undefined` -- `uiAmount` may be null,
 *    but it may not be absent.
 */

import { RPC_ERROR, describeError, redactRpcUrl, redactUrlsIn as redactUrls, rpcError } from './rpc-errors.js';

/** base58 alphabet: no 0, O, I or l. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const DIGITS_RE = /^[0-9]+$/;
/** Encoding bounds of a 32-byte key in base58, not tunables. */
const ADDRESS_MIN_CHARS = 32;
const ADDRESS_MAX_CHARS = 44;
/** `decimals` is a u8 in the mint account. */
const MAX_TOKEN_DECIMALS = 255;
/** Ceiling on foreign text echoed into one of our messages. */
const MAX_DETAIL_CHARS = 300;

/** Memoised web3.js `PublicKey`, imported lazily so a test that injects a
 * connectionFactory never loads (or depends on) the whole library. */
let publicKeyCtor = null;
async function loadPublicKeyCtor() {
  if (publicKeyCtor === null) {
    const web3 = await import('@solana/web3.js');
    if (typeof web3.PublicKey !== 'function') {
      throw new Error('@solana/web3.js did not export PublicKey');
    }
    publicKeyCtor = web3.PublicKey;
  }
  return publicKeyCtor;
}

/**
 * Short, log-safe description of an unexpected value. Never dumps a payload:
 * an RPC response can be megabytes.
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 48));
  if (typeof value === 'object') return 'object';
  return String(value);
}

/**
 * Redact every URL inside foreign text. Upstream messages routinely embed the
 * whole endpoint -- Helius puts the API key in the query string -- so redacting
 * only our own interpolations would still leak the key through `err.message`.
 * @param {unknown} text
 * @returns {string}
 */
export const redactUrlsIn = redactUrls;

/**
 * One-line, length-capped, credential-free description of any throwable.
 * @param {unknown} err
 * @returns {string}
 */
export function safeDetail(err) {
  const text = redactUrlsIn(describeError(err));
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}...` : text;
}

/**
 * @param {string} what
 * @param {string} detail
 * @returns {Error} an `RPC_ERROR.UNPARSEABLE` error
 */
export function unparseable(what, detail) {
  return rpcError(`${what}: ${detail}`, { code: RPC_ERROR.UNPARSEABLE });
}

/**
 * Validate an endpoint. The URL itself is never echoed into the message: only
 * its redaction, because a malformed URL can still contain a live key.
 * @param {unknown} value
 * @param {string} what
 * @returns {string} `value` unchanged, once known to be http(s)
 * @throws {TypeError} configuration is wrong, which is a bug, not a network event
 */
export function requireHttpUrl(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${what} must be an http(s) URL, got ${describeValue(value)}`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${what} is not a parseable URL (${redactRpcUrl(value)})`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`${what} must be http(s), got ${parsed.protocol} (${redactRpcUrl(value)})`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean} true when every character is in the base58 alphabet
 */
export const isBase58 = (value) => typeof value === 'string' && BASE58_RE.test(value);

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` could be a base58-encoded 32-byte key
 */
export const isAddress = (value) =>
  isBase58(value) &&
  /** @type {string} */ (value).length >= ADDRESS_MIN_CHARS &&
  /** @type {string} */ (value).length <= ADDRESS_MAX_CHARS;

/**
 * Validate an address the CALLER supplied. A failure here is a usage bug, hence
 * `INVALID_ADDRESS`; a bad address inside a node's RESPONSE is `UNPARSEABLE`
 * instead (see `requireBase58Like`), because the two need different handling.
 * @param {unknown} address
 * @param {string} what
 * @returns {string}
 * @throws rpcError `INVALID_ADDRESS`
 */
export function requireAddress(address, what) {
  if (typeof address !== 'string') {
    throw rpcError(`${what}: address must be a base58 string, got ${describeValue(address)}`, {
      code: RPC_ERROR.INVALID_ADDRESS,
    });
  }
  if (!isAddress(address)) {
    throw rpcError(`${what}: "${address}" is not a base58 Solana address`, {
      code: RPC_ERROR.INVALID_ADDRESS,
    });
  }
  return address;
}

/**
 * base58 string from a RESPONSE field, which may be a string or a web3.js
 * `PublicKey`. Anything else makes the response unparseable, not the request
 * invalid: the caller asked a well-formed question and got a bad answer.
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 * @throws rpcError `UNPARSEABLE`
 */
export function requireBase58Like(value, what) {
  const asString =
    typeof value === 'string'
      ? value
      : value !== null &&
          typeof value === 'object' &&
          typeof /** @type {any} */ (value).toBase58 === 'function'
        ? /** @type {any} */ (value).toBase58()
        : null;
  if (!isAddress(asString)) {
    throw unparseable(what, `expected a base58 address, got ${describeValue(value)}`);
  }
  return /** @type {string} */ (asString);
}

/**
 * Build the `PublicKey` web3.js requires. Rejects junk on the cheap regex path
 * first, so most invalid addresses never load the library at all.
 * @param {unknown} address
 * @param {string} what
 * @returns {Promise<object>} a web3.js PublicKey
 * @throws rpcError `INVALID_ADDRESS`
 */
export async function toPublicKey(address, what) {
  const validated = requireAddress(address, what);
  const PublicKey = await loadPublicKeyCtor();
  try {
    return new PublicKey(validated);
  } catch (err) {
    throw rpcError(`${what}: "${validated}" is not a valid 32-byte public key`, {
      code: RPC_ERROR.INVALID_ADDRESS,
      cause: err,
    });
  }
}

/**
 * Unwrap a `{ context, value }` RPC envelope. A missing `value` is unparseable,
 * never an empty object.
 * @param {unknown} envelope
 * @param {string} what
 * @returns {unknown} the `value` field, still unvalidated
 */
export function requireEnvelopeValue(envelope, what) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw unparseable(
      what,
      `expected an { context, value } envelope, got ${describeValue(envelope)}`,
    );
  }
  if (!('value' in envelope)) {
    throw unparseable(what, 'envelope has no "value" field');
  }
  return /** @type {any} */ (envelope).value;
}

/**
 * Validate a `{ amount, decimals, uiAmount }` token amount.
 * `uiAmount` may be `null` (too large for a float) but never absent: unknown
 * must arrive as null, never as an undefined that becomes NaN downstream.
 * @param {unknown} raw
 * @param {string} what
 * @returns {Readonly<{amount: string, decimals: number, uiAmount: number|null}>}
 */
export function requireTokenAmount(raw, what) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw unparseable(what, `expected a token amount object, got ${describeValue(raw)}`);
  }
  const { amount, decimals, uiAmount } = /** @type {any} */ (raw);
  if (typeof amount !== 'string' || !DIGITS_RE.test(amount)) {
    throw unparseable(what, `amount must be an integer string, got ${describeValue(amount)}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw unparseable(what, `decimals must be a u8, got ${describeValue(decimals)}`);
  }
  if (uiAmount !== null && !Number.isFinite(uiAmount)) {
    throw unparseable(
      what,
      `uiAmount must be a finite number or null, got ${describeValue(uiAmount)}`,
    );
  }
  return Object.freeze({ amount, decimals, uiAmount });
}

/**
 * One entry of `getTokenLargestAccounts`: a token amount plus its account.
 * @param {unknown} raw
 * @param {string} what
 * @returns {Readonly<{address: string, amount: string, decimals: number, uiAmount: number|null}>}
 */
export function requireTokenAccount(raw, what) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw unparseable(what, `expected a token account object, got ${describeValue(raw)}`);
  }
  const amount = requireTokenAmount(raw, what);
  const address = requireBase58Like(/** @type {any} */ (raw).address, `${what}.address`);
  return Object.freeze({ address, ...amount });
}

/**
 * `null` means the account does not exist -- a VALUE the caller interprets.
 * Anything else must be a whole AccountInfo: a half-read one would let a caller
 * read a missing `data` as "no extensions present".
 * @param {unknown} info
 * @param {string} what
 * @returns {object|null} frozen shallow copy
 */
export function requireAccountInfo(info, what) {
  if (info === null) return null;
  if (typeof info !== 'object' || Array.isArray(info)) {
    throw unparseable(what, `expected AccountInfo or null, got ${describeValue(info)}`);
  }
  const raw = /** @type {any} */ (info);
  if (!(raw.data instanceof Uint8Array)) {
    throw unparseable(what, `AccountInfo.data must be bytes, got ${describeValue(raw.data)}`);
  }
  if (!Number.isFinite(raw.lamports)) {
    throw unparseable(
      what,
      `AccountInfo.lamports must be a number, got ${describeValue(raw.lamports)}`,
    );
  }
  requireBase58Like(raw.owner, `${what}.owner`);
  // Frozen shallow COPY: the library's own object is left untouched, and `data`
  // stays a live Uint8Array because bytes cannot be frozen.
  return Object.freeze({ ...raw });
}

/**
 * An array of objects (signature infos), each frozen. Empty is a valid answer:
 * "this node knows of no signatures" is a fact.
 * @param {unknown} list
 * @param {string} what
 * @returns {readonly object[]} frozen array of frozen shallow copies
 */
export function requireObjectArray(list, what) {
  if (!Array.isArray(list)) {
    throw unparseable(what, `expected an array, got ${describeValue(list)}`);
  }
  return Object.freeze(
    list.map((entry, i) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw unparseable(`${what}[${i}]`, `expected an object, got ${describeValue(entry)}`);
      }
      return Object.freeze({ ...entry });
    }),
  );
}

/**
 * `null` (not found) or an object. Frozen SHALLOW on purpose: a parsed
 * transaction nests `PublicKey` instances whose internals must stay writable.
 * `undefined` is NOT accepted -- only an explicit null means "not found".
 * @param {unknown} value
 * @param {string} what
 * @returns {object|null}
 */
export function requireNullableObject(value, what) {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw unparseable(what, `expected an object or null, got ${describeValue(value)}`);
  }
  return Object.freeze({ .../** @type {any} */ (value) });
}
