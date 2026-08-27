import { describe, expect, it, vi } from 'vitest';
import { JOURNAL } from '../../src/config.js';
import {
  BOOK_TRADE_TAIL,
  appendJournal,
  buildBookRecord,
  buildTradeRecord,
  journalFile,
  loadJournal,
  readJournal,
} from '../../src/paper/journal.js';
import {
  closePosition,
  emptyPortfolio,
  markPositions,
  openPosition,
  portfolioEquityUsd,
} from '../../src/paper/portfolio.js';

const T = Date.parse('2026-08-27T07:00:00Z');
const A = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const B = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

/** A book with one open position and one closed trade, via the real engine. */
function tradedBook() {
  let pf = emptyPortfolio({});
  pf = openPosition(pf, { mint: A, sizeUsd: 40, entryPriceUsd: 0.001, ts: T, costUsd: 0.6, gateResult: { buyable: true } });
  pf = openPosition(pf, { mint: B, sizeUsd: 40, entryPriceUsd: 0.002, ts: T + 1_000, costUsd: 0.6, gateResult: { buyable: true } });
  pf = markPositions(pf, { marks: { [A]: 0.00082, [B]: 0.0019 }, ts: T + 60_000 });
  pf = closePosition(pf, { mint: A, exitPriceUsd: 0.00082, ts: T + 900_000, costUsd: 0.6, reason: 'stopLoss' });
  return pf;
}

describe('journalFile', () => {
  it('buckets by UTC day', () => {
    expect(journalFile(Date.parse('2026-08-27T23:59:59Z'))).toBe('2026-08-27.jsonl');
    expect(journalFile(Date.parse('2026-08-28T00:00:00Z'))).toBe('2026-08-28.jsonl');
  });
});

describe('buildBookRecord', () => {
  /**
   * The regression that matters. The first version read markPriceUsd, pnlUsd and
   * costUsd -- none of which the portfolio writes. Optional chaining turned every
   * one into null and the dashboard rendered a column of dashes where the P&L
   * belonged. Asserting NOT-null is the only version of this test that would have
   * caught it; asserting the key exists would have passed.
   */
  it('reads the field names portfolio.js actually writes', () => {
    const pf = tradedBook();
    const rec = buildBookRecord({ ts: T + 900_000, portfolio: pf, equityUsd: portfolioEquityUsd(pf) });

    expect(rec.positions).toHaveLength(1);
    expect(rec.positions[0].lastPriceUsd).toBeCloseTo(0.0019);
    expect(rec.positions[0].unrealisedPnlUsd).toBeCloseTo(-2, 5);
    expect(rec.positions[0].openedTs).toBe(T + 1_000);

    expect(rec.recentClosed).toHaveLength(1);
    expect(rec.recentClosed[0].netPnlUsd).toBeCloseTo(-8.4, 5);
    expect(rec.recentClosed[0].reason).toBe('stopLoss');
    // Every field except `symbol`, which is legitimately null when no symbol map
    // was passed -- covered by its own test. Everything else being non-null is
    // the actual assertion: a null here means a field name that does not exist.
    for (const [k, v] of Object.entries(rec.recentClosed[0])) {
      if (k === 'symbol') continue;
      expect(v, `recentClosed.${k} is null -- wrong field name?`).not.toBeNull();
    }
  });

  it('publishes the totals a reader must never recompute', () => {
    const pf = tradedBook();
    const rec = buildBookRecord({ ts: T, portfolio: pf, equityUsd: portfolioEquityUsd(pf) });

    expect(rec.realisedPnlUsd).toBeCloseTo(-8.4, 5);
    expect(rec.unrealisedPnlUsd).toBeCloseTo(-2, 5);
    expect(rec.equityUsd).toBeCloseTo(439, 5);
    expect(rec.closedCount).toBe(1);
    expect(rec.openedCount).toBe(2);
  });

  it('attaches symbols for display without inventing them', () => {
    const pf = tradedBook();
    const rec = buildBookRecord({ ts: T, portfolio: pf, equityUsd: 0, symbols: { [B]: 'TRUMPPISTA' } });

    expect(rec.positions[0].symbol).toBe('TRUMPPISTA');
    // No symbol known is null, never the mint dressed up as a ticker.
    const bare = buildBookRecord({ ts: T, portfolio: pf, equityUsd: 0 });
    expect(bare.positions[0].symbol).toBeNull();
  });

  it('carries only a tail of closed trades', () => {
    // Small sizes on purpose: RISK.absoluteSpendCapUsd is a HARD cap on
    // cumulative gross deployed, and 25 rounds at $40 breaches it -- which the
    // first draft of this test discovered by throwing. The cap is the code
    // working; the test had to stay under it.
    let pf = emptyPortfolio({ bookSizeUsd: 5_000 });
    for (let i = 0; i < BOOK_TRADE_TAIL + 5; i += 1) {
      const mint = `mint${i}`;
      pf = openPosition(pf, { mint, sizeUsd: 10, entryPriceUsd: 0.001, ts: T + i, costUsd: 0.1, gateResult: { buyable: true } });
      pf = closePosition(pf, { mint, exitPriceUsd: 0.0009, ts: T + i + 1, costUsd: 0.1, reason: 'stopLoss' });
    }
    const rec = buildBookRecord({ ts: T, portfolio: pf, equityUsd: 0 });

    // The tail bounds the line size; the `trade` lines are the real history.
    expect(rec.recentClosed).toHaveLength(BOOK_TRADE_TAIL);
    expect(rec.closedCount).toBe(BOOK_TRADE_TAIL + 5);
  });
});

describe('buildTradeRecord', () => {
  it('keeps gross and net apart, because the gap is the cost of trading', () => {
    const pf = tradedBook();
    const rec = buildTradeRecord({ ts: T, trade: pf.closedTrades[0], symbol: 'HAILEY' });

    expect(rec.grossPnlUsd).toBeCloseTo(-7.2, 5);
    expect(rec.totalCostUsd).toBeCloseTo(1.2, 5);
    expect(rec.netPnlUsd).toBeCloseTo(-8.4, 5);
    // Net is worse than gross. A journal that reported only one of them would
    // hide the entire cost model this project exists to measure.
    expect(rec.netPnlUsd).toBeLessThan(rec.grossPnlUsd);
    expect(rec.win).toBe(false);
    expect(rec.holdMs).toBe(900_000);
  });
});

describe('readJournal', () => {
  const book = (ts, over = {}) =>
    JSON.stringify({ schemaVersion: JOURNAL.schemaVersion, type: 'book', ts, realisedPnlUsd: 0, positions: [], recentClosed: [], ...over });
  const trade = (ts, over = {}) =>
    JSON.stringify({ schemaVersion: JOURNAL.schemaVersion, type: 'trade', ts, mint: A, closedTs: ts, netPnlUsd: -1, ...over });

  it('the newest book wins outright', () => {
    const out = readJournal([book(T, { cashUsd: 1 }), book(T + 5_000, { cashUsd: 2 }), book(T + 1_000, { cashUsd: 3 })]);
    expect(out.book.cashUsd).toBe(2);
    expect(out.hasBook).toBe(true);
  });

  it('collects every trade line in closing order', () => {
    const out = readJournal([trade(T + 2_000), trade(T), trade(T + 1_000)]);
    expect(out.trades.map((t) => t.closedTs)).toEqual([T, T + 1_000, T + 2_000]);
  });

  it('survives a torn final line without losing the rest', () => {
    const out = readJournal([book(T), trade(T), '{"schemaVersion":1,"type":"tra']);
    expect(out.hasBook).toBe(true);
    expect(out.trades).toHaveLength(1);
    expect(out.malformed).toBe(1);
  });

  it('ignores a foreign schema version rather than half-reading it', () => {
    const out = readJournal([JSON.stringify({ schemaVersion: 999, type: 'book', ts: T, cashUsd: 7 })]);
    expect(out.hasBook).toBe(false);
    expect(out.book).toBeNull();
  });

  it('distinguishes no book from an empty book', () => {
    // "The bot never ran" and "the bot is flat" must not look the same.
    expect(readJournal([]).hasBook).toBe(false);
    expect(readJournal([book(T, { positions: [] })]).hasBook).toBe(true);
  });

  it('is frozen', () => {
    const out = readJournal([book(T)]);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.trades)).toBe(true);
  });
});

describe('appendJournal', () => {
  it('splits a batch that spans midnight across both day files', async () => {
    const appendFile = vi.fn(async () => {});
    const n = await appendJournal(
      [
        { ts: Date.parse('2026-08-27T23:59:00Z') },
        { ts: Date.parse('2026-08-28T00:01:00Z') },
      ],
      { dir: 'd' },
      { appendFile, mkdir: vi.fn(async () => {}) },
    );

    expect(n).toBe(2);
    expect(appendFile).toHaveBeenCalledTimes(2);
    const targets = appendFile.mock.calls.map((c) => String(c[0]).replace(/\\/g, '/'));
    expect(targets.some((t) => t.endsWith('2026-08-27.jsonl'))).toBe(true);
    expect(targets.some((t) => t.endsWith('2026-08-28.jsonl'))).toBe(true);
  });

  it('writes nothing for an empty batch', async () => {
    const appendFile = vi.fn(async () => {});
    expect(await appendJournal([], {}, { appendFile, mkdir: vi.fn(async () => {}) })).toBe(0);
    expect(appendFile).not.toHaveBeenCalled();
  });
});

describe('loadJournal', () => {
  it('a missing directory is no book, not a crash', async () => {
    const out = await loadJournal(
      { dir: 'nope' },
      {
        readdir: vi.fn(async () => {
          throw new Error('ENOENT');
        }),
        readFile: vi.fn(),
      },
    );
    expect(out.hasBook).toBe(false);
    expect(out.trades).toEqual([]);
  });

  it('round-trips what appendJournal wrote', async () => {
    const files = {};
    const deps = {
      appendFile: vi.fn(async (path, text) => {
        const name = String(path).replace(/\\/g, '/').split('/').pop();
        files[name] = (files[name] ?? '') + text;
      }),
      mkdir: vi.fn(async () => {}),
      readdir: vi.fn(async () => Object.keys(files)),
      readFile: vi.fn(async (path) => files[String(path).replace(/\\/g, '/').split('/').pop()]),
    };
    const pf = tradedBook();
    await appendJournal(
      [
        buildBookRecord({ ts: T + 900_000, portfolio: pf, equityUsd: portfolioEquityUsd(pf) }),
        buildTradeRecord({ ts: T + 900_000, trade: pf.closedTrades[0] }),
      ],
      { dir: 'd' },
      deps,
    );
    const out = await loadJournal({ dir: 'd' }, deps);

    expect(out.hasBook).toBe(true);
    expect(out.book.equityUsd).toBeCloseTo(439, 5);
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0].netPnlUsd).toBeCloseTo(-8.4, 5);
  });
});
