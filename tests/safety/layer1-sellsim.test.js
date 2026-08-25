import { describe, expect, it, vi } from 'vitest';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SAFETY } from '../../src/config.js';
import { OUTCOME } from '../../src/safety/verdict.js';
import {
  LAYER,
  SIMULATION_LIMITATION,
  checkSellability,
} from '../../src/safety/layer1-sellsim.js';

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const quote = (outAmount, priceImpactPct) =>
  Object.freeze({
    inAmount: '1',
    outAmount: String(outAmount),
    otherAmountThreshold: String(outAmount),
    priceImpactPct,
    routePlan: Object.freeze([{ swapInfo: { label: 'Raydium' } }]),
    raw: Object.freeze({}),
  });

/** A round trip that returns `returned` lamports out of `probe` lamports spent. */
const roundTripReturning = (probe, returned, impacts = { buy: 0.4, sell: 0.6 }) =>
  Object.freeze({
    buyQuote: quote('123456789', impacts.buy),
    sellQuote: quote(returned, impacts.sell),
    returnedLamports: returned,
    roundTripLossPct: (1 - returned / probe) * 100,
    sellRouteExists: true,
  });

const noSellRoute = () =>
  Object.freeze({
    buyQuote: quote('123456789', 0.4),
    sellQuote: null,
    returnedLamports: 0,
    roundTripLossPct: 100,
    sellRouteExists: false,
  });

const expectedProbeLamports = Math.round(SAFETY.layer1.probeSizeSol * LAMPORTS_PER_SOL);

describe('checkSellability', () => {
  it('rejects when no sell route exists, naming the honeypot explicitly', async () => {
    const getRoundTrip = vi.fn(async () => noSellRoute());

    const v = await checkSellability(MINT, { getRoundTrip });

    expect(v.layer).toBe(LAYER);
    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.join(' ')).toMatch(/honeypot/i);
    expect(v.reasons.join(' ')).toMatch(/cannot be sold/i);
    expect(v.facts.sellRouteExists).toBe(false);
    expect(v.facts.roundTripLossPct).toBe(100);
  });

  it('rejects a 50% round-trip loss', async () => {
    const probe = expectedProbeLamports;
    const getRoundTrip = vi.fn(async () => roundTripReturning(probe, probe / 2));

    const v = await checkSellability(MINT, { getRoundTrip });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.roundTripLossPct).toBeCloseTo(50, 10);
    expect(v.reasons.join(' ')).toMatch(/50\.00%/);
    expect(v.reasons.join(' ')).toContain(String(SAFETY.layer1.maxRoundTripLossPct));
    // The route existed: this is a cost rejection, not a honeypot finding.
    expect(v.facts.sellRouteExists).toBe(true);
  });

  it('passes a 2% round-trip loss and records both price impacts', async () => {
    const probe = expectedProbeLamports;
    const getRoundTrip = vi.fn(async () =>
      roundTripReturning(probe, probe * 0.98, { buy: 0.31, sell: 0.44 }),
    );

    const v = await checkSellability(MINT, { getRoundTrip });

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.reasons).toEqual([]);
    expect(v.facts.roundTripLossPct).toBeCloseTo(2, 10);
    expect(v.facts.buyPriceImpactPct).toBe(0.31);
    expect(v.facts.sellPriceImpactPct).toBe(0.44);
    expect(v.facts.returnedLamports).toBe(probe * 0.98);
  });

  it('passes at exactly the configured maximum loss (reject is strictly above)', async () => {
    const probe = expectedProbeLamports;
    const returned = probe * (1 - SAFETY.layer1.maxRoundTripLossPct / 100);
    const getRoundTrip = vi.fn(async () => ({
      ...roundTripReturning(probe, returned),
      roundTripLossPct: SAFETY.layer1.maxRoundTripLossPct,
    }));

    const v = await checkSellability(MINT, { getRoundTrip });

    expect(v.outcome).toBe(OUTCOME.PASS);
  });

  it('yields ERROR when the round trip throws (fail closed)', async () => {
    const getRoundTrip = vi.fn(async () => {
      throw new Error('jupiter quote request failed: socket hang up');
    });

    const v = await checkSellability(MINT, { getRoundTrip });

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.outcome).not.toBe(OUTCOME.PASS);
    expect(v.reasons.join(' ')).toMatch(/socket hang up/);
    expect(v.facts.probeLamports).toBe(expectedProbeLamports);
  });

  it('yields ERROR on an unparseable round-trip result', async () => {
    const cases = [null, 'nope', {}, { sellRouteExists: true, roundTripLossPct: 'low' }];

    for (const value of cases) {
      const v = await checkSellability(MINT, { getRoundTrip: async () => value });
      expect(v.outcome).toBe(OUTCOME.ERROR);
    }
  });

  it('yields ERROR on a missing dependency or bad mint instead of throwing', async () => {
    const noDeps = await checkSellability(MINT, {});
    expect(noDeps.outcome).toBe(OUTCOME.ERROR);

    const badMint = await checkSellability('', { getRoundTrip: async () => noSellRoute() });
    expect(badMint.outcome).toBe(OUTCOME.ERROR);
  });

  it('reads probe size and slippage from config, never from a literal', async () => {
    const getRoundTrip = vi.fn(async () =>
      roundTripReturning(expectedProbeLamports, expectedProbeLamports),
    );

    const v = await checkSellability(MINT, { getRoundTrip });

    expect(getRoundTrip).toHaveBeenCalledTimes(1);
    expect(getRoundTrip).toHaveBeenCalledWith({
      mint: MINT,
      probeLamports: expectedProbeLamports,
      slippageBps: SAFETY.layer1.quoteSlippageBps,
    });
    // 0.05 SOL at 1e9 lamports/SOL, straight from SAFETY.layer1.probeSizeSol.
    expect(expectedProbeLamports).toBe(50_000_000);
    expect(v.facts.probeSizeSol).toBe(SAFETY.layer1.probeSizeSol);
    expect(v.facts.probeLamports).toBe(expectedProbeLamports);
    expect(v.facts.slippageBps).toBe(SAFETY.layer1.quoteSlippageBps);
  });

  it('never claims the sell transaction was simulated', async () => {
    const probe = expectedProbeLamports;
    const v = await checkSellability(MINT, {
      getRoundTrip: async () => roundTripReturning(probe, probe),
    });

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.sellTransactionSimulated).toBe(false);
    expect(v.facts.simulationMethod).toBe('quote-only-round-trip');
  });

  it('returns frozen verdicts', async () => {
    const v = await checkSellability(MINT, { getRoundTrip: async () => noSellRoute() });

    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.facts)).toBe(true);
    expect(Object.isFrozen(v.reasons)).toBe(true);
  });
});

describe('SIMULATION_LIMITATION', () => {
  it('is frozen and documents what the quote round trip does not prove', () => {
    expect(Object.isFrozen(SIMULATION_LIMITATION)).toBe(true);
    expect(Object.isFrozen(SIMULATION_LIMITATION.notProven)).toBe(true);
    expect(SIMULATION_LIMITATION.layer).toBe(LAYER);
    expect(SIMULATION_LIMITATION.notProven.length).toBeGreaterThan(0);
    expect(SIMULATION_LIMITATION.notProven.join(' ')).toMatch(/transferhook|hook/i);
    expect(SIMULATION_LIMITATION.requiredForFullProof.join(' ')).toMatch(/simulateTransaction/);
    expect(SIMULATION_LIMITATION.unsatisfiedConfigFlag).toBe(
      'SAFETY.layer1.requireSellSimulationSuccess',
    );
  });
});
