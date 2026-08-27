import { describe, expect, it, vi } from 'vitest';
import { publishBook } from '../../scripts/bot.js';
import {
  closePosition,
  emptyPortfolio,
  markPositions,
  openPosition,
} from '../../src/paper/portfolio.js';

const T = Date.parse('2026-08-27T07:00:00Z');
const A = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const sink = () => {
  const written = [];
  return {
    written,
    deps: {
      appendFile: vi.fn(async (_p, text) => {
        for (const line of String(text).trim().split('\n')) written.push(JSON.parse(line));
      }),
      mkdir: vi.fn(async () => {}),
    },
  };
};

const open = (pf, mint = A) =>
  openPosition(pf, {
    mint,
    sizeUsd: 40,
    entryPriceUsd: 0.001,
    ts: T,
    costUsd: 0.6,
    gateResult: { buyable: true },
  });

describe('publishBook', () => {
  it('writes a book line and one trade line when a position closes', async () => {
    const before = open(emptyPortfolio({}));
    const after = closePosition(before, {
      mint: A,
      exitPriceUsd: 0.0008,
      ts: T + 60_000,
      costUsd: 0.6,
      reason: 'stopLoss',
    });
    const { written, deps } = sink();

    await publishBook({
      state: { engine: { portfolio: after } },
      before,
      symbolOf: new Map([[A, 'HAILEY']]),
      at: T + 60_000,
      dir: 'd',
      deps,
    });

    expect(written.map((r) => r.type)).toEqual(['book', 'trade']);
    expect(written[1].symbol).toBe('HAILEY');
    expect(written[1].netPnlUsd).toBeCloseTo(-9.2, 5);
    expect(written[0].closedCount).toBe(1);
  });

  it('writes nothing when the book did not change', async () => {
    // Otherwise every 60s tick appends a line and the journal becomes a log of
    // price noise rather than a record of decisions.
    const pf = open(emptyPortfolio({}));
    const { written, deps } = sink();

    await publishBook({
      state: { engine: { portfolio: pf } },
      before: pf,
      symbolOf: new Map(),
      at: T,
      dir: 'd',
      deps,
    });

    expect(written).toEqual([]);
    expect(deps.appendFile).not.toHaveBeenCalled();
  });

  it('publishes when only the mark moved, so unrealised P&L stays current', async () => {
    const before = open(emptyPortfolio({}));
    const after = markPositions(before, { marks: { [A]: 0.0009 }, ts: T + 1_000 });
    const { written, deps } = sink();

    await publishBook({
      state: { engine: { portfolio: after } },
      before,
      symbolOf: new Map(),
      at: T + 1_000,
      dir: 'd',
      deps,
    });

    expect(written).toHaveLength(1);
    expect(written[0].unrealisedPnlUsd).toBeCloseTo(-4, 5);
  });

  it('a write failure must not stop the bot', async () => {
    // The journal is important, but not more important than continuing to manage
    // open positions. A full disk cannot become a trading halt.
    const before = open(emptyPortfolio({}));
    const after = closePosition(before, {
      mint: A,
      exitPriceUsd: 0.0008,
      ts: T + 60_000,
      costUsd: 0.6,
      reason: 'stopLoss',
    });

    await expect(
      publishBook({
        state: { engine: { portfolio: after } },
        before,
        symbolOf: new Map(),
        at: T + 60_000,
        dir: 'd',
        deps: {
          mkdir: vi.fn(async () => {}),
          appendFile: vi.fn(async () => {
            throw new Error('ENOSPC: no space left on device');
          }),
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('writes one trade line per newly closed trade, not just the last', async () => {
    // Counted from the closedCount delta rather than read off the action list, so
    // two closes in one tick both land.
    const B = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    let before = open(emptyPortfolio({}));
    before = openPosition(before, {
      mint: B,
      sizeUsd: 40,
      entryPriceUsd: 0.002,
      ts: T,
      costUsd: 0.6,
      gateResult: { buyable: true },
    });
    let after = closePosition(before, { mint: A, exitPriceUsd: 0.0008, ts: T + 1, costUsd: 0.6, reason: 'stopLoss' });
    after = closePosition(after, { mint: B, exitPriceUsd: 0.0016, ts: T + 2, costUsd: 0.6, reason: 'timeStop' });
    const { written, deps } = sink();

    await publishBook({
      state: { engine: { portfolio: after } },
      before,
      symbolOf: new Map(),
      at: T + 2,
      dir: 'd',
      deps,
    });

    expect(written.filter((r) => r.type === 'trade')).toHaveLength(2);
    expect(written.filter((r) => r.type === 'trade').map((r) => r.reason)).toEqual([
      'stopLoss',
      'timeStop',
    ]);
  });
});
