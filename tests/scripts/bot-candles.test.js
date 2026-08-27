import { describe, expect, it, vi } from 'vitest';
import { publishCandles } from '../../scripts/bot.js';

const MINT = 'hgin2YeSuc6JXDwiTKGxZaw1xkDHKicUAHPV3u9pump';
const POOL = '84HjcceuKPw2mFNP5Y8G1ZKPXQtzyfMYy5ZPChrHvART';
const AT = Date.parse('2026-08-27T08:00:00Z');
const MIN = 60_000;

const bar = (i) => ({
  ts: AT - (10 - i) * MIN,
  open: 0.001 + i * 1e-5,
  high: 0.0011 + i * 1e-5,
  low: 0.0009 + i * 1e-5,
  close: 0.001 + i * 1e-5,
  volumeUsd: 100 + i,
});

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

describe('publishCandles', () => {
  it('fetches one-minute bars for a held position and writes them', async () => {
    const { written, deps } = sink();
    const fetchOhlcv = vi.fn(async () => Array.from({ length: 10 }, (_, i) => bar(i)));
    const state = {};

    await publishCandles({
      state, held: [MINT], poolOf: { [MINT]: POOL }, at: AT, dir: 'd',
      deps: { ...deps, fetchOhlcv },
    });

    expect(fetchOhlcv).toHaveBeenCalledWith(
      expect.objectContaining({ poolAddress: POOL, timeframe: 'minute', aggregate: 1 }),
    );
    expect(written).toHaveLength(1);
    expect(written[0].type).toBe('candles');
    expect(written[0].intervalMinutes).toBe(1);
    expect(written[0].candles).toHaveLength(10);
  });

  it('holds nothing, fetches nothing', async () => {
    const { deps } = sink();
    const fetchOhlcv = vi.fn();
    await publishCandles({ state: {}, held: [], poolOf: {}, at: AT, dir: 'd', deps: { ...deps, fetchOhlcv } });
    expect(fetchOhlcv).not.toHaveBeenCalled();
  });

  it('skips a held mint whose pool is unknown rather than guessing one', async () => {
    const { deps } = sink();
    const fetchOhlcv = vi.fn();
    await publishCandles({
      state: {}, held: [MINT], poolOf: {}, at: AT, dir: 'd', deps: { ...deps, fetchOhlcv },
    });
    expect(fetchOhlcv).not.toHaveBeenCalled();
  });

  /**
   * The delta, and why it overlaps by one bar. The newest candle is mid-minute
   * when it is written: its high, low and close are all still moving. Re-sending
   * it lets the reader replace an incomplete bar; excluding it would freeze every
   * bar at its first observation.
   */
  it('the second call re-sends only the last known bar plus anything newer', async () => {
    const { written, deps } = sink();
    const first = Array.from({ length: 10 }, (_, i) => bar(i));
    const fetchOhlcv = vi.fn(async () => first);
    const state = {};

    await publishCandles({ state, held: [MINT], poolOf: { [MINT]: POOL }, at: AT, dir: 'd', deps: { ...deps, fetchOhlcv } });
    expect(written[0].candles).toHaveLength(10);

    // Nothing new upstream: only the still-forming last bar comes back.
    await publishCandles({ state, held: [MINT], poolOf: { [MINT]: POOL }, at: AT + MIN, dir: 'd', deps: { ...deps, fetchOhlcv } });
    expect(written[1].candles).toHaveLength(1);
    expect(written[1].candles[0].ts).toBe(first.at(-1).ts);
  });

  it('a failed fetch is reported and skipped, never fatal', async () => {
    const { written, deps } = sink();
    const fetchOhlcv = vi.fn(async () => {
      throw new Error('HTTP 429: Too Many Requests');
    });

    await expect(
      publishCandles({
        state: {}, held: [MINT], poolOf: { [MINT]: POOL }, at: AT, dir: 'd',
        deps: { ...deps, fetchOhlcv },
      }),
    ).resolves.toBeUndefined();
    expect(written).toEqual([]);
  });

  it('an empty response writes nothing rather than an empty record', async () => {
    const { written, deps } = sink();
    await publishCandles({
      state: {}, held: [MINT], poolOf: { [MINT]: POOL }, at: AT, dir: 'd',
      deps: { ...deps, fetchOhlcv: vi.fn(async () => []) },
    });
    expect(written).toEqual([]);
    expect(deps.appendFile).not.toHaveBeenCalled();
  });
});
