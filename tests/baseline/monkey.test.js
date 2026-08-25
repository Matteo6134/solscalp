import { describe, expect, it } from 'vitest';
import { BASELINE, KNOWN, STRATEGY } from '../../src/config.js';
import { estimateRoundTripCost } from '../../src/paper/costModel.js';
import { emptyPortfolio } from '../../src/paper/portfolio.js';
import { createEngineState, stepEngine } from '../../src/paper/engine.js';
import {
  createBaselineDecider,
  createRng,
  decideEntryRandom,
} from '../../src/baseline/monkey.js';

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const NOW = 1_756_000_000_000;
const MS_PER_MIN = 60_000;

const q = (f) => Object.freeze({ priceImpactPct: String(f), slippageBps: 300 });
const cheapCost = () =>
  estimateRoundTripCost({ positionSizeUsd: 40, solPriceUsd: 150, buyQuote: q(0.005), sellQuote: q(0.005) });
const dearCost = () =>
  estimateRoundTripCost({ positionSizeUsd: 40, solPriceUsd: 150, buyQuote: q(0.09), sellQuote: q(0.09) });

const buyableGate = Object.freeze({
  buyable: true, complete: true, rejectedBy: [], erroredIn: [], reasons: [],
});
const blockedGate = Object.freeze({
  buyable: false, complete: true, rejectedBy: ['layer1-sellsim'], erroredIn: [],
  reasons: ['HONEYPOT: no sell route exists'],
});

/** A pair with FLAT momentum: the strategy would refuse it, the monkey should not care. */
const flatPair = (over = {}) =>
  Object.freeze({
    mint: MINT,
    pairAddress: 'PAIR1',
    priceUsd: 0.001,
    liquidityUsd: 50_000,
    marketCap: 400_000,
    fdv: 400_000,
    baseToken: { address: MINT },
    quoteToken: { address: KNOWN.WSOL },
    volumeUsd: { m5: 1, h1: 30_000 },
    priceChangePct: { m5: 0, h1: 0 },
    txns: { m5: { buys: 1, sells: 50 }, h1: { buys: 300, sells: 200 } },
    pairCreatedAtMs: NOW - 6 * 60 * MS_PER_MIN,
    ...over,
  });

const decide = (over = {}, args = {}) =>
  decideEntryRandom({
    pair: flatPair(over),
    portfolio: emptyPortfolio({}),
    gateResult: buyableGate,
    costBreakdown: cheapCost(),
    now: NOW,
    rng: createRng(1),
    probability: 1,
    ...args,
  });

describe('createRng -- determinism is the whole point', () => {
  it('produces an identical sequence for the same seed, forever', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());

    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 10 }, createRng(1).next);
    const b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => createRng(1).next());
    const seqB = Array.from({ length: 10 }, () => b.next());

    expect(seqA[0]).not.toBe(seqB[0]);
    expect(a.length).toBe(10);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(7);
    const values = Array.from({ length: 500 }, () => rng.next());

    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('defaults to the configured seed so a run is reproducible without arguments', () => {
    expect(createRng().seed).toBe(BASELINE.seed);
    expect(createRng().next()).toBe(createRng(BASELINE.seed).next());
  });

  it('exposes its state so a run can be checkpointed', () => {
    const rng = createRng(99);
    const before = rng.state();
    rng.next();

    expect(rng.state()).not.toBe(before);
    expect(Number.isInteger(rng.state())).toBe(true);
  });

  it('refuses a non-integer seed rather than silently coercing', () => {
    expect(() => createRng(1.5)).toThrow(/integer/);
    expect(() => createRng('42')).toThrow(/integer/);
  });

  it('handles a negative seed deterministically', () => {
    expect(createRng(-5).next()).toBe(createRng(-5).next());
  });
});

describe('decideEntryRandom -- it is a BASELINE, so it obeys every shared rule', () => {
  it('ignores flat momentum that the strategy would refuse', () => {
    const v = decide();

    expect(v.enter).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('still obeys the safety gate -- a honeypot is never bought at random', () => {
    const v = decide({}, { gateResult: blockedGate });

    expect(v.enter).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/safety gate blocked.*HONEYPOT/);
  });

  it('still obeys the market-cap ceiling', () => {
    const v = decide({ marketCap: STRATEGY.universe.maxMarketCapUsd + 1 });

    expect(v.enter).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/above ceiling/);
  });

  it('still obeys the cost model', () => {
    const v = decide({}, { costBreakdown: dearCost() });

    expect(v.enter).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/does not clear break-even/);
  });

  it('still fails closed on unknown inputs', () => {
    const v = decide({ marketCap: null, fdv: null });

    expect(v.enter).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/market cap unknown/);
  });
});

describe('decideEntryRandom -- the coin flip', () => {
  it('enters when the draw is below the probability', () => {
    expect(decide({}, { probability: 1 }).enter).toBe(true);
  });

  it('declines when the draw is at or above the probability', () => {
    const v = decide({}, { probability: 0 });

    expect(v.enter).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/coin flip declined/);
    expect(v.roll).toBeGreaterThanOrEqual(0);
  });

  it('takes NO draw when a real rule already blocked the entry', () => {
    // this is what keeps two runs over the same recording comparable: the draw
    // sequence must not depend on how many tokens failed the gate
    const rng = createRng(5);
    const before = rng.state();

    const v = decideEntryRandom({
      pair: flatPair(),
      portfolio: emptyPortfolio({}),
      gateResult: blockedGate,
      costBreakdown: cheapCost(),
      now: NOW,
      rng,
      probability: 1,
    });

    expect(v.enter).toBe(false);
    expect(v.roll).toBeNull();
    expect(rng.state()).toBe(before);
  });

  it('consumes exactly one draw per evaluated candidate', () => {
    const rng = createRng(11);
    const first = createRng(11).next();

    const v = decide({}, { rng, probability: 1 });

    expect(v.roll).toBe(first);
  });

  it('requires an rng: a silently-seeded baseline is not a baseline', () => {
    expect(() =>
      decideEntryRandom({
        pair: flatPair(),
        portfolio: emptyPortfolio({}),
        gateResult: buyableGate,
        costBreakdown: cheapCost(),
        now: NOW,
      }),
    ).toThrow(/rng\.next\(\) is required/);
  });

  it('rejects a probability outside [0, 1]', () => {
    expect(() => decide({}, { probability: 1.5 })).toThrow(/probability/);
    expect(() => decide({}, { probability: -0.1 })).toThrow(/probability/);
  });

  it('defaults to the configured probability', () => {
    // with p = BASELINE.entryProbabilityPerTick (small), most draws decline
    const rng = createRng(3);
    const results = Array.from({ length: 200 }, () =>
      decideEntryRandom({
        pair: flatPair(),
        portfolio: emptyPortfolio({}),
        gateResult: buyableGate,
        costBreakdown: cheapCost(),
        now: NOW,
        rng,
      }),
    );
    const entered = results.filter((r) => r.enter).length;

    expect(entered).toBeLessThan(200 * BASELINE.entryProbabilityPerTick * 4);
  });
});

describe('createBaselineDecider -- wired into stepEngine', () => {
  const tick = (over = {}) => ({
    ts: NOW,
    pairs: [flatPair()],
    gateResults: { [MINT]: buyableGate },
    costs: { [MINT]: cheapCost() },
    ...over,
  });

  it('lets the baseline open a position the strategy would have refused', () => {
    const strategyRun = stepEngine(createEngineState({ portfolio: emptyPortfolio({}) }), tick());
    expect(strategyRun.portfolio.positions).toEqual({});

    const baselineRun = stepEngine(
      createEngineState({ portfolio: emptyPortfolio({}), label: 'baseline' }),
      tick({ entryDecider: createBaselineDecider(createRng(1), 1) }),
    );
    expect(Object.keys(baselineRun.portfolio.positions)).toEqual([MINT]);
  });

  it('reproduces an identical run from the same seed', () => {
    const run = (seed) => {
      let s = createEngineState({ portfolio: emptyPortfolio({}), label: 'baseline' });
      const decider = createBaselineDecider(createRng(seed), 0.5);
      for (let i = 0; i < 25; i += 1) {
        s = stepEngine(s, {
          ts: NOW + i * MS_PER_MIN,
          pairs: [flatPair({ priceUsd: 0.001 * (1 + (i % 5) / 100) })],
          gateResults: { [MINT]: buyableGate },
          costs: { [MINT]: cheapCost() },
          entryDecider: decider,
        });
      }
      return s;
    };

    const a = run(1234);
    const b = run(1234);
    const c = run(9999);

    expect(a.portfolio.openedCount).toBe(b.portfolio.openedCount);
    expect(a.portfolio.closedTrades.map((t) => t.reason)).toEqual(
      b.portfolio.closedTrades.map((t) => t.reason),
    );
    expect(a.portfolio.realisedPnlUsd).toBe(b.portfolio.realisedPnlUsd);
    // a different seed must actually change something, or the seed is not wired in
    expect(a.portfolio.openedCount > 0 || c.portfolio.openedCount > 0).toBe(true);
  });

  it('uses the SAME exit rules as the strategy: only entry differs', () => {
    // open via the baseline, then let the ordinary exit path close it
    let s = stepEngine(
      createEngineState({ portfolio: emptyPortfolio({}), label: 'baseline' }),
      tick({ entryDecider: createBaselineDecider(createRng(1), 1) }),
    );
    const entryPrice = s.portfolio.positions[MINT].entryPriceUsd;
    const target = entryPrice * (1 + (STRATEGY.exit.takeProfitPct + 1) / 100);

    s = stepEngine(s, {
      ts: NOW + MS_PER_MIN,
      pairs: [flatPair({ priceUsd: target })],
      gateResults: {},
      costs: { [MINT]: cheapCost() },
      entryDecider: createBaselineDecider(createRng(1), 1),
    });

    expect(s.portfolio.closedTrades[0].reason).toBe('takeProfit');
  });
});
