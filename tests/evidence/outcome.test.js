import { describe, expect, it } from 'vitest';
import { LABELS, RECORDER } from '../../src/config.js';
import { LABEL, decideOutcome, shouldRelabel } from '../../src/evidence/outcome.js';
import { readDataset } from '../../scripts/label.js';

const HOUR = 3_600_000;
const NOW = 1_756_000_000_000;
const OLD = NOW - 48 * HOUR;

const decide = (over = {}) =>
  decideOutcome({
    recordedTs: OLD,
    recordedLiquidityUsd: 50_000,
    recordedPriceUsd: 0.001,
    current: { liquidityUsd: 45_000, priceUsd: 0.0009 },
    now: NOW,
    apiHealthy: true,
    ...over,
  });

describe('decideOutcome -- survival', () => {
  it('calls a still-liquid pool SURVIVED', () => {
    const r = decide();

    expect(r.label).toBe(LABEL.SURVIVED);
    expect(r.reasons.join(' ')).toMatch(/still trading/);
  });

  it('records the before/after evidence so a relabel needs no re-collection', () => {
    const r = decide();

    expect(r.evidence.liquidityBeforeUsd).toBe(50_000);
    expect(r.evidence.liquidityAfterUsd).toBe(45_000);
    expect(r.evidence.liquidityDropPct).toBeCloseTo(10, 5);
    expect(r.evidence.thresholds.ruggedLiquidityDropPct).toBe(LABELS.ruggedLiquidityDropPct);
  });

  it('treats a pool that GREW as survived', () => {
    expect(decide({ current: { liquidityUsd: 90_000, priceUsd: 0.002 } }).label).toBe(LABEL.SURVIVED);
  });
});

describe('decideOutcome -- rug detection', () => {
  it('flags a liquidity collapse past the drop threshold', () => {
    const r = decide({ current: { liquidityUsd: 50_000 * 0.19, priceUsd: 0.001 } });

    expect(r.label).toBe(LABEL.RUGGED);
    expect(r.reasons.join(' ')).toMatch(/liquidity fell/);
  });

  it('does NOT flag a drop just short of the threshold', () => {
    // 79% drop, threshold is 80%
    const r = decide({ current: { liquidityUsd: 50_000 * 0.21, priceUsd: 0.001 } });

    expect(r.label).toBe(LABEL.SURVIVED);
  });

  it('flags a pool below the absolute floor even if it started small', () => {
    const r = decide({
      recordedLiquidityUsd: 1_200,
      current: { liquidityUsd: LABELS.ruggedBelowLiquidityUsd - 1, priceUsd: 0.001 },
    });

    expect(r.label).toBe(LABEL.RUGGED);
    expect(r.reasons.join(' ')).toMatch(/dead pool/);
  });

  it('flags a price collapse even when the pool still holds liquidity', () => {
    const r = decide({
      current: { liquidityUsd: 48_000, priceUsd: 0.001 * 0.05 },
    });

    expect(r.label).toBe(LABEL.RUGGED);
    expect(r.reasons.join(' ')).toMatch(/price fell/);
  });

  it('flags a vanished pair when the source is demonstrably healthy', () => {
    const r = decide({ current: null, apiHealthy: true });

    expect(r.label).toBe(LABEL.RUGGED);
    expect(r.reasons.join(' ')).toMatch(/no pair exists any more/);
  });
});

describe('decideOutcome -- refusing to guess', () => {
  it('will not judge a token younger than the minimum age', () => {
    const r = decide({ recordedTs: NOW - 2 * HOUR });

    expect(r.label).toBe(LABEL.TOO_EARLY);
    expect(r.reasons.join(' ')).toMatch(/required before an outcome means anything/);
  });

  it('labels exactly at the age boundary', () => {
    const r = decide({ recordedTs: NOW - LABELS.minAgeHoursBeforeLabelling * HOUR });

    expect(r.label).not.toBe(LABEL.TOO_EARLY);
  });

  it('a vanished pair during an OUTAGE is UNKNOWN, never rugged', () => {
    // the most important honesty rule here: an outage must not be recorded as
    // every pool being dead, which would fabricate a spectacular rug rate
    const r = decide({ current: null, apiHealthy: false });

    expect(r.label).toBe(LABEL.UNKNOWN);
    expect(r.reasons.join(' ')).toMatch(/refusing to read an outage as a dead pool/);
  });

  it('a pair with no liquidity figure is UNKNOWN, not survived', () => {
    const r = decide({ current: { liquidityUsd: null, priceUsd: 0.001 } });

    expect(r.label).toBe(LABEL.UNKNOWN);
  });

  it('is UNKNOWN when nothing was recorded to compare against', () => {
    const r = decide({
      recordedLiquidityUsd: null,
      recordedPriceUsd: null,
      current: { liquidityUsd: 45_000, priceUsd: 0.0009 },
    });

    expect(r.label).toBe(LABEL.UNKNOWN);
    expect(r.reasons.join(' ')).toMatch(/nothing was recorded to compare against/);
  });

  it('is UNKNOWN with an unusable timestamp', () => {
    expect(decide({ recordedTs: null }).label).toBe(LABEL.UNKNOWN);
  });

  it('returns a frozen result', () => {
    const r = decide();

    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.reasons)).toBe(true);
    expect(Object.isFrozen(r.evidence)).toBe(true);
  });
});

describe('shouldRelabel', () => {
  it('labels a mint that has never been labelled', () => {
    expect(shouldRelabel({ lastLabelledTs: null, lastLabel: null, now: NOW })).toBe(true);
  });

  it('never re-labels a rug: a dead pool does not come back', () => {
    expect(
      shouldRelabel({ lastLabelledTs: NOW - 500 * HOUR, lastLabel: LABEL.RUGGED, now: NOW }),
    ).toBe(false);
  });

  it('re-checks a survivor once the cooldown has passed', () => {
    const stale = NOW - (LABELS.relabelAfterHours + 1) * HOUR;
    const fresh = NOW - 1 * HOUR;

    expect(shouldRelabel({ lastLabelledTs: stale, lastLabel: LABEL.SURVIVED, now: NOW })).toBe(true);
    expect(shouldRelabel({ lastLabelledTs: fresh, lastLabel: LABEL.SURVIVED, now: NOW })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

const snapshot = (candidates, ts = OLD) =>
  JSON.stringify({ schemaVersion: RECORDER.schemaVersion, ts, iso: 'x', candidates });

const labelLine = (labels, ts = NOW) =>
  JSON.stringify({ schemaVersion: RECORDER.schemaVersion, type: LABELS.recordType, ts, labels });

describe('readDataset', () => {
  it('keeps the FIRST observation of a mint', () => {
    const { observations } = readDataset([
      snapshot([{ mint: 'A', liquidityUsd: 50_000, outcome: null }], OLD),
      snapshot([{ mint: 'A', liquidityUsd: 10, outcome: null }], OLD + HOUR),
    ]);

    // the first is the decision the filter would have traded on, and the
    // liquidity the collapse must be measured against
    expect(observations.get('A').liquidityUsd).toBe(50_000);
    expect(observations.get('A').recordedTs).toBe(OLD);
  });

  it('reads appended label records separately from snapshots', () => {
    const { observations, labels } = readDataset([
      snapshot([{ mint: 'A', outcome: null }]),
      labelLine([{ mint: 'A', outcome: 'rugged', ts: NOW }]),
    ]);

    expect(observations.size).toBe(1);
    expect(labels.get('A').outcome).toBe('rugged');
  });

  it('keeps the most recent label when a mint is labelled twice', () => {
    const { labels } = readDataset([
      snapshot([{ mint: 'A', outcome: null }]),
      labelLine([{ mint: 'A', outcome: 'survived', ts: NOW - HOUR }], NOW - HOUR),
      labelLine([{ mint: 'A', outcome: 'rugged', ts: NOW }], NOW),
    ]);

    expect(labels.get('A').outcome).toBe('rugged');
  });

  it('counts malformed and wrong-schema lines without throwing', () => {
    const { malformed, observations } = readDataset([
      snapshot([{ mint: 'A' }]),
      '{"truncated',
      JSON.stringify({ schemaVersion: 999, candidates: [{ mint: 'B' }] }),
      '',
    ]);

    expect(malformed).toBe(2);
    expect(observations.has('B')).toBe(false);
  });
});
