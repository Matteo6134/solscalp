/**
 * Value readers for UNTRUSTED RPC responses, shared by the fetchers in this folder.
 *
 * WHAT THIS MODULE PROVES: that a single field of a node's answer is readable and of
 * the type we require.
 * WHAT IT DOES NOT PROVE: anything about the meaning of that field. Every safety
 * judgement is made by a caller.
 *
 * The trap these close is the one from src/data/coerce.js: `Number('')`,
 * `Number(null)` and `Number([])` are all 0, and a 0 that means "unknown" reads to a
 * safety layer as "no supply" or "no balance". Missing is ALWAYS null here.
 */

import { RPC_ERROR, rpcError } from './rpc-errors.js';

/** @returns {boolean} true for a non-null, non-array object. */
export const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A pubkey-ish value as base58, or null. Unknown is never a fabricated address.
 * Unlike the token2022 reader, the all-zero pubkey is NOT mapped to null here: at
 * the account level it is the system program, a real and meaningful owner.
 * @param {unknown} value
 * @returns {string|null}
 */
export function addressOrNull(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (isPlainObject(value) && typeof value.toBase58 === 'function') return value.toBase58();
  return null;
}

/**
 * Strict numeric read for raw base-unit amounts, lamports and counters. Accepts the
 * decimal strings the RPC uses for u64s, and bigints. Never coerces '' or null to 0.
 * @param {unknown} value
 * @returns {number|null}
 */
export function amountOrNull(value) {
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A Buffer view over account data, or null when it is not bytes at all.
 * @param {unknown} value
 * @returns {Buffer|null}
 */
export function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * "The node answered, but with a shape we refuse to guess at."
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {Error} rpcError with code UNPARSEABLE
 */
export function unparseable(message, extra = {}) {
  return rpcError(message, { code: RPC_ERROR.UNPARSEABLE, ...extra });
}
