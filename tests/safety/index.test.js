/**
 * The orchestrator's failure paths ARE the feature.
 *
 * Every test injects its layers through deps.layers and its fetchers through
 * deps.*, so nothing here opens a socket, imports @solana/web3.js or touches
 * src/rpc / src/data at all. What is under test is the bookkeeping: that a
 * skipped layer never reads as a passed one, that a timeout is never a pass,
 * and that an exhausted whole-gate budget produces an INCOMPLETE result rather
 * than a decided one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAFETY } from '../../src/config.js';
import { GATE_LAYER, RECHECK_LAYERS, recheckGate, runGate } from '../../src/safety/index.js';
import { LAYER_ORDER, LAYER_SPECS } from '../../src/safety/gate-layers.js';
import { OUTCOME, errored, pass, reject } from '../../src/safety/verdict.js';

/** A real base58 mint (USDC). requireAddress only checks base58 + 32-44 chars. */
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const nameOf = (id) => LAYER_SPECS[id].name;
const ALL_NAMES = LAYER_ORDER.map(nameOf);

/** Fetcher spies for every ctx accessor, so "zero calls" is assertable. */
function fetcherSpies(overrides = {}) {
  const spies = {
    getMintFacts: vi.fn(async () => ({ mint: MINT })),
    getHolders: vi.fn(async () => ({ holders: [], amountField: 'amount', supply: 1 })),
    getCreator: vi.fn(async () => null),
    getDeployerHistory: vi.fn(async () => ({ address: 'x', priorRugRate: null })),
    getRoundTrip: vi.fn(async () => ({ sellRouteExists: true, roundTripLossPct: 1 })),
    getPair: vi.fn(async () => ({ liquidityUsd: 100_000, marketCap: 1_000_000 })),
    getTokenReport: vi.fn(async () => ({ scoreNormalised: 0 })),
    getInsiderGraph: vi.fn(async () => ({ clusters: [] })),
    ...overrides,
  };
  return spies;
}

const totalCalls = (spies) =>
  Object.values(spies).reduce((sum, spy) => sum + spy.mock.calls.length, 0);

const passLayer = (id, facts) => vi.fn(async () => pass(nameOf(id), facts));
const rejectLayer = (id, reason) => vi.fn(async () => reject(nameOf(id), [reason]));
const throwLayer = (message) =>
  vi.fn(async () => {
    throw new Error(message);
  });
/** Never settles: only the per-layer deadline can end it. */
const hangLayer = () => vi.fn(() => new Promise(() => {}));

const allPassing = () =>
  Object.fromEntries(LAYER_ORDER.map((id) => [id, passLayer(id)]));

afterEach(() => {
  vi.useRealTimers();
});

describe('runGate - the happy path is the only path that may read as buyable', () => {
  it('all six layers pass: buyable, complete, nothing skipped', async () => {
    const layers = allPassing();
    const result = await runGate(MINT, { layers });

    expect(result.buyable).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.rejectedBy).toEqual([]);
    expect(result.erroredIn).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.layers.map((v) => v.layer)).toEqual(ALL_NAMES);
    expect(result.order).toEqual([...LAYER_ORDER]);
    expect(result.mint).toBe(MINT);
    for (const id of LAYER_ORDER) expect(layers[id]).toHaveBeenCalledTimes(1);
  });

  it('returns a frozen result whose arrays cannot be grown', async () => {
    const result = await runGate(MINT, { layers: allPassing() });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.skipped)).toBe(true);
    expect(Object.isFrozen(result.residualRisks)).toBe(true);
    expect(() => result.skipped.push('layer0-mint')).toThrow(TypeError);
    expect(() => {
      result.buyable = true;
    }).toThrow(TypeError);
  });

  it('records wall time and the layers own timings separately', async () => {
    let t = 5_000;
    const now = () => (t += 10);
    const result = await runGate(MINT, { layers: allPassing(), now });
    expect(result.startedAtMs).toBe(5_010);
    expect(result.finishedAtMs).toBeGreaterThan(result.startedAtMs);
    expect(result.elapsedMs).toBe(result.finishedAtMs - result.startedAtMs);
    // pass() defaults ms to 0, so the sum of the layers' own timings is 0 and is
    // NOT silently replaced by wall time.
    expect(result.totalMs).toBe(0);
  });

  it('hands each layer a ctx with exactly the contracted keys', async () => {
    /** @type {object} */
    let seen = null;
    const layers = {
      layer0: vi.fn(async (mint, ctx) => {
        seen = ctx;
        return pass(nameOf('layer0'));
      }),
    };
    const result = await runGate(MINT, { layers, order: ['layer0'] });

    expect(result.buyable).toBe(true);
    expect(Object.keys(seen).sort()).toEqual(
      [
        'getCreator',
        'getDeployerHistory',
        'getHolders',
        'getInsiderGraph',
        'getMintFacts',
        'getPair',
        'getRoundTrip',
        'getTokenReport',
        'logger',
        'mint',
        'remainingMs',
        'signal',
      ].sort(),
    );
    expect(Object.isFrozen(seen)).toBe(true);
    expect(seen.mint).toBe(MINT);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal.aborted).toBe(false);
    expect(seen.remainingMs()).toBeLessThanOrEqual(SAFETY.totalGateTimeoutMs);
    expect(seen.remainingMs()).toBeGreaterThan(0);
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(typeof seen.logger[level]).toBe('function');
    }
  });
});

describe('runGate - a REJECT decides the gate and everything after it is SKIPPED', () => {
  it('layer0 rejects: layers 1-5 are skipped, never counted as passed', async () => {
    const layers = allPassing();
    layers.layer0 = rejectLayer('layer0', 'mint authority is still live');

    const result = await runGate(MINT, { layers });

    expect(result.buyable).toBe(false);
    expect(result.rejectedBy).toEqual([nameOf('layer0')]);
    expect(result.reasons).toContain('mint authority is still live');
    // Exactly one verdict exists. The other five are skipped, not passed.
    expect(result.layers).toHaveLength(1);
    expect(result.skipped).toEqual(ALL_NAMES.slice(1));
    for (const id of LAYER_ORDER.slice(1)) expect(layers[id]).not.toHaveBeenCalled();
    // The critical non-conflation: no skipped layer appears as a PASS verdict.
    const passedNames = result.layers
      .filter((v) => v.outcome === OUTCOME.PASS)
      .map((v) => v.layer);
    expect(passedNames).toEqual([]);
    for (const skippedName of result.skipped) expect(passedNames).not.toContain(skippedName);
  });

  it('a mid-order reject skips only the layers after it', async () => {
    const layers = allPassing();
    layers.layer3 = rejectLayer('layer3', 'top10 holders own 71%');

    const result = await runGate(MINT, { layers });

    expect(result.buyable).toBe(false);
    expect(result.layers.map((v) => v.outcome)).toEqual([
      OUTCOME.PASS,
      OUTCOME.PASS,
      OUTCOME.PASS,
      OUTCOME.REJECT,
    ]);
    expect(result.skipped).toEqual([nameOf('layer4'), nameOf('layer5')]);
    expect(layers.layer4).not.toHaveBeenCalled();
    expect(layers.layer5).not.toHaveBeenCalled();
    // complete === true means "no layer errored", NOT "every layer ran".
    expect(result.complete).toBe(true);
    expect(result.buyable).toBe(false);
  });
});

describe('runGate - fail closed: an ERROR is never a pass', () => {
  it('a layer that throws becomes ERROR and blocks the buy', async () => {
    const layers = allPassing();
    layers.layer1 = throwLayer('jupiter 502');

    const result = await runGate(MINT, { layers });

    expect(SAFETY.failClosed).toBe(true);
    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.erroredIn).toEqual([nameOf('layer1')]);
    expect(result.reasons.join(' ')).toContain('jupiter 502');
    expect(result.skipped).toEqual(ALL_NAMES.slice(2));
    const layer1Verdict = result.layers.find((v) => v.layer === nameOf('layer1'));
    expect(layer1Verdict.outcome).toBe(OUTCOME.ERROR);
    expect(layer1Verdict.facts.timedOut).toBe(false);
    expect(layer1Verdict.facts.ran).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'PASS'],
    ['an array', []],
    ['an unknown outcome', { layer: 'layer0-mint', outcome: 'MAYBE' }],
    ['a nameless verdict', { layer: '', outcome: 'PASS' }],
    ['non-array reasons', { layer: 'layer0-mint', outcome: 'REJECT', reasons: 'nope' }],
    ['non-object facts', { layer: 'layer0-mint', outcome: 'PASS', facts: 'clean' }],
  ])('a layer returning %s is an ERROR, not a pass', async (_label, returned) => {
    const result = await runGate(MINT, {
      layers: { layer0: vi.fn(async () => returned) },
      order: ['layer0'],
    });

    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.erroredIn).toEqual([nameOf('layer0')]);
  });

  it('an all-ERROR run can never read as buyable', async () => {
    const layers = Object.fromEntries(
      LAYER_ORDER.map((id) => [id, throwLayer(`${id} exploded`)]),
    );
    const result = await runGate(MINT, { layers });

    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.layers.every((v) => v.outcome === OUTCOME.ERROR)).toBe(true);
    // Fail closed short-circuits, so exactly one error verdict exists and the
    // rest are skipped -- and neither reads as a pass.
    expect(result.layers).toHaveLength(1);
    expect(result.skipped).toHaveLength(LAYER_ORDER.length - 1);
  });

  it('a layer that returns errored() itself is treated as a real ERROR', async () => {
    const layers = allPassing();
    layers.layer2 = vi.fn(async () => errored(nameOf('layer2'), new Error('no pair data')));

    const result = await runGate(MINT, { layers });

    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.erroredIn).toEqual([nameOf('layer2')]);
    expect(layers.layer3).not.toHaveBeenCalled();
  });
});

describe('runGate - a timeout is an ERROR, never a PASS', () => {
  it('cuts off a hanging layer at SAFETY.perLayerTimeoutMs', async () => {
    vi.useFakeTimers();
    const layers = allPassing();
    layers.layer0 = hangLayer();

    const running = runGate(MINT, { layers });
    await vi.advanceTimersByTimeAsync(SAFETY.perLayerTimeoutMs + 1);
    const result = await running;

    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    const v = result.layers[0];
    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.facts.timedOut).toBe(true);
    expect(v.facts.aborted).toBe(false);
    expect(v.facts.timeoutMs).toBe(SAFETY.perLayerTimeoutMs);
    expect(v.reasons.join(' ')).toContain('timed out');
    expect(result.skipped).toEqual(ALL_NAMES.slice(1));
  });

  it('caps the per-layer deadline at the whole-gate budget that is left', async () => {
    // A clock that reports almost the entire gate budget already spent, so
    // min(perLayerTimeoutMs, remaining) must pick `remaining`.
    const startedAt = 1_000_000;
    let calls = 0;
    const now = () => (calls++ === 0 ? startedAt : startedAt + SAFETY.totalGateTimeoutMs - 5);

    const result = await runGate(MINT, {
      layers: { layer0: hangLayer() },
      order: ['layer0'],
      now,
    });

    const v = result.layers[0];
    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.facts.timedOut).toBe(true);
    expect(v.facts.timeoutMs).toBe(5);
    expect(result.buyable).toBe(false);
  });

  it('a caller abort produces ERROR verdicts, not passes', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutting down'));
    const layers = allPassing();

    const result = await runGate(MINT, { layers, signal: controller.signal });

    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.layers[0].outcome).toBe(OUTCOME.ERROR);
    expect(result.layers[0].facts.aborted).toBe(true);
    expect(layers.layer0).not.toHaveBeenCalled();
  });
});

describe('runGate - an exhausted whole-gate budget is INCOMPLETE, not decided', () => {
  it('errors (never skips) the layers that the budget left no room for', async () => {
    let t = 2_000_000;
    const now = () => t;
    const layers = allPassing();
    // Layer 0 passes, but burns the entire gate budget doing it.
    layers.layer0 = vi.fn(async () => {
      t += SAFETY.totalGateTimeoutMs;
      return pass(nameOf('layer0'));
    });

    const result = await runGate(MINT, { layers, now });

    expect(result.buyable).toBe(false);
    // The distinction this whole test exists for:
    expect(result.complete).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(result.layers).toHaveLength(LAYER_ORDER.length);
    expect(result.erroredIn).toEqual(ALL_NAMES.slice(1));
    for (const id of LAYER_ORDER.slice(1)) expect(layers[id]).not.toHaveBeenCalled();

    const starved = result.layers[1];
    expect(starved.outcome).toBe(OUTCOME.ERROR);
    expect(starved.facts.gateBudgetExhausted).toBe(true);
    expect(starved.facts.ran).toBe(false);
    expect(starved.reasons.join(' ')).toContain('INCOMPLETE, not decided');
    expect(result.residualRisks).toContain(LAYER_SPECS.layer5.unproven);
  });

  it('a REJECT still decides the gate even when the budget is also gone', async () => {
    let t = 3_000_000;
    const now = () => t;
    const layers = allPassing();
    layers.layer0 = vi.fn(async () => {
      t += SAFETY.totalGateTimeoutMs;
      return reject(nameOf('layer0'), ['freeze authority present']);
    });

    const result = await runGate(MINT, { layers, now });

    expect(result.rejectedBy).toEqual([nameOf('layer0')]);
    expect(result.layers).toHaveLength(1);
    // Decided beats out-of-budget: the rest are skipped, not errored.
    expect(result.skipped).toEqual(ALL_NAMES.slice(1));
    expect(result.erroredIn).toEqual([]);
  });
});

describe('runGate - residualRisks never overstates what was proven', () => {
  it('collects the unproven text of skipped layers and the facts of layers that ran', async () => {
    const layers = allPassing();
    layers.layer0 = passLayer('layer0', { residualRisk: 'a clean mint can still be dumped' });
    layers.layer1 = passLayer('layer1', {
      residualRisk: 'a quoted route can still revert on chain',
      unverified: ['sellTransactionSimulated'],
    });
    layers.layer2 = rejectLayer('layer2', 'liquidity 900 USD below minimum 30000 USD');

    const result = await runGate(MINT, { layers });

    expect(result.residualRisks).toContain('a clean mint can still be dumped');
    expect(result.residualRisks).toContain('a quoted route can still revert on chain');
    expect(result.residualRisks).toContain(
      `${nameOf('layer1')}: could not verify sellTransactionSimulated`,
    );
    for (const id of ['layer3', 'layer4', 'layer5']) {
      expect(result.residualRisks).toContain(LAYER_SPECS[id].unproven);
    }
    // Layers that ran and passed do not contribute their registry `unproven`
    // text twice, and the list carries no duplicates.
    expect(new Set(result.residualRisks).size).toBe(result.residualRisks.length);
  });

  it('surfaces facts.unverified from a scored-down pass', async () => {
    const layers = allPassing();
    layers.layer2 = passLayer('layer2', {
      unverified: ['lpBurnedOrLocked'],
      scoreDown: true,
    });

    const result = await runGate(MINT, { layers });

    expect(result.buyable).toBe(true);
    expect(result.residualRisks).toEqual([
      `${nameOf('layer2')}: could not verify lpBurnedOrLocked`,
    ]);
  });
});

describe('runGate - the mint is validated before anything is fetched', () => {
  it.each([
    ['not base58', 'not-a-valid-mint-address-0OIl-000000000000'],
    ['too short', 'abc'],
    ['too long', 'E'.repeat(45)],
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 12345],
    ['an object', { mint: MINT }],
  ])('%s: one errored(gate) verdict and zero fetcher calls', async (_label, badMint) => {
    const spies = fetcherSpies();
    const layers = allPassing();

    const result = await runGate(badMint, { ...spies, layers });

    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].layer).toBe(GATE_LAYER);
    expect(result.layers[0].outcome).toBe(OUTCOME.ERROR);
    expect(result.layers[0].facts.fetchersCalled).toBe(false);
    expect(totalCalls(spies)).toBe(0);
    for (const id of LAYER_ORDER) expect(layers[id]).not.toHaveBeenCalled();
    // Nothing ran, so every layer is reported as skipped with its unproven text.
    expect(result.skipped).toEqual(ALL_NAMES);
    expect(result.residualRisks).toEqual(LAYER_ORDER.map((id) => LAYER_SPECS[id].unproven));
  });

  it('never throws on a bad mint (an exception could be read as "no problem found")', async () => {
    await expect(runGate(null)).resolves.toMatchObject({ buyable: false });
  });
});

describe('runGate - bad wiring fails closed instead of running half a gate', () => {
  it.each([
    ['an unknown layer id in deps.order', { order: ['layer0', 'layer9'] }],
    ['a non-array deps.order', { order: 'layer0' }],
    ['a non-function layer override', { layers: { layer0: 'checkMint' } }],
    ['an unknown layer override id', { layers: { layerX: async () => pass('x') } }],
    ['a non-object deps.layers', { layers: [] }],
    ['a non-function deps.importer', { importer: './layer0-mint.js' }],
    ['a non-function fetcher override', { getPair: 'dexscreener' }],
  ])('%s becomes errored(gate)', async (_label, deps) => {
    const result = await runGate(MINT, deps);

    expect(result.buyable).toBe(false);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].layer).toBe(GATE_LAYER);
    expect(result.layers[0].facts.stage).toBe('preflight');
  });

  it('an empty order can never be buyable', async () => {
    const result = await runGate(MINT, { order: [] });
    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.layers).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe('runGate - lazy layer resolution', () => {
  it('resolves a layer through deps.importer when no override is given', async () => {
    const importer = vi.fn(async (specifier) => {
      expect(specifier).toBe(LAYER_SPECS.layer0.module);
      return { checkMint: async () => pass(nameOf('layer0')) };
    });

    const result = await runGate(MINT, { order: ['layer0'], importer });

    expect(result.buyable).toBe(true);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('a missing layer module is an ERROR, never a silently disabled check', async () => {
    const importer = vi.fn(async () => {
      throw new Error('Cannot find module ./layer0-mint.js');
    });

    const result = await runGate(MINT, { order: ['layer0'], importer });

    expect(result.buyable).toBe(false);
    expect(result.erroredIn).toEqual([nameOf('layer0')]);
    expect(result.reasons.join(' ')).toContain('Cannot find module');
  });

  it('a module exporting no recognisable layer function is an ERROR', async () => {
    const result = await runGate(MINT, {
      order: ['layer0'],
      importer: async () => ({ notALayer: 42 }),
    });

    expect(result.buyable).toBe(false);
    expect(result.erroredIn).toEqual([nameOf('layer0')]);
  });
});

describe('runGate - ctx memoisation: one question, one network call per run', () => {
  it('two layers asking for the same data cause ONE fetch', async () => {
    const spies = fetcherSpies();
    const layers = {
      layer0: vi.fn(async (mint, ctx) => {
        await ctx.getMintFacts();
        await ctx.getPair();
        return pass(nameOf('layer0'));
      }),
      layer3: vi.fn(async (mint, ctx) => {
        await ctx.getMintFacts();
        await ctx.getPair();
        await ctx.getMintFacts();
        return pass(nameOf('layer3'));
      }),
    };

    const result = await runGate(MINT, { ...spies, layers, order: ['layer0', 'layer3'] });

    expect(result.buyable).toBe(true);
    expect(spies.getMintFacts).toHaveBeenCalledTimes(1);
    expect(spies.getPair).toHaveBeenCalledTimes(1);
    expect(spies.getMintFacts).toHaveBeenCalledWith(MINT, expect.any(Object));
  });

  it('memoises a REJECTION too: one failed question is not retried inside a run', async () => {
    const getPair = vi.fn(async () => {
      throw new Error('dexscreener 429');
    });
    const seen = [];
    const layers = {
      layer2: vi.fn(async (mint, ctx) => {
        await ctx.getPair().catch((err) => seen.push(err.message));
        return pass(nameOf('layer2'));
      }),
      layer3: vi.fn(async (mint, ctx) => {
        await ctx.getPair().catch((err) => seen.push(err.message));
        return pass(nameOf('layer3'));
      }),
    };

    await runGate(MINT, { getPair, layers, order: ['layer2', 'layer3'] });

    expect(getPair).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['dexscreener 429', 'dexscreener 429']);
  });

  it('memoises per deployer address, not globally', async () => {
    const getDeployerHistory = vi.fn(async (address) => ({ address, priorRugRate: null }));
    const layers = {
      layer4: vi.fn(async (mint, ctx) => {
        await ctx.getDeployerHistory('deployerOne');
        await ctx.getDeployerHistory('deployerOne');
        await ctx.getDeployerHistory('deployerTwo');
        return pass(nameOf('layer4'));
      }),
    };

    await runGate(MINT, { getDeployerHistory, layers, order: ['layer4'] });

    expect(getDeployerHistory).toHaveBeenCalledTimes(2);
  });

  it('accepts fetcher overrides under their module export names too', async () => {
    const fetchMintFacts = vi.fn(async () => ({ mint: MINT }));
    const getBestPair = vi.fn(async () => null);
    const layers = {
      layer0: vi.fn(async (mint, ctx) => {
        await ctx.getMintFacts();
        await ctx.getPair();
        return pass(nameOf('layer0'));
      }),
    };

    await runGate(MINT, { fetchMintFacts, getBestPair, layers, order: ['layer0'] });

    expect(fetchMintFacts).toHaveBeenCalledTimes(1);
    expect(getBestPair).toHaveBeenCalledTimes(1);
  });

  it('passes THIS layer AbortSignal to the fetchers', async () => {
    let fetchSignal = null;
    let ctxSignal = null;
    const getMintFacts = vi.fn(async (mint, deps) => {
      fetchSignal = deps.signal;
      return { mint };
    });
    const layers = {
      layer0: vi.fn(async (mint, ctx) => {
        ctxSignal = ctx.signal;
        await ctx.getMintFacts();
        return pass(nameOf('layer0'));
      }),
    };

    await runGate(MINT, { getMintFacts, layers, order: ['layer0'] });

    expect(fetchSignal).toBeInstanceOf(AbortSignal);
    expect(fetchSignal).toBe(ctxSignal);
  });
});

describe('recheckGate - layers 0 and 1 only', () => {
  it('runs exactly RECHECK_LAYERS and ignores deps.order', async () => {
    const layers = allPassing();

    const result = await recheckGate(MINT, { layers, order: LAYER_ORDER });

    expect(RECHECK_LAYERS).toEqual(['layer0', 'layer1']);
    expect(layers.layer0).toHaveBeenCalledTimes(1);
    expect(layers.layer1).toHaveBeenCalledTimes(1);
    for (const id of ['layer2', 'layer3', 'layer4', 'layer5']) {
      expect(layers[id]).not.toHaveBeenCalled();
    }
    expect(result.layers.map((v) => v.layer)).toEqual([nameOf('layer0'), nameOf('layer1')]);
    expect(result.order).toEqual(['layer0', 'layer1']);
    expect(result.buyable).toBe(true);
  });

  it('a honeypot that appeared after the buy blocks the recheck', async () => {
    const layers = allPassing();
    layers.layer1 = rejectLayer('layer1', 'HONEYPOT: no sell route exists');

    const result = await recheckGate(MINT, { layers });

    expect(result.buyable).toBe(false);
    expect(result.rejectedBy).toEqual([nameOf('layer1')]);
    expect(result.skipped).toEqual([]);
  });

  it('RECHECK_LAYERS is frozen', () => {
    expect(Object.isFrozen(RECHECK_LAYERS)).toBe(true);
  });
});
