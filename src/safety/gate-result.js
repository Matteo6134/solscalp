/**
 * Turning layer returns into verdicts, and verdicts into a GateResult.
 *
 * WHAT THIS MODULE PROVES
 *   Nothing about a token. It enforces two structural guarantees instead:
 *   (a) a layer's return value is shape-checked and re-frozen before the gate
 *       believes it -- layers are owned by other modules, so their output is
 *       untrusted input, and a malformed verdict must become an ERROR rather
 *       than a truthy object that reads as "no problem found";
 *   (b) the assembled result keeps SKIPPED, ERRORED and PASSED strictly apart,
 *       and carries the residual-risk text that stops a scored-down pass from
 *       being logged as a clean one.
 *
 * WHAT IT DOES NOT PROVE
 *   That the layers asked the right questions, or that a PASS means anything.
 *   It only guarantees the bookkeeping is honest.
 */

import { SAFETY } from '../config.js';
import { describeValue } from '../rpc/rpc-validate.js';
import { LAYER_ORDER, LAYER_SPECS } from './gate-layers.js';
import { OUTCOME, combine, errored, verdict } from './verdict.js';

/** Pseudo-layer name for a failure of the gate itself (bad mint, bad deps). */
export const GATE_LAYER = 'gate';

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate and re-create a layer's return value as a frozen verdict.
 * Anything that is not a well-formed verdict THROWS, and the orchestrator turns
 * that into `errored()` -- fail closed, because a layer that returns junk has
 * established nothing at all.
 *
 * @param {unknown} value whatever the layer returned
 * @param {{id: string, name: string}} spec the layer's registry entry
 * @param {number} measuredMs wall time, used only when the layer reported none
 * @returns {object} frozen verdict
 */
export function normaliseVerdict(value, spec, measuredMs) {
  if (!isPlainObject(value)) {
    throw new TypeError(
      `${spec.name} returned ${describeValue(value)} instead of a verdict: ` +
        'a layer must return pass()/reject()/errored() from src/safety/verdict.js',
    );
  }
  if (typeof value.outcome !== 'string' || !Object.hasOwn(OUTCOME, value.outcome)) {
    throw new TypeError(
      `${spec.name} returned an unknown outcome ${describeValue(value.outcome)} ` +
        `(expected one of ${Object.keys(OUTCOME).join(', ')})`,
    );
  }
  if (typeof value.layer !== 'string' || value.layer.length === 0) {
    throw new TypeError(`${spec.name} returned a verdict with no layer name`);
  }
  const reasons = value.reasons ?? [];
  if (!Array.isArray(reasons)) {
    throw new TypeError(
      `${spec.name} verdict.reasons must be an array, got ${describeValue(reasons)}`,
    );
  }
  const facts = value.facts ?? {};
  if (!isPlainObject(facts)) {
    throw new TypeError(`${spec.name} verdict.facts must be an object, got ${describeValue(facts)}`);
  }
  return verdict({
    layer: value.layer,
    outcome: value.outcome,
    reasons,
    facts,
    ms: Number.isFinite(value.ms) ? value.ms : measuredMs,
  });
}

/**
 * Everything a layer that RAN left unproven, in the layer's own words.
 *
 * `facts.unverified` is layer 2's and layer 4's convention for "passed, but this
 * could not be established"; both module headers require the orchestrator to
 * surface it, so a scored-down pass never reads as a clean one.
 *
 * @param {object} v a verdict
 * @returns {readonly string[]}
 */
export function residualRisksOf(v) {
  const facts = isPlainObject(v.facts) ? v.facts : {};
  const out = [];
  if (typeof facts.residualRisk === 'string' && facts.residualRisk.trim() !== '') {
    out.push(facts.residualRisk);
  }
  const unverified = Array.isArray(facts.unverified) ? facts.unverified : [];
  for (const item of unverified) {
    if (typeof item === 'string' && item.trim() !== '') {
      out.push(`${v.layer}: could not verify ${item}`);
    }
  }
  return Object.freeze(out);
}

/** First-seen order, duplicates dropped: the same risk twice is noise. */
function dedupe(list) {
  return Object.freeze([...new Set(list.filter((s) => typeof s === 'string' && s.trim() !== ''))]);
}

/**
 * Assemble the frozen GateResult.
 * @param {object} p
 * @param {object} p.combined output of `combine(verdicts, failClosed)`
 * @param {string} p.mint
 * @param {readonly string[]} p.order layer IDS this run was asked to cover
 * @param {readonly string[]} p.skipped layer names that NEVER RAN
 * @param {readonly string[]} p.residualRisks
 * @param {number} p.startedAtMs
 * @param {number} p.finishedAtMs
 */
export function freezeResult({
  combined,
  mint,
  order,
  skipped,
  residualRisks,
  startedAtMs,
  finishedAtMs,
}) {
  return Object.freeze({
    ...combined,
    mint,
    /**
     * Which layers this result covers. A `recheckGate` result covers only
     * RECHECK_LAYERS, so `buyable` from it must never be read as a full gate pass.
     */
    order: Object.freeze([...order]),
    skipped: Object.freeze([...skipped]),
    residualRisks: dedupe(residualRisks),
    startedAtMs,
    finishedAtMs,
    /** Wall time. `totalMs` (from combine) is the sum of the layers' own timings. */
    elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
  });
}

/**
 * The gate could not even start (invalid mint, invalid deps). One
 * `errored('gate', ...)` verdict, and every layer reported as never run, so
 * `buyable` is false and nothing whatsoever looks proven.
 *
 * @param {object} p
 * @param {unknown} p.mint
 * @param {unknown} p.err
 * @param {readonly string[]} [p.order] validated order, when validation got that far
 * @param {number} p.startedAtMs
 * @param {number} p.finishedAtMs
 */
export function preflightFailure({ mint, err, order, startedAtMs, finishedAtMs }) {
  const ids =
    Array.isArray(order) && order.every((id) => Object.hasOwn(LAYER_SPECS, id))
      ? order
      : LAYER_ORDER;
  const label = typeof mint === 'string' ? mint : describeValue(mint);
  const gateVerdict = errored(
    GATE_LAYER,
    err,
    Object.freeze({
      mint: label,
      stage: 'preflight',
      /** Nothing was fetched: the failure happened before any network call. */
      fetchersCalled: false,
      ran: false,
    }),
    Math.max(0, finishedAtMs - startedAtMs),
  );
  return freezeResult({
    combined: combine([gateVerdict], SAFETY.failClosed),
    mint: label,
    order: ids,
    skipped: ids.map((id) => LAYER_SPECS[id].name),
    residualRisks: ids.map((id) => LAYER_SPECS[id].unproven),
    startedAtMs,
    finishedAtMs,
  });
}
