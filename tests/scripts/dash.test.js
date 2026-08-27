import { describe, expect, it, vi } from 'vitest';
import { RECORDER } from '../../src/config.js';
import { EMPTY, buildDashData } from '../../scripts/lib/dashData.js';
import {
  aggregateCandles,
  filterHistory,
  fitColumns,
  groupCounts,
  positionRows,
} from '../../scripts/dash.js';

const TS = 1_756_000_000_000;
const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const candidate = (over = {}) => ({
  mint: MINT,
  symbol: 'TKN',
  priceUsd: 0.001,
  marketCapUsd: 400_000,
  liquidityUsd: 50_000,
  ageMinutes: 120,
  volumeM5Usd: 5_000,
  volumeH1Usd: 30_000,
  priceChangeM5Pct: 6,
  priceChangeH1Pct: 12,
  buySellRatioM5: 2,
  volumeAccelerationRatio: 2,
  quoteMint: 'So11111111111111111111111111111111111111112',
  pairCreatedAtMs: TS - 120 * 60_000,
  txns: { m5: { buys: 40, sells: 20 }, h1: { buys: 300, sells: 200 } },
  roundTrip: { buyPriceImpactPct: 0.004, sellPriceImpactPct: 0.005 },
  wouldEnter: true,
  entryBlockedBy: [],
  gate: {
    buyable: true, complete: true, passed: ['layer0-mint'],
    rejectedBy: [], erroredIn: [], skipped: [], reasons: [],
  },
  outcome: null,
  ...over,
});

const snapshot = (candidates, ts = TS) =>
  JSON.stringify({ schemaVersion: RECORDER.schemaVersion, ts, iso: 'x', profile: 'early', candidates });

const fakeFs = (files) => ({
  readdir: vi.fn(async () => Object.keys(files)),
  readFile: vi.fn(async (path) => {
    const name = String(path).replace(/\\/g, '/').split('/').pop();
    if (!(name in files)) throw new Error('ENOENT');
    return files[name];
  }),
});

describe('fitColumns', () => {
  const cols = [
    { key: 'a', w: 10, keep: 9 },
    { key: 'b', w: 10, keep: 5 },
    { key: 'c', w: 10, keep: 1 },
  ];

  it('keeps everything when there is room', () => {
    expect(fitColumns(cols, 40).map((c) => c.key)).toEqual(['a', 'b', 'c']);
  });

  /**
   * The bug this exists to prevent. Hard-coded widths that sum past the terminal
   * were the original defect: Ink truncates a cell's text but cannot create
   * horizontal space, so an over-wide row wraps and the layout comes apart --
   * measured at 81 and 86 characters on an 80-column terminal.
   */
  it('drops the lowest-priority columns to fit a narrow terminal', () => {
    expect(fitColumns(cols, 25).map((c) => c.key)).toEqual(['a', 'b']);
    expect(fitColumns(cols, 15).map((c) => c.key)).toEqual(['a']);
  });

  it('never returns a set wider than the budget', () => {
    for (const budget of [0, 5, 9, 10, 11, 19, 20, 21, 29, 30, 31, 100]) {
      const total = fitColumns(cols, budget).reduce((n, c) => n + c.w, 0);
      expect(total).toBeLessThanOrEqual(Math.max(0, budget));
    }
  });

  it('preserves the authored order, not the priority order', () => {
    // priority decides what survives; the reader still sees the intended layout
    const out = fitColumns(
      [
        { key: 'first', w: 10, keep: 1 },
        { key: 'second', w: 10, keep: 9 },
      ],
      25,
    );
    expect(out.map((c) => c.key)).toEqual(['first', 'second']);
  });

  it('returns nothing when nothing fits, rather than overflowing', () => {
    expect(fitColumns(cols, 3)).toEqual([]);
  });
});

describe('buildDashData', () => {
  it('reads the recording into one frozen payload', async () => {
    const fs = fakeFs({ '2026-08-26.jsonl': `${snapshot([candidate()])}\n` });
    const d = await buildDashData({ now: TS }, fs);

    expect(Object.isFrozen(d)).toBe(true);
    expect(d.ticks).toHaveLength(1);
    expect(d.lastScan).toHaveLength(1);
    expect(d.history).toHaveLength(1);
    expect(d.recorder.profile).toBe('early');
  });

  it('carries the entry decision through, separate from the gate verdict', async () => {
    const fs = fakeFs({ '2026-08-26.jsonl': `${snapshot([candidate()])}\n` });
    const d = await buildDashData({ now: TS }, fs);

    // safe and worth-buying are different questions and stay different fields
    expect(d.lastScan[0].gateBuyable).toBe(true);
    expect(d.lastScan[0].wouldEnter).toBe(true);
  });

  it('reports recorder health from the snapshot age', async () => {
    const fresh = fakeFs({ '2026-08-26.jsonl': `${snapshot([candidate()], TS - 10_000)}\n` });
    const stale = fakeFs({ '2026-08-26.jsonl': `${snapshot([candidate()], TS - 3_600_000)}\n` });

    expect((await buildDashData({ now: TS }, fresh)).recorder.healthy).toBe(true);
    expect((await buildDashData({ now: TS }, stale)).recorder.healthy).toBe(false);
  });

  it('a missing directory yields a NULL age, not zero', async () => {
    // zero would read as "perfectly fresh", which is the opposite of the truth
    const fs = {
      readdir: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
      readFile: vi.fn(),
    };
    const d = await buildDashData({ now: TS }, fs);

    expect(d.recorder.snapshotAgeMs).toBeNull();
    expect(d.recorder.healthy).toBe(false);
    expect(d.ticks).toEqual([]);
  });

  it('never throws on a torn line', async () => {
    const fs = fakeFs({ '2026-08-26.jsonl': `${snapshot([candidate()])}\n{"schemaVersion":1,"ca` });
    await expect(buildDashData({ now: TS }, fs)).resolves.toBeDefined();
  });

  it('sorts history worst-first, so the collapses are visible immediately', async () => {
    const fs = fakeFs({
      '2026-08-26.jsonl': [
        snapshot([
          candidate({ mint: 'AAA', symbol: 'UP', liquidityUsd: 10_000 }),
          candidate({ mint: 'BBB', symbol: 'DOWN', liquidityUsd: 100_000 }),
        ], TS - 100_000),
        snapshot([
          candidate({ mint: 'AAA', symbol: 'UP', liquidityUsd: 20_000 }),
          candidate({ mint: 'BBB', symbol: 'DOWN', liquidityUsd: 5_000 }),
        ], TS),
      ].join('\n') + '\n',
    });
    const d = await buildDashData({ now: TS }, fs);

    expect(d.history[0].symbol).toBe('DOWN');
    expect(d.history[0].changePct).toBeLessThan(0);
  });

  it('EMPTY is a usable first frame', () => {
    expect(Object.isFrozen(EMPTY)).toBe(true);
    expect(EMPTY.recorder.healthy).toBe(false);
    expect(EMPTY.recorder.snapshotAgeMs).toBeNull();
    expect(EMPTY.evidence.report.sufficient).toBe(false);
  });
});

describe('filterHistory and groupCounts', () => {
  const cfg = { RUGGED: 'rugged', SURVIVED: 'survived' };
  const rows = [
    { symbol: 'PHASEONE', mint: 'aaa111', label: 'rugged', gateBuyable: false },
    { symbol: 'HAILEY', mint: 'bbb222', label: 'survived', gateBuyable: true },
    { symbol: 'cat', mint: 'ccc333', label: null, gateBuyable: true },
    { symbol: null, mint: 'ddd444', label: null, gateBuyable: false },
  ];

  it('every group narrows the same list', () => {
    expect(filterHistory(rows, 'all', '', cfg)).toHaveLength(4);
    expect(filterHistory(rows, 'rugged', '', cfg).map((r) => r.symbol)).toEqual(['PHASEONE']);
    expect(filterHistory(rows, 'survived', '', cfg).map((r) => r.symbol)).toEqual(['HAILEY']);
    expect(filterHistory(rows, 'safe', '', cfg).map((r) => r.symbol)).toEqual(['HAILEY', 'cat']);
  });

  it('unlabelled is anything not yet decided, not a third label', () => {
    // UNKNOWN is the default and must never be counted as survived.
    expect(filterHistory(rows, 'open', '', cfg).map((r) => r.mint)).toEqual(['ccc333', 'ddd444']);
  });

  it('search matches the symbol or the mint, case-insensitively', () => {
    expect(filterHistory(rows, 'all', 'hail', cfg).map((r) => r.mint)).toEqual(['bbb222']);
    expect(filterHistory(rows, 'all', 'CCC', cfg).map((r) => r.mint)).toEqual(['ccc333']);
    expect(filterHistory(rows, 'all', 'nothing', cfg)).toEqual([]);
  });

  it('a row with no symbol is searchable by mint and never throws', () => {
    expect(filterHistory(rows, 'all', 'ddd', cfg).map((r) => r.mint)).toEqual(['ddd444']);
  });

  it('search and group compose', () => {
    expect(filterHistory(rows, 'safe', 'cat', cfg).map((r) => r.mint)).toEqual(['ccc333']);
    expect(filterHistory(rows, 'rugged', 'cat', cfg)).toEqual([]);
  });

  it('an unknown group falls back to ALL rather than showing nothing', () => {
    expect(filterHistory(rows, 'not-a-group', '', cfg)).toHaveLength(4);
  });

  it('counts cover every row exactly once per group definition', () => {
    const counts = groupCounts(rows, cfg);
    const by = Object.fromEntries(counts.map((c) => [c.key, c.n]));
    expect(by.all).toBe(4);
    expect(by.rugged + by.survived + by.open).toBe(4);
  });
});

describe('positionRows', () => {
  const book = {
    positions: [{ mint: 'open1', symbol: 'A' }],
    realisedPnlUsd: 0,
  };
  const trades = [
    { mint: 'old', symbol: 'OLD', closedTs: 1 },
    { mint: 'new', symbol: 'NEW', closedTs: 2 },
  ];

  it('open positions come first, then closed newest-first', () => {
    const rows = positionRows(book, trades);
    expect(rows.map((r) => r.kind)).toEqual(['open', 'closed', 'closed']);
    // The last thing that happened is the thing being asked about.
    expect(rows.map((r) => r.symbol)).toEqual(['A', 'NEW', 'OLD']);
  });

  it('no book is an empty list, not a crash', () => {
    expect(positionRows(null, trades)).toEqual([]);
  });

  it('does not mutate the trades it was given', () => {
    const original = [...trades];
    positionRows(book, trades);
    expect(trades).toEqual(original);
  });
});

describe('aggregateCandles', () => {
  const min = 60_000;
  const base = Date.UTC(2026, 7, 27, 10, 0, 0);
  const c = (i, o, h_, l, cl, v) => ({ ts: base + i * min, open: o, high: h_, low: l, close: cl, volumeUsd: v });
  const ten = [
    c(0, 10, 12, 9, 11, 100),
    c(1, 11, 15, 10, 14, 200),
    c(2, 14, 14, 8, 9, 50),
    c(3, 9, 10, 7, 8, 10),
    c(4, 8, 20, 8, 19, 400),
    c(5, 19, 19, 18, 18, 1),
  ];

  it('one minute is the identity, not a rebuild', () => {
    expect(aggregateCandles(ten, 1)).toBe(ten);
  });

  it('rolls five bars into one with the right OHLCV', () => {
    const out = aggregateCandles(ten.slice(0, 5), 5);
    expect(out).toHaveLength(1);
    // Open from the FIRST bar, close from the LAST, extremes across all of them.
    expect(out[0].open).toBe(10);
    expect(out[0].close).toBe(19);
    expect(out[0].high).toBe(20);
    expect(out[0].low).toBe(7);
    expect(out[0].volumeUsd).toBe(760);
  });

  it('buckets on absolute epoch time, so bars do not shift as data arrives', () => {
    // The distinguishing property. Bucketing relative to the newest candle would
    // redraw every bar boundary each time a minute ticked over.
    const first = aggregateCandles(ten.slice(0, 5), 5);
    const withMore = aggregateCandles(ten, 5);
    expect(withMore[0].ts).toBe(first[0].ts);
    expect(withMore[0].open).toBe(first[0].open);
    expect(withMore[0].high).toBe(first[0].high);
  });

  it('a sixth minute opens a new bucket', () => {
    const out = aggregateCandles(ten, 5);
    expect(out).toHaveLength(2);
    expect(out[1].open).toBe(19);
    expect(out[1].volumeUsd).toBe(1);
  });

  it('handles an empty series', () => {
    expect(aggregateCandles([], 5)).toEqual([]);
  });

  it('treats a missing volume as zero rather than NaN', () => {
    const out = aggregateCandles([{ ts: base, open: 1, high: 1, low: 1, close: 1 }], 5);
    expect(out[0].volumeUsd).toBe(0);
  });
});
