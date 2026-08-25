import { describe, expect, it, vi } from 'vitest';
import { SAFETY } from '../../src/config.js';
import { LAYER_SPECS, loadLayerFn } from '../../src/safety/gate-layers.js';
import { OUTCOME } from '../../src/safety/verdict.js';
import {
  LAYER,
  THIRD_PARTY_LIMITATION,
  checkThirdParty,
} from '../../src/safety/layer5-thirdparty.js';

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const CEILING = SAFETY.layer5.maxRugcheckScoreNormalised;

/** Shaped exactly like getTokenReport()'s frozen RugcheckTokenReport. */
const report = (over = {}) => ({
  mint: MINT,
  scoreNormalised: 0,
  scoreRaw: 0,
  scoreOutOfDocumentedRange: false,
  rugged: false,
  risks: [],
  topHolders: [],
  totalHolders: 812,
  liquidityUsd: 91_000,
  lpLockedPct: 100,
  lpMint: null,
  marketCount: 1,
  creator: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  graphInsidersDetected: 0,
  token: {},
  raw: {},
  ...over,
});

const risk = (name, level, score) => ({
  name,
  level,
  score,
  value: '',
  description: `${name} description`,
});

const makeCtx = (tokenReport = report(), rest = {}) => ({
  getTokenReport: vi.fn(async () => tokenReport),
  ...rest,
});

describe('checkThirdParty -- score direction (HIGHER = RISKIER)', () => {
  it('passes 0 and rejects 100: inverting the comparison would only buy scams', async () => {
    const clean = await checkThirdParty(MINT, makeCtx(report({ scoreNormalised: 0 })));
    const maximallyDangerous = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: 100, risks: [risk('Permanent delegate', 'danger', 40)] })),
    );

    expect(clean.outcome).toBe(OUTCOME.PASS);
    expect(maximallyDangerous.outcome).toBe(OUTCOME.REJECT);
    expect(maximallyDangerous.reasons.join(' ')).toMatch(/higher is riskier/i);
    expect(clean.facts.scoreDirection).toMatch(/HIGHER = RISKIER/);
  });

  it('passes a score EXACTLY at the ceiling and rejects one point above it', async () => {
    const atLimit = await checkThirdParty(MINT, makeCtx(report({ scoreNormalised: CEILING })));
    const overLimit = await checkThirdParty(MINT, makeCtx(report({ scoreNormalised: CEILING + 1 })));

    expect(atLimit.outcome).toBe(OUTCOME.PASS);
    expect(atLimit.facts.scoreNormalised).toBe(CEILING);
    expect(overLimit.outcome).toBe(OUTCOME.REJECT);
    expect(overLimit.reasons.join(' ')).toContain(String(CEILING));
    expect(overLimit.reasons.join(' ')).toContain(String(CEILING + 1));
  });

  it('honours an injected ceiling without mutating frozen config', async () => {
    const strict = await checkThirdParty(MINT, makeCtx(report({ scoreNormalised: 5 })), {
      maxRugcheckScoreNormalised: 4,
    });
    const viaCtx = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: 5 }), { layer5: { maxRugcheckScoreNormalised: 4 } }),
    );

    expect(strict.outcome).toBe(OUTCOME.REJECT);
    expect(viaCtx.outcome).toBe(OUTCOME.REJECT);
    expect(strict.facts.maxRugcheckScoreNormalised).toBe(4);
    expect(SAFETY.layer5.maxRugcheckScoreNormalised).toBe(CEILING);
  });

  it.each([
    ['a string ceiling', { maxRugcheckScoreNormalised: '20' }],
    ['a negative ceiling', { maxRugcheckScoreNormalised: -1 }],
    ['a ceiling above the documented scale', { maxRugcheckScoreNormalised: 250 }],
  ])('errors on %s rather than guessing', async (_label, options) => {
    const v = await checkThirdParty(MINT, makeCtx(), options);

    expect(v.outcome).toBe(OUTCOME.ERROR);
  });
});

describe('checkThirdParty -- vetoes', () => {
  it('rejects rugged === true even on a perfect score', async () => {
    const v = await checkThirdParty(MINT, makeCtx(report({ scoreNormalised: 0, rugged: true })));

    expect(v.layer).toBe(LAYER);
    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.join(' ')).toMatch(/RUGGED/);
    expect(v.facts.rugged).toBe(true);
  });

  it('rejects when the report flags the score as out of the documented range', async () => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: 1_000, scoreOutOfDocumentedRange: true })),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.join(' ')).toMatch(/outside the documented 0-100 range/);
    expect(v.reasons.join(' ')).toMatch(/fail closed, never clamp/);
    expect(v.facts.scoreOutOfDocumentedRange).toBe(true);
  });

  it('re-derives the out-of-range veto when the flag itself is missing', async () => {
    const overScale = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: 250, scoreOutOfDocumentedRange: undefined })),
    );
    const negative = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: -5, scoreOutOfDocumentedRange: undefined })),
    );

    expect(overScale.outcome).toBe(OUTCOME.REJECT);
    expect(overScale.facts.scoreOutOfDocumentedRange).toBe(true);
    // A negative score would sail under any ceiling: out of range is the only veto
    // that catches it.
    expect(negative.outcome).toBe(OUTCOME.REJECT);
    expect(negative.reasons.join(' ')).toMatch(/outside the documented/);
  });

  it('reports an out-of-range score and a rugged flag as two separate reasons', async () => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: 140, scoreOutOfDocumentedRange: true, rugged: true })),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons).toHaveLength(2);
  });

  it('names the individual risks in the rejection reason', async () => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(
        report({
          scoreNormalised: 76,
          risks: [risk('Freeze authority still enabled', 'danger', 50), risk('Low liquidity', 'warn', 26)],
        }),
      ),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.join(' ')).toMatch(/Freeze authority still enabled \[danger\]/);
    expect(v.reasons.join(' ')).toMatch(/Low liquidity \[warn\]/);
  });

  it('rejects an over-ceiling score even with no risks list to quote', async () => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: 90, risks: undefined })),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toMatch(/exceeds the ceiling/);
    expect(v.facts.risks).toBeNull();
  });

  it('quotes an unlevelled risk by name alone', async () => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: 90, risks: [risk('Single holder owns 40%', null, 90)] })),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons.join(' ')).toMatch(/Single holder owns 40%/);
    expect(v.reasons.join(' ')).not.toMatch(/\[null\]/);
    expect(v.facts.risks[0].level).toBeNull();
  });

  it('reports absent or junk informational fields as null, never as zero', async () => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(
        report({
          liquidityUsd: null,
          lpLockedPct: undefined,
          totalHolders: 'many',
          creator: null,
          graphInsidersDetected: null,
          scoreRaw: 'n/a',
        }),
      ),
    );

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.reportedLiquidityUsd).toBeNull();
    expect(v.facts.reportedLpLockedPct).toBeNull();
    expect(v.facts.reportedTotalHolders).toBeNull();
    expect(v.facts.reportedCreator).toBeNull();
    expect(v.facts.graphInsidersDetected).toBeNull();
    expect(v.facts.scoreRaw).toBeNull();
  });

  it('ignores non-object entries in the risks array instead of crashing', async () => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(report({ risks: [null, 'danger', { name: '', level: 'warn', score: '3' }] })),
    );

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.riskNames).toEqual(['unnamed-risk']);
    expect(v.facts.risks[0].score).toBeNull();
  });
});

describe('checkThirdParty -- a pass is not evidence of safety', () => {
  it('passes a score of 0 with no risks but records that silence proves nothing', async () => {
    const v = await checkThirdParty(MINT, makeCtx(report({ scoreNormalised: 0, risks: [] })));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.reasons).toEqual([]);
    expect(v.facts.riskCount).toBe(0);
    expect(v.facts.silenceIsNotEvidence).toBe(true);
    expect(v.facts.residualRisk).toMatch(/silence is not evidence of safety/i);
    expect(v.facts.evidenceRole).toBe('veto-only');
    expect(THIRD_PARTY_LIMITATION.notProven.join(' ')).toMatch(/silence is not evidence of safety/i);
  });

  it('surfaces the individual risks in facts for the log on a pass', async () => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: 12, risks: [risk('Mutable metadata', 'warn', 12)] })),
    );

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.riskNames).toEqual(['Mutable metadata']);
    expect(v.facts.risks[0]).toEqual({
      name: 'Mutable metadata',
      level: 'warn',
      score: 12,
      value: null,
      description: 'Mutable metadata description',
    });
  });

  it('reports an absent risks array as null, never as "no risks found"', async () => {
    const v = await checkThirdParty(MINT, makeCtx(report({ risks: undefined })));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.risks).toBeNull();
    expect(v.facts.riskCount).toBeNull();
    expect(v.facts.riskNames).toBeNull();
  });

  it('keeps the legacy raw score out of the threshold comparison', async () => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: 3, scoreRaw: 41_000 })),
    );

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.scoreRaw).toBe(41_000);
    expect(v.facts.scoreNormalised).toBe(3);
  });
});

describe('checkThirdParty -- fail closed', () => {
  it('errors when the report fetch throws (rugcheck down)', async () => {
    const ctx = {
      getTokenReport: vi.fn(async () => {
        throw new Error('rugcheck token report HTTP 503');
      }),
    };

    const v = await checkThirdParty(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/HTTP 503/);
    expect(v.facts.scoreNormalised).toBeNull();
    expect(v.facts.rugged).toBeNull();
    expect(v.facts.residualRisk).toMatch(/silence is not evidence of safety/i);
  });

  it('errors on a per-layer timeout, never a pass', async () => {
    const ctx = {
      getTokenReport: vi.fn(async () => {
        throw Object.assign(new Error('layer5-thirdparty exceeded 4000ms'), {
          code: 'GATE_TIMEOUT',
        });
      }),
    };

    const v = await checkThirdParty(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/exceeded 4000ms/);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'no report'],
    ['a number', 20],
  ])('errors when the report is %s rather than an object', async (_label, value) => {
    const v = await checkThirdParty(MINT, makeCtx(value));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/must resolve to an object/);
  });

  it.each([
    ['missing', undefined],
    ['a numeric string', '20'],
    ['null', null],
    ['NaN', Number.NaN],
  ])('errors when scoreNormalised is %s -- no fallback to the legacy score', async (_l, score) => {
    const v = await checkThirdParty(
      MINT,
      makeCtx(report({ scoreNormalised: score, scoreRaw: 5 })),
    );

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/no usable scoreNormalised/);
  });

  it.each([
    ['missing', undefined],
    ['a truthy string', 'true'],
    ['a number', 1],
  ])('errors when the rugged flag is %s', async (_label, rugged) => {
    const v = await checkThirdParty(MINT, makeCtx(report({ rugged })));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/non-boolean rugged flag/);
  });

  it.each([
    ['a missing mint', undefined],
    ['an empty mint', '   '],
    ['a non-string mint', 99],
  ])('errors on %s', async (_label, badMint) => {
    const v = await checkThirdParty(badMint, makeCtx());

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.reasons.join(' ')).toMatch(/mint must be a non-empty string/);
  });

  it.each([
    ['ctx is null', null],
    ['ctx is a number', 5],
    ['getTokenReport is missing', {}],
    ['getTokenReport is not callable', { getTokenReport: 'yes' }],
  ])('errors when %s', async (_label, ctx) => {
    const v = await checkThirdParty(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
  });
});

describe('checkThirdParty -- immutability and wiring', () => {
  it('returns a frozen verdict with frozen facts and mutates no argument', async () => {
    const tokenReport = report({ scoreNormalised: 9, risks: [risk('Mutable metadata', 'warn', 9)] });
    const before = structuredClone(tokenReport);

    const v = await checkThirdParty(MINT, makeCtx(tokenReport));

    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.facts)).toBe(true);
    expect(Object.isFrozen(v.facts.risks)).toBe(true);
    expect(Object.isFrozen(v.facts.risks[0])).toBe(true);
    expect(Object.isFrozen(v.facts.documentedScoreRange)).toBe(true);
    expect(tokenReport).toEqual(before);
  });

  it('uses the layer name the gate registry expects', () => {
    expect(LAYER).toBe(LAYER_SPECS.layer5.name);
  });

  it('is resolvable through loadLayerFn, so the gate can never skip it silently', async () => {
    const fn = await loadLayerFn(LAYER_SPECS.layer5);

    expect(fn).toBe(checkThirdParty);
  });
});
