import { describe, expect, it, vi } from 'vitest';
import { RECORDER } from '../../src/config.js';
import { EMPTY, buildDashData } from '../../scripts/lib/dashData.js';
import { fitColumns } from '../../scripts/dash.js';

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
