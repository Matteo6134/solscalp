import { describe, expect, it } from 'vitest';
import { RISK, STRATEGY, UNIVERSE_PROFILES, KNOWN } from '../../src/config.js';
import { estimateRoundTripCost } from '../../src/paper/costModel.js';
import { emptyPortfolio, openPosition } from '../../src/paper/portfolio.js';
import {
  EXIT_REASON,
  createEngineState,
  decideEntry,
  decideExit,
  readSignals,
  splitLegCosts,
  stepEngine,
} from '../../src/paper/engine.js';

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const MINT2 = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
const NOW = 1_756_000_000_000;
const MS_PER_MIN = 60_000;
const SOL = 150;

const q = (fraction) => Object.freeze({ priceImpactPct: String(fraction), slippageBps: 300 });

/** A cost breakdown cheap enough that expectedGrossMovePct clears it. */
const cheapCost = (positionSizeUsd = RISK.positionSizeUsd) =>
  estimateRoundTripCost({ positionSizeUsd, solPriceUsd: SOL, buyQuote: q(0.005), sellQuote: q(0.005) });

/** A cost breakdown so expensive that no configured move can clear it. */
const dearCost = (positionSizeUsd = RISK.positionSizeUsd) =>
  estimateRoundTripCost({ positionSizeUsd, solPriceUsd: SOL, buyQuote: q(0.09), sellQuote: q(0.09) });

const buyableGate = Object.freeze({
  buyable: true,
  complete: true,
  rejectedBy: Object.freeze([]),
  erroredIn: Object.freeze([]),
  reasons: Object.freeze([]),
});

const blockedGate = Object.freeze({
  buyable: false,
  complete: true,
  rejectedBy: Object.freeze(['layer0-mint']),
  erroredIn: Object.freeze([]),
  reasons: Object.freeze(['freeze authority is not revoked']),
});

/** A pair that satisfies every default condition. Override one field per test. */
const pair = (over = {}) =>
  Object.freeze({
    mint: MINT,
    pairAddress: 'PAIR1',
    dexId: 'raydium',
    priceUsd: 0.001,
    liquidityUsd: 50_000,
    marketCap: 400_000,
    fdv: 400_000,
    baseToken: Object.freeze({ address: MINT, symbol: 'TKN' }),
    quoteToken: Object.freeze({ address: KNOWN.WSOL, symbol: 'SOL' }),
    volumeUsd: Object.freeze({ m5: 5_000, h1: 30_000 }),
    priceChangePct: Object.freeze({ m5: 6, h1: 12 }),
    txns: Object.freeze({
      m5: Object.freeze({ buys: 40, sells: 20 }),
      h1: Object.freeze({ buys: 300, sells: 200 }),
    }),
    pairCreatedAtMs: NOW - 6 * 60 * MS_PER_MIN,
    ...over,
  });

const entry = (over = {}, extra = {}) =>
  decideEntry({
    pair: pair(over),
    portfolio: emptyPortfolio({}),
    gateResult: buyableGate,
    costBreakdown: cheapCost(),
    now: NOW,
    ...extra,
  });

/** Reasons joined, for substring assertions. */
const why = (verdict) => verdict.reasons.join(' | ');

describe('splitLegCosts', () => {
  it('partitions the round trip exactly: entry + exit === total, nothing double-charged', () => {
    const c = cheapCost();
    const legs = splitLegCosts(c);

    expect(legs.entryUsd + legs.exitUsd).toBeCloseTo(legs.totalUsd, 12);
    // and the total is costModel's own total, so no cost is invented or dropped
    expect(legs.totalUsd).toBeCloseTo(c.totalUsd, 12);
  });

  it('puts each slippage leg on its own side and splits the flat costs evenly', () => {
    const c = estimateRoundTripCost({
      positionSizeUsd: 40,
      solPriceUsd: SOL,
      buyQuote: q(0.01),
      sellQuote: q(0.05),
    });
    const legs = splitLegCosts(c);

    // the sell leg is dearer, so the exit must carry more
    expect(legs.exitUsd).toBeGreaterThan(legs.entryUsd);
    expect(legs.entryUsd).toBeCloseTo((c.fixedUsd + c.routerFeeUsd) / 2 + c.buySlippageUsd, 12);
    expect(legs.exitUsd).toBeCloseTo((c.fixedUsd + c.routerFeeUsd) / 2 + c.sellSlippageUsd, 12);
  });

  it('throws rather than defaulting when a cost field is missing', () => {
    expect(() => splitLegCosts({})).toThrow(/fixedUsd/);
    expect(() => splitLegCosts(null)).toThrow(/costBreakdown/);
  });
});

describe('readSignals', () => {
  it('derives the momentum ratios from the snapshot', () => {
    const s = readSignals(pair(), NOW);

    expect(s.buySellRatioM5).toBe(2);
    // vol(m5) * 12 / vol(h1) = 5000 * 12 / 30000
    expect(s.volumeAccelerationRatio).toBe(2);
    expect(s.txnsH1).toBe(500);
    expect(s.ageMinutes).toBe(360);
  });

  it('reports an unmeasurable buy/sell ratio as null, not as infinitely bullish', () => {
    const s = readSignals(pair({ txns: { m5: { buys: 40, sells: 0 } } }), NOW);

    expect(s.buySellRatioM5).toBeNull();
  });

  it('recomputes age from now rather than trusting a stale ageMinutes field', () => {
    const stale = pair({ ageMinutes: 1, pairCreatedAtMs: NOW - 120 * MS_PER_MIN });

    expect(readSignals(stale, NOW).ageMinutes).toBe(120);
  });

  it('reports a missing creation timestamp as unknown age', () => {
    expect(readSignals(pair({ pairCreatedAtMs: null }), NOW).ageMinutes).toBeNull();
  });
});

describe('decideEntry -- the gate is not negotiable', () => {
  it('enters when every condition is satisfied', () => {
    const v = entry();

    expect(v.enter).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('refuses when the gate is not buyable, quoting the gate reason', () => {
    const v = decideEntry({
      pair: pair(),
      portfolio: emptyPortfolio({}),
      gateResult: blockedGate,
      costBreakdown: cheapCost(),
      now: NOW,
    });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/safety gate blocked.*freeze authority/);
  });

  it('refuses on a gate result that merely omits buyable', () => {
    const v = decideEntry({
      pair: pair(),
      portfolio: emptyPortfolio({}),
      gateResult: { reasons: [] },
      costBreakdown: cheapCost(),
      now: NOW,
    });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/safety gate blocked/);
  });
});

describe('decideEntry -- market cap window (small enough to multiply)', () => {
  it('refuses a market cap above the ceiling', () => {
    const v = entry({ marketCap: STRATEGY.universe.maxMarketCapUsd + 1 });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/above ceiling.*too big to multiply/);
  });

  it('accepts a market cap exactly at the ceiling', () => {
    expect(entry({ marketCap: STRATEGY.universe.maxMarketCapUsd }).enter).toBe(true);
  });

  it('refuses a market cap below the floor: no float to exit into', () => {
    const v = entry({ marketCap: STRATEGY.universe.minMarketCapUsd - 1 });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/below floor.*no float to exit into/);
  });

  it('accepts a market cap exactly at the floor', () => {
    expect(entry({ marketCap: STRATEGY.universe.minMarketCapUsd }).enter).toBe(true);
  });

  it('falls back to fdv when marketCap is absent', () => {
    // the Pair normaliser does this, but decideEntry must not re-break it
    const v = entry({ marketCap: 400_000, fdv: 400_000 });

    expect(v.enter).toBe(true);
  });

  it('FAILS CLOSED on an unknown market cap rather than treating it as in range', () => {
    const v = entry({ marketCap: null, fdv: null });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/market cap unknown -- cannot be evaluated \(fail closed/);
    // and the nonsense "unknown above ceiling 5000000" phrasing must not appear
    expect(why(v)).not.toMatch(/unknown above ceiling/);
  });
});

describe('decideEntry -- universe filters, each in isolation', () => {
  it('refuses a pair younger than the minimum age', () => {
    const v = entry({ pairCreatedAtMs: NOW - (STRATEGY.universe.minPairAgeMinutes - 1) * MS_PER_MIN });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/pair age .* below minimum/);
  });

  it('accepts a pair exactly at the minimum age', () => {
    const v = entry({ pairCreatedAtMs: NOW - STRATEGY.universe.minPairAgeMinutes * MS_PER_MIN });

    expect(v.enter).toBe(true);
  });

  it('refuses a pair older than the maximum age', () => {
    const tooOld = (STRATEGY.universe.maxPairAgeHours * 60 + 1) * MS_PER_MIN;
    const v = entry({ pairCreatedAtMs: NOW - tooOld });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/pair age .* above maximum/);
  });

  it('refuses thin 1h volume', () => {
    const v = entry({ volumeUsd: { m5: 5_000, h1: STRATEGY.universe.minVolumeH1Usd - 1 } });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/1h volume .* below minimum/);
  });

  it('refuses too few 1h transactions', () => {
    const v = entry({ txns: { m5: { buys: 40, sells: 20 }, h1: { buys: 5, sells: 5 } } });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/1h txns 10\.00 below minimum/);
  });

  it('refuses a pair quoted in something other than SOL or USDC', () => {
    const v = entry({ quoteToken: { address: MINT2, symbol: 'WEIRD' } });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/quote mint .* is not in the permitted set/);
  });

  it('FAILS CLOSED on an unknown quote mint', () => {
    const v = entry({ quoteToken: {} });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/quote mint unknown/);
  });

  it('keeps the quote-mint rule even when a profile override is supplied', () => {
    // quoteMints is a safety choice, so a profile must not be able to widen it
    const v = entry(
      { quoteToken: { address: MINT2 } },
      { universe: { ...UNIVERSE_PROFILES.early, quoteMints: [MINT2] } },
    );

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/not in the permitted set/);
  });
});

describe('decideEntry -- momentum, each in isolation', () => {
  it('refuses a 5m move below the minimum', () => {
    const v = entry({ priceChangePct: { m5: STRATEGY.entry.minPriceChangeM5Pct - 0.1, h1: 12 } });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/5m change .* below minimum/);
  });

  it('refuses a 5m move that is already vertical', () => {
    const v = entry({ priceChangePct: { m5: STRATEGY.entry.maxPriceChangeM5Pct + 1, h1: 12 } });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/already vertical -- we would be the exit liquidity/);
  });

  it('refuses a 1h move below the minimum', () => {
    const v = entry({ priceChangePct: { m5: 6, h1: STRATEGY.entry.minPriceChangeH1Pct - 0.1 } });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/1h change .* below minimum/);
  });

  it('refuses when the move is being sold into', () => {
    const v = entry({ txns: { m5: { buys: 10, sells: 20 }, h1: { buys: 300, sells: 200 } } });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/buy\/sell .*the move is being sold into/);
  });

  it('refuses a move that is ongoing rather than accelerating', () => {
    // vol(m5)*12/vol(h1) = 1000*12/30000 = 0.4
    const v = entry({ volumeUsd: { m5: 1_000, h1: 30_000 } });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/volume acceleration .*ongoing, not accelerating/);
  });

  it('FAILS CLOSED when a momentum field is missing', () => {
    const v = entry({ priceChangePct: {} });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/5m price change unknown/);
    expect(why(v)).toMatch(/1h price change unknown/);
  });

  it('reports every failed condition, not just the first', () => {
    const v = entry({
      priceChangePct: { m5: 0, h1: 0 },
      volumeUsd: { m5: 1, h1: STRATEGY.universe.minVolumeH1Usd - 1 },
    });

    expect(v.reasons.length).toBeGreaterThan(2);
  });
});

describe('decideEntry -- it must pay for itself', () => {
  it('refuses when the expected move does not clear break-even', () => {
    const v = decideEntry({
      pair: pair(),
      portfolio: emptyPortfolio({}),
      gateResult: buyableGate,
      costBreakdown: dearCost(),
      now: NOW,
    });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/does not clear break-even/);
    expect(v.costs.clears).toBe(false);
  });

  it('refuses, rather than throwing, when costs consume the whole position', () => {
    // A pool thin enough that the probe moves the price ~100%. breakEvenMovePct
    // throws on this by design; decideEntry must convert it into a refusal, or a
    // single pathological token aborts the tick and every other position loses
    // its exit evaluation.
    const catastrophic = estimateRoundTripCost({
      positionSizeUsd: RISK.positionSizeUsd,
      solPriceUsd: SOL,
      buyQuote: q(1),
      sellQuote: q(1),
    });

    let v;
    expect(() => {
      v = decideEntry({
        pair: pair(),
        portfolio: emptyPortfolio({}),
        gateResult: buyableGate,
        costBreakdown: catastrophic,
        now: NOW,
      });
    }).not.toThrow();
    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/not priceable, so not enterable/);
  });

  it('reports the real break-even number alongside the decision', () => {
    const v = entry();

    expect(v.costs.breakEvenPct).toBeGreaterThan(0);
    expect(v.costs.edgePct).toBeCloseTo(
      STRATEGY.entry.expectedGrossMovePct - v.costs.breakEvenPct,
      10,
    );
  });
});

describe('decideEntry -- capacity', () => {
  const withPositions = (count) => {
    let book = emptyPortfolio({ bookSizeUsd: 100_000 });
    for (let i = 0; i < count; i += 1) {
      book = openPosition(book, {
        mint: `mint-${i}`,
        sizeUsd: 1,
        entryPriceUsd: 1,
        ts: NOW,
        costUsd: 0,
        gateResult: buyableGate,
      });
    }
    return book;
  };

  it('refuses when every slot is taken', () => {
    const v = decideEntry({
      pair: pair(),
      portfolio: withPositions(RISK.maxConcurrentPositions),
      gateResult: buyableGate,
      costBreakdown: cheapCost(),
      now: NOW,
    });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/no free slot/);
  });

  it('refuses a second position in a mint already held', () => {
    const book = openPosition(emptyPortfolio({}), {
      mint: MINT,
      sizeUsd: 1,
      entryPriceUsd: 1,
      ts: NOW,
      costUsd: 0,
      gateResult: buyableGate,
    });
    const v = decideEntry({
      pair: pair(),
      portfolio: book,
      gateResult: buyableGate,
      costBreakdown: cheapCost(),
      now: NOW,
    });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/already holding/);
  });
});

describe('decideEntry -- the early profile', () => {
  const smallYoung = {
    marketCap: 300_000,
    fdv: 300_000,
    pairCreatedAtMs: NOW - 30 * MS_PER_MIN,
    volumeUsd: { m5: 2_000, h1: 10_000 },
    txns: { m5: { buys: 30, sells: 15 }, h1: { buys: 20, sells: 10 } },
  };

  it('rejects a small young pair under the standard profile', () => {
    const v = entry(smallYoung);

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/below minimum/);
  });

  it('accepts the same pair under the early profile', () => {
    const v = entry(smallYoung, { universe: UNIVERSE_PROFILES.early });

    expect(v.enter).toBe(true);
  });

  it('still enforces the early profile own tighter market-cap ceiling', () => {
    const v = entry(
      { ...smallYoung, marketCap: UNIVERSE_PROFILES.early.maxMarketCapUsd + 1 },
      { universe: UNIVERSE_PROFILES.early },
    );

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/above ceiling/);
  });

  it('still requires the safety gate: a profile can never bypass it', () => {
    const v = decideEntry({
      pair: pair(smallYoung),
      portfolio: emptyPortfolio({}),
      gateResult: blockedGate,
      costBreakdown: cheapCost(),
      now: NOW,
      universe: UNIVERSE_PROFILES.early,
    });

    expect(v.enter).toBe(false);
    expect(why(v)).toMatch(/safety gate blocked/);
  });
});

describe('decideEntry -- momentum:false shares every other check', () => {
  it('skips momentum but still enforces gate, universe and costs', () => {
    const flat = { priceChangePct: { m5: 0, h1: 0 }, volumeUsd: { m5: 1, h1: 30_000 } };

    expect(entry(flat).enter).toBe(false);
    expect(entry(flat, { momentum: false }).enter).toBe(true);

    // ...but the non-momentum checks are untouched
    expect(entry({ ...flat, marketCap: 9_000_000 }, { momentum: false }).enter).toBe(false);
    expect(
      decideEntry({
        pair: pair(flat),
        portfolio: emptyPortfolio({}),
        gateResult: blockedGate,
        costBreakdown: cheapCost(),
        now: NOW,
        momentum: false,
      }).enter,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

const position = (over = {}) =>
  Object.freeze({
    mint: MINT,
    sizeUsd: 40,
    entryPriceUsd: 100,
    qty: 0.4,
    openedTs: NOW,
    entryCostUsd: 0.5,
    lastPriceUsd: 100,
    lastMarkTs: NOW,
    unrealisedPnlUsd: 0,
    ...over,
  });

const priceFor = (pct) => 100 * (1 + pct / 100);

describe('decideExit -- precedence', () => {
  it('exits on a failed gate recheck before anything else, even deep in profit', () => {
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(STRATEGY.exit.takeProfitPct + 50),
      now: NOW + MS_PER_MIN,
      gateRecheck: { buyable: false, reasons: ['transferHook appeared'] },
    });

    expect(v.exit).toBe(true);
    expect(v.reason).toBe(EXIT_REASON.GATE_RECHECK);
    expect(why(v)).toMatch(/transferHook appeared/);
  });

  it('prefers the stop loss over the time stop when both apply', () => {
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(-STRATEGY.exit.stopLossPct - 5),
      now: NOW + (STRATEGY.exit.timeStopMinutes + 10) * MS_PER_MIN,
    });

    expect(v.reason).toBe(EXIT_REASON.STOP_LOSS);
  });

  it('prefers the trailing stop over take profit when both apply', () => {
    // peak +30%, now +13% -> 13% off the peak, and above takeProfitPct too
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(13),
      peakPriceUsd: priceFor(30),
      now: NOW + MS_PER_MIN,
    });

    expect(v.reason).toBe(EXIT_REASON.TRAILING_STOP);
  });
});

describe('decideExit -- each rule', () => {
  it('fires the stop loss exactly at the threshold', () => {
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(-STRATEGY.exit.stopLossPct),
      now: NOW + MS_PER_MIN,
    });

    expect(v.exit).toBe(true);
    expect(v.reason).toBe(EXIT_REASON.STOP_LOSS);
  });

  it('holds one basis point above the stop loss', () => {
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(-STRATEGY.exit.stopLossPct + 0.01),
      now: NOW + MS_PER_MIN,
    });

    expect(v.exit).toBe(false);
  });

  it('does NOT arm the trailing stop below trailingArmsAtPct', () => {
    // peak only +5% (< trailingArmsAtPct 6), now well off that peak
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(-1),
      peakPriceUsd: priceFor(STRATEGY.exit.trailingArmsAtPct - 1),
      now: NOW + MS_PER_MIN,
    });

    expect(v.exit).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('arms the trailing stop once the peak reached trailingArmsAtPct', () => {
    const peakPct = STRATEGY.exit.trailingArmsAtPct;
    const peak = priceFor(peakPct);
    // drop trailingStopPct off that peak
    const price = peak * (1 - STRATEGY.exit.trailingStopPct / 100);
    const v = decideExit({
      position: position(),
      priceUsd: price,
      peakPriceUsd: peak,
      now: NOW + MS_PER_MIN,
    });

    expect(v.exit).toBe(true);
    expect(v.reason).toBe(EXIT_REASON.TRAILING_STOP);
  });

  it('takes profit exactly at the threshold', () => {
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(STRATEGY.exit.takeProfitPct),
      now: NOW + MS_PER_MIN,
    });

    expect(v.exit).toBe(true);
    expect(v.reason).toBe(EXIT_REASON.TAKE_PROFIT);
  });

  it('fires the time stop exactly at timeStopMinutes', () => {
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(1),
      now: NOW + STRATEGY.exit.timeStopMinutes * MS_PER_MIN,
    });

    expect(v.exit).toBe(true);
    expect(v.reason).toBe(EXIT_REASON.TIME_STOP);
  });

  it('holds one minute short of the time stop', () => {
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(1),
      now: NOW + (STRATEGY.exit.timeStopMinutes - 1) * MS_PER_MIN,
    });

    expect(v.exit).toBe(false);
  });
});

describe('decideExit -- unknown price', () => {
  it('refuses to fabricate a pnl, and does not call it an exit', () => {
    const v = decideExit({ position: position(), now: NOW + MS_PER_MIN });

    expect(v.exit).toBe(false);
    expect(v.priceUnknown).toBe(true);
    expect(v.pnlPct).toBeNull();
    expect(why(v)).toMatch(/refusing to fabricate/);
  });

  it('still exits on a failed recheck even with no price', () => {
    const v = decideExit({
      position: position(),
      now: NOW + MS_PER_MIN,
      gateRecheck: { buyable: false, reasons: ['pool drained'] },
    });

    expect(v.exit).toBe(true);
    expect(v.reason).toBe(EXIT_REASON.GATE_RECHECK);
  });

  it('a passing recheck does not by itself cause an exit', () => {
    const v = decideExit({
      position: position(),
      priceUsd: priceFor(1),
      now: NOW + MS_PER_MIN,
      gateRecheck: { buyable: true, reasons: [] },
    });

    expect(v.exit).toBe(false);
  });
});

describe('stepEngine', () => {
  const tick = (over = {}) => ({
    ts: NOW,
    pairs: [pair()],
    gateResults: { [MINT]: buyableGate },
    costs: { [MINT]: cheapCost() },
    ...over,
  });

  it('opens a position when the rules fire, charging only the entry leg', () => {
    const s0 = createEngineState({ portfolio: emptyPortfolio({}) });
    const s1 = stepEngine(s0, tick());

    expect(Object.keys(s1.portfolio.positions)).toEqual([MINT]);
    const legs = splitLegCosts(cheapCost());
    expect(s1.portfolio.positions[MINT].entryCostUsd).toBeCloseTo(legs.entryUsd, 12);
    expect(s1.actions.some((a) => a.kind === 'open')).toBe(true);
  });

  it('never mutates the state it was given', () => {
    const s0 = createEngineState({ portfolio: emptyPortfolio({}) });
    const before = JSON.stringify(s0);

    stepEngine(s0, tick());

    expect(JSON.stringify(s0)).toBe(before);
    expect(Object.keys(s0.portfolio.positions)).toEqual([]);
    expect(Object.isFrozen(s0)).toBe(true);
  });

  it('returns a frozen state with a frozen actions log', () => {
    const s1 = stepEngine(createEngineState({ portfolio: emptyPortfolio({}) }), tick());

    expect(Object.isFrozen(s1)).toBe(true);
    expect(Object.isFrozen(s1.actions)).toBe(true);
    expect(Object.isFrozen(s1.peaks)).toBe(true);
    expect(() => s1.actions.push({})).toThrow();
  });

  it('skips a mint with no gate result: never enters on an unchecked token', () => {
    const s1 = stepEngine(
      createEngineState({ portfolio: emptyPortfolio({}) }),
      tick({ gateResults: {} }),
    );

    expect(s1.portfolio.positions).toEqual({});
    expect(s1.actions.find((a) => a.kind === 'skip').reasons.join(' ')).toMatch(
      /no gate result/,
    );
  });

  it('skips a mint with no cost breakdown: cannot prove it clears costs', () => {
    const s1 = stepEngine(
      createEngineState({ portfolio: emptyPortfolio({}) }),
      tick({ costs: {} }),
    );

    expect(s1.portfolio.positions).toEqual({});
    expect(s1.actions.find((a) => a.kind === 'skip').reasons.join(' ')).toMatch(
      /no cost breakdown/,
    );
  });

  it('tracks the high-water mark across ticks', () => {
    let s = stepEngine(createEngineState({ portfolio: emptyPortfolio({}) }), tick());
    const entryPrice = s.portfolio.positions[MINT].entryPriceUsd;

    // +5%: below takeProfitPct (12) and below trailingArmsAtPct (6), so nothing exits
    s = stepEngine(s, tick({ ts: NOW + MS_PER_MIN, pairs: [pair({ priceUsd: entryPrice * 1.05 })] }));
    expect(s.peaks[MINT]).toBeCloseTo(entryPrice * 1.05, 12);

    // price falls back; the peak must NOT fall with it
    s = stepEngine(s, tick({ ts: NOW + 2 * MS_PER_MIN, pairs: [pair({ priceUsd: entryPrice })] }));
    expect(Object.keys(s.portfolio.positions)).toEqual([MINT]);
    expect(s.peaks[MINT]).toBeCloseTo(entryPrice * 1.05, 12);
  });

  it('does NOT re-enter a mint it exited in the same tick', () => {
    let s = stepEngine(createEngineState({ portfolio: emptyPortfolio({}) }), tick());
    const entryPrice = s.portfolio.positions[MINT].entryPriceUsd;
    const target = entryPrice * (1 + (STRATEGY.exit.takeProfitPct + 1) / 100);

    // the same tick both signals the exit AND still satisfies every entry rule
    s = stepEngine(s, tick({ ts: NOW + MS_PER_MIN, pairs: [pair({ priceUsd: target })] }));

    expect(s.portfolio.positions).toEqual({});
    expect(s.portfolio.closedTrades).toHaveLength(1);
    expect(s.portfolio.openedCount).toBe(1);
    expect(s.actions.find((a) => a.kind === 'skip').reasons.join(' ')).toMatch(
      /exited this tick/,
    );
  });

  it('closes a position on take profit and charges the exit leg once', () => {
    let s = stepEngine(createEngineState({ portfolio: emptyPortfolio({}) }), tick());
    const entryPrice = s.portfolio.positions[MINT].entryPriceUsd;
    const target = entryPrice * (1 + (STRATEGY.exit.takeProfitPct + 1) / 100);

    s = stepEngine(s, tick({ ts: NOW + MS_PER_MIN, pairs: [pair({ priceUsd: target })] }));

    expect(s.portfolio.positions).toEqual({});
    expect(s.portfolio.closedTrades).toHaveLength(1);
    const trade = s.portfolio.closedTrades[0];
    const legs = splitLegCosts(cheapCost());
    expect(trade.reason).toBe(EXIT_REASON.TAKE_PROFIT);
    expect(trade.exitCostUsd).toBeCloseTo(legs.exitUsd, 12);
    expect(trade.totalCostUsd).toBeCloseTo(legs.totalUsd, 12);
    // the peak is forgotten once the position is gone
    expect(s.peaks[MINT]).toBeUndefined();
  });

  it('exits on a failed recheck even when the price is happy', () => {
    let s = stepEngine(createEngineState({ portfolio: emptyPortfolio({}) }), tick());
    s = stepEngine(
      s,
      tick({
        ts: NOW + MS_PER_MIN,
        gateRechecks: { [MINT]: { buyable: false, reasons: ['pausableConfig appeared'] } },
      }),
    );

    expect(s.portfolio.closedTrades[0].reason).toBe(EXIT_REASON.GATE_RECHECK);
  });

  it('lets a tripped kill switch block entries while still allowing exits', () => {
    // six consecutive losses trips RISK.killSwitchConsecutiveLosses
    let book = emptyPortfolio({ bookSizeUsd: 100_000 });
    for (let i = 0; i < RISK.killSwitchConsecutiveLosses; i += 1) {
      book = openPosition(book, {
        mint: `loser-${i}`,
        sizeUsd: 10,
        entryPriceUsd: 10,
        ts: NOW,
        costUsd: 0,
        gateResult: buyableGate,
      });
      book = stepEngine(createEngineState({ portfolio: book }), {
        ts: NOW + MS_PER_MIN,
        pairs: [{ mint: `loser-${i}`, priceUsd: 1, priceChangePct: {}, txns: {}, volumeUsd: {} }],
        gateResults: {},
        costs: {},
      }).portfolio;
    }

    expect(book.consecutiveLosses).toBeGreaterThanOrEqual(RISK.killSwitchConsecutiveLosses);

    const s = stepEngine(createEngineState({ portfolio: book }), tick());
    expect(s.killSwitch.tripped).toBe(true);
    expect(s.portfolio.positions[MINT]).toBeUndefined();
    expect(s.actions.some((a) => a.kind === 'kill-switch')).toBe(true);
  });

  it('skips an entry the book refuses instead of abandoning the whole tick', () => {
    // A book with almost no cash: openPosition throws rather than overspending.
    // The tick must survive that -- the exits and marks already applied above it
    // would otherwise be lost.
    const broke = emptyPortfolio({ bookSizeUsd: 1 });
    const s = stepEngine(createEngineState({ portfolio: broke }), tick());

    expect(s.portfolio.positions).toEqual({});
    const skip = s.actions.find((a) => a.kind === 'skip');
    expect(skip.reasons.join(' ')).toMatch(/entry refused by the book/);
    // and the state is still a usable, frozen portfolio
    expect(Object.isFrozen(s.portfolio)).toBe(true);
  });

  it('records an unpriced held position as a hold rather than guessing', () => {
    let s = stepEngine(createEngineState({ portfolio: emptyPortfolio({}) }), tick());
    s = stepEngine(s, { ts: NOW + MS_PER_MIN, pairs: [], gateResults: {}, costs: {} });

    // the position survives, and the missing price is SURFACED rather than
    // silently treated as "unchanged" (which would understate drawdown)
    expect(Object.keys(s.portfolio.positions)).toEqual([MINT]);
    expect(s.actions.some((a) => a.kind === 'hold-unpriced')).toBe(true);
    expect(s.portfolio.closedTrades).toHaveLength(0);
  });
});
