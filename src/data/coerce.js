/**
 * Coercion helpers for UNTRUSTED external JSON.
 *
 * The trap these exist to close: `Number('')`, `Number(null)` and
 * `Number([])` are all 0. If a missing liquidity figure reaches the safety
 * layers as 0 it reads as "no liquidity" rather than "unknown", and a 0 in a
 * ratio silently yields Infinity or NaN instead of an error. So: genuinely
 * missing is ALWAYS null here, never 0 and never undefined.
 *
 * Nothing in this module throws unless it is named require*.
 */

/**
 * Coerce an API value to a finite number, or null when it is missing or junk.
 * Accepts numeric strings (Dexscreener sends prices as strings).
 * @param {unknown} value
 * @returns {number|null}
 */
export function toNumberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // booleans, null, undefined, objects, arrays: all "unknown", never 0.
  return null;
}

/**
 * Same coercion, but a missing/unparseable value is a hard error. Use where a
 * number is structural rather than optional (an OHLCV candle without a close
 * price is not a candle).
 * @param {unknown} value
 * @param {string} what fully-qualified description, e.g. 'GET /x ohlcv_list[3].close'
 * @returns {number}
 */
export function requireFiniteNumber(value, what) {
  const parsed = toNumberOrNull(value);
  if (parsed === null) {
    throw new TypeError(`${what} was not a finite number (${describeValue(value)})`);
  }
  return parsed;
}

/**
 * Coerce an ISO-8601 timestamp to unix milliseconds, or null.
 * @param {unknown} value
 * @returns {number|null}
 */
export function isoToEpochMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A short, log-safe description of an unexpected value, for error messages.
 * Never interpolates the whole payload: responses can be megabytes.
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(${value.length})`;
  const type = typeof value;
  if (type === 'string') {
    const clipped = value.length > 40 ? `${value.slice(0, 40)}...` : value;
    return `string("${clipped}")`;
  }
  if (type === 'object') return `object(${Object.keys(value).slice(0, 6).join(',')})`;
  return `${type}(${String(value)})`;
}

/**
 * Read a nested plain object, or an empty object when the level is missing.
 * Lets a normaliser walk an untrusted payload without optional-chaining noise.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
