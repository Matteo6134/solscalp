import { describe, expect, it } from 'vitest';
import { RECORDER } from '../../src/config.js';
import {
  BASE_RATE_PCT,
  MIN_SAMPLE,
  scoreRugFilter,
  tallyRecords,
  wilsonInterval,
} from '../../scripts/backtest-rug-filter.js';

describe('wilsonInterval', () => {
  it('never returns a negative lower bound, even at zero successes', () => {
    // this is precisely why Wilson is used instead of the normal approximation
    const i = wilsonInterval(0, 30);

    expect(i.low).toBe(0);
    expect(i.high).toBeGreaterThan(0);
    expect(i.high).toBeLessThan(20);
  });

  it('never exceeds 100% at full successes', () => {
    const i = wilsonInterval(30, 30);

    expect(i.high).toBe(100);
    expect(i.low).toBeLessThan(100);
  });

  it('narrows as the sample grows', () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(500, 1000);

    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('brackets the point estimate', () => {
    const i = wilsonInterval(10, 100);

    expect(i.low).toBeLessThan(10);
    expect(i.high).toBeGreaterThan(10);
  });

  it('rejects impossible inputs rather than returning nonsense', () => {
    expect(() => wilsonInterval(-1, 10)).toThrow(/non-negative/);
    expect(() => wilsonInterval(1, 0)).toThrow(/positive/);
    expect(() => wilsonInterval(11, 10)).toThrow(/exceeds/);
    expect(() => wilsonInterval(1.5, 10)).toThrow(/integer/);
  });
});

describe('scoreRugFilter -- refusing to mislead', () => {
  it('reports NO RATE below the minimum sample, and says why', () => {
    const r = scoreRugFilter({ approved: MIN_SAMPLE - 1, rugged: 3 });

    expect(r.sufficient).toBe(false);
    expect(r.ruggedPct).toBeNull();
    expect(r.interval).toBeNull();
    expect(r.liftPctPoints).toBeNull();
    expect(r.reason).toMatch(/required before a rate is meaningful/);
  });

  it('still reports the raw counts when the sample is too small', () => {
    const r = scoreRugFilter({ approved: 4, rugged: 1, unlabelled: 7, rejected: 90 });

    expect(r.approved).toBe(4);
    expect(r.rugged).toBe(1);
    expect(r.survived).toBe(3);
    expect(r.unlabelled).toBe(7);
    expect(r.rejected).toBe(90);
  });

  it('reports a rate exactly at the minimum sample', () => {
    const r = scoreRugFilter({ approved: MIN_SAMPLE, rugged: 3 });

    expect(r.sufficient).toBe(true);
    expect(r.ruggedPct).toBeCloseTo(10, 10);
    expect(r.interval.low).toBeGreaterThan(0);
  });

  it('computes lift in percentage POINTS against the base rate', () => {
    const r = scoreRugFilter({ approved: 100, rugged: 20 });

    expect(r.ruggedPct).toBe(20);
    expect(r.liftPctPoints).toBeCloseTo(BASE_RATE_PCT - 20, 10);
  });

  it('reports a NEGATIVE lift when the filter is worse than the base rate', () => {
    const r = scoreRugFilter({ approved: 100, rugged: 100 });

    expect(r.ruggedPct).toBe(100);
    expect(r.liftPctPoints).toBeCloseTo(BASE_RATE_PCT - 100, 10);
    expect(r.liftPctPoints).toBeLessThan(0);
  });

  it('is frozen, and rejects impossible counts', () => {
    expect(Object.isFrozen(scoreRugFilter({ approved: 50, rugged: 1 }))).toBe(true);
    expect(() => scoreRugFilter({ approved: 10, rugged: 11 })).toThrow(/exceeds/);
    expect(() => scoreRugFilter({ approved: -1, rugged: 0 })).toThrow(/non-negative/);
    expect(() => scoreRugFilter({ approved: 1.5, rugged: 0 })).toThrow(/integer/);
  });

  it('honours an injected minSample so the threshold is testable', () => {
    expect(scoreRugFilter({ approved: 2, rugged: 0, minSample: 2 }).sufficient).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

const candidate = (mint, over = {}) => ({
  mint,
  outcome: null,
  gate: { buyable: true, complete: true, passed: [], rejectedBy: [], erroredIn: [], skipped: [] },
  ...over,
});

const record = (candidates, over = {}) =>
  JSON.stringify({
    schemaVersion: RECORDER.schemaVersion,
    ts: 1,
    iso: 'x',
    candidates,
    ...over,
  });

describe('tallyRecords', () => {
  it('counts snapshots from parsed records, not from line count', () => {
    // a trailing newline yields an empty final element; it must not be counted
    const t = tallyRecords([record([candidate('a')]), '']);

    expect(t.snapshots).toBe(1);
    expect(t.malformed).toBe(0);
  });

  it('treats an approval with no outcome as UNLABELLED, never as survived', () => {
    const t = tallyRecords([record([candidate('a')])]);

    expect(t.approved).toBe(0);
    expect(t.unlabelled).toBe(1);
    expect(t.rugged).toBe(0);
  });

  it('counts a labelled rug', () => {
    const t = tallyRecords([record([candidate('a', { outcome: 'rugged' })])]);

    expect(t.approved).toBe(1);
    expect(t.rugged).toBe(1);
    expect(t.unlabelled).toBe(0);
  });

  it('separates blocked tokens from approvals', () => {
    const blocked = candidate('b', {
      gate: { buyable: false, complete: true, passed: [], rejectedBy: ['layer0-mint'], erroredIn: [], skipped: [] },
    });
    const t = tallyRecords([record([candidate('a', { outcome: 'survived' }), blocked])]);

    expect(t.approved).toBe(1);
    expect(t.rejected).toBe(1);
    expect(t.uniqueMints).toBe(2);
  });

  it('keeps the FIRST verdict for a repeated mint but accepts a later label', () => {
    const first = record([candidate('a')]);
    const later = record([candidate('a', { outcome: 'rugged' })]);
    const t = tallyRecords([first, later]);

    expect(t.uniqueMints).toBe(1);
    expect(t.approved).toBe(1);
    expect(t.rugged).toBe(1);
    expect(t.snapshots).toBe(2);
  });

  it('skips a truncated final line instead of throwing', () => {
    const t = tallyRecords([record([candidate('a')]), '{"schemaVersion":1,"candi']);

    expect(t.malformed).toBe(1);
    expect(t.snapshots).toBe(1);
  });

  it('skips a record written by a different schema version', () => {
    const t = tallyRecords([record([candidate('a')], { schemaVersion: 999 })]);

    expect(t.malformed).toBe(1);
    expect(t.uniqueMints).toBe(0);
  });

  it('ignores a candidate with no mint rather than counting a phantom', () => {
    const t = tallyRecords([record([{ outcome: 'rugged', gate: { buyable: true } }])]);

    expect(t.uniqueMints).toBe(0);
  });

  it('handles an empty input', () => {
    const t = tallyRecords([]);

    expect(t.snapshots).toBe(0);
    expect(t.uniqueMints).toBe(0);
    expect(t.approved).toBe(0);
  });
});
