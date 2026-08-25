/**
 * Immutable paper portfolio.
 *
 * Rules this file enforces, all of them from RISK in src/config.js:
 *   - never more than RISK.maxConcurrentPositions open at once,
 *   - never more than RISK.absoluteSpendCapUsd deployed in total, ever,
 *   - never two open positions in the same mint,
 *   - never a position opened on a gate result that is not buyable.
 *
 * NOTHING here mutates. Every exported function takes a frozen portfolio and
 * returns a NEW frozen portfolio; the input is never touched, so a caller can
 * keep the pre-trade state for comparison, replay or backtest diffing.
 *
 * No keypair, no signing, no broadcast: this is a ledger of hypotheticals.
 */

import { RISK } from '../config.js';
import {
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
  assertPlainObject,
  assertPositiveNumber,
  assertTimestampMs,
} from './guards.js';

const PCT_PER_UNIT = 100;
/** Day bucket length used by dayKey: an ISO date, YYYY-MM-DD. */
const ISO_DATE_LENGTH = 10;

/**
 * @typedef {Readonly<{
 *   mint: string, sizeUsd: number, entryPriceUsd: number, qty: number,
 *   openedTs: number, entryCostUsd: number, lastPriceUsd: number,
 *   lastMarkTs: number, unrealisedPnlUsd: number,
 *   gate: Readonly<{ buyable: boolean, complete: boolean,
 *                    rejectedBy: readonly string[], erroredIn: readonly string[] }>
 * }>} Position
 */

/**
 * @typedef {Readonly<{
 *   bookSizeUsd: number, cashUsd: number,
 *   positions: Readonly<Record<string, Position>>,
 *   closedTrades: readonly object[],
 *   realisedPnlUsd: number, unrealisedPnlUsd: number,
 *   costsPaidUsd: number, grossSpentUsd: number,
 *   consecutiveLosses: number, wins: number, losses: number,
 *   openedCount: number, closedCount: number,
 *   dailyRealisedPnlUsd: Readonly<Record<string, number>>,
 *   lastTs: number
 * }>} Portfolio
 */

/**
 * UTC day bucket for daily-loss accounting. UTC, not local time, so the
 * kill switch behaves identically wherever the bot runs.
 * @param {number} ts epoch ms
 * @returns {string} YYYY-MM-DD
 */
export function dayKey(ts) {
  assertTimestampMs(ts, 'ts');
  return new Date(ts).toISOString().slice(0, ISO_DATE_LENGTH);
}

/**
 * Freeze a portfolio and every container inside it. Object.freeze is shallow,
 * so the nested maps/arrays are frozen explicitly -- otherwise a caller could
 * push into closedTrades and silently rewrite history.
 * @param {object} draft
 * @returns {Portfolio}
 */
function freezePortfolio(draft) {
  const positions = Object.freeze(
    Object.fromEntries(
      Object.entries(draft.positions).map(([mint, position]) => [
        mint,
        Object.isFrozen(position) ? position : Object.freeze({ ...position }),
      ]),
    ),
  );
  return Object.freeze({
    ...draft,
    positions,
    closedTrades: Object.freeze(
      draft.closedTrades.map((t) => (Object.isFrozen(t) ? t : Object.freeze({ ...t }))),
    ),
    dailyRealisedPnlUsd: Object.freeze({ ...draft.dailyRealisedPnlUsd }),
  });
}

/**
 * A portfolio must be one of ours: frozen, and shaped as expected. Anything
 * else is a programming error and throws rather than being repaired.
 * @param {unknown} portfolio
 * @param {string} fn caller name, for the message
 * @returns {Portfolio}
 */
function assertPortfolio(portfolio, fn) {
  assertPlainObject(portfolio, `${fn}: portfolio`);
  const p = /** @type {Portfolio} */ (portfolio);
  if (!Object.isFrozen(p)) {
    throw new TypeError(
      `${fn}: portfolio must be a frozen value from emptyPortfolio/openPosition/closePosition`,
    );
  }
  assertPositiveNumber(p.bookSizeUsd, `${fn}: portfolio.bookSizeUsd`);
  assertNonNegativeNumber(p.cashUsd, `${fn}: portfolio.cashUsd`);
  assertPlainObject(p.positions, `${fn}: portfolio.positions`);
  assertPlainObject(p.dailyRealisedPnlUsd, `${fn}: portfolio.dailyRealisedPnlUsd`);
  assertNonNegativeNumber(p.grossSpentUsd, `${fn}: portfolio.grossSpentUsd`);
  assertNonNegativeInteger(p.consecutiveLosses, `${fn}: portfolio.consecutiveLosses`);
  if (!Array.isArray(p.closedTrades)) {
    throw new TypeError(`${fn}: portfolio.closedTrades must be an array`);
  }
  return p;
}

/**
 * The gate decides what may be bought; the portfolio refuses to be the place
 * where that decision is bypassed. combine() from src/safety/verdict.js sets
 * buyable=false for any reject AND (under failClosed) for any errored layer.
 * @param {unknown} gateResult
 * @returns {Readonly<{ buyable: boolean, complete: boolean, rejectedBy: readonly string[], erroredIn: readonly string[] }>}
 */
function summariseGate(gateResult) {
  const gate = assertPlainObject(gateResult, 'gateResult');
  if (gate.buyable !== true) {
    const why = Array.isArray(gate.reasons) && gate.reasons.length > 0
      ? gate.reasons.join('; ')
      : 'gateResult.buyable is not true';
    throw new Error(`openPosition: refusing to open on a non-buyable gate result: ${why}`);
  }
  return Object.freeze({
    buyable: true,
    complete: gate.complete === true,
    rejectedBy: Object.freeze([...(Array.isArray(gate.rejectedBy) ? gate.rejectedBy : [])]),
    erroredIn: Object.freeze([...(Array.isArray(gate.erroredIn) ? gate.erroredIn : [])]),
  });
}

/** @param {Readonly<Record<string, Position>>} positions */
const sumUnrealised = (positions) =>
  Object.values(positions).reduce((sum, p) => sum + p.unrealisedPnlUsd, 0);

/**
 * Fresh book. Frozen from the first instant so nothing can be bolted on later.
 * @param {object} [p]
 * @param {number} [p.bookSizeUsd] defaults to RISK.bookSizeUsd
 * @returns {Portfolio}
 */
export function emptyPortfolio({ bookSizeUsd = RISK.bookSizeUsd } = {}) {
  assertPositiveNumber(bookSizeUsd, 'bookSizeUsd');
  return freezePortfolio({
    bookSizeUsd,
    cashUsd: bookSizeUsd,
    positions: {},
    closedTrades: [],
    realisedPnlUsd: 0,
    unrealisedPnlUsd: 0,
    /** Cumulative costs actually charged, both legs. */
    costsPaidUsd: 0,
    /** Cumulative gross USD deployed, measured against RISK.absoluteSpendCapUsd. */
    grossSpentUsd: 0,
    consecutiveLosses: 0,
    wins: 0,
    losses: 0,
    openedCount: 0,
    closedCount: 0,
    dailyRealisedPnlUsd: {},
    lastTs: 0,
  });
}

/**
 * Open a paper position.
 *
 * costUsd is the cost attributed to THIS leg only -- pass the entry share of
 * estimateRoundTripCost (and the exit share to closePosition). Passing the whole
 * round-trip total at both legs double-charges it.
 *
 * @param {Portfolio} portfolio
 * @param {object} p
 * @param {string} p.mint
 * @param {number} p.sizeUsd        gross USD notional
 * @param {number} p.entryPriceUsd  price per token, USD
 * @param {number} p.ts             epoch ms
 * @param {number} p.costUsd        entry-leg cost, USD
 * @param {object} p.gateResult     combine() result; must be buyable
 * @returns {Portfolio} a NEW frozen portfolio
 */
export function openPosition(portfolio, { mint, sizeUsd, entryPriceUsd, ts, costUsd, gateResult }) {
  const book = assertPortfolio(portfolio, 'openPosition');
  assertNonEmptyString(mint, 'mint');
  assertPositiveNumber(sizeUsd, 'sizeUsd');
  assertPositiveNumber(entryPriceUsd, 'entryPriceUsd');
  assertTimestampMs(ts, 'ts');
  assertNonNegativeNumber(costUsd, 'costUsd');
  const gate = summariseGate(gateResult);

  if (Object.hasOwn(book.positions, mint)) {
    throw new Error(
      `openPosition: duplicate mint ${mint}; a position in it is already open ` +
        '(one position per mint, so exposure is never doubled by accident)',
    );
  }

  const openCount = Object.keys(book.positions).length;
  if (openCount >= RISK.maxConcurrentPositions) {
    throw new Error(
      `openPosition: would breach RISK.maxConcurrentPositions (${RISK.maxConcurrentPositions}); ` +
        `${openCount} already open`,
    );
  }

  const spendUsd = sizeUsd + costUsd;
  const grossSpentUsd = book.grossSpentUsd + spendUsd;
  if (grossSpentUsd > RISK.absoluteSpendCapUsd) {
    throw new Error(
      `openPosition: would breach RISK.absoluteSpendCapUsd (${RISK.absoluteSpendCapUsd}); ` +
        `cumulative spend would reach ${grossSpentUsd.toFixed(2)}`,
    );
  }
  if (spendUsd > book.cashUsd) {
    throw new Error(
      `openPosition: insufficient paper cash; need ${spendUsd.toFixed(2)} ` +
        `but only ${book.cashUsd.toFixed(2)} is free`,
    );
  }

  const position = Object.freeze({
    mint,
    sizeUsd,
    entryPriceUsd,
    /** Token units held. Exit pnl is qty * (exit - entry). */
    qty: sizeUsd / entryPriceUsd,
    openedTs: ts,
    entryCostUsd: costUsd,
    lastPriceUsd: entryPriceUsd,
    lastMarkTs: ts,
    unrealisedPnlUsd: 0,
    gate,
  });

  const positions = { ...book.positions, [mint]: position };
  return freezePortfolio({
    ...book,
    cashUsd: book.cashUsd - spendUsd,
    grossSpentUsd,
    costsPaidUsd: book.costsPaidUsd + costUsd,
    positions,
    unrealisedPnlUsd: sumUnrealised(positions),
    openedCount: book.openedCount + 1,
    lastTs: Math.max(book.lastTs, ts),
  });
}

/**
 * Close an open position and realise its pnl.
 *
 * netPnl = gross - entry-leg cost - exit-leg cost. Both legs are charged
 * exactly once, so a "profit" that only exists before costs cannot survive here.
 *
 * @param {Portfolio} portfolio
 * @param {object} p
 * @param {string} p.mint
 * @param {number} p.exitPriceUsd
 * @param {number} p.ts           epoch ms, must not precede the open
 * @param {number} p.costUsd      exit-leg cost, USD
 * @param {string} p.reason       why we exited, e.g. 'takeProfit' | 'stopLoss' | 'gateRecheck'
 * @returns {Portfolio} a NEW frozen portfolio
 */
export function closePosition(portfolio, { mint, exitPriceUsd, ts, costUsd, reason }) {
  const book = assertPortfolio(portfolio, 'closePosition');
  assertNonEmptyString(mint, 'mint');
  assertPositiveNumber(exitPriceUsd, 'exitPriceUsd');
  assertTimestampMs(ts, 'ts');
  assertNonNegativeNumber(costUsd, 'costUsd');
  assertNonEmptyString(reason, 'reason');

  if (!Object.hasOwn(book.positions, mint)) {
    throw new Error(`closePosition: no open position for mint ${mint}`);
  }
  const position = book.positions[mint];
  if (ts < position.openedTs) {
    throw new RangeError(
      `closePosition: ts ${ts} precedes openedTs ${position.openedTs} for mint ${mint}`,
    );
  }

  const grossPnlUsd = position.qty * (exitPriceUsd - position.entryPriceUsd);
  const netPnlUsd = grossPnlUsd - position.entryCostUsd - costUsd;
  // Exactly zero is neither a win nor a loss, and resets the streak.
  const isLoss = netPnlUsd < 0;
  const isWin = netPnlUsd > 0;

  const trade = Object.freeze({
    mint,
    sizeUsd: position.sizeUsd,
    qty: position.qty,
    entryPriceUsd: position.entryPriceUsd,
    exitPriceUsd,
    openedTs: position.openedTs,
    closedTs: ts,
    holdMs: ts - position.openedTs,
    entryCostUsd: position.entryCostUsd,
    exitCostUsd: costUsd,
    totalCostUsd: position.entryCostUsd + costUsd,
    grossPnlUsd,
    netPnlUsd,
    netPnlPct: (netPnlUsd / position.sizeUsd) * PCT_PER_UNIT,
    reason,
    win: isWin,
  });

  const positions = Object.fromEntries(
    Object.entries(book.positions).filter(([key]) => key !== mint),
  );
  const key = dayKey(ts);

  return freezePortfolio({
    ...book,
    // Entry cost left the book at open; only the exit cost is charged here.
    cashUsd: book.cashUsd + position.sizeUsd + grossPnlUsd - costUsd,
    costsPaidUsd: book.costsPaidUsd + costUsd,
    realisedPnlUsd: book.realisedPnlUsd + netPnlUsd,
    positions,
    unrealisedPnlUsd: sumUnrealised(positions),
    closedTrades: [...book.closedTrades, trade],
    consecutiveLosses: isLoss ? book.consecutiveLosses + 1 : 0,
    wins: book.wins + (isWin ? 1 : 0),
    losses: book.losses + (isLoss ? 1 : 0),
    closedCount: book.closedCount + 1,
    dailyRealisedPnlUsd: {
      ...book.dailyRealisedPnlUsd,
      [key]: (book.dailyRealisedPnlUsd[key] ?? 0) + netPnlUsd,
    },
    lastTs: Math.max(book.lastTs, ts),
  });
}

/**
 * Re-mark open positions at current prices. Returns a NEW frozen portfolio;
 * marks for a mint we do not hold throw, because a typo that silently leaves a
 * position unmarked understates drawdown.
 *
 * @param {Portfolio} portfolio
 * @param {object} p
 * @param {Record<string, number>} p.marks mint -> current price USD
 * @param {number} p.ts
 * @returns {Portfolio}
 */
export function markPositions(portfolio, { marks, ts }) {
  const book = assertPortfolio(portfolio, 'markPositions');
  assertPlainObject(marks, 'marks');
  assertTimestampMs(ts, 'ts');

  const priced = Object.entries(marks).map(([mint, price]) => {
    assertPositiveNumber(price, `marks[${mint}]`);
    if (!Object.hasOwn(book.positions, mint)) {
      throw new Error(`markPositions: mark for ${mint} but no position is open in it`);
    }
    return [mint, price];
  });
  const priceOf = new Map(priced);

  const positions = Object.fromEntries(
    Object.entries(book.positions).map(([mint, position]) => {
      const price = priceOf.get(mint);
      if (price === undefined) return [mint, position];
      return [
        mint,
        Object.freeze({
          ...position,
          lastPriceUsd: price,
          lastMarkTs: ts,
          unrealisedPnlUsd: position.qty * (price - position.entryPriceUsd),
        }),
      ];
    }),
  );

  return freezePortfolio({
    ...book,
    positions,
    unrealisedPnlUsd: sumUnrealised(positions),
    lastTs: Math.max(book.lastTs, ts),
  });
}

/**
 * Mark-to-market equity: free cash plus what the open positions are worth.
 * @param {Portfolio} portfolio
 * @returns {number}
 */
export function portfolioEquityUsd(portfolio) {
  const book = assertPortfolio(portfolio, 'portfolioEquityUsd');
  return (
    book.cashUsd +
    Object.values(book.positions).reduce((sum, p) => sum + p.sizeUsd + p.unrealisedPnlUsd, 0)
  );
}

/**
 * Kill switch. Trips on either RISK limit:
 *   - the day (UTC) is down by RISK.maxDailyLossPct of bookSizeUsd or more,
 *   - RISK.killSwitchConsecutiveLosses consecutive losing trades, exactly at
 *     the configured count.
 *
 * Daily pnl = realised for that day PLUS any unrealised LOSS on open positions.
 * Unrealised gains never offset a realised drawdown: an open winner can evaporate,
 * a closed loss cannot come back.
 *
 * Loss is measured against bookSizeUsd (the mandate), not against day-start
 * equity, so the limit does not quietly widen after a good day.
 *
 * @param {Portfolio} portfolio
 * @param {object} p
 * @param {number} p.ts epoch ms, selects the UTC day
 * @param {Record<string, number>} [p.marks] optional live prices; when given,
 *   open-position losses are included instead of the last stored marks
 * @returns {Readonly<{ tripped: boolean, reasons: readonly string[], dayKey: string,
 *   dailyPnlUsd: number, dailyPnlPct: number, consecutiveLosses: number,
 *   limits: Readonly<{ maxDailyLossPct: number, killSwitchConsecutiveLosses: number }> }>}
 */
export function shouldKillSwitch(portfolio, { ts, marks } = {}) {
  const book = assertPortfolio(portfolio, 'shouldKillSwitch');
  const key = dayKey(ts);

  const realisedToday = book.dailyRealisedPnlUsd[key] ?? 0;
  const openPnlUsd = marks === undefined ? book.unrealisedPnlUsd : unrealisedAt(book, marks);
  const dailyPnlUsd = realisedToday + Math.min(0, openPnlUsd);
  const dailyPnlPct = (dailyPnlUsd / book.bookSizeUsd) * PCT_PER_UNIT;

  const reasons = [];
  if (dailyPnlPct <= -RISK.maxDailyLossPct) {
    reasons.push(
      `daily pnl ${dailyPnlPct.toFixed(2)}% on ${key} breached ` +
        `RISK.maxDailyLossPct (-${RISK.maxDailyLossPct}%)`,
    );
  }
  if (book.consecutiveLosses >= RISK.killSwitchConsecutiveLosses) {
    reasons.push(
      `${book.consecutiveLosses} consecutive losses reached ` +
        `RISK.killSwitchConsecutiveLosses (${RISK.killSwitchConsecutiveLosses})`,
    );
  }

  return Object.freeze({
    tripped: reasons.length > 0,
    reasons: Object.freeze(reasons),
    dayKey: key,
    dailyPnlUsd,
    dailyPnlPct,
    consecutiveLosses: book.consecutiveLosses,
    limits: Object.freeze({
      maxDailyLossPct: RISK.maxDailyLossPct,
      killSwitchConsecutiveLosses: RISK.killSwitchConsecutiveLosses,
    }),
  });
}

/**
 * Unrealised pnl of open positions valued at the supplied marks. A position
 * with no mark keeps its last stored value rather than being counted flat.
 * @param {Portfolio} book
 * @param {Record<string, number>} marks
 * @returns {number}
 */
function unrealisedAt(book, marks) {
  assertPlainObject(marks, 'marks');
  return Object.values(book.positions).reduce((sum, position) => {
    const price = marks[position.mint];
    if (price === undefined) return sum + position.unrealisedPnlUsd;
    assertPositiveNumber(price, `marks[${position.mint}]`);
    return sum + position.qty * (price - position.entryPriceUsd);
  }, 0);
}
