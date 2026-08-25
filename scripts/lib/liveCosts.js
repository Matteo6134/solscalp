/**
 * Turning live gate output into a cost breakdown the engine can price entries with.
 *
 * Shared by scripts/paper.js and scripts/dash.js so there is exactly one place
 * that decides how a Jupiter price impact becomes a modelled round-trip cost. Two
 * copies would drift, and the dashboard would then show an entry decision the
 * paper engine would not actually make.
 *
 * FAIL CLOSED: a mint whose impact figures cannot be read gets NO cost breakdown,
 * and decideEntry refuses any mint without one. Never a guessed cost.
 */

import { RISK, SAFETY } from '../../src/config.js';
import { estimateRoundTripCost } from '../../src/paper/costModel.js';

/** Sanity floor for an implied SOL price; below this the division was nonsense. */
const MIN_PLAUSIBLE_SOL_USD = 1;
/** Used only when no SOL-quoted pair is present in the snapshot. */
export const SOL_PRICE_FALLBACK_USD = 150;
const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * Imply SOL/USD from any SOL-quoted pair in the snapshot: priceUsd / priceNative
 * is USD per SOL. Free, and avoids another rate-limited request.
 * @param {readonly object[]} pairs
 * @returns {number}
 */
export function solPriceFrom(pairs) {
  for (const pair of pairs) {
    if (pair?.quoteToken?.address !== WSOL) continue;
    if (pair.priceUsd === null || !pair.priceNative) continue;
    const implied = pair.priceUsd / pair.priceNative;
    if (Number.isFinite(implied) && implied > MIN_PLAUSIBLE_SOL_USD) return implied;
  }
  return SOL_PRICE_FALLBACK_USD;
}

/**
 * Build `mint -> CostBreakdown` from the price impacts layer 1 already measured.
 *
 * Layer 1 records Jupiter's `priceImpactPct` verbatim, which is a DECIMAL
 * FRACTION despite the name (0.0042 == 0.42%) -- costModel documents and enforces
 * that, so the value is passed straight through without scaling.
 *
 * @param {object} p
 * @param {readonly object[]} p.pairs
 * @param {Record<string, object>} p.gates mint -> GateResult
 * @param {number} p.solPriceUsd
 * @param {number} [p.positionSizeUsd]
 * @returns {Record<string, object>} only mints whose cost is genuinely knowable
 */
export function costsFor({ pairs, gates, solPriceUsd, positionSizeUsd = RISK.positionSizeUsd }) {
  const costs = {};
  for (const pair of pairs) {
    const facts = gates[pair.mint]?.layers?.find((l) => l.layer === 'layer1-sellsim')?.facts;
    const buy = facts?.buyPriceImpactPct;
    const sell = facts?.sellPriceImpactPct;
    if (typeof buy !== 'number' || typeof sell !== 'number') continue;
    try {
      costs[pair.mint] = estimateRoundTripCost({
        positionSizeUsd,
        solPriceUsd,
        buyQuote: { priceImpactPct: buy, slippageBps: SAFETY.layer1.quoteSlippageBps },
        sellQuote: { priceImpactPct: sell, slippageBps: SAFETY.layer1.quoteSlippageBps },
      });
    } catch {
      // An impact figure outside the documented range means we cannot price the
      // trade. Omitting the entry is correct; inventing a cost would not be.
    }
  }
  return costs;
}
