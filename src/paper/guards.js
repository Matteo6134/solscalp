/**
 * Boundary assertions shared by the paper-trading modules.
 *
 * Money maths is where a silent NaN turns into fabricated profit, so every
 * external value is checked before it is read. Each helper RETURNS the
 * validated value so it can be used inline, and THROWS a descriptive
 * TypeError/RangeError otherwise. Nothing here ever coerces or defaults:
 * a bad input is a hard failure, never a quietly substituted zero.
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
export function assertFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${describe(value)}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number} value, guaranteed > 0
 */
export function assertPositiveNumber(value, name) {
  const n = assertFiniteNumber(value, name);
  if (n <= 0) throw new RangeError(`${name} must be > 0, got ${n}`);
  return n;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number} value, guaranteed >= 0
 */
export function assertNonNegativeNumber(value, name) {
  const n = assertFiniteNumber(value, name);
  if (n < 0) throw new RangeError(`${name} must be >= 0, got ${n}`);
  return n;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number} integer >= 0
 */
export function assertNonNegativeInteger(value, name) {
  const n = assertFiniteNumber(value, name);
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`${name} must be an integer >= 0, got ${n}`);
  }
  return n;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string} non-empty, trimmed-non-empty string
 */
export function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

/**
 * Plain-ish object check: rejects null, arrays and primitives. Used before
 * reading nested fields off untrusted API payloads.
 * @param {unknown} value
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
export function assertPlainObject(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object, got ${describe(value)}`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Epoch milliseconds. Integer so that day bucketing is deterministic.
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
export function assertTimestampMs(value, name) {
  const n = assertNonNegativeInteger(value, name);
  if (!Number.isFinite(new Date(n).getTime())) {
    throw new RangeError(`${name} is not a representable timestamp: ${n}`);
  }
  return n;
}

/** Short, safe rendering of an unexpected value for error messages. */
function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}
