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
export function buildBookRecord({ ts, portfolio, equityUsd, symbols = {} }) {
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
    } else if (record.type === 'trade') {
      trades.push(record);
    }
  }

  trades.sort((a, b) => (a.closedTs ?? a.ts) - (b.closedTs ?? b.ts));

  return Object.freeze({
    book,
    trades: Object.freeze(trades),
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
