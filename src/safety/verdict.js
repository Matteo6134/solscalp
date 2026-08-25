/**
 * The single value type every safety layer returns.
 * Immutable by construction: helpers return new verdicts, never mutate.
 */

/** @typedef {'PASS'|'REJECT'|'ERROR'} Outcome */

export const OUTCOME = Object.freeze({
  PASS: 'PASS',
  REJECT: 'REJECT',
  /** A check could not complete. Under failClosed this is treated as REJECT. */
  ERROR: 'ERROR',
});

/**
 * @param {object} p
 * @param {string} p.layer      e.g. 'layer0-mint'
 * @param {Outcome} p.outcome
 * @param {string[]} [p.reasons] human-readable reject reasons
 * @param {object} [p.facts]    raw evidence gathered, for logging/backtest
 * @param {number} [p.ms]       wall time of the check
 */
export function verdict({ layer, outcome, reasons = [], facts = {}, ms = 0 }) {
  if (!OUTCOME[outcome]) throw new TypeError(`unknown outcome: ${outcome}`);
  if (typeof layer !== 'string' || layer.length === 0) {
    throw new TypeError('verdict requires a layer name');
  }
  return Object.freeze({
    layer,
    outcome,
    reasons: Object.freeze([...reasons]),
    facts: Object.freeze({ ...facts }),
    ms,
  });
}

export const pass = (layer, facts = {}, ms = 0) =>
  verdict({ layer, outcome: OUTCOME.PASS, facts, ms });

export const reject = (layer, reasons, facts = {}, ms = 0) =>
  verdict({
    layer,
    outcome: OUTCOME.REJECT,
    reasons: Array.isArray(reasons) ? reasons : [reasons],
    facts,
    ms,
  });

/** Use when a check itself failed. Never conflate with PASS. */
export const errored = (layer, err, facts = {}, ms = 0) =>
  verdict({
    layer,
    outcome: OUTCOME.ERROR,
    reasons: [`check failed: ${err?.message ?? String(err)}`],
    facts,
    ms,
  });

/**
 * Combine layer verdicts into one gate result.
 *
 * Buyable only if EVERY layer AFFIRMATIVELY PASSED. Under failClosed, ERROR
 * blocks the buy.
 *
 * BUYABILITY IS A WHITELIST, NOT "NOTHING OBJECTED".
 *   This was originally written as `blocked = anyReject || anyError`, with
 *   buyable being its negation -- so any verdict whose `outcome` was neither
 *   REJECT nor ERROR counted as a pass. An audit showed that meant `'MAYBE'`,
 *   `'SKIPPED'`, `''`, `null`, `undefined`, `0` and even lowercase `'pass'` all
 *   read as buyable. `verdict()` rejects unknown outcomes, so no layer in this
 *   repo could produce one -- but the failure mode it invited is exactly the one
 *   the project exists to prevent, and it would have arrived silently the first
 *   time anyone added an outcome to OUTCOME (a `SKIPPED` value especially, since
 *   invariant 1 is that skipped must never be conflated with passed).
 *
 *   So the count is now explicit: every verdict must be PASS. An unrecognised
 *   outcome is reported in `unrecognised` and blocks, because "did not object"
 *   is not the same claim as "approved".
 *
 * @param {readonly object[]} verdicts
 * @param {boolean} failClosed
 */
export function combine(verdicts, failClosed = true) {
  const list = Object.freeze([...verdicts]);
  const passed = list.filter((v) => v?.outcome === OUTCOME.PASS);
  const rejected = list.filter((v) => v?.outcome === OUTCOME.REJECT);
  const errors = list.filter((v) => v?.outcome === OUTCOME.ERROR);
  /** Neither PASS, REJECT nor ERROR: we cannot say what this layer decided. */
  const unrecognised = list.filter(
    (v) => v?.outcome !== OUTCOME.PASS && v?.outcome !== OUTCOME.REJECT && v?.outcome !== OUTCOME.ERROR,
  );

  const blocked =
    rejected.length > 0 || unrecognised.length > 0 || (failClosed && errors.length > 0);

  return Object.freeze({
    // Both halves are required: nothing blocked it AND every layer said PASS.
    buyable: !blocked && list.length > 0 && passed.length === list.length,
    /** Present so an all-ERROR result can never be silently read as buyable. */
    complete: list.length > 0 && errors.length === 0 && unrecognised.length === 0,
    rejectedBy: Object.freeze(rejected.map((v) => v.layer)),
    erroredIn: Object.freeze(errors.map((v) => v.layer)),
    /** Layers whose outcome could not be interpreted. Always blocks. */
    unrecognised: Object.freeze(unrecognised.map((v) => v?.layer ?? '<no layer name>')),
    reasons: Object.freeze([
      ...[...rejected, ...errors].flatMap((v) => [...v.reasons]),
      ...unrecognised.map(
        (v) =>
          `unrecognised outcome ${JSON.stringify(v?.outcome)} from ` +
          `${v?.layer ?? 'an unnamed layer'}: refusing to read it as a pass`,
      ),
    ]),
    layers: list,
    totalMs: list.reduce((sum, v) => sum + (v?.ms ?? 0), 0),
  });
}
