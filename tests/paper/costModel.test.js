import { describe, expect, it } from 'vitest';
import { COSTS, RISK, SAFETY } from '../../src/config.js';
import {
  breakEvenMovePct,
  clearsCosts,
  estimateRoundTripCost,
} from '../../src/paper/costModel.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_PRICE_USD = 150;

/** Jupiter reports priceImpactPct as a decimal fraction: 0.004 == 0.4%. */
const quote = (impactFraction, slippageBps = SAFETY.layer1.quoteSlippageBps) =>
  Object.freeze({ priceImpactPct: String(impactFraction), slippageBps });

const estimate = (impact = 0.004, positionSizeUsd = RISK.positionSizeUsd) =>
  estimateRoundTripCost({
    positionSizeUsd,
    solPriceUsd: SOL_PRICE_USD,
    buyQuote: quote(impact),
    sellQuote: quote(impact),
  });

describe('estimateRoundTripCost', () => {
  it('returns a frozen breakdown with every documented field', () => {
    const c = estimate();
    expect(Object.isFrozen(c)).toBe(true);
    for (const field of [
      'baseFeeUsd',
      'priorityFeeUsd',
      'ataRentUsd',
      'ataRentRefundableUsd',
      'routerFeeUsd',
      'buySlippageUsd',
      'sellSlippageUsd',
      'totalUsd',
      'totalPct',
    ]) {
      expect(Number.isFinite(c[field]), field).toBe(true);
    }
    expect(() => {
      c.totalUsd = 0;
    }).toThrow(TypeError);
  });

  it('prices network fees from COSTS for both legs at the live SOL price', () => {
    const c = estimate();
    const legs = 2;
    expect(c.baseFeeUsd).toBeCloseTo(
      ((COSTS.solBaseFeeLamports * legs) / LAMPORTS_PER_SOL) * SOL_PRICE_USD,
      12,
    );
    expect(c.priorityFeeUsd).toBeCloseTo(
      ((COSTS.priorityFeeLamports * legs) / LAMPORTS_PER_SOL) * SOL_PRICE_USD,
      12,
    );
  });

  it('charges the router fee on both legs from COSTS.routerFeeBps', () => {
    const c = estimate();
    expect(c.routerFeeUsd).toBeCloseTo(
      2 * RISK.positionSizeUsd * (COSTS.routerFeeBps / 10_000),
      12,
    );
  });

  it('takes slippage from the live quotes, not a hardcoded guess', () => {
    expect(COSTS.useLiveQuoteForSlippage).toBe(true);
    const cheap = estimate(0.001);
    const pricey = estimate(0.01);
    expect(cheap.slippageSource).toBe('live-quote:priceImpactPct');
    expect(cheap.buySlippagePct).toBeCloseTo(0.1, 12);
    expect(pricey.buySlippagePct).toBeCloseTo(1, 12);
    // 10x the impact must be exactly 10x the slippage cost.
    expect(pricey.buySlippageUsd / cheap.buySlippageUsd).toBeCloseTo(10, 9);
    expect(pricey.totalUsd).toBeGreaterThan(cheap.totalUsd);
  });

  it('reads asymmetric buy and sell impacts independently', () => {
    const c = estimateRoundTripCost({
      positionSizeUsd: RISK.positionSizeUsd,
      solPriceUsd: SOL_PRICE_USD,
      buyQuote: quote(0.002),
      sellQuote: quote(0.006),
    });
    expect(c.buySlippagePct).toBeCloseTo(0.2, 12);
    expect(c.sellSlippagePct).toBeCloseTo(0.6, 12);
    expect(c.sellSlippageUsd).toBeCloseTo(3 * c.buySlippageUsd, 9);
  });

  it('fails closed on unusable quote data instead of assuming zero slippage', () => {
    const size = { positionSizeUsd: RISK.positionSizeUsd, solPriceUsd: SOL_PRICE_USD };
    expect(() => estimateRoundTripCost({ ...size, sellQuote: quote(0.004) })).toThrow(
      /buyQuote must be an object/,
    );
    expect(() =>
      estimateRoundTripCost({ ...size, buyQuote: {}, sellQuote: quote(0.004) }),
    ).toThrow(/priceImpactPct is missing/);
    expect(() =>
      estimateRoundTripCost({
        ...size,
        buyQuote: { priceImpactPct: '   ' },
        sellQuote: quote(0.004),
      }),
    ).toThrow(/blank/);
    expect(() =>
      estimateRoundTripCost({
        ...size,
        buyQuote: { priceImpactPct: 'not-a-number' },
        sellQuote: quote(0.004),
      }),
    ).toThrow(/not a finite number/);
    expect(() =>
      estimateRoundTripCost({
        ...size,
        buyQuote: { priceImpactPct: 42 },
        sellQuote: quote(0.004),
      }),
    ).toThrow(/exceeds 1\.0/);
    expect(() => estimateRoundTripCost({ positionSizeUsd: 0, solPriceUsd: 1 })).toThrow(
      /positionSizeUsd must be > 0/,
    );
    expect(() =>
      estimateRoundTripCost({ positionSizeUsd: 40, solPriceUsd: 0 }),
    ).toThrow(/solPriceUsd must be > 0/);
  });

  it('never lets a favourable (negative) impact subsidise other costs', () => {
    const c = estimateRoundTripCost({
      positionSizeUsd: RISK.positionSizeUsd,
      solPriceUsd: SOL_PRICE_USD,
      buyQuote: { priceImpactPct: -0.003 },
      sellQuote: quote(0),
    });
    expect(c.buySlippagePct).toBe(0);
    expect(c.buySlippageUsd).toBe(0);
    expect(c.totalUsd).toBeGreaterThan(0);
  });

  it('does not double-count refundable ATA rent as a loss', () => {
    const c = estimate();
    expect(c.ataRentUsd).toBeCloseTo(
      (COSTS.ataRentLamports / LAMPORTS_PER_SOL) * SOL_PRICE_USD,
      12,
    );
    // Fully refundable: tied-up capital, zero net cost.
    expect(c.ataRentRefundableUsd).toBe(c.ataRentUsd);
    expect(c.ataRentNetUsd).toBe(0);

    // totalUsd is exactly the non-refundable parts -- rent is not in there.
    const nonRefundable =
      c.baseFeeUsd + c.priorityFeeUsd + c.routerFeeUsd + c.buySlippageUsd + c.sellSlippageUsd;
    expect(c.totalUsd).toBeCloseTo(nonRefundable, 12);
    expect(c.totalUsd).toBeLessThan(nonRefundable + c.ataRentUsd);

    // ...but the deposit still has to be funded up front.
    expect(c.capitalRequiredUsd).toBeCloseTo(
      RISK.positionSizeUsd + c.ataRentUsd + c.baseFeeUsd + c.priorityFeeUsd,
      12,
    );
    expect(c.capitalRequiredUsd).toBeGreaterThan(RISK.positionSizeUsd + c.ataRentUsd * 0.99);
  });

  it('expresses totalPct against the position size', () => {
    const c = estimate();
    expect(c.totalPct).toBeCloseTo((c.totalUsd / RISK.positionSizeUsd) * 100, 12);
  });

  it('prices a worst-case fill at the quoted slippage tolerance', () => {
    const c = estimate(0.001);
    expect(c.worstCaseTotalUsd).toBeGreaterThan(c.totalUsd);
    expect(c.worstCaseTotalPct).toBeGreaterThan(c.totalPct);
  });
});

describe('breakEvenMovePct', () => {
  it('lands in the documented 2-4% band at a 40 USD position', () => {
    // Order-of-magnitude guard: with a 40 USD position and realistic live
    // quotes the round trip costs a few percent, never a few basis points and
    // never tens of percent. Bounds are deliberately wider (1%-6%) than the
    // 2-4% documented on COSTS so plausible quote variation does not break the
    // suite, while an arithmetic slip of 10x in either direction does.
    expect(RISK.positionSizeUsd).toBe(40);
    for (const impact of [0, 0.001, 0.004, 0.01]) {
      const move = breakEvenMovePct(estimate(impact));
      expect(move, `impact ${impact}`).toBeGreaterThan(1);
      expect(move, `impact ${impact}`).toBeLessThan(6);
    }
  });

  it('is never cheaper than the naive cost percentage', () => {
    // The sell-side rate applies to the larger exit notional, so the true
    // break-even sits just above totalPct. Below it would fabricate profit.
    const c = estimate();
    expect(breakEvenMovePct(c)).toBeGreaterThan(c.totalPct);
    expect(breakEvenMovePct(c)).toBeLessThan(c.totalPct * 1.5);
  });

  it('rises monotonically with slippage', () => {
    const moves = [0, 0.002, 0.005, 0.01].map((i) => breakEvenMovePct(estimate(i)));
    for (let i = 1; i < moves.length; i += 1) {
      expect(moves[i]).toBeGreaterThan(moves[i - 1]);
    }
  });

  it('shrinks as the position grows, because fixed fees amortise', () => {
    const small = breakEvenMovePct(estimate(0.004, 10));
    const large = breakEvenMovePct(estimate(0.004, 400));
    expect(small).toBeGreaterThan(large);
  });

  it('rejects a breakdown it cannot trust', () => {
    expect(() => breakEvenMovePct(undefined)).toThrow(/costBreakdown must be an object/);
    expect(() => breakEvenMovePct({})).toThrow(/positionSizeUsd/);
    expect(() =>
      breakEvenMovePct({ positionSizeUsd: 40, fixedUsd: 0, buyProportionalPct: 1 }),
    ).toThrow(/sellProportionalPct/);
    expect(() =>
      breakEvenMovePct({
        positionSizeUsd: 40,
        fixedUsd: 0,
        buyProportionalPct: 100,
        sellProportionalPct: 1,
      }),
    ).toThrow(/no break-even move exists/);
  });
});

describe('clearsCosts', () => {
  it('separates a move that clears costs from one that does not', () => {
    const c = estimate();
    const breakEven = breakEvenMovePct(c);
    const winner = clearsCosts(c, breakEven + 1);
    const loser = clearsCosts(c, breakEven - 0.1);
    expect(winner.clears).toBe(true);
    expect(winner.edgePct).toBeCloseTo(1, 9);
    expect(loser.clears).toBe(false);
    expect(loser.edgePct).toBeLessThan(0);
    expect(Object.isFrozen(winner)).toBe(true);
  });

  it('treats an exactly-break-even move as not clearing', () => {
    const c = estimate();
    expect(clearsCosts(c, breakEvenMovePct(c)).clears).toBe(false);
  });
});
