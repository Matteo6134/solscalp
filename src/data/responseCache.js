/**
 * Tiny in-process response cache for the data clients.
 *
 * What it proves: that a request whose answer is already known does not spend a
 * rate-limit slot. On the free tiers this project lives on (LIMITS in
 * src/config.js -- GeckoTerminal is 30 req/min for the whole process, per IP)
 * a duplicate fetch is not merely slow, it is budget that a safety check needed.
 *
 * What it does NOT do:
 *   - It does not decide staleness. The caller supplies an absolute expiry per
 *     entry, because only the caller knows whether it fetched a CLOSED window
 *     (cannot change; `Infinity`) or a LIVE snapshot (must not be remembered
 *     past its usefulness).
 *   - It does not read the clock. `now` arrives as a parameter, so a test never
 *     needs fake timers and behaviour is deterministic.
 *   - It does not cache failures, or anything else the caller does not hand it.
 *     That policy belongs to the client: caching a bad response would turn one
 *     broken reply into a lasting wrong answer.
 *
 * Eviction is FIFO on insertion order, purely as a memory bound.
 */

/**
 * Default memory bound. Not a tunable threshold: an unbounded cache in a process
 * that runs for days is a leak, and this is simply where the bound sits.
 */
const DEFAULT_MAX_ENTRIES = 512;

/**
 * @typedef {object} ResponseCache
 * @property {(key: string, nowMs: number) => unknown} get value, or `undefined`
 *   when absent or expired
 * @property {(key: string, value: unknown, expiresAtMs: number) => void} set
 * @property {() => void} clear
 * @property {() => number} size
 */

/**
 * @param {object} [p]
 * @param {number} [p.maxEntries] memory bound; oldest insertion is evicted first
 * @returns {ResponseCache} frozen
 */
export function createResponseCache({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError(
      `createResponseCache: maxEntries must be a positive integer, got ${String(maxEntries)}`,
    );
  }
  /** @type {Map<string, Readonly<{value: unknown, expiresAtMs: number}>>} */
  const entries = new Map();

  return Object.freeze({
    /**
     * @param {string} key
     * @param {number} nowMs
     * @returns {unknown} `undefined` = miss. An expired entry is dropped on read.
     */
    get(key, nowMs) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      if (nowMs >= hit.expiresAtMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },

    /**
     * @param {string} key exact request identity (a url, including its query)
     * @param {unknown} value normalised, already-frozen result
     * @param {number} expiresAtMs absolute epoch ms; `Infinity` never expires
     */
    set(key, value, expiresAtMs) {
      // Re-insert so insertion order stays the eviction order.
      entries.delete(key);
      entries.set(key, Object.freeze({ value, expiresAtMs }));
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },

    clear() {
      entries.clear();
    },

    /** Entry count, including any that are expired but not yet read. */
    size() {
      return entries.size;
    },
  });
}
