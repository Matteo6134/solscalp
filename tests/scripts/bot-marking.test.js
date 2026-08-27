import { describe, expect, it, vi } from 'vitest';
import { cycle } from '../../scripts/bot.js';
import { createEngineState } from '../../src/paper/engine.js';
import { emptyPortfolio, openPosition } from '../../src/paper/portfolio.js';

const HELD = 'hgin2YeSuc6JXDwiTKGxZaw1xkDHKicUAHPV3u9pump';
const AT = Date.parse('2026-08-27T07:10:00Z');

/** A held position, entered at 0.0003. */
const stateHolding = () => ({
  cycle: 0,
  alertsPaused: false,
  lastRecheckAt: AT,
  updateOffset: 0,
  engine: createEngineState({
    portfolio: openPosition(emptyPortfolio({}), {
      mint: HELD,
      sizeUsd: 40,
      entryPriceUsd: 0.0003,
      ts: AT - 600_000,
      costUsd: 0.64,
      gateResult: { buyable: true },
    }),
  }),
  candidates: [],
  funnel: { pools: 0, pairs: 0, screened: 0, gated: 0, safe: 0, wouldEnter: 0 },
});

/** A Dexscreener-shaped pair, priced. */
const pairFor = (mint, priceUsd) => ({
  mint,
  pairAddress: 'p',
  dexId: 'raydium',
  baseToken: { symbol: 'PHASEONE' },
  quoteMint: 'So11111111111111111111111111111111111111112',
  priceUsd,
  marketCapUsd: 300_000,
  liquidityUsd: 40_000,
  pairCreatedAtMs: AT - 3_600_000,
  volume: { m5: 5_000, h1: 30_000 },
  priceChange: { m5: -8, h1: -12 },
  txns: { m5: { buys: 10, sells: 30 }, h1: { buys: 100, sells: 200 } },
});

const deps = (over = {}) => ({
  now: () => AT,
  // The recorder screened NOTHING this tick -- the ordinary case, and the one
  // that used to leave a held position unpriced.
  latestSnapshot: vi.fn(async () => ({
    ts: AT - 1_000,
    snapshotAgeMs: 1_000,
    profile: 'early',
    candidates: [],
    pairs: [],
    gateResults: {},
    scanned: [],
    fileCount: 1,
  })),
  fetchPairs: vi.fn(async (mints) => new Map(mints.map((m) => [m, pairFor(m, 0.00021)]))),
  fetchPools: vi.fn(async () => []),
  gate: vi.fn(),
  recheck: vi.fn(async () => ({ ok: true, reasons: [] })),
  isRecorderHealthy: () => true,
  recorderIntervalSeconds: 60,
  rpc: {},
  appendFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  ...over,
});

const notifier = () => ({ send: vi.fn(async () => {}), getUpdates: vi.fn(async () => []) });

describe('cycle: marking a held position', () => {
  /**
   * The bug this exists to prevent, and it was not cosmetic.
   *
   * The recorder stores only tokens that PASS the universe screen, and tokens
   * fall out of it constantly. On the recording path a held position therefore
   * had no price at all -- measured 6.1 minutes with no mark on a live position.
   *
   * decideExit compares the CURRENT price against the stop, so with no price
   * there is no comparison: the stop loss, the take profit and the trailing stop
   * all stop working. The position becomes unmanaged, silently.
   */
  it('fetches a price for a held mint the recorder no longer screens', async () => {
    const state = stateHolding();
    const d = deps();

    await cycle({
      state,
      notifier: notifier(),
      deps: d,
      universe: undefined,
      paperEnabled: true,
      limit: 8,
      fromRecording: true,
      paperDir: 'd',
    });

    expect(d.fetchPairs).toHaveBeenCalledTimes(1);
    expect(d.fetchPairs).toHaveBeenCalledWith([HELD]);
  });

  it('the mark actually moves the unrealised P&L', async () => {
    const state = stateHolding();
    const before = state.engine.portfolio.positions[HELD].unrealisedPnlUsd;

    await cycle({
      state,
      notifier: notifier(),
      deps: deps(),
      universe: undefined,
      paperEnabled: true,
      limit: 8,
      fromRecording: true,
      paperDir: 'd',
    });

    const after = state.engine.portfolio;
    // Entered at 0.0003, now 0.00021: a 30% fall on $40 is about -$12. Frozen
    // at the entry price it would have stayed at 0.
    if (after.positions[HELD] !== undefined) {
      expect(after.positions[HELD].lastPriceUsd).toBeCloseTo(0.00021);
      expect(after.positions[HELD].unrealisedPnlUsd).toBeLessThan(before);
    } else {
      // Or the stop loss fired on the newly available price, which is the whole
      // point -- it could not fire at all before.
      expect(after.closedCount).toBe(1);
    }
  });

  it('a 30% fall now triggers the stop loss instead of being invisible', async () => {
    const state = stateHolding();

    await cycle({
      state,
      notifier: notifier(),
      deps: deps(),
      universe: undefined,
      paperEnabled: true,
      limit: 8,
      fromRecording: true,
      paperDir: 'd',
    });

    // STRATEGY.exit.stopLossPct is 6, and this is a 30% fall.
    expect(state.engine.portfolio.closedCount).toBe(1);
    expect(state.engine.portfolio.closedTrades[0].reason).toBe('stopLoss');
  });

  it('does not fetch when the recording already priced the held mint', async () => {
    // The added request is only for the gap. A held token still passing the
    // screen must not cost an extra call every cycle.
    const state = stateHolding();
    const d = deps({
      latestSnapshot: vi.fn(async () => ({
        ts: AT - 1_000,
        snapshotAgeMs: 1_000,
        profile: 'early',
        candidates: [{ mint: HELD }],
        pairs: [pairFor(HELD, 0.00031)],
        gateResults: {
          [HELD]: { buyable: false, complete: true, passed: [], rejectedBy: ['layer2-liquidity'], erroredIn: [], skipped: [], reasons: [] },
        },
        scanned: [],
        fileCount: 1,
      })),
    });

    await cycle({
      state,
      notifier: notifier(),
      deps: d,
      universe: undefined,
      paperEnabled: true,
      limit: 8,
      fromRecording: true,
      paperDir: 'd',
    });

    expect(d.fetchPairs).not.toHaveBeenCalled();
  });

  it('an unpriceable held position does not crash the cycle', async () => {
    const state = stateHolding();
    const d = deps({
      fetchPairs: vi.fn(async () => {
        throw new Error('HTTP 429: Too Many Requests');
      }),
    });

    await expect(
      cycle({
        state,
        notifier: notifier(),
        deps: d,
        universe: undefined,
        paperEnabled: true,
        limit: 8,
        fromRecording: true,
        paperDir: 'd',
      }),
    ).resolves.toBeUndefined();
    // Still held, still unmarked -- and the dashboard shows the mark age so this
    // is visible rather than silent.
    expect(state.engine.portfolio.closedCount).toBe(0);
  });
});
