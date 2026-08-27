/**
 * Paper-trading decision engine -- PURE. No network, no clock, no randomness.
 *
 * WHAT THIS MODULE PROVES
 *   Given a pool snapshot, a gate result and a cost breakdown, whether the
 *   configured rules say enter or exit, and WHY -- every failed condition is
 *   returned, because the reasons are the log and the log is the evidence.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about the future. The entry conditions detect a move that has
 *   ALREADY STARTED in the last five minutes; no arrangement of these numbers
 *   can know a token is "about to" pump. The design record is explicit that
 *   price prediction is not honestly testable here, so this module is a rule
 *   evaluator, never a forecaster. A PASS from it means "the rules fired", not
 *   "this trade is good".
 *
 * WHY IT IS PURE
 *   Time arrives as `now`, prices arrive as a snapshot, randomness (for the
 *   baseline) arrives as an injected rng. There is no Date.now() and no
 *   Math.random() anywhere in this file, so a paper run is replayable from its
 *   recording and a test sees exactly one possible behaviour.
 *
 * FAIL CLOSED, HERE TOO
 *   An unknown input is never read as a satisfied condition. A null market cap,
 *   a missing volume figure or an absent creation timestamp means the condition
 *   CANNOT be evaluated, which means NO ENTRY. Unknown momentum is not
 *   permission to buy.
 *
 * All state transitions go through src/paper/portfolio.js; none of the
 * accounting is reimplemented here.
 */

import { RISK, STRATEGY } from '../config.js';
import { clearsCosts } from './costModel.js';
import {
  assertFiniteNumber,
  assertNonNegativeNumber,
  assertPlainObject,
  assertPositiveNumber,
  assertTimestampMs,
} from './guards.js';
import { closePosition, markPositions, openPosition, shouldKillSwitch } from './portfolio.js';

/** Unit conversions, not tunables. */
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const PCT_PER_UNIT = 100;
/** Five-minute windows in an hour: turns vol(m5) into an hourly-rate comparison. */
const M5_WINDOWS_PER_HOUR = 12;
/** A round trip is two legs; fixed costs and router fees split evenly across them. */
const LEGS_PER_ROUND_TRIP = 2;

/** Exit reasons, in the order they are evaluated. First match wins. */
export const EXIT_REASON = Object.freeze({
  GATE_RECHECK: 'gateRecheck',
  STOP_LOSS: 'stopLoss',
  TRAILING_STOP: 'trailingStop',
  TAKE_PROFIT: 'takeProfit',
  TIME_STOP: 'timeStop',
});

/* -------------------------------------------------------------------------- */
/* cost split                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Split a round-trip breakdown into its two legs.
 *
 * portfolio.openPosition charges the ENTRY leg and closePosition charges the
 * EXIT leg, so the split must partition the total exactly: entry + exit ===
 * totalUsd, no cost charged twice and none dropped. Fixed costs and router fees
 * are per-leg by construction (costModel multiplies them by 2); slippage is
 * already attributed to a specific leg.
 *
 * @param {object} costBreakdown output of estimateRoundTripCost
 * @returns {Readonly<{ entryUsd: number, exitUsd: number, totalUsd: number }>}
 */
export function splitLegCosts(costBreakdown) {
  const c = assertPlainObject(costBreakdown, 'costBreakdown');
  const fixedUsd = assertNonNegativeNumber(c.fixedUsd, 'costBreakdown.fixedUsd');
  const routerFeeUsd = assertNonNegativeNumber(c.routerFeeUsd, 'costBreakdown.routerFeeUsd');
  const buySlippageUsd = assertNonNegativeNumber(
    c.buySlippageUsd,
    'costBreakdown.buySlippageUsd',
  );
  const sellSlippageUsd = assertNonNegativeNumber(
    c.sellSlippageUsd,
    'costBreakdown.sellSlippageUsd',
  );

  const perLegFlat = (fixedUsd + routerFeeUsd) / LEGS_PER_ROUND_TRIP;
  return Object.freeze({
    entryUsd: perLegFlat + buySlippageUsd,
    exitUsd: perLegFlat + sellSlippageUsd,
    totalUsd: fixedUsd + routerFeeUsd + buySlippageUsd + sellSlippageUsd,
  });
}

/* -------------------------------------------------------------------------- */
/* signals                                                                    */
/* -------------------------------------------------------------------------- */

/** @returns {number|null} finite number or null. Unknown stays unknown. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Age in minutes, recomputed from `now` rather than trusting the snapshot's own
 * `ageMinutes` (which was fixed at fetch time and goes stale in a slow loop).
 */
function ageMinutesAt(pair, now) {
  const createdAt = num(pair.pairCreatedAtMs);
  if (createdAt === null) return null;
  return (now - createdAt) / MS_PER_MINUTE;
}

/**
 * Every derived quantity the entry rules read, each `null` when its inputs are
 * unknown. Extracted so the rule list below is a flat set of comparisons and so
 * the signals can be logged verbatim next to the decision.
 * @param {object} pair
 * @param {number} now epoch ms
 */
export function readSignals(pair, now) {
  const volumeUsd = pair.volumeUsd ?? {};
  const priceChangePct = pair.priceChangePct ?? {};
  const txns = pair.txns ?? {};
  const m5Txns = txns.m5 ?? {};

  const volM5 = num(volumeUsd.m5);
  const volH1 = num(volumeUsd.h1);
  const buys = num(m5Txns.buys);
  const sells = num(m5Txns.sells);

  return Object.freeze({
    ageMinutes: ageMinutesAt(pair, now),
    marketCapUsd: num(pair.marketCap),
    liquidityUsd: num(pair.liquidityUsd),
    priceUsd: num(pair.priceUsd),
    volumeM5Usd: volM5,
    volumeH1Usd: volH1,
    txnsH1: (() => {
      const h1 = txns.h1 ?? {};
      const b = num(h1.buys);
      const s = num(h1.sells);
      return b === null || s === null ? null : b + s;
    })(),
    priceChangeM5Pct: num(priceChangePct.m5),
    priceChangeH1Pct: num(priceChangePct.h1),
    /**
     * Buys per sell over the last 5 minutes. Zero sells with real buys is not
     * "infinitely bullish" -- it is a pool nobody has exited yet, which is
     * unmeasurable rather than good, so it stays null.
     */
    buySellRatioM5: buys === null || sells === null || sells === 0 ? null : buys / sells,
    /** Is the move accelerating, or merely ongoing? vol(m5) annualised to an hour. */
    volumeAccelerationRatio:
      volM5 === null || volH1 === null || volH1 === 0
        ? null
        : (volM5 * M5_WINDOWS_PER_HOUR) / volH1,
    quoteMint: pair.quoteToken?.address ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* entry                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the active universe filter. A profile from UNIVERSE_PROFILES may be
 * passed in; `quoteMints` always comes from STRATEGY.universe because it is a
 * safety choice (an exotic quote token hides its own rug risk), not a tuning knob.
 * @param {object} [override]
 */
function resolveUniverse(override) {
  if (override === undefined) return STRATEGY.universe;
  assertPlainObject(override, 'universe');
  return Object.freeze({
    ...STRATEGY.universe,
    ...override,
    // Re-asserted AFTER the spread, deliberately: a profile may widen how small
    // or young we go, but it must never widen which quote tokens are acceptable.
    // That is a safety choice, and a caller-supplied profile is not allowed to
    // reach it -- a test pins this.
    quoteMints: STRATEGY.universe.quoteMints,
  });
}

/**
 * Push a reason when a condition is not satisfied OR cannot be evaluated.
 * `value === null` yields the "unknown" reason: fail closed, never a silent pass.
 */
function require_(reasons, ok, value, label, detail) {
  if (value === null) {
    // Deliberately does NOT quote `detail`: that text formats the value, and
    // interpolating "unknown" into it produces nonsense. The label names the
    // check, which is all a reader needs.
    reasons.push(`${label} unknown -- cannot be evaluated (fail closed: no entry)`);
    return;
  }
  if (!ok) reasons.push(detail);
}

/**
 * Should we open a position in this pair?
 *
 * ALL of the following must hold: the safety gate says buyable, the pair is in
 * the universe (age / volume / txns / market-cap window / quote mint), the
 * momentum conditions fire, a position slot is free, and the expected gross move
 * clears its own round-trip cost. That last one is arithmetic, not opinion: an
 * entry whose expected move does not beat breakEvenMovePct is rejected even when
 * every signal looks perfect.
 *
 * @param {object} p
 * @param {object} p.pair            Dexscreener Pair snapshot
 * @param {object} p.portfolio       frozen portfolio
 * @param {object} p.gateResult      runGate result; must be buyable
 * @param {object} p.costBreakdown   estimateRoundTripCost output
 * @param {number} p.now             epoch ms
 * @param {object} [p.universe]      UNIVERSE_PROFILES entry; defaults to STRATEGY.universe
 * @param {boolean} [p.momentum]     when false, the STRATEGY.entry momentum block is
 *   skipped and every other check still applies. This exists for the random-entry
 *   baseline in src/baseline/monkey.js: the comparison is only meaningful if the two
 *   run the SAME gate, universe, capacity and cost checks, so they share this one
 *   implementation and differ in exactly one flag.
 * @returns {Readonly<{enter: boolean, reasons: readonly string[], signals: object}>}
 */
export function decideEntry({
  pair,
  portfolio,
  gateResult,
  costBreakdown,
  now,
  universe,
  momentum = true,
}) {
  assertPlainObject(pair, 'pair');
  assertPlainObject(portfolio, 'portfolio');
  assertTimestampMs(now, 'now');
  const uni = resolveUniverse(universe);
  const cfg = STRATEGY.entry;
  const signals = readSignals(pair, now);
  const reasons = [];

  // --- the gate is not negotiable, and it is checked first ---
  if (!assertPlainObject(gateResult, 'gateResult').buyable) {
    const why = Array.isArray(gateResult.reasons) && gateResult.reasons.length > 0
      ? gateResult.reasons.join('; ')
      : 'gate did not return buyable';
    reasons.push(`safety gate blocked: ${why}`);
  }

  // --- capacity ---
  const openCount = Object.keys(portfolio.positions ?? {}).length;
  if (openCount >= RISK.maxConcurrentPositions) {
    reasons.push(
      `no free slot: ${openCount} positions open, max ${RISK.maxConcurrentPositions}`,
    );
  }
  if (Object.hasOwn(portfolio.positions ?? {}, pair.mint)) {
    reasons.push(`already holding ${pair.mint} (one position per mint)`);
  }

  reasons.push(...universeReasons(pair, now, universe, signals));

  // --- momentum: a move that has already started ---
  if (momentum) {
  require_(
    reasons,
    signals.priceChangeM5Pct >= cfg.minPriceChangeM5Pct,
    signals.priceChangeM5Pct,
    '5m price change',
    `5m change ${fmt(signals.priceChangeM5Pct, cfg.minPriceChangeM5Pct)}% below minimum ${cfg.minPriceChangeM5Pct}%`,
  );
  require_(
    reasons,
    signals.priceChangeM5Pct <= cfg.maxPriceChangeM5Pct,
    signals.priceChangeM5Pct,
    '5m price change',
    `5m change ${fmt(signals.priceChangeM5Pct, cfg.maxPriceChangeM5Pct)}% above maximum ${cfg.maxPriceChangeM5Pct}% ` +
      '(already vertical -- we would be the exit liquidity)',
  );
  require_(
    reasons,
    signals.priceChangeH1Pct >= cfg.minPriceChangeH1Pct,
    signals.priceChangeH1Pct,
    '1h price change',
    `1h change ${fmt(signals.priceChangeH1Pct, cfg.minPriceChangeH1Pct)}% below minimum ${cfg.minPriceChangeH1Pct}%`,
  );
  require_(
    reasons,
    signals.buySellRatioM5 >= cfg.minBuySellRatioM5,
    signals.buySellRatioM5,
    '5m buy/sell ratio',
    `5m buy/sell ${fmt(signals.buySellRatioM5, cfg.minBuySellRatioM5)} below minimum ${cfg.minBuySellRatioM5} ` +
      '(the move is being sold into)',
  );
  require_(
    reasons,
    signals.volumeAccelerationRatio >= cfg.minVolumeAccelerationRatio,
    signals.volumeAccelerationRatio,
    'volume acceleration',
    `volume acceleration ${fmt(signals.volumeAccelerationRatio)} below minimum ` +
      `${cfg.minVolumeAccelerationRatio} (ongoing, not accelerating)`,
  );
  }

  // --- and it must pay for itself ---
  // breakEvenMovePct THROWS when the round trip consumes the whole position (a
  // pool so thin that the probe moves the price ~100%). That is the most emphatic
  // possible "do not enter", so it is converted into a reason rather than allowed
  // to escape: one pathological token must not abort a tick and take every other
  // position's exit evaluation down with it.
  let costs;
  try {
    costs = clearsCosts(costBreakdown, cfg.expectedGrossMovePct);
  } catch (err) {
    costs = Object.freeze({ clears: false, breakEvenPct: Infinity, edgePct: -Infinity });
    reasons.push(`round trip is not priceable, so not enterable: ${err?.message ?? err}`);
  }
  if (!costs.clears && Number.isFinite(costs.breakEvenPct)) {
    reasons.push(
      `expected gross move ${cfg.expectedGrossMovePct}% does not clear break-even ` +
        `${costs.breakEvenPct.toFixed(2)}% (edge ${costs.edgePct.toFixed(2)}%)`,
    );
  }

  return Object.freeze({
    enter: reasons.length === 0,
    reasons: Object.freeze(reasons),
    signals,
    costs: Object.freeze({ ...costs }),
  });
}

/**
 * The universe filter on its own: is this pair even eligible?
 *
 * Exported because scripts/scan.js screens a candidate list BEFORE paying for a
 * gate run, and it must screen on exactly the same rules the engine will later
 * apply. Two copies of this logic would drift, and a scanner that surfaces
 * candidates the engine then refuses is worse than no scanner.
 *
 * @param {object} pair
 * @param {number} now epoch ms
 * @param {object} [universe] UNIVERSE_PROFILES entry; defaults to STRATEGY.universe
 * @param {object} [precomputed] readSignals output, to avoid recomputing it
 * @returns {readonly string[]} empty when the pair is eligible
 */
export function universeReasons(pair, now, universe, precomputed) {
  const uni = resolveUniverse(universe);
  const signals = precomputed ?? readSignals(pair, now);
  const reasons = [];
  const maxAgeMinutes = uni.maxPairAgeHours * MINUTES_PER_HOUR;
  require_(
    reasons,
    signals.ageMinutes >= uni.minPairAgeMinutes,
    signals.ageMinutes,
    'pair age',
    `pair age ${fmt(signals.ageMinutes)}m below minimum ${uni.minPairAgeMinutes}m`,
  );
  require_(
    reasons,
    signals.ageMinutes <= maxAgeMinutes,
    signals.ageMinutes,
    'pair age',
    `pair age ${fmt(signals.ageMinutes)}m above maximum ${maxAgeMinutes}m ` +
      `(${uni.maxPairAgeHours}h)`,
  );
  require_(
    reasons,
    signals.marketCapUsd <= uni.maxMarketCapUsd,
    signals.marketCapUsd,
    'market cap',
    `market cap ${fmt(signals.marketCapUsd, uni.maxMarketCapUsd)} above ceiling ${uni.maxMarketCapUsd} ` +
      '(too big to multiply)',
  );
  require_(
    reasons,
    signals.marketCapUsd >= uni.minMarketCapUsd,
    signals.marketCapUsd,
    'market cap',
    `market cap ${fmt(signals.marketCapUsd, uni.minMarketCapUsd)} below floor ${uni.minMarketCapUsd} ` +
      '(no float to exit into)',
  );
  require_(
    reasons,
    signals.volumeH1Usd >= uni.minVolumeH1Usd,
    signals.volumeH1Usd,
    '1h volume',
    `1h volume ${fmt(signals.volumeH1Usd, uni.minVolumeH1Usd)} below minimum ${uni.minVolumeH1Usd}`,
  );
  require_(
    reasons,
    signals.txnsH1 >= uni.minTxnsH1,
    signals.txnsH1,
    '1h txns',
    `1h txns ${fmt(signals.txnsH1, uni.minTxnsH1)} below minimum ${uni.minTxnsH1}`,
  );
  if (signals.quoteMint === null) {
    reasons.push('quote mint unknown: cannot confirm a SOL/USDC-quoted pair (fail closed)');
  } else if (!uni.quoteMints.includes(signals.quoteMint)) {
    reasons.push(`quote mint ${signals.quoteMint} is not in the permitted set`);
  }

  // The token being traded must not itself be one of the quote assets. The
  // trending feed is full of SOL/USDC pools, whose BASE mint is WSOL -- that is
  // the major pair, not a candidate to buy. They used to reach the screen and be
  // discarded as "market cap unknown", which is fail-closed working but for
  // entirely the wrong reason: Dexscreener reports no market cap for SOL because
  // the question is meaningless, not because the data is missing. Measured on one
  // trending page: 8 of 20 pools were SOL/USDC.
  //
  // Derived from quoteMints rather than a second list, so the two can never drift.
  if (typeof pair.mint === 'string' && uni.quoteMints.includes(pair.mint)) {
    reasons.push(
      `${pair.mint} is itself a quote asset, not a trade candidate ` +
        '(this is the major pair, e.g. SOL/USDC)',
    );
  }

  return Object.freeze(reasons);
}

/** Compact number for a reason string; 'unknown' for null. */
/**
 * A number for a refusal message, at enough precision to stay TRUE.
 *
 * Two decimals produced self-contradicting reasons: a buy/sell ratio of 1.2996
 * against a minimum of 1.3 printed as "1.30 below minimum 1.3", which reads as a
 * bug in the rule rather than a marginal token. When the rounded value would
 * print as equal to the threshold it is compared against, show more digits.
 *
 * @param {number|null} v
 * @param {number} [limit] the threshold this value is being reported against
 */
function fmt(v, limit) {
  if (v === null) return 'unknown';
  if (Math.abs(v) >= 1000) return Math.round(v).toString();
  const two = v.toFixed(2);
  if (limit !== undefined && Number(two) === Number(limit)) {
    // Enough to separate them, and trailing zeroes trimmed so a clear-cut case
    // never gains noise from a rule that exists for the marginal ones.
    return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }
  return two;
}

/* -------------------------------------------------------------------------- */
/* exit                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Should we close this position?
 *
 * PRECEDENCE, first match wins:
 *   1. gate recheck failed  -- a held token can BECOME a honeypot; leave at once
 *   2. stop loss            -- cap the loss before anything optional
 *   3. trailing stop        -- only once armed at trailingArmsAtPct off the peak
 *   4. take profit
 *   5. time stop            -- a scalp that has not worked is capital doing nothing
 *
 * A missing price is NOT an exit signal and NOT a hold: it is reported as
 * `priceUnknown`, and the caller decides. Guessing a price would fabricate pnl.
 *
 * @param {object} p
 * @param {object} p.position       portfolio Position
 * @param {object} [p.pair]         current snapshot (for priceUsd)
 * @param {number} [p.priceUsd]     explicit current price, overrides the pair
 * @param {number} p.now            epoch ms
 * @param {number} [p.peakPriceUsd] high-water mark since entry; defaults to entry price
 * @param {object} [p.gateRecheck]  recheckGate result for the held token
 * @returns {Readonly<{exit: boolean, reason: string|null, reasons: readonly string[],
 *   priceUnknown: boolean, pnlPct: number|null, peakPriceUsd: number}>}
 */
export function decideExit({ position, pair, priceUsd, now, peakPriceUsd, gateRecheck }) {
  const pos = assertPlainObject(position, 'position');
  assertTimestampMs(now, 'now');
  const cfg = STRATEGY.exit;
  const entry = assertPositiveNumber(pos.entryPriceUsd, 'position.entryPriceUsd');

  const price = num(priceUsd) ?? num(pair?.priceUsd);
  const peak = Math.max(num(peakPriceUsd) ?? entry, price ?? entry, entry);
  const reasons = [];

  // 1. the gate is re-run on open positions; any failure is an immediate exit
  if (cfg.exitOnGateRecheckFail && gateRecheck !== undefined && gateRecheck !== null) {
    const recheck = assertPlainObject(gateRecheck, 'gateRecheck');
    if (recheck.buyable !== true) {
      const why = Array.isArray(recheck.reasons) && recheck.reasons.length > 0
        ? recheck.reasons.join('; ')
        : 'recheck did not return buyable';
      return frozenExit(true, EXIT_REASON.GATE_RECHECK, [
        `gate recheck failed -- exiting immediately: ${why}`,
      ], false, price === null ? null : pnlPct(entry, price), peak);
    }
  }

  if (price === null) {
    return frozenExit(
      false,
      null,
      ['current price unknown: refusing to fabricate a pnl or an exit'],
      true,
      null,
      peak,
    );
  }

  const pnl = pnlPct(entry, price);
  const heldMinutes = (now - pos.openedTs) / MS_PER_MINUTE;
  const drawdownFromPeakPct = ((peak - price) / peak) * PCT_PER_UNIT;

  // 2. stop loss
  if (pnl <= -cfg.stopLossPct) {
    reasons.push(`stop loss: ${pnl.toFixed(2)}% at or below -${cfg.stopLossPct}%`);
    return frozenExit(true, EXIT_REASON.STOP_LOSS, reasons, false, pnl, peak);
  }

  // 3. trailing stop -- armed only after the position has been up trailingArmsAtPct
  const peakGainPct = pnlPct(entry, peak);
  const armed = peakGainPct >= cfg.trailingArmsAtPct;
  if (armed && drawdownFromPeakPct >= cfg.trailingStopPct) {
    reasons.push(
      `trailing stop: ${drawdownFromPeakPct.toFixed(2)}% off the peak ` +
        `(peak +${peakGainPct.toFixed(2)}%, armed at +${cfg.trailingArmsAtPct}%, ` +
        `trail ${cfg.trailingStopPct}%)`,
    );
    return frozenExit(true, EXIT_REASON.TRAILING_STOP, reasons, false, pnl, peak);
  }

  // 4. take profit
  if (pnl >= cfg.takeProfitPct) {
    reasons.push(`take profit: ${pnl.toFixed(2)}% at or above ${cfg.takeProfitPct}%`);
    return frozenExit(true, EXIT_REASON.TAKE_PROFIT, reasons, false, pnl, peak);
  }

  // 5. time stop
  if (heldMinutes >= cfg.timeStopMinutes) {
    reasons.push(
      `time stop: held ${heldMinutes.toFixed(1)}m at or above ${cfg.timeStopMinutes}m ` +
        `with ${pnl.toFixed(2)}% pnl`,
    );
    return frozenExit(true, EXIT_REASON.TIME_STOP, reasons, false, pnl, peak);
  }

  return frozenExit(false, null, reasons, false, pnl, peak);
}

const pnlPct = (entry, price) => ((price - entry) / entry) * PCT_PER_UNIT;

function frozenExit(exit, reason, reasons, priceUnknown, pnl, peakPriceUsd) {
  return Object.freeze({
    exit,
    reason,
    reasons: Object.freeze([...reasons]),
    priceUnknown,
    pnlPct: pnl,
    peakPriceUsd,
  });
}

/* -------------------------------------------------------------------------- */
/* reducer                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A fresh engine state. `peaks` lives here rather than on the Position because
 * portfolio.js is a tested, frozen value type and the high-water mark is a
 * strategy concern, not an accounting one.
 * @param {object} p
 * @param {object} p.portfolio
 * @param {string} [p.label] appears in the actions log, e.g. 'strategy' | 'baseline'
 */
export function createEngineState({ portfolio, label = 'strategy' }) {
  return Object.freeze({
    label,
    portfolio: assertPlainObject(portfolio, 'portfolio'),
    peaks: Object.freeze({}),
    actions: Object.freeze([]),
  });
}

/**
 * Advance the engine by one tick. PURE: returns a new frozen state and never
 * touches the one it was given.
 *
 * Order is deliberate -- mark, then exit, then enter. Marking first means the
 * kill switch and the exit rules see current prices; exiting before entering
 * frees a slot in the same tick, and means a tripped kill switch can still
 * close positions while it can never open one.
 *
 * @param {object} state    from createEngineState or a previous stepEngine
 * @param {object} tick
 * @param {number} tick.ts                epoch ms
 * @param {readonly object[]} [tick.pairs] candidate + held snapshots
 * @param {Record<string, object>} [tick.gateResults]  mint -> runGate result
 * @param {Record<string, object>} [tick.gateRechecks] mint -> recheckGate result
 * @param {Record<string, object>} [tick.costs]        mint -> cost breakdown
 * @param {number} [tick.sizeUsd]         position size; defaults to RISK.positionSizeUsd
 * @param {object} [tick.universe]        universe profile override
 * @param {Function} [tick.entryDecider]  defaults to decideEntry; the baseline injects its own
 * @returns {Readonly<{portfolio: object, peaks: object, actions: readonly object[],
 *   killSwitch: object, label: string}>}
 */
export function stepEngine(state, tick) {
  const s = assertPlainObject(state, 'state');
  const t = assertPlainObject(tick, 'tick');
  const ts = assertTimestampMs(t.ts, 'tick.ts');
  const pairs = Array.isArray(t.pairs) ? t.pairs : [];
  const gateResults = t.gateResults ?? {};
  const gateRechecks = t.gateRechecks ?? {};
  const costs = t.costs ?? {};
  const sizeUsd = t.sizeUsd ?? RISK.positionSizeUsd;
  const decide = typeof t.entryDecider === 'function' ? t.entryDecider : decideEntry;

  const priceOf = new Map();
  for (const pair of pairs) {
    const p = num(pair?.priceUsd);
    if (p !== null && p > 0) priceOf.set(pair.mint, p);
  }

  let portfolio = s.portfolio;
  const actions = [];
  /**
   * Mints exited during THIS tick. Without this, a take-profit exit is followed
   * immediately by a fresh entry in the same mint at the same price -- buying
   * back the top we just sold, and paying a full round trip in costs to do it.
   * One decision per mint per tick.
   */
  const closedThisTick = new Set();

  // --- 1. mark open positions at current prices -------------------------------
  const marks = Object.fromEntries(
    Object.keys(portfolio.positions).flatMap((mint) =>
      priceOf.has(mint) ? [[mint, priceOf.get(mint)]] : [],
    ),
  );
  if (Object.keys(marks).length > 0) {
    portfolio = markPositions(portfolio, { marks, ts });
  }

  // --- 2. update high-water marks --------------------------------------------
  const peaks = { ...s.peaks };
  for (const [mint, position] of Object.entries(portfolio.positions)) {
    const price = priceOf.get(mint) ?? position.lastPriceUsd;
    const prior = peaks[mint] ?? position.entryPriceUsd;
    peaks[mint] = Math.max(prior, price);
  }

  // --- 3. exits (before entries: frees a slot, and always allowed) -----------
  for (const [mint, position] of Object.entries(portfolio.positions)) {
    const verdict = decideExit({
      position,
      priceUsd: priceOf.get(mint),
      now: ts,
      peakPriceUsd: peaks[mint],
      gateRecheck: gateRechecks[mint],
    });
    if (!verdict.exit) {
      if (verdict.priceUnknown) {
        actions.push(frozenAction('hold-unpriced', mint, ts, verdict.reasons));
      }
      continue;
    }
    const exitPrice = priceOf.get(mint) ?? position.lastPriceUsd;
    const legs = costs[mint] === undefined ? null : splitLegCosts(costs[mint]);
    portfolio = closePosition(portfolio, {
      mint,
      exitPriceUsd: exitPrice,
      ts,
      // No fresh quote for this mint: charge the entry-leg cost again as the exit
      // leg rather than zero. A free exit is the one thing we know is false.
      costUsd: legs === null ? position.entryCostUsd : legs.exitUsd,
      reason: verdict.reason,
    });
    delete peaks[mint];
    closedThisTick.add(mint);
    actions.push(frozenAction('close', mint, ts, verdict.reasons, { reason: verdict.reason }));
  }

  // --- 4. kill switch: blocks entries only -----------------------------------
  const killSwitch = shouldKillSwitch(portfolio, { ts });
  if (killSwitch.tripped) {
    actions.push(frozenAction('kill-switch', null, ts, killSwitch.reasons));
    return frozenState(s.label, portfolio, peaks, actions, killSwitch);
  }

  // --- 5. entries ------------------------------------------------------------
  for (const pair of pairs) {
    if (!pair || typeof pair.mint !== 'string') continue;
    if (Object.hasOwn(portfolio.positions, pair.mint)) continue;
    if (closedThisTick.has(pair.mint)) {
      actions.push(
        frozenAction('skip', pair.mint, ts, [
          'exited this tick: not re-entering the same mint in the same tick',
        ]),
      );
      continue;
    }
    const costBreakdown = costs[pair.mint];
    if (costBreakdown === undefined) {
      actions.push(
        frozenAction('skip', pair.mint, ts, [
          'no cost breakdown for this mint: cannot prove the move clears its costs',
        ]),
      );
      continue;
    }
    const gateResult = gateResults[pair.mint];
    if (gateResult === undefined) {
      actions.push(
        frozenAction('skip', pair.mint, ts, [
          'no gate result for this mint: never entered on an unchecked token',
        ]),
      );
      continue;
    }

    const verdict = decide({
      pair,
      portfolio,
      gateResult,
      costBreakdown,
      now: ts,
      universe: t.universe,
      rng: t.rng,
    });
    if (!verdict.enter) {
      actions.push(frozenAction('reject', pair.mint, ts, verdict.reasons));
      continue;
    }

    const price = priceOf.get(pair.mint);
    if (price === undefined) {
      actions.push(
        frozenAction('skip', pair.mint, ts, ['entry signalled but price is unknown']),
      );
      continue;
    }
    const legs = splitLegCosts(costBreakdown);
    try {
      portfolio = openPosition(portfolio, {
        mint: pair.mint,
        sizeUsd,
        entryPriceUsd: price,
        ts,
        costUsd: legs.entryUsd,
        gateResult,
      });
    } catch (err) {
      // portfolio.js enforces RISK.absoluteSpendCapUsd and the paper cash balance
      // and THROWS when either would be breached. Those are hard limits working
      // correctly, not engine failures -- so the entry is skipped and recorded.
      // Letting the throw escape would abandon the whole tick, losing the exits
      // and marks already applied above.
      actions.push(
        frozenAction('skip', pair.mint, ts, [`entry refused by the book: ${err?.message ?? err}`]),
      );
      continue;
    }
    peaks[pair.mint] = price;
    actions.push(frozenAction('open', pair.mint, ts, [], { sizeUsd, entryPriceUsd: price }));
  }

  return frozenState(s.label, portfolio, peaks, actions, killSwitch);
}

function frozenAction(kind, mint, ts, reasons, extra = {}) {
  return Object.freeze({
    kind,
    mint,
    ts,
    reasons: Object.freeze([...reasons]),
    ...extra,
  });
}

function frozenState(label, portfolio, peaks, actions, killSwitch) {
  return Object.freeze({
    label,
    portfolio,
    peaks: Object.freeze({ ...peaks }),
    actions: Object.freeze(actions.map((a) => Object.freeze(a))),
    killSwitch,
  });
}

/** Re-exported so a caller never has to reach past the engine for sizing maths. */
export { assertFiniteNumber };
