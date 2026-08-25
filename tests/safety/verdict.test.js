import { describe, expect, it } from 'vitest';
import { OUTCOME, combine, errored, pass, reject, verdict } from '../../src/safety/verdict.js';

const v = (outcome, layer = 'x') => ({ layer, outcome, reasons: [], facts: {}, ms: 0 });

describe('verdict()', () => {
  it('refuses an unknown outcome rather than inventing one', () => {
    expect(() => verdict({ layer: 'x', outcome: 'MAYBE' })).toThrow(/unknown outcome/);
    expect(() => verdict({ layer: 'x', outcome: 'pass' })).toThrow(/unknown outcome/);
    expect(() => verdict({ layer: 'x', outcome: undefined })).toThrow(/unknown outcome/);
  });

  it('requires a layer name', () => {
    expect(() => verdict({ layer: '', outcome: OUTCOME.PASS })).toThrow(/layer name/);
    expect(() => verdict({ outcome: OUTCOME.PASS })).toThrow(/layer name/);
  });

  it('freezes the verdict and its containers', () => {
    const result = pass('layer0-mint', { a: 1 }, 5);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.facts)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  it('copies reasons and facts, so a caller cannot mutate them afterwards', () => {
    const reasons = ['a'];
    const facts = { x: 1 };
    const result = reject('l', reasons, facts);
    reasons.push('b');
    facts.x = 2;

    expect(result.reasons).toEqual(['a']);
    expect(result.facts.x).toBe(1);
  });

  it('errored() never conflates a failed check with a pass', () => {
    const result = errored('l', new Error('rpc down'));

    expect(result.outcome).toBe(OUTCOME.ERROR);
    expect(result.reasons.join(' ')).toMatch(/rpc down/);
  });
});

describe('combine() -- buyability is a whitelist, not "nothing objected"', () => {
  it('is buyable only when every layer affirmatively PASSED', () => {
    expect(combine([v(OUTCOME.PASS), v(OUTCOME.PASS)]).buyable).toBe(true);
  });

  /**
   * The regression this file exists for. combine() used to compute
   * `blocked = anyReject || anyError` and return `!blocked`, so ANY outcome that
   * was not REJECT or ERROR counted as a pass. An audit found that 'MAYBE',
   * 'SKIPPED', '', null, undefined, 0 and lowercase 'pass' all read as buyable.
   *
   * 'SKIPPED' is the pointed one: invariant 1 is that a skipped layer must never
   * be conflated with a passed one, and this was the exact mechanism by which
   * that would have happened the moment anyone added the value to OUTCOME.
   */
  it.each([
    ['lowercase pass', 'pass'],
    ['MAYBE', 'MAYBE'],
    ['SKIPPED', 'SKIPPED'],
    ['UNKNOWN', 'UNKNOWN'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['one', 1],
    ['true', true],
    ['an object', {}],
  ])('refuses to read outcome %s as a pass', (_label, outcome) => {
    const result = combine([v(outcome)]);

    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.unrecognised).toHaveLength(1);
    expect(result.reasons.join(' ')).toMatch(/refusing to read it as a pass/);
  });

  it('blocks the whole gate when even one layer is unrecognised', () => {
    const result = combine([v(OUTCOME.PASS), v('WAT'), v(OUTCOME.PASS)]);

    expect(result.buyable).toBe(false);
    expect(result.unrecognised).toEqual(['x']);
  });

  it('names the layer whose outcome could not be read', () => {
    const result = combine([{ layer: 'layer3-holders', outcome: 'WAT', reasons: [], ms: 0 }]);

    expect(result.unrecognised).toEqual(['layer3-holders']);
    expect(result.reasons.join(' ')).toMatch(/layer3-holders/);
  });

  it('survives a verdict with no layer name at all', () => {
    const result = combine([{ outcome: 'WAT', reasons: [] }]);

    expect(result.buyable).toBe(false);
    expect(result.unrecognised).toEqual(['<no layer name>']);
  });

  it('survives null and undefined entries without throwing', () => {
    expect(() => combine([null, undefined])).not.toThrow();
    expect(combine([null, undefined]).buyable).toBe(false);
  });

  it('an empty verdict list is never buyable', () => {
    expect(combine([]).buyable).toBe(false);
    expect(combine([]).complete).toBe(false);
  });

  it('a REJECT blocks and is still complete (the gate did answer)', () => {
    const result = combine([v(OUTCOME.PASS), v(OUTCOME.REJECT, 'layer2-liquidity')]);

    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.rejectedBy).toEqual(['layer2-liquidity']);
  });

  it('an ERROR blocks under failClosed and is never complete', () => {
    const result = combine([v(OUTCOME.PASS), v(OUTCOME.ERROR, 'layer3-holders')], true);

    expect(result.buyable).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.erroredIn).toEqual(['layer3-holders']);
  });

  it('with failClosed=false an ERROR no longer blocks, but is still not complete', () => {
    // complete must stay false: an unanswered check is unanswered either way
    const result = combine([v(OUTCOME.PASS), v(OUTCOME.ERROR)], false);

    expect(result.complete).toBe(false);
  });

  it('returns a frozen result with frozen containers', () => {
    const result = combine([v(OUTCOME.PASS)]);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
    expect(Object.isFrozen(result.unrecognised)).toBe(true);
    expect(() => result.reasons.push('x')).toThrow();
  });
});
