/**
 * Feature Extraction & Normalization for Token Machine Learning.
 * Transforms raw DexScreener/RPC/Gate metrics into normalized numeric vectors.
 */

/** Feature labels in exact index order */
export const FEATURE_NAMES = Object.freeze([
  'log_liquidity',
  'log_market_cap',
  'liq_to_mc_ratio',
  'log_age_minutes',
  'log_vol_m5',
  'log_vol_h1',
  'vol_acceleration',
  'buy_sell_ratio_m5',
  'price_change_m5',
  'price_change_h1',
  'gate_buyable',
  'slippage_impact_pct',
]);

/** Number of features in each vector */
export const FEATURE_DIM = FEATURE_NAMES.length;

/**
 * Safely extract a normalized float or fallback.
 * @param {number|null|undefined} v
 * @param {number} fallback
 */
function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Log scale transformation (safe for zero and negative values)
 * @param {number} v
 */
function log1p(v) {
  return Math.log(Math.max(0, v) + 1);
}

/**
 * Extract feature vector from pair, signals, and gate data.
 * @param {object} p
 * @param {object} p.pair            DexScreener pair
 * @param {object} [p.signals]       readSignals output
 * @param {object} [p.gateResult]    runGate output
 * @param {object} [p.costBreakdown] round trip cost breakdown
 * @returns {Float64Array} normalized feature vector
 */
export function extractFeatures({ pair = {}, signals = {}, gateResult = {}, costBreakdown = {} } = {}) {
  const vec = new Float64Array(FEATURE_DIM);

  const liq = num(pair.liquidityUsd ?? signals.liquidityUsd, 0);
  const mc = num(pair.marketCap ?? pair.fdv ?? signals.marketCapUsd, 0);
  const age = num(signals.ageMinutes ?? pair.ageMinutes, 0);
  const volM5 = num(signals.volumeM5Usd ?? pair.volumeUsd?.m5, 0);
  const volH1 = num(signals.volumeH1Usd ?? pair.volumeUsd?.h1, 0);
  const bsRatio = num(signals.buySellRatioM5 ?? pair.buySellRatioM5, 1.0);
  const pcM5 = num(signals.priceChangeM5Pct ?? pair.priceChangePct?.m5, 0);
  const pcH1 = num(signals.priceChangeH1Pct ?? pair.priceChangePct?.h1, 0);
  const buyable = gateResult.buyable === true ? 1.0 : 0.0;
  
  // Extract round-trip slippage/impact
  const slippage = num(costBreakdown.entryUsd, 0) + num(costBreakdown.exitUsd, 0);

  // 1. log(Liquidity) (typically 8.0 to 14.0 for $3k to $1M)
  vec[0] = log1p(liq) / 15.0;

  // 2. log(Market Cap) (typically 9.0 to 16.0 for $10k to $10M)
  vec[1] = log1p(mc) / 18.0;

  // 3. Liquidity / Market Cap Ratio (healthy is ~0.15 to 0.40)
  vec[2] = mc > 0 ? Math.min(1.0, Math.max(0.0, liq / mc)) : 0.0;

  // 4. log(Age Minutes)
  vec[3] = log1p(age) / 10.0;

  // 5. log(Volume M5)
  vec[4] = log1p(volM5) / 15.0;

  // 6. log(Volume H1)
  vec[5] = log1p(volH1) / 18.0;

  // 7. Volume Acceleration (volM5 * 12 / volH1)
  const volAccel = volH1 > 0 ? (volM5 * 12) / volH1 : 1.0;
  vec[6] = Math.min(5.0, Math.max(0.0, volAccel)) / 5.0;

  // 8. Buy/Sell Ratio M5 (clamped [0, 5])
  vec[7] = Math.min(5.0, Math.max(0.0, bsRatio)) / 5.0;

  // 9. Price Change M5 (clamped [-100%, +300%])
  vec[8] = (Math.min(300, Math.max(-100, pcM5)) + 100) / 400.0;

  // 10. Price Change H1 (clamped [-100%, +1000%])
  vec[9] = (Math.min(1000, Math.max(-100, pcH1)) + 100) / 1100.0;

  // 11. Gate Buyable (0 or 1)
  vec[10] = buyable;

  // 12. Round trip cost / slippage ratio
  vec[11] = Math.min(1.0, Math.max(0.0, slippage / 40.0));

  return vec;
}
