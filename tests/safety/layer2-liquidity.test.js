import { describe, expect, it, vi } from 'vitest';
import { RISK, SAFETY } from '../../src/config.js';
import { LAYER_SPECS, loadLayerFn } from '../../src/safety/gate-layers.js';
import { checkLiquidity, runLayer2 } from '../../src/safety/layer2-liquidity.js';
import { OUTCOME } from '../../src/safety/verdict.js';

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const cfg = SAFETY.layer2;

/** A pair that clears every layer-2 threshold. Override one field per test. */
const pair = (over = {}) => ({
  pairAddress: 'PAIR1',
  dexId: 'raydium',
  liquidityUsd: 100_000,
  marketCap: 1_000_000,
  lpBurnedPct: 100,
  ...over,
});

const why = (v) => v.reasons.join(' | ');

describe('checkLiquidity -- depth', () => {
  it('passes a healthy pool', async () => {
    const v = await checkLiquidity(pair());

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.reasons).toEqual([]);
    expect(v.layer).toBe('layer2-liquidity');
  });

  it('rejects liquidity below the floor', async () => {
    const v = await checkLiquidity(pair({ liquidityUsd: cfg.minLiquidityUsd - 1, marketCap: 100_000 }));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(why(v)).toMatch(/below minimum/);
  });

  it('accepts liquidity exactly at the floor', async () => {
    const v = await checkLiquidity(
      pair({ liquidityUsd: cfg.minLiquidityUsd, marketCap: cfg.minLiquidityUsd * 10 }),
    );

    expect(v.outcome).toBe(OUTCOME.PASS);
  });

  it('REJECTS unknown liquidity rather than reading it as zero', async () => {
    const v = await checkLiquidity(pair({ liquidityUsd: null }));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(why(v)).toMatch(/liquidityUsd unknown/);
  });

  it('rejects a zero pool as untradeable, distinctly from unknown', async () => {
    const v = await checkLiquidity(pair({ liquidityUsd: 0 }));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(why(v)).toMatch(/no tradeable pool/);
  });

  it('reads Dexscreener nested liquidity.usd', async () => {
    const v = await checkLiquidity({
      pairAddress: 'P',
      liquidity: { usd: 100_000 },
      marketCap: 1_000_000,
      lpBurnedPct: 100,
    });

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.liquidityUsd).toBe(100_000);
  });
});

describe('checkLiquidity -- our own footprint', () => {
  it('rejects when our order is too large a slice of the pool', async () => {
    // maxPositionPctOfLiquidity is a PERCENT: 0.5 means half a percent
    const tiny = (RISK.positionSizeUsd / (cfg.maxPositionPctOfLiquidity / 100)) - 1;
    const v = await checkLiquidity(pair({ liquidityUsd: Math.max(tiny, cfg.minLiquidityUsd) }));

    if (tiny > cfg.minLiquidityUsd) {
      expect(v.outcome).toBe(OUTCOME.REJECT);
      expect(why(v)).toMatch(/we would be our own slippage/);
    }
  });

  it('honours an injected positionSizeUsd', async () => {
    const v = await checkLiquidity(pair({ liquidityUsd: 100_000 }), { positionSizeUsd: 50_000 });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(why(v)).toMatch(/of liquidity/);
  });

  it('rejects a non-positive positionSizeUsd as a usage error', async () => {
    const v = await checkLiquidity(pair(), { positionSizeUsd: 0 });

    expect(v.outcome).toBe(OUTCOME.ERROR);
  });
});

describe('checkLiquidity -- float vs cap', () => {
  it('rejects a thin float on an inflated cap', async () => {
    // ratio below minLiquidityToMcapRatio
    const v = await checkLiquidity(pair({ liquidityUsd: 50_000, marketCap: 50_000_000 }));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(why(v)).toMatch(/thin float on an inflated cap/);
  });

  it('REJECTS unknown market cap rather than skipping the ratio', async () => {
    const v = await checkLiquidity(pair({ marketCap: null, fdv: null }));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(why(v)).toMatch(/marketCap unknown/);
  });

  it('falls back to fdv, the more conservative of the two', async () => {
    const v = await checkLiquidity({
      pairAddress: 'P',
      liquidityUsd: 100_000,
      fdv: 1_000_000,
      lpBurnedPct: 100,
    });

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.marketCap).toBe(1_000_000);
  });
});

describe('checkLiquidity -- LP burned or locked', () => {
  it('rejects LP below the burn minimum', async () => {
    const v = await checkLiquidity(pair({ lpBurnedPct: cfg.minLpBurnedPct - 1 }));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(why(v)).toMatch(/the creator can still pull the pool/);
  });

  it('accepts LP exactly at the minimum', async () => {
    const v = await checkLiquidity(pair({ lpBurnedPct: cfg.minLpBurnedPct }));

    expect(v.outcome).toBe(OUTCOME.PASS);
  });

  it('PASSES with an explicit unverified marker when no LP evidence exists', async () => {
    // never a silent pass: the orchestrator must be able to surface this
    const v = await checkLiquidity(pair({ lpBurnedPct: undefined }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.lp.status).toBe('unverified');
    expect(v.facts.unverified).toContain('lpBurnedOrLocked');
    expect(v.facts.scoreDown).toBe(true);
  });

  it('REJECTS unverifiable LP when the caller demands verification', async () => {
    const v = await checkLiquidity(pair({ lpBurnedPct: undefined }), { requireLpVerified: true });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(why(v)).toMatch(/LP burn\/lock could not be verified/);
  });

  it('reads rugcheck markets[].lp.lpLockedPct, taking the highest', async () => {
    const v = await checkLiquidity({
      pairAddress: 'P',
      liquidityUsd: 100_000,
      marketCap: 1_000_000,
      markets: [{ lp: { lpLockedPct: 40 } }, { lp: { lpLockedPct: 99 } }],
    });

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.lp.pct).toBe(99);
    expect(v.facts.lp.verified).toBe(true);
  });

  it('ERRORS on a nonsense percentage instead of trusting it', async () => {
    const v = await checkLiquidity(pair({ lpBurnedPct: 400 }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
  });
});

describe('checkLiquidity -- fail closed on bad input', () => {
  it('errors on a non-object pair', async () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const v = await checkLiquidity(bad);
      expect(v.outcome).toBe(OUTCOME.ERROR);
    }
  });

  it('returns a frozen verdict with frozen facts', async () => {
    const v = await checkLiquidity(pair());

    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.facts)).toBe(true);
  });

  it('collects EVERY failed condition, not just the first', async () => {
    const v = await checkLiquidity(
      pair({ liquidityUsd: 100, marketCap: 50_000_000, lpBurnedPct: 0 }),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.length).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------- */

const ctxWith = (over = {}) => ({
  getPair: vi.fn(async () => pair()),
  getTokenReport: vi.fn(async () => ({ markets: [] })),
  ...over,
});

describe('runLayer2 -- the gate adapter', () => {
  it('resolves the pair through ctx.getPair and passes', async () => {
    const ctx = ctxWith();
    const v = await runLayer2(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(ctx.getPair).toHaveBeenCalledTimes(1);
    expect(v.facts.mint).toBe(MINT);
  });

  it('REJECTS a null pair: no depth to size against', async () => {
    const v = await runLayer2(MINT, ctxWith({ getPair: async () => null }));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(why(v)).toMatch(/no pair: nothing to size against/);
    expect(v.facts.pairFound).toBe(false);
  });

  it('enriches the pair with LP evidence from the rugcheck report', async () => {
    const ctx = ctxWith({
      getPair: async () => pair({ lpBurnedPct: undefined }),
      getTokenReport: async () => ({ markets: [{ lp: { lpLockedPct: 97 } }] }),
    });
    const v = await runLayer2(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.lp.pct).toBe(97);
  });

  it('does NOT let a rugcheck failure become layer 2 failure -- layer 5 owns that veto', async () => {
    const ctx = ctxWith({
      getPair: async () => pair({ lpBurnedPct: undefined }),
      getTokenReport: async () => {
        throw new Error('rugcheck 503');
      },
    });
    const v = await runLayer2(MINT, ctx);

    // falls through to the documented 'unverified' path rather than erroring
    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.unverified).toContain('lpBurnedOrLocked');
  });

  it('ERRORS when the pair fetch itself throws (fail closed)', async () => {
    const v = await runLayer2(MINT, ctxWith({
      getPair: async () => {
        throw new Error('dexscreener 500');
      },
    }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(why(v)).toMatch(/dexscreener 500/);
  });

  it('ERRORS on a context with no getPair', async () => {
    for (const bad of [null, undefined, {}, { getPair: 'nope' }]) {
      const v = await runLayer2(MINT, bad);
      expect(v.outcome).toBe(OUTCOME.ERROR);
    }
  });

  it('is what the gate registry resolves for layer2', async () => {
    const fn = await loadLayerFn(LAYER_SPECS.layer2);

    expect(fn).toBe(runLayer2);
  });
});
