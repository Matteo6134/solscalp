/**
 * Random-entry baseline -- the control group.
 *
 * WHAT THIS IS FOR
 *   One question, asked cheaply: is the strategy better than luck? This buys at
 *   random and sells with the IDENTICAL exit rules, the identical position size,
 *   the identical cost model and the identical safety gate. If the strategy's
 *   equity curve does not beat this one, the momentum logic is decoration and
 *   that is worth knowing before any real money is involved.
 *
 * WHY IT SHARES decideEntry
 *   A baseline is only meaningful if EXACTLY ONE thing differs. So this module
 *   does not reimplement the gate, universe, capacity or cost checks -- it calls
 *   engine.decideEntry with `momentum: false` and adds a coin flip. Anything
 *   else would be a different experiment wearing a baseline's name.
 *
 * WHAT IT IS NOT
 *   Not a trading strategy, and not something to run for profit. It is
 *   diagnostic scaffolding, off by default, exposed behind a --baseline flag so
 *   an ordinary run never mentions it.
 *
 * DETERMINISM IS THE POINT
 *   Math.random() would make every run unreproducible, so the whole repo forbids
 *   it. The same seed must replay the same decisions forever, or the baseline
 *   cannot be compared across runs or re-derived from a recording.
 */

import { BASELINE } from '../config.js';
import { decideEntry } from '../paper/engine.js';

/**
 * mulberry32 -- a 32-bit PRNG. Chosen because it is four lines, has no state
 * beyond one uint32, passes the usual smoke tests for a task like this, and is
 * trivially portable, so a recorded seed reproduces a run on any machine.
 *
 * Reference: Tommy Ettinger's mulberry32, public domain.
 *
 * @param {number} [seed] defaults to BASELINE.seed
 * @returns {Readonly<{ next: () => number, state: () => number, seed: number }>}
 */
export function createRng(seed = BASELINE.seed) {
  if (!Number.isInteger(seed)) {
    throw new TypeError(`createRng: seed must be an integer, got ${String(seed)}`);
  }
  // Coerce into uint32 so a negative or oversized seed is still deterministic.
  let s = seed >>> 0;
  return Object.freeze({
    seed,
    /** @returns {number} in [0, 1) */
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    },
    /** Current internal state, so a run can be checkpointed and resumed. */
    state: () => s,
  });
}

/**
 * Random entry. Every check the strategy makes still applies EXCEPT the
 * STRATEGY.entry momentum signals; in their place, a coin flip weighted to
 * BASELINE.entryProbabilityPerTick.
 *
 * The rng is consumed ONLY when every other condition already passed. That
 * keeps the draw sequence independent of how many tokens happened to fail the
 * gate on a given tick, so two runs over the same recording stay comparable.
 *
 * @param {object} p same shape as decideEntry, plus:
 * @param {{next: () => number}} p.rng required; there is no default, because a
 *   silently-seeded baseline is an unreproducible one
 * @param {number} [p.probability] defaults to BASELINE.entryProbabilityPerTick
 * @returns {Readonly<{enter: boolean, reasons: readonly string[], signals: object,
 *   roll: number|null}>}
 */
export function decideEntryRandom({ rng, probability = BASELINE.entryProbabilityPerTick, ...rest }) {
  if (typeof rng?.next !== 'function') {
    throw new TypeError(
      'decideEntryRandom: rng.next() is required -- pass createRng(seed). A baseline ' +
        'that cannot be replayed is not a baseline.',
    );
  }
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError(
      `decideEntryRandom: probability must be in [0, 1], got ${String(probability)}`,
    );
  }

  const shared = decideEntry({ ...rest, momentum: false });
  if (!shared.enter) {
    // Blocked for a real reason (gate, universe, capacity, costs). No draw is
    // taken, so the sequence stays aligned across runs.
    return Object.freeze({ ...shared, roll: null });
  }

  const roll = rng.next();
  if (roll >= probability) {
    return Object.freeze({
      enter: false,
      reasons: Object.freeze([
        `baseline coin flip declined: ${roll.toFixed(4)} >= ${probability}`,
      ]),
      signals: shared.signals,
      costs: shared.costs,
      roll,
    });
  }

  return Object.freeze({
    enter: true,
    reasons: Object.freeze([]),
    signals: shared.signals,
    costs: shared.costs,
    roll,
  });
}

/**
 * An entryDecider for stepEngine, closing over one rng so a whole paper run
 * draws from a single reproducible sequence.
 * @param {{next: () => number}} rng
 * @param {number} [probability]
 * @returns {(args: object) => object}
 */
export function createBaselineDecider(rng, probability) {
  return (args) => decideEntryRandom({ ...args, rng, probability });
}
