/**
 * Round-trip cost model.
 *
 * Every strategy in this repo has to clear its own costs before it makes a
 * cent, so this file is the arithmetic that decides whether an "edge" is real.
 * An error here does not crash anything -- it silently fabricates profit.
 * Therefore:
 *   - every threshold comes from COSTS / SAFETY in src/config.js,
 *   - slippage comes from the LIVE quote, never from a guess,
 *   - unusable inputs THROW instead of defaulting to a cheap zero.
 *
 * Refundable ATA rent is deliberately kept OUT of totalUsd. See
 * "ATA rent: tied-up capital, not a loss" on estimateRoundTripCost.
 */

import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { COSTS, SAFETY } from '../config.js';
import {
  assertFiniteNumber,
  assertNonNegativeNumber,
  assertPlainObject,
  assertPositiveNumber,
} from './guards.js';

/** Unit conversions, not tunables. */
const BPS_PER_PCT = 100;
const PCT_PER_UNIT = 100;
/** A round trip is buy + sell: two signed transactions, two router fees. */
const LEGS_PER_ROUND_TRIP = 2;

/** @typedef {{ priceImpactPct?: unknown, slippageBps?: unknown }} Quote */

/** @param {number} bps @returns {number} the same quantity as a percentage */
const bpsToPct = (bps) => bps / BPS_PER_PCT;

/** @param {number} lamports @param {number} solPriceUsd */
const lamportsToUsd = (lamports, solPriceUsd) =>
  (lamports / LAMPORTS_PER_SOL) * solPriceUsd;

/**
 * Read priceImpactPct off a Jupiter quote.
 *
 * CONTRACT: Jupiter reports `priceImpactPct` as a DECIMAL FRACTION despite the
 * name -- "0.0042" means 0.42%, not 0.0042%. We return it converted to a
 * percentage. Anything above 1.0 (100%) is treated as a malformed field rather
 * than a 4200% route, and rejected.
 *
 * Fail closed: a missing, blank or unparseable field throws. Reading it as 0
 * would price a honeypot-thin route as frictionless.
 *
 * @param {Quote|undefined} quote
 * @param {string} label
 * @returns {number} price impact as a percentage, floored at 0
 */
function readPriceImpactPct(quote, label) {
  assertPlainObject(quote, label);
  const raw = /** @type {Record<string, unknown>} */ (quote).priceImpactPct;
  if (raw === undefined || raw === null) {
    throw new TypeError(
      `${label}.priceImpactPct is missing; refusing to assume zero slippage`,
    );
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new TypeError(
      `${label}.priceImpactPct must be a number or numeric string, got ${typeof raw}`,
    );
  }
  if (typeof raw === 'string' && raw.trim().length === 0) {
    throw new TypeError(
      `${label}.priceImpactPct is blank; refusing to assume zero slippage`,
    );
  }
  const fraction = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(fraction)) {
    throw new TypeError(
      `${label}.priceImpactPct is not a finite number: ${JSON.stringify(raw)}`,
    );
  }
  if (fraction > 1) {
    throw new RangeError(
      `${label}.priceImpactPct=${fraction} exceeds 1.0; the field is a decimal ` +
        `fraction (0.0042 == 0.42%), so this payload is malformed or the route is unusable`,
    );
  }
  // Jupiter occasionally returns a tiny negative impact (fill better than mid).
  // A favourable leg is never allowed to subsidise the other costs.
  return Math.max(0, fraction) * PCT_PER_UNIT;
}

/**
 * Worst tolerated slippage for a leg: what the router is allowed to fill at.
 * Uses the slippageBps echoed by the quote when present, else the configured
 * probe tolerance. Only ever used for the worstCase* fields.
 *
 * @param {Quote|undefined} quote
 * @returns {number} tolerance as a percentage
 */
function readSlippageTolerancePct(quote) {
  const raw =
    typeof quote === 'object' && quote !== null
      ? /** @type {Record<string, unknown>} */ (quote).slippageBps
      : undefined;
  const bps =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
      ? raw
      : SAFETY.layer1.quoteSlippageBps;
  return bpsToPct(bps);
}

/**
 * @typedef {Readonly<{
 *   positionSizeUsd: number,
 *   solPriceUsd: number,
 *   baseFeeUsd: number,
 *   priorityFeeUsd: number,
 *   ataRentUsd: number,
 *   ataRentRefundableUsd: number,
 *   ataRentNetUsd: number,
 *   routerFeeUsd: number,
 *   buySlippageUsd: number,
 *   sellSlippageUsd: number,
 *   buySlippagePct: number,
 *   sellSlippagePct: number,
 *   routerFeePctPerLeg: number,
 *   buyProportionalPct: number,
 *   sellProportionalPct: number,
 *   fixedUsd: number,
 *   totalUsd: number,
 *   totalPct: number,
 *   worstCaseTotalUsd: number,
 *   worstCaseTotalPct: number,
 *   capitalRequiredUsd: number,
 *   slippageSource: string,
 * }>} CostBreakdown
 */

/**
 * Full round-trip (buy + sell) cost of a paper position.
 *
 * ATA rent: tied-up capital, not a loss.
 *   COSTS.ataRentLamports is the rent-exempt deposit for the associated token
 *   account. It is RECOVERED in full when that account is closed, so it is NOT
 *   a cost of trading -- it is capital that cannot be deployed while the
 *   position is open. It is therefore reported three ways:
 *     ataRentUsd            - the deposit (tied-up capital, in capitalRequiredUsd)
 *     ataRentRefundableUsd  - the part recovered on close (all of it)
 *     ataRentNetUsd         - the unrecovered remainder, and the ONLY part
 *                             included in totalUsd
 *   Adding ataRentUsd into totalUsd as well would double-count it and overstate
 *   round-trip cost by ~0.75% of a 40 USD position, which is enough to reject
 *   genuinely profitable setups.
 *
 * @param {object} p
 * @param {number} p.positionSizeUsd gross USD notional deployed on the buy leg
 * @param {number} p.solPriceUsd     live SOL/USD, for lamport-denominated fees
 * @param {Quote} [p.buyQuote]       live buy quote; required when COSTS.useLiveQuoteForSlippage
 * @param {Quote} [p.sellQuote]      live sell quote; required when COSTS.useLiveQuoteForSlippage
 * @returns {CostBreakdown} frozen breakdown
 */
export function estimateRoundTripCost({ positionSizeUsd, solPriceUsd, buyQuote, sellQuote }) {
  assertPositiveNumber(positionSizeUsd, 'positionSizeUsd');
  assertPositiveNumber(solPriceUsd, 'solPriceUsd');

  const useLiveQuotes = COSTS.useLiveQuoteForSlippage === true;
  const buySlippagePct = useLiveQuotes
    ? readPriceImpactPct(buyQuote, 'buyQuote')
    : bpsToPct(SAFETY.layer1.quoteSlippageBps);
  const sellSlippagePct = useLiveQuotes
    ? readPriceImpactPct(sellQuote, 'sellQuote')
    : bpsToPct(SAFETY.layer1.quoteSlippageBps);
  const slippageSource = useLiveQuotes
    ? 'live-quote:priceImpactPct'
    : 'config:SAFETY.layer1.quoteSlippageBps';

  // --- lamport-denominated, size-independent ---
  const baseFeeUsd = lamportsToUsd(
    COSTS.solBaseFeeLamports * LEGS_PER_ROUND_TRIP,
    solPriceUsd,
  );
  const priorityFeeUsd = lamportsToUsd(
    COSTS.priorityFeeLamports * LEGS_PER_ROUND_TRIP,
    solPriceUsd,
  );
  const ataRentUsd = lamportsToUsd(COSTS.ataRentLamports, solPriceUsd);
  const ataRentRefundableUsd = ataRentUsd; // fully recovered when the ATA closes
  const ataRentNetUsd = ataRentUsd - ataRentRefundableUsd; // == 0, kept explicit
  const fixedUsd = baseFeeUsd + priorityFeeUsd + ataRentNetUsd;

  // --- proportional, charged on both legs ---
  const routerFeePctPerLeg = bpsToPct(COSTS.routerFeeBps);
  const routerFeeUsd =
    positionSizeUsd * (routerFeePctPerLeg / PCT_PER_UNIT) * LEGS_PER_ROUND_TRIP;
  const buySlippageUsd = positionSizeUsd * (buySlippagePct / PCT_PER_UNIT);
  // Approximated at entry notional: the true exit notional is unknown until we
  // exit. breakEvenMovePct() applies these as rates instead, which handles the
  // compounding exactly.
  const sellSlippageUsd = positionSizeUsd * (sellSlippagePct / PCT_PER_UNIT);

  const totalUsd = fixedUsd + routerFeeUsd + buySlippageUsd + sellSlippageUsd;

  // Expected impact is not a bound: the router may legally fill anywhere up to
  // the requested tolerance. worstCase* prices that tail.
  const tolerancePct = Math.max(
    readSlippageTolerancePct(buyQuote),
    readSlippageTolerancePct(sellQuote),
  );
  const worstBuyPct = Math.max(buySlippagePct, tolerancePct);
  const worstSellPct = Math.max(sellSlippagePct, tolerancePct);
  const worstCaseTotalUsd =
    fixedUsd +
    routerFeeUsd +
    positionSizeUsd * ((worstBuyPct + worstSellPct) / PCT_PER_UNIT);

  return Object.freeze({
    positionSizeUsd,
    solPriceUsd,
    baseFeeUsd,
    priorityFeeUsd,
    ataRentUsd,
    ataRentRefundableUsd,
    ataRentNetUsd,
    routerFeeUsd,
    buySlippageUsd,
    sellSlippageUsd,
    buySlippagePct,
    sellSlippagePct,
    routerFeePctPerLeg,
    /** Rates that scale with notional, per leg -- the inputs to break-even. */
    buyProportionalPct: routerFeePctPerLeg + buySlippagePct,
    sellProportionalPct: routerFeePctPerLeg + sellSlippagePct,
    fixedUsd,
    totalUsd,
    totalPct: (totalUsd / positionSizeUsd) * PCT_PER_UNIT,
    worstCaseTotalUsd,
    worstCaseTotalPct: (worstCaseTotalUsd / positionSizeUsd) * PCT_PER_UNIT,
    /** Cash that must be free up front, incl. the refundable rent deposit. */
    capitalRequiredUsd: positionSizeUsd + ataRentUsd + baseFeeUsd + priorityFeeUsd,
    slippageSource,
  });
}

/**
 * Gross percentage price move required just to break even.
 *
 * Not simply totalPct: the proportional costs are RATES, and the sell-side rate
 * applies to the (larger) exit notional. With P = position, F = fixed costs,
 * b = buy proportional rate, s = sell proportional rate:
 *
 *   P(1-b)(1+m)(1-s) - F = P   =>   m = (P+F) / (P(1-b)(1-s)) - 1
 *
 * At RISK.positionSizeUsd (40 USD) with live quotes this lands around 2-4%
 * (the range documented on COSTS in src/config.js) -- and always slightly
 * ABOVE totalPct, never below it. tests/paper/costModel.test.js asserts that
 * order of magnitude.
 *
 * @param {CostBreakdown} costBreakdown output of estimateRoundTripCost
 * @returns {number} required gross move, as a percentage
 */
export function breakEvenMovePct(costBreakdown) {
  assertPlainObject(costBreakdown, 'costBreakdown');
  const positionSizeUsd = assertPositiveNumber(
    costBreakdown.positionSizeUsd,
    'costBreakdown.positionSizeUsd',
  );
  const fixedUsd = assertNonNegativeNumber(costBreakdown.fixedUsd, 'costBreakdown.fixedUsd');
  const buyPct = assertFiniteNumber(
    costBreakdown.buyProportionalPct,
    'costBreakdown.buyProportionalPct',
  );
  const sellPct = assertFiniteNumber(
    costBreakdown.sellProportionalPct,
    'costBreakdown.sellProportionalPct',
  );

  const buyKeep = 1 - buyPct / PCT_PER_UNIT;
  const sellKeep = 1 - sellPct / PCT_PER_UNIT;
  if (buyKeep <= 0 || sellKeep <= 0) {
    throw new RangeError(
      `round-trip costs consume the entire position (buy ${buyPct}%, sell ${sellPct}%): ` +
        'no break-even move exists',
    );
  }

  return (
    ((positionSizeUsd + fixedUsd) / (positionSizeUsd * buyKeep * sellKeep) - 1) * PCT_PER_UNIT
  );
}

/**
 * Does an expected gross move clear its own round-trip cost?
 * Convenience so strategy code writes the comparison exactly once.
 *
 * @param {CostBreakdown} costBreakdown
 * @param {number} expectedGrossMovePct
 * @returns {Readonly<{ clears: boolean, breakEvenPct: number, edgePct: number }>}
 */
export function clearsCosts(costBreakdown, expectedGrossMovePct) {
  assertFiniteNumber(expectedGrossMovePct, 'expectedGrossMovePct');
  const breakEvenPct = breakEvenMovePct(costBreakdown);
  return Object.freeze({
    clears: expectedGrossMovePct > breakEvenPct,
    breakEvenPct,
    edgePct: expectedGrossMovePct - breakEvenPct,
  });
}
