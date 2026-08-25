/**
 * Boundary validation and exclusion-set PROVENANCE for layer 3, extracted from
 * layer3-holders.js so the file-size limit is respected and so every input rule
 * can be exercised without a gate context.
 *
 * WHAT THIS MODULE PROVES
 * -----------------------
 * That the numbers handed to holderConcentration.js are usable: a real holder
 * list, a real supply, both in the SAME unit, and an auditable record of which
 * addresses were excluded from the concentration maths and why.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * Nothing about the token. It checks SHAPE and UNITS, never semantics, and it
 * cannot know whether the exclusion set was COMPLETE -- only which addresses
 * anybody told us about. A missed vault inflates measured concentration (a false
 * REJECT); a wrongly excluded holder would hide concentration, which is why the
 * only sources here are pool/vault addresses reported by the pair or by
 * RugCheck's markets, never anything derived from the holder list itself.
 *
 * FAIL CLOSED: every function here throws rather than returning a hole, except
 * `optionalEvidence`, which exists precisely because a missing pair or report can
 * only make layer 3 STRICTER.
 */

import { KNOWN } from '../config.js';

/** Percentages are 0-100 everywhere in this project. Not a tunable. */
export const PCT_MAX = 100;
/** Encoding bounds of a 32-byte key in base58. Format rule, not a threshold. */
const ADDRESS_MIN_CHARS = 32;
const ADDRESS_MAX_CHARS = 44;
/** base58 alphabet: no 0, O, I or l. Mirrors src/rpc/rpc-validate.js. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
/** src/rpc/holders.js contract: holder balances and supply are both RAW base units. */
export const RAW_AMOUNT_FIELD = 'amount';

/**
 * Fields on a RugCheck `markets[]` entry that name an on-chain HOLDER: the pool
 * itself (often the vault authority) and the pool's reserve token accounts.
 * `mintA`/`mintB`/`mintLP` are deliberately absent -- those are mints, and a mint
 * is never a holder, exactly as KNOWN.WSOL/KNOWN.USDC are absent from
 * buildExclusionSet.
 */
export const MARKET_HOLDER_FIELDS = Object.freeze([
  'pubkey',
  'address',
  'poolAddress',
  'marketAddress',
  'liquidityA',
  'liquidityB',
  'liquidityAAccount',
  'liquidityBAccount',
  'baseVault',
  'quoteVault',
  'vaultA',
  'vaultB',
]);

/** @param {unknown} value */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An address-shaped string, or null. Accepts the string itself or a small object
 * wrapping it, because RugCheck returns `liquidityAAccount` as either.
 * @param {unknown} value
 * @returns {string|null}
 */
export function readAddress(value) {
  const raw = isPlainObject(value) ? (value.address ?? value.pubkey ?? value.account) : value;
  if (typeof raw !== 'string') return null;
  if (raw.length < ADDRESS_MIN_CHARS || raw.length > ADDRESS_MAX_CHARS) return null;
  return BASE58_RE.test(raw) ? raw : null;
}

/**
 * RugCheck's normalised report keeps `markets` only under `raw` (see
 * normaliseTokenReport in src/data/rugcheck.js, which exposes lpLockedPct/lpMint/
 * marketCount but not the array), so both spellings are accepted.
 * @param {unknown} report
 * @returns {readonly unknown[]}
 */
export function readMarkets(report) {
  if (!isPlainObject(report)) return [];
  if (Array.isArray(report.markets)) return report.markets;
  if (isPlainObject(report.raw) && Array.isArray(report.raw.markets)) return report.raw.markets;
  return [];
}

/**
 * Every address layer 3 will refuse to count, WITH the reason it was collected.
 * Getting this set wrong makes every healthy token look concentrated, so it is
 * returned as auditable data rather than folded into a boolean.
 *
 * @param {unknown} pair Dexscreener-shaped pair (`pairAddress`)
 * @param {unknown} report RugCheck token report (`markets[]`)
 * @returns {readonly Readonly<{address: string, source: string}>[]} deduped,
 *   first source wins, incinerator first
 */
export function collectPoolAddresses(pair, report) {
  /** @type {{address: string, source: string}[]} */
  const found = [];
  const add = (value, source) => {
    const address = readAddress(value);
    if (address !== null) found.push({ address, source });
  };

  // buildExclusionSet always adds the incinerator; recorded here so the reported
  // provenance list matches the resulting address set exactly.
  add(KNOWN.INCINERATOR, 'config.KNOWN.INCINERATOR (burned supply)');

  if (isPlainObject(pair)) {
    add(pair.pairAddress, 'pair.pairAddress');
    add(pair.poolAddress, 'pair.poolAddress');
  }

  readMarkets(report).forEach((market, index) => {
    if (!isPlainObject(market)) return;
    for (const field of MARKET_HOLDER_FIELDS) {
      add(market[field], `rugcheckReport.markets[${index}].${field}`);
    }
  });

  const seen = new Set();
  return Object.freeze(
    found
      .filter((entry) => (seen.has(entry.address) ? false : seen.add(entry.address)))
      .map((entry) => Object.freeze({ ...entry })),
  );
}

/**
 * Split `ctx.getHolders()` into the holder list and the supply, without guessing
 * either. A missing supply stays `undefined` so readSupply() throws with its own
 * message instead of this layer inventing a denominator.
 * @param {unknown} response
 * @returns {{list: unknown, supply: unknown, declaredField: string|null}}
 */
export function readHoldersResponse(response) {
  if (Array.isArray(response)) return { list: response, supply: undefined, declaredField: null };
  if (!isPlainObject(response)) {
    throw new TypeError(
      `ctx.getHolders() returned ${response === null ? 'null' : typeof response}: layer 3 ` +
        'cannot measure concentration without a holder list and a supply',
    );
  }
  return {
    list: Array.isArray(response.holders) ? response.holders : response,
    supply: response.supply ?? response.totalSupply,
    declaredField: typeof response.amountField === 'string' ? response.amountField : null,
  };
}

/**
 * Refuse a percentage whose numerator and denominator may be in different units.
 *
 * A ui-amount balance over a raw supply does NOT trip holderConcentration's
 * "balance exceeds supply" guard -- it is far smaller -- so it would silently
 * understate concentration by 10**decimals and PASS. That is the one failure
 * direction this layer must never take, so it is checked explicitly here.
 *
 * @param {{declared: string|null, read: string, supply: unknown}} p
 */
export function assertSameUnit({ declared, read, supply }) {
  if (declared !== null && declared !== read) {
    throw new TypeError(
      `ctx.getHolders() declared balances in '${declared}' but the entries carry '${read}': ` +
        'refusing to divide by a supply of unknown unit',
    );
  }
  if (read !== RAW_AMOUNT_FIELD && !(isPlainObject(supply) && supply[read] !== undefined)) {
    throw new TypeError(
      `holder balances were read from '${read}', not raw '${RAW_AMOUNT_FIELD}', and the supply ` +
        `carries no '${read}' field: a ui-amount balance over a raw supply understates ` +
        'concentration by 10**decimals, so the percentage is refused',
    );
  }
}

/**
 * A percentage that may be compared against a threshold, or a throw. NaN, null
 * and a nonsense 300% all fail closed rather than silently comparing false
 * against every limit (which reads as a pass).
 * @param {unknown} pct
 * @param {string} label
 * @returns {number}
 */
export function assertUsablePct(pct, label) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    throw new TypeError(`${label} is ${String(pct)}, not a finite percentage`);
  }
  if (pct < 0 || pct > PCT_MAX) {
    throw new RangeError(`${label} is ${pct}, outside 0-${PCT_MAX}: unusable as a percentage`);
  }
  return pct;
}

/**
 * Optional evidence fetch. A pair or report we cannot read only ever SHRINKS the
 * exclusion set, which inflates measured concentration -- strictly stricter, so
 * it is recorded as a gap rather than turned into layer 3's own failure. The
 * insider graph is deliberately NOT fetched this way: unknown insider
 * concentration must become an ERROR, never a zero.
 *
 * @param {unknown} fn candidate fetcher from the gate context
 * @param {string} label used verbatim in the recorded gap
 * @param {string[]} gaps local accumulator; never a caller-owned array
 * @returns {Promise<object|null>} null whenever nothing usable was obtained
 */
export async function optionalEvidence(fn, label, gaps) {
  if (typeof fn !== 'function') {
    gaps.push(`${label} was not provided by the gate context`);
    return null;
  }
  try {
    const value = await fn();
    if (value === null || value === undefined) {
      gaps.push(`${label} returned no data`);
      return null;
    }
    return value;
  } catch (err) {
    gaps.push(`${label} failed: ${err?.message ?? String(err)}`);
    return null;
  }
}
