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
 * Buyable only if EVERY layer passed. Under failClosed, ERROR blocks the buy.
 * @param {readonly object[]} verdicts
 * @param {boolean} failClosed
 */
export function combine(verdicts, failClosed = true) {
  const list = Object.freeze([...verdicts]);
  const rejected = list.filter((v) => v.outcome === OUTCOME.REJECT);
  const errors = list.filter((v) => v.outcome === OUTCOME.ERROR);

  const blocked = rejected.length > 0 || (failClosed && errors.length > 0);

  return Object.freeze({
    buyable: !blocked && list.length > 0,
    /** Present so an all-ERROR result can never be silently read as buyable. */
    complete: list.length > 0 && errors.length === 0,
    rejectedBy: Object.freeze(rejected.map((v) => v.layer)),
    erroredIn: Object.freeze(errors.map((v) => v.layer)),
    reasons: Object.freeze([...rejected, ...errors].flatMap((v) => [...v.reasons])),
    layers: list,
    totalMs: list.reduce((sum, v) => sum + (v.ms ?? 0), 0),
  });
}
