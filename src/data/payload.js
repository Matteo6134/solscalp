/**
 * Shape helpers for UNTRUSTED API payloads, shared by the data clients.
 *
 * What this module proves: that a value coming off the wire has the SHAPE we are
 * about to read (a plain object, a non-blank string, a base58 address, a
 * positive integer), and that whatever a client hands back is frozen and does
 * not alias -- or freeze -- the caller's own input.
 *
 * What it does not prove: anything about the MEANING of the value. A base58
 * string is not necessarily a live mint, and a positive integer is not
 * necessarily the number the API expected. Semantics stay in the client that
 * knows the endpoint.
 *
 * Companion to `coerce.js`, which owns number and timestamp coercion (missing is
 * always `null`, never 0). Nothing here throws unless it is named assert*.
 */

import { describeValue } from './coerce.js';

/** base58, 32-44 chars. Solana mints, pool addresses and wallets share it. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Unit conversions, not tunables. */
export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;

/**
 * @param {unknown} value
 * @returns {boolean} true for a plain object; arrays and null are NOT objects here
 */
export const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {string|null} the string, or null when absent or blank. Blank is
 *   "unknown", never the empty string, which reads as a real (empty) name.
 */
export const stringOrNull = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/**
 * Structural deep freeze over a JSON tree (finite and acyclic by construction).
 * @template T
 * @param {T} value
 * @returns {T} the same reference, frozen
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Deep-freeze a CLONE. Used for the `raw` field every client carries: freezing
 * the payload in place would mutate an argument, which is forbidden, and would
 * surprise a test that reuses a fixture.
 * @template T
 * @param {T} value structured-cloneable (parsed JSON)
 * @returns {T} frozen clone
 */
export const frozenClone = (value) => deepFreeze(structuredClone(value));

/**
 * @param {unknown} value
 * @param {string} what fully-qualified description, e.g. 'dexscreener: getBestPair(mint)'
 * @returns {string} the validated address
 * @throws {TypeError} when it is not a base58 address
 */
export function assertBase58Address(value, what) {
  if (typeof value !== 'string' || !BASE58_ADDRESS.test(value)) {
    throw new TypeError(
      `${what} must be a base58 address (32-44 chars), got ${describeValue(value)}`,
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} what fully-qualified description
 * @returns {number} the validated integer
 * @throws {TypeError} when it is not a positive integer
 */
export function assertPositiveInteger(value, what) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${what} must be a positive integer, got ${describeValue(value)}`);
  }
  return value;
}

/**
 * Read the wall clock through an injectable seam, so a client's `fetchedAtMs` is
 * deterministic under test and no data module reaches for `Date.now()` directly.
 * @param {{now?: () => number}} deps
 * @param {string} label prefixes the error message
 * @returns {number} epoch milliseconds
 * @throws {TypeError} when the seam is not a function or returns a non-number
 */
export function readNowMs(deps, label) {
  const now = deps?.now ?? Date.now;
  if (typeof now !== 'function') {
    throw new TypeError(`${label}: deps.now must be a function, got ${describeValue(deps?.now)}`);
  }
  const ms = now();
  if (!Number.isFinite(ms)) {
    throw new TypeError(`${label}: deps.now() returned ${describeValue(ms)}, expected epoch ms`);
  }
  return ms;
}

/**
 * Age in minutes of a timestamp, or null when the timestamp is unknown.
 * Unknown age stays null: a 0 would claim the pool was created this instant.
 * @param {number|null} fromMs
 * @param {number} nowMs
 * @returns {number|null}
 */
export const minutesSince = (fromMs, nowMs) =>
  fromMs === null ? null : (nowMs - fromMs) / MS_PER_MINUTE;
