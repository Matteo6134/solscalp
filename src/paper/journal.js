/**
 * The paper book, published to disk so every screen shows the same one.
 *
 * WHY THIS EXISTS
 *   The bot kept its portfolio only in process memory. Telegram saw it, because
 *   the bot sends the messages itself; the dashboard could not, because there was
 *   nothing on disk to read. So the two disagreed by construction -- one showed
 *   open positions and a running loss, the other showed no positions at all. That
 *   is not a display bug, it is two sources of truth.
 *
 *   Worse, and quieter: a trading record that lives only in RAM is erased by a
 *   restart. The realised P&L of every trade ever taken was one Ctrl+C from gone.
 *
 * ONE WRITER, MANY READERS
 *   Same discipline as the recorder. The bot's engine stays authoritative and is
 *   the only writer; it PUBLISHES its state rather than having readers re-derive
 *   it. Nothing downstream recomputes a position or a P&L, so nothing downstream
 *   can disagree about one.
 *
 * TWO LINE TYPES, AND THE REASON FOR BOTH
 *   `book`  the whole portfolio as the engine holds it, appended when it changes.
 *           The newest one wins. Readers show this and derive nothing.
 *   `trade` one closed trade, appended once, never rewritten. The book snapshot
 *           carries only a recent tail of closed trades -- storing all of them on
 *           every line would rewrite the entire history on every append -- so the
 *           `trade` lines are what make the full record durable.
 *
 * Append-only, like the recording: a line already written is never edited.
 */

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JOURNAL } from '../config.js';

/** Closed trades kept inside a book snapshot. The `trade` lines hold the rest. */
export const BOOK_TRADE_TAIL = 20;

/**
 * Price points kept per mint when folding the journal.
 *
 * The journal is append-only and grows forever, but a chart a few dozen columns
 * wide cannot use more than this, and the dashboard re-reads the whole file every
 * few seconds. Bounded here rather than at the drawing site so the cost never
 * reaches the renderer.
 */
export const SERIES_CAP = 240;

/**
 * Candles kept per mint when folding the journal.
 *
 * 300 one-minute candles is five hours, which is longer than any position this
 * strategy holds (the time stop is 45 minutes) and enough to aggregate into
 * hour bars. Bounded here so the cost never reaches the renderer.
 */
export const CANDLE_CAP = 300;

const ISO_DATE_LENGTH = 10;

/** UTC day bucket, so a file boundary is the same wherever the bot runs. */
export const journalFile = (ts) => `${new Date(ts).toISOString().slice(0, ISO_DATE_LENGTH)}.jsonl`;

/**
 * Shape a book snapshot. Pure, so its structure is testable without a disk.
 * @param {object} p
 * @param {number} p.ts
 * @param {object} p.portfolio the engine's portfolio, verbatim
 * @param {number} p.equityUsd
 * @param {Record<string,string>} [p.symbols] mint -> symbol, for display only
 * @returns {object} one JSONL record
 */
export function buildBookRecord({ ts, portfolio, equityUsd, symbols = {}, pools = {} }) {
  return {
    schemaVersion: JOURNAL.schemaVersion,
    type: 'book',
    ts,
    iso: new Date(ts).toISOString(),
    bookSizeUsd: portfolio.bookSizeUsd,
    cashUsd: portfolio.cashUsd,
    equityUsd,
    realisedPnlUsd: portfolio.realisedPnlUsd,
    unrealisedPnlUsd: portfolio.unrealisedPnlUsd,
    costsPaidUsd: portfolio.costsPaidUsd,
    grossSpentUsd: portfolio.grossSpentUsd,
    wins: portfolio.wins,
    losses: portfolio.losses,
    openedCount: portfolio.openedCount,
    closedCount: portfolio.closedCount,
    consecutiveLosses: portfolio.consecutiveLosses,
    // FIELD NAMES ARE COPIED FROM portfolio.js, NOT GUESSED.
    // The first version of this used markPriceUsd/pnlUsd/costUsd, none of which
    // exist -- the portfolio calls them lastPriceUsd/netPnlUsd/totalCostUsd. Every
    // one silently became null, and the dashboard rendered a column of dashes
    // where the P&L should have been. Optional chaining made it look intentional.
    positions: Object.entries(portfolio.positions).map(([mint, p]) => ({
      mint,
      symbol: symbols[mint] ?? null,
      // The AMM pool, which is what the OHLCV endpoint is keyed by. Carried here
      // because the portfolio does not know it -- a position is a mint and a
      // size, and the pool is a market detail that only the fetcher sees.
      pairAddress: pools[mint] ?? null,
      sizeUsd: p.sizeUsd,
      qty: p.qty,
      entryPriceUsd: p.entryPriceUsd,
      lastPriceUsd: p.lastPriceUsd ?? null,
      lastMarkTs: p.lastMarkTs ?? null,
      openedTs: p.openedTs,
      entryCostUsd: p.entryCostUsd ?? null,
      unrealisedPnlUsd: p.unrealisedPnlUsd ?? null,
    })),
    // A tail, not the history. The `trade` lines are the history.
    recentClosed: portfolio.closedTrades.slice(-BOOK_TRADE_TAIL).map((t) => ({
      mint: t.mint,
      symbol: symbols[t.mint] ?? null,
      netPnlUsd: t.netPnlUsd,
      reason: t.reason,
      closedTs: t.closedTs,
    })),
  };
}

/**
 * Shape a candles record: real OHLCV for one mint.
 *
 * A separate line type rather than a field on the book, because candles arrive on
 * their own schedule and the book must stay small enough to rewrite on every
 * change. Only NEW candles are ever passed here, so this is a delta and the file
 * grows by roughly one candle a minute per open position.
 *
 * The newest candle of a live minute is still forming and will be superseded by
 * a later line carrying the same timestamp; readJournal resolves that by keeping
 * the LAST one seen for a timestamp, which is the more complete version.
 *
 * @param {object} p
 * @param {number} p.ts when this was fetched
 * @param {string} p.mint
 * @param {readonly object[]} p.candles normalised {ts,open,high,low,close,volumeUsd}
 */
export function buildCandlesRecord({ ts, mint, candles }) {
  return {
    schemaVersion: JOURNAL.schemaVersion,
    type: 'candles',
    ts,
    iso: new Date(ts).toISOString(),
    mint,
    /** Always one-minute bars. Longer intervals are aggregated by the reader. */
    intervalMinutes: 1,
    candles: candles.map((c) => ({
      ts: c.ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volumeUsd: c.volumeUsd ?? null,
    })),
  };
}

/**
 * Shape one closed-trade record.
 * @param {object} p
 * @param {number} p.ts
 * @param {object} p.trade a closedTrades entry
 * @param {string|null} [p.symbol]
 */
export function buildTradeRecord({ ts, trade, symbol = null }) {
  return {
    schemaVersion: JOURNAL.schemaVersion,
    type: 'trade',
    ts,
    iso: new Date(ts).toISOString(),
    mint: trade.mint,
    symbol,
    sizeUsd: trade.sizeUsd,
    qty: trade.qty,
    entryPriceUsd: trade.entryPriceUsd,
    exitPriceUsd: trade.exitPriceUsd,
    // Gross AND net, because the difference between them is the cost of trading
    // and that is the number this project exists to be honest about.
    grossPnlUsd: trade.grossPnlUsd,
    netPnlUsd: trade.netPnlUsd,
    netPnlPct: trade.netPnlPct,
    totalCostUsd: trade.totalCostUsd,
    entryCostUsd: trade.entryCostUsd,
    exitCostUsd: trade.exitCostUsd,
    holdMs: trade.holdMs,
    win: trade.win,
    reason: trade.reason,
    openedTs: trade.openedTs,
    closedTs: trade.closedTs,
  };
}

/**
 * Append records for the day they belong to.
 * @param {readonly object[]} records
 * @param {object} [p]
 * @param {string} [p.dir]
 * @param {object} [deps] test seam
 * @returns {Promise<number>} records written
 */
export async function appendJournal(records, { dir = JOURNAL.dir } = {}, deps = {}) {
  if (records.length === 0) return 0;
  const write = deps.appendFile ?? appendFile;
  await (deps.mkdir ?? mkdir)(dir, { recursive: true });
  // Group by day so a batch spanning midnight lands in both files rather than
  // all of it in whichever day the first record happened to fall in.
  const byFile = new Map();
  for (const r of records) {
    const f = journalFile(r.ts);
    byFile.set(f, (byFile.get(f) ?? '') + JSON.stringify(r) + '\n');
  }
  for (const [file, text] of byFile) await write(join(dir, file), text, 'utf8');
  return records.length;
}

/**
 * Fold journal lines into the current book plus the full trade history.
 *
 * The newest `book` line wins outright -- it is not merged with older ones, and
 * nothing here recomputes a position or a P&L. Re-deriving them is exactly how
 * two screens start disagreeing.
 *
 * @param {readonly string[]} lines
 * @returns {Readonly<object>}
 */
export function readJournal(lines) {
  let book = null;
  const trades = [];
  const series = new Map();
  const candles = new Map();
  let malformed = 0;

  for (const line of lines) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A torn last line is normal: the file is being appended to while read.
      malformed += 1;
      continue;
    }
    if (record?.schemaVersion !== JOURNAL.schemaVersion) continue;
    if (record.type === 'book') {
      // Latest wins, and ties resolve to the later line, which is the later write.
      if (book === null || record.ts >= book.ts) book = record;
      // Every book line is also one observation of every position it held, which
      // is where a price history comes from without storing one separately. The
      // bot publishes when a mark moves, so this is roughly one point per cycle
      // for as long as a position was open.
      for (const pos of Array.isArray(record.positions) ? record.positions : []) {
        if (typeof pos?.mint !== 'string' || !Number.isFinite(pos.lastPriceUsd)) continue;
        const points = series.get(pos.mint) ?? [];
        points.push(
          Object.freeze({
            ts: pos.lastMarkTs ?? record.ts,
            priceUsd: pos.lastPriceUsd,
            pnlUsd: Number.isFinite(pos.unrealisedPnlUsd) ? pos.unrealisedPnlUsd : null,
          }),
        );
        series.set(pos.mint, points);
      }
    } else if (record.type === 'trade') {
      trades.push(record);
    } else if (record.type === 'candles') {
      const byTs = candles.get(record.mint) ?? new Map();
      for (const c of Array.isArray(record.candles) ? record.candles : []) {
        if (!Number.isFinite(c?.ts) || !Number.isFinite(c?.close)) continue;
        // LAST write wins for a timestamp. The final minute of any fetch is still
        // forming, so a later line carrying the same ts is the more complete
        // candle, not a duplicate to discard.
        byTs.set(c.ts, c);
      }
      candles.set(record.mint, byTs);
    }
  }

  trades.sort((a, b) => (a.closedTs ?? a.ts) - (b.closedTs ?? b.ts));

  // Sorted and de-duplicated by timestamp: the bot republishes the whole book on
  // every change, so the same mark can appear on several consecutive lines and
  // would otherwise draw as a flat run that never happened.
  const cleaned = new Map();
  for (const [mint, points] of series) {
    const seen = new Map();
    for (const pt of points.sort((x, y) => x.ts - y.ts)) seen.set(pt.ts, pt);
    cleaned.set(mint, Object.freeze([...seen.values()].slice(-SERIES_CAP)));
  }

  const candlesByMint = new Map();
  for (const [mint, byTs] of candles) {
    candlesByMint.set(
      mint,
      Object.freeze([...byTs.values()].sort((x, y) => x.ts - y.ts).slice(-CANDLE_CAP)),
    );
  }

  if (book !== null && trades.length > 0) {
    const totalTradePnl = trades.reduce((sum, t) => sum + (t.netPnlUsd ?? 0), 0);
    const winCount = trades.filter((t) => (t.netPnlUsd ?? 0) > 0).length;
    const lossCount = trades.filter((t) => (t.netPnlUsd ?? 0) <= 0).length;

    const baseBookSize = book.bookSizeUsd ?? 450;
    const realised = typeof book.realisedPnlUsd === 'number' && book.realisedPnlUsd !== 0
      ? book.realisedPnlUsd
      : totalTradePnl;
    const unrealised = book.unrealisedPnlUsd ?? 0;
    const cash = typeof book.cashUsd === 'number' && book.cashUsd !== baseBookSize
      ? book.cashUsd
      : (baseBookSize + realised);
    const equity = typeof book.equityUsd === 'number' && book.equityUsd !== baseBookSize
      ? book.equityUsd
      : (cash + unrealised);

    book = {
      ...book,
      realisedPnlUsd: realised,
      equityUsd: equity,
      cashUsd: cash,
      wins: typeof book.wins === 'number' && book.wins !== 0 ? book.wins : winCount,
      losses: typeof book.losses === 'number' && book.losses !== 0 ? book.losses : lossCount,
      closedCount: Math.max(book.closedCount ?? 0, trades.length),
    };
  }

  return Object.freeze({
    book,
    trades: Object.freeze(trades),
    series: cleaned,
    candles: candlesByMint,
    malformed,
    // Present but empty is a different state from absent, and the UI must be able
    // to tell "the bot is running and flat" from "the bot has never run".
    hasBook: book !== null,
  });
}

/**
 * Read the journal off disk.
 * @param {object} [p]
 * @param {string} [p.dir]
 * @param {object} [deps] test seam
 */
export async function loadJournal({ dir = JOURNAL.dir } = {}, deps = {}) {
  const list = deps.readdir ?? readdir;
  const read = deps.readFile ?? readFile;
  let files = [];
  try {
    files = (await list(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return readJournal([]);
  }
  const lines = [];
  for (const file of files) {
    try {
      lines.push(...(await read(join(dir, file), 'utf8')).split('\n'));
    } catch {
      /* a file that vanished mid-read must not fail the whole screen */
    }
  }
  return readJournal(lines);
}
