import { describe, expect, it } from 'vitest';
import { RECORDER } from '../../src/config.js';
import { EXIT, intFlag, parseArgs, printGateReport } from '../../scripts/lib/cli.js';
import { buildRecord, dayFile } from '../../scripts/record.js';
import { OUTCOME } from '../../src/safety/verdict.js';

describe('parseArgs', () => {
  it('reads --flag, --key=value, --key value and positionals', () => {
    const { positional, flags } = parseArgs(['MINT1', '--early', '--limit=5', '--feed', 'top']);

    expect(positional).toEqual(['MINT1']);
    expect(flags.early).toBe(true);
    expect(flags.limit).toBe('5');
    expect(flags.feed).toBe('top');
  });

  it('does not swallow a following flag as a value', () => {
    const { flags } = parseArgs(['--json', '--early']);

    expect(flags.json).toBe(true);
    expect(flags.early).toBe(true);
  });

  it('returns frozen results and handles an empty argv', () => {
    const parsed = parseArgs([]);

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.flags)).toBe(true);
    expect(parsed.positional).toEqual([]);
  });
});

describe('intFlag', () => {
  it('parses a positive integer and falls back otherwise', () => {
    expect(intFlag('7', 3)).toBe(7);
    expect(intFlag(undefined, 3)).toBe(3);
    expect(intFlag(true, 3)).toBe(3);
    expect(intFlag('0', 3)).toBe(3);
    expect(intFlag('-4', 3)).toBe(3);
    expect(intFlag('abc', 3)).toBe(3);
    expect(intFlag('2.5', 3)).toBe(3);
  });
});

describe('EXIT codes', () => {
  it('keeps a usage/internal error distinct from a negative answer', () => {
    // `check-token && buy` must not read a typo as a considered rejection
    expect(EXIT.OK).toBe(0);
    expect(EXIT.NEGATIVE).toBe(1);
    expect(EXIT.ERROR).toBe(2);
  });
});

const verdict = (layer, outcome, reasons = []) =>
  Object.freeze({ layer, outcome, reasons: Object.freeze(reasons), facts: {}, ms: 5 });

const gateResult = (over = {}) =>
  Object.freeze({
    mint: 'MINT',
    buyable: false,
    complete: true,
    rejectedBy: Object.freeze(['layer0-mint']),
    erroredIn: Object.freeze([]),
    reasons: Object.freeze(['freeze authority is still live']),
    layers: Object.freeze([verdict('layer0-mint', OUTCOME.REJECT, ['freeze authority is still live'])]),
    order: Object.freeze(['layer0']),
    skipped: Object.freeze(['layer1-sellsim', 'layer2-liquidity']),
    residualRisks: Object.freeze(['no exit route was proven']),
    elapsedMs: 12,
    totalMs: 5,
    ...over,
  });

const capture = (gate) => {
  const lines = [];
  printGateReport(gate, (s) => lines.push(s));
  return lines.join('\n');
};

describe('printGateReport -- honesty in output', () => {
  it('labels skipped layers as NOT passes, in their own section', () => {
    const text = capture(gateResult());

    expect(text).toMatch(/NOT RUN/);
    expect(text).toMatch(/These are NOT passes/);
    expect(text).toMatch(/layer1-sellsim/);
    expect(text).toMatch(/layer2-liquidity/);
  });

  it('prints the reject reason and the blocked verdict', () => {
    const text = capture(gateResult());

    expect(text).toMatch(/REJECT.*layer0-mint/s);
    expect(text).toMatch(/freeze authority is still live/);
    expect(text).toMatch(/VERDICT: BLOCKED/);
  });

  it('warns that an incomplete run is not a pass', () => {
    const text = capture(
      gateResult({ complete: false, erroredIn: ['layer3-holders'], rejectedBy: [] }),
    );

    expect(text).toMatch(/Incomplete/);
    expect(text).toMatch(/never a pass/);
  });

  it('a BUYABLE verdict still prints what passing does NOT mean', () => {
    const text = capture(
      gateResult({
        buyable: true,
        rejectedBy: [],
        reasons: [],
        skipped: [],
        layers: [verdict('layer0-mint', OUTCOME.PASS)],
      }),
    );

    expect(text).toMatch(/VERDICT: BUYABLE/);
    expect(text).toMatch(/does NOT mean profitable|NOT mean profitable/i);
    expect(text).toMatch(/SOFT RUG/i);
  });

  it('deduplicates residual risks so the list stays readable', () => {
    const text = capture(gateResult({ residualRisks: ['same risk', 'same risk', 'other'] }));
    const occurrences = text.split('same risk').length - 1;

    expect(occurrences).toBe(1);
    expect(text).toMatch(/other/);
  });
});

describe('record.js pure helpers', () => {
  it('buckets files by UTC day', () => {
    expect(dayFile(Date.parse('2026-08-25T23:59:59Z'))).toBe('2026-08-25.jsonl');
    expect(dayFile(Date.parse('2026-08-26T00:00:01Z'))).toBe('2026-08-26.jsonl');
  });

  it('stamps the schema version and keeps the four gate outcomes APART', () => {
    const rec = buildRecord({
      ts: Date.parse('2026-08-25T12:00:00Z'),
      profile: 'early',
      rows: [
        {
          pair: { mint: 'M1', baseToken: { symbol: 'X' }, pairAddress: 'P', dexId: 'raydium' },
          signals: { priceUsd: 1, marketCapUsd: 2, liquidityUsd: 3, ageMinutes: 4 },
          gate: {
            buyable: false,
            complete: false,
            layers: [
              { layer: 'layer0-mint', outcome: 'PASS', reasons: [] },
              { layer: 'layer3-holders', outcome: 'ERROR', reasons: ['rpc 429'] },
            ],
            rejectedBy: [],
            erroredIn: ['layer3-holders'],
            skipped: ['layer4-deployer'],
            reasons: ['rpc 429'],
            elapsedMs: 9,
          },
        },
      ],
    });

    expect(rec.schemaVersion).toBe(RECORDER.schemaVersion);
    expect(rec.profile).toBe('early');
    const c = rec.candidates[0];
    expect(c.gate.passed).toEqual(['layer0-mint']);
    expect(c.gate.erroredIn).toEqual(['layer3-holders']);
    expect(c.gate.skipped).toEqual(['layer4-deployer']);
    expect(c.gate.rejectedBy).toEqual([]);
    // a fresh record is never pre-labelled
    expect(c.outcome).toBeNull();
  });

  it('produces a single-line JSON record, so a crash cannot straddle two', () => {
    const rec = buildRecord({ ts: 1, profile: 'standard', rows: [] });
    const text = JSON.stringify(rec);

    expect(text.includes('\n')).toBe(false);
    expect(JSON.parse(text).candidates).toEqual([]);
  });
});
