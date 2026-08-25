import { describe, expect, it, vi } from 'vitest';
import { SAFETY } from '../../src/config.js';
import { LAYER_SPECS, loadLayerFn } from '../../src/safety/gate-layers.js';
import { OUTCOME } from '../../src/safety/verdict.js';
import {
  DEPLOYER_LIMITATION,
  LAYER,
  checkDeployer,
} from '../../src/safety/layer4-deployer.js';

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const DEPLOYER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const CEILING = SAFETY.layer4.maxDeployerPriorRugRate;

const creatorRecord = (over = {}) => ({
  creator: DEPLOYER,
  createdAtMs: 1_756_000_000_000,
  signature: '5Jk1QpXwXvVYtQ9E5Nq9k8bXcVv2t7pQ9m1n2o3p4q5r6s7t8u9v',
  ...over,
});

/** Shaped exactly like fetchDeployerHistory's frozen result. */
const historyRecord = (over = {}) => ({
  address: DEPLOYER,
  mintCount: 4,
  ruggedCount: 0,
  priorRugRate: 0,
  knownMints: ['MintAaa1111111111111111111111111111111111111'],
  lookbackDays: SAFETY.layer4.deployerHistoryLookbackDays,
  source: 'onchain:initializeMint-scan+rugcheck:wallet-risk',
  mintCountIsLowerBound: false,
  scannedTransactions: 12,
  unverified: [],
  ...over,
});

/** Minimal gate ctx: only the two fetchers layer 4 is contracted to use. */
const makeCtx = ({ creator = creatorRecord(), history = historyRecord(), ...rest } = {}) => ({
  getCreator: vi.fn(async () => creator),
  getDeployerHistory: vi.fn(async () => history),
  ...rest,
});

describe('checkDeployer -- prior rug rate veto', () => {
  it('rejects a deployer whose prior rug rate is above the ceiling, naming the counts', async () => {
    const ctx = makeCtx({
      history: historyRecord({ priorRugRate: 0.6, ruggedCount: 3, mintCount: 5 }),
    });

    const v = await checkDeployer(MINT, ctx);

    expect(v.layer).toBe(LAYER);
    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.join(' ')).toContain(DEPLOYER);
    expect(v.reasons.join(' ')).toMatch(/60\.0%/);
    expect(v.reasons.join(' ')).toMatch(/3 rugged of 5 known mints/);
    expect(v.facts.priorRugRate).toBe(0.6);
    expect(v.facts.priorRugRateKnown).toBe(true);
  });

  it('passes a rate EXACTLY at the ceiling and rejects one hair above it', async () => {
    const atLimit = await checkDeployer(MINT, {
      ...makeCtx({ history: historyRecord({ priorRugRate: CEILING, ruggedCount: 1, mintCount: 4 }) }),
    });
    const overLimit = await checkDeployer(MINT, {
      ...makeCtx({
        history: historyRecord({
          priorRugRate: CEILING + Number.EPSILON * 8,
          ruggedCount: 1,
          mintCount: 4,
        }),
      }),
    });

    expect(atLimit.outcome).toBe(OUTCOME.PASS);
    expect(atLimit.facts.priorRugRate).toBe(CEILING);
    expect(overLimit.outcome).toBe(OUTCOME.REJECT);
    expect(overLimit.reasons.join(' ')).toMatch(/above the ceiling/);
  });

  it('distinguishes a KNOWN rate of 0 from an unknown rate', async () => {
    const known = await checkDeployer(MINT, makeCtx({ history: historyRecord({ priorRugRate: 0 }) }));
    const unknown = await checkDeployer(
      MINT,
      makeCtx({ history: historyRecord({ priorRugRate: null }) }),
    );

    expect(known.outcome).toBe(OUTCOME.PASS);
    expect(known.facts.priorRugRate).toBe(0);
    expect(known.facts.priorRugRateKnown).toBe(true);
    expect(known.facts.scoreDown).toBe(false);

    expect(unknown.outcome).toBe(OUTCOME.PASS);
    expect(unknown.facts.priorRugRate).toBeNull();
    expect(unknown.facts.priorRugRateKnown).toBe(false);
    expect(unknown.facts.scoreDown).toBe(true);
  });

  it('never reads a null rate as 0, even against a zero-tolerance ceiling', async () => {
    const v = await checkDeployer(
      MINT,
      makeCtx({ history: historyRecord({ priorRugRate: null, ruggedCount: null, mintCount: null }) }),
      { maxDeployerPriorRugRate: 0 },
    );

    // A ceiling of 0 with `null` coerced to 0 would read as "clean deployer".
    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.priorRugRate).toBeNull();
    expect(v.facts.mintCount).toBeNull();
    expect(v.facts.ruggedCount).toBeNull();
    expect(v.facts.unverified.join(' ')).toMatch(/UNKNOWN \(null\), which is NOT 0/);
  });
});

describe('checkDeployer -- unknown deployer', () => {
  it('passes with scoreDown and names what was not established', async () => {
    const ctx = makeCtx({ creator: null });

    const v = await checkDeployer(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.deployerKnown).toBe(false);
    expect(v.facts.deployer).toBeNull();
    expect(v.facts.scoreDown).toBe(true);
    expect(v.facts.unverified.join(' ')).toMatch(/deployer identity/i);
    expect(v.facts.unverified.join(' ')).toMatch(/prior rug rate/i);
    // Nothing to look up: the history fetcher must not burn rate-limit budget.
    expect(ctx.getDeployerHistory).not.toHaveBeenCalled();
  });

  it('rejects an unknown deployer when rejectUnknownDeployer is injected as true', async () => {
    const v = await checkDeployer(MINT, makeCtx({ creator: null }), {
      rejectUnknownDeployer: true,
    });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.join(' ')).toMatch(/deployer unknown/i);
    expect(v.facts.thresholds.rejectUnknownDeployer).toBe(true);
    // The frozen config was never touched to achieve this.
    expect(SAFETY.layer4.rejectUnknownDeployer).toBe(false);
  });

  it('accepts the override on ctx.layer4 too, so an orchestrator can set it', async () => {
    const v = await checkDeployer(
      MINT,
      makeCtx({ creator: null, layer4: { rejectUnknownDeployer: true } }),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.thresholds.rejectUnknownDeployer).toBe(true);
  });

  it('rejects a KNOWN deployer with an unknown rate when rejectUnknownDeployer is true', async () => {
    const v = await checkDeployer(
      MINT,
      makeCtx({ history: historyRecord({ priorRugRate: null }) }),
      { rejectUnknownDeployer: true },
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.join(' ')).toMatch(/no known prior rug rate/i);
    expect(v.reasons.join(' ')).toMatch(/null is UNKNOWN, not 0/);
    expect(v.facts.deployerKnown).toBe(true);
  });

  it('still rejects a demonstrated bad rate when rejectUnknownDeployer is false', async () => {
    const v = await checkDeployer(
      MINT,
      makeCtx({ history: historyRecord({ priorRugRate: 0.9, ruggedCount: 9, mintCount: 10 }) }),
      { rejectUnknownDeployer: false },
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
  });
});

describe('checkDeployer -- fail closed', () => {
  it('errors when ctx.getCreator throws (network failure)', async () => {
    const ctx = {
      getCreator: vi.fn(async () => {
        throw new Error('rpc getSignaturesForAddress failed');
      }),
      getDeployerHistory: vi.fn(async () => historyRecord()),
    };

    const v = await checkDeployer(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/getSignaturesForAddress failed/);
    expect(v.facts.deployerKnown).toBe(false);
    expect(v.facts.priorRugRate).toBeNull();
  });

  it('errors when ctx.getDeployerHistory throws', async () => {
    const ctx = makeCtx();
    ctx.getDeployerHistory = vi.fn(async () => {
      throw new Error('rpc exhausted');
    });

    const v = await checkDeployer(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/rpc exhausted/);
  });

  it('errors on a per-layer timeout, never a pass', async () => {
    const timeout = Object.assign(new Error('layer4-deployer exceeded 4000ms'), {
      code: 'GATE_TIMEOUT',
    });
    const ctx = makeCtx();
    ctx.getDeployerHistory = vi.fn(async () => {
      throw timeout;
    });

    const v = await checkDeployer(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/exceeded 4000ms/);
  });

  it('errors when the history object omits priorRugRate entirely', async () => {
    const ctx = makeCtx({ history: { address: DEPLOYER, mintCount: 2, unverified: [] } });

    const v = await checkDeployer(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/no priorRugRate field/);
  });

  it.each([
    ['a numeric string', '0.5'],
    ['a rate above 1', 1.4],
    ['a negative rate', -0.1],
    ['NaN', Number.NaN],
    ['undefined-as-value', undefined],
  ])('errors on a malformed priorRugRate: %s', async (_label, priorRugRate) => {
    const ctx = makeCtx({ history: historyRecord({ priorRugRate }) });

    const v = await checkDeployer(MINT, ctx);

    // `undefined` is an explicitly present key, so it is a shape error too: the
    // fetcher contracts to report unknown as null.
    expect(v.outcome).toBe(OUTCOME.ERROR);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'no-history'],
    ['a number', 7],
  ])('errors when the history is %s rather than an object', async (_label, history) => {
    const v = await checkDeployer(MINT, makeCtx({ history }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/must resolve to an object/);
  });

  it('errors on a creator record with no usable address', async () => {
    const v = await checkDeployer(MINT, makeCtx({ creator: creatorRecord({ creator: 42 }) }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/non-empty address string/);
  });

  it('errors on a creator record that is an array', async () => {
    const v = await checkDeployer(MINT, makeCtx({ creator: [DEPLOYER] }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/an array/);
  });

  it('errors on a negative mintCount rather than trusting it', async () => {
    const v = await checkDeployer(MINT, makeCtx({ history: historyRecord({ mintCount: -3 }) }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/non-negative finite number/);
  });

  it.each([
    ['a missing mint', undefined],
    ['an empty mint', ''],
    ['a non-string mint', 1234],
  ])('errors on %s', async (_label, badMint) => {
    const v = await checkDeployer(badMint, makeCtx());

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/mint must be a non-empty string/);
  });

  it.each([
    ['ctx is null', null],
    ['ctx is a string', 'ctx'],
    ['getCreator is missing', { getDeployerHistory: async () => historyRecord() }],
    ['getDeployerHistory is missing', { getCreator: async () => creatorRecord() }],
  ])('errors when %s', async (_label, ctx) => {
    const v = await checkDeployer(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
  });

  it.each([
    ['a non-boolean rejectUnknownDeployer', { rejectUnknownDeployer: 'yes' }],
    ['a ceiling above 1', { maxDeployerPriorRugRate: 25 }],
    ['a negative ceiling', { maxDeployerPriorRugRate: -1 }],
    ['a string ceiling', { maxDeployerPriorRugRate: '0.25' }],
  ])('errors on %s override rather than guessing', async (_label, options) => {
    const v = await checkDeployer(MINT, makeCtx(), options);

    expect(v.outcome).toBe(OUTCOME.ERROR);
  });
});

describe('checkDeployer -- facts and honesty', () => {
  it('states plainly that a fresh address makes a pass nearly worthless', async () => {
    const v = await checkDeployer(MINT, makeCtx());

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.residualRisk).toMatch(/fresh address/i);
    expect(v.facts.residualRisk).toMatch(/proves very little/i);
    expect(DEPLOYER_LIMITATION.notProven.join(' ')).toMatch(/serial rugger on a fresh address/i);
  });

  it('merges the fetcher\'s own unverified entries without duplicating ours', async () => {
    const fetcherNote = 'mint count is a floor: the 180-day history was truncated';
    const ctx = makeCtx({
      history: historyRecord({
        priorRugRate: null,
        mintCountIsLowerBound: true,
        unverified: [
          fetcherNote,
          'prior rug rate is UNKNOWN (null), which must not be read as 0: no rate is derivable',
        ],
      }),
    });

    const v = await checkDeployer(MINT, ctx);

    expect(v.facts.unverified).toContain(fetcherNote);
    expect(v.facts.unverified.filter((u) => /prior rug rate/i.test(u)).length).toBe(2);
    expect(new Set(v.facts.unverified).size).toBe(v.facts.unverified.length);
    expect(v.facts.mintCountIsLowerBound).toBe(true);
    expect(v.facts.scoreDown).toBe(true);
  });

  it('scores down a truncated mint count even when the rate is known and clean', async () => {
    const ctx = makeCtx({
      history: historyRecord({
        priorRugRate: 0.1,
        mintCountIsLowerBound: true,
        unverified: ['mint count is a floor: the 180-day history was truncated'],
      }),
    });

    const v = await checkDeployer(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.scoreDown).toBe(true);
    expect(v.facts.priorRugRateKnown).toBe(true);
  });

  it('reports a known creator whose block time was pruned', async () => {
    const v = await checkDeployer(MINT, makeCtx({ creator: creatorRecord({ createdAtMs: null }) }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.deployerKnown).toBe(true);
    expect(v.facts.createdAtMs).toBeNull();
  });

  it('hands its budget signal down to the history fetcher', async () => {
    const controller = new AbortController();
    const ctx = makeCtx({ signal: controller.signal });

    await checkDeployer(MINT, ctx);

    expect(ctx.getDeployerHistory).toHaveBeenCalledWith(
      DEPLOYER,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('returns a frozen verdict with frozen facts and mutates no argument', async () => {
    const creator = creatorRecord();
    const history = historyRecord({ unverified: ['mint count is a floor'] });
    const creatorBefore = structuredClone(creator);
    const historyBefore = structuredClone(history);

    const v = await checkDeployer(MINT, makeCtx({ creator, history }));

    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.facts)).toBe(true);
    expect(Object.isFrozen(v.facts.unverified)).toBe(true);
    expect(Object.isFrozen(v.facts.thresholds)).toBe(true);
    expect(creator).toEqual(creatorBefore);
    expect(history).toEqual(historyBefore);
  });

  it('survives a minimal history payload, reporting every absent field as unknown', async () => {
    // Only the decisive field is present: nothing else may crash the layer, and no
    // missing counter may print as a number.
    const v = await checkDeployer(MINT, makeCtx({ history: { priorRugRate: 0.9 } }));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.join(' ')).toMatch(/unknown rugged of unknown known mints/);
    expect(v.reasons.join(' ')).toMatch(/source: none/);
    expect(v.facts.knownMints).toEqual([]);
    expect(v.facts.mintCount).toBeNull();
    expect(v.facts.ruggedCount).toBeNull();
    expect(v.facts.historySource).toBeNull();
    expect(v.facts.scannedTransactions).toBeNull();
    // No lookback reported by the fetcher: fall back to the configured window rather
    // than printing null days.
    expect(v.facts.lookbackDays).toBe(SAFETY.layer4.deployerHistoryLookbackDays);
    expect(v.facts.unverified).toEqual([]);
    expect(v.facts.scoreDown).toBe(false);
  });

  it('drops blank entries from knownMints and unverified rather than counting them', async () => {
    const v = await checkDeployer(
      MINT,
      makeCtx({
        history: historyRecord({
          knownMints: ['MintAaa1111111111111111111111111111111111111', '', null, 7],
          unverified: ['mint count is a floor', '', null],
        }),
      }),
    );

    expect(v.facts.knownMints).toEqual(['MintAaa1111111111111111111111111111111111111']);
    expect(v.facts.unverified).toEqual(['mint count is a floor']);
  });

  it('carries the config thresholds it actually applied', async () => {
    const v = await checkDeployer(MINT, makeCtx());

    expect(v.facts.thresholds).toEqual({
      maxDeployerPriorRugRate: SAFETY.layer4.maxDeployerPriorRugRate,
      rejectUnknownDeployer: SAFETY.layer4.rejectUnknownDeployer,
      deployerHistoryLookbackDays: SAFETY.layer4.deployerHistoryLookbackDays,
    });
  });
});

describe('checkDeployer -- registry wiring', () => {
  it('uses the layer name the gate registry expects', () => {
    expect(LAYER).toBe(LAYER_SPECS.layer4.name);
  });

  it('is resolvable through loadLayerFn, so the gate can never skip it silently', async () => {
    const fn = await loadLayerFn(LAYER_SPECS.layer4);

    expect(fn).toBe(checkDeployer);
  });
});
