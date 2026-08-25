/**
 * The safety gate orchestrator.
 *
 * WHAT A `buyable: true` RESULT PROVES
 *   Every layer in the requested order RAN TO COMPLETION inside its budget and
 *   returned PASS, and `complete === true` says no layer errored. Nothing else.
 *
 * WHAT IT DOES NOT PROVE
 *   That the token is a good trade -- passing the gate means "probably not
 *   stolen from you", not "profitable". And it never claims more than the layers
 *   established: `skipped` names the layers that NEVER RAN, `residualRisks`
 *   names what the run left unproven (each layer's own `facts.residualRisk`,
 *   every entry of its `facts.unverified`, and the registry's `unproven` text
 *   for a layer that never ran). A skipped layer is reported as skipped, never
 *   as a pass -- conflating the two is the exact inversion this project exists
 *   to prevent, and it would poison the forward-test dataset at the source.
 *
 * THREE FAILURE MODES, KEPT DISTINCT ON PURPOSE
 *   1. REJECT           a layer proved something disqualifying. The gate is
 *                       DECIDED: later layers are `skipped`, and never paid for.
 *   2. ERROR            a layer threw, returned nonsense, or blew its per-layer
 *                       timeout. Under SAFETY.failClosed that blocks the buy and
 *                       decides the gate, so later layers are `skipped` too.
 *                       A timeout is NEVER a pass.
 *   3. BUDGET EXHAUSTED the whole-gate budget ran out with nothing decided. The
 *                       remaining layers are `errored()` and NOT `skipped`: the
 *                       result is INCOMPLETE (`complete: false`) rather than
 *                       decided, which is a different fact about the token and
 *                       must never be recorded as if the gate had ruled.
 *
 * No keypair, no signing, no transaction: this module only ever reads.
 */

import { SAFETY } from '../config.js';
import { describeValue, requireAddress } from '../rpc/rpc-validate.js';
import { createGateContext, normaliseLogger } from './gate-context.js';
import { LAYER_ORDER, LAYER_SPECS, lazyLayer, normaliseOrder } from './gate-layers.js';
import {
  GATE_LAYER,
  freezeResult,
  normaliseVerdict,
  preflightFailure,
  residualRisksOf,
} from './gate-result.js';
import { createBudget, isAbortError, isTimeoutError, timeoutError, withTimeout } from './gate-timeout.js';
import { OUTCOME, combine, errored } from './verdict.js';

export { GATE_LAYER };

/**
 * Layers re-run on an OPEN position. A held token can BECOME a honeypot: a
 * scheduled transfer fee activates, a hook appears, the only route out dies.
 * Layers 0+1 are the two that would notice, and the two cheap enough to run
 * every SAFETY.recheckOpenPositionsSeconds.
 */
export const RECHECK_LAYERS = Object.freeze(['layer0', 'layer1']);

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @typedef {object} GateResult
 * @property {string} mint
 * @property {boolean} buyable        true only if every layer ran and passed
 * @property {boolean} complete       false if any layer errored (all-ERROR is never buyable)
 * @property {readonly string[]} rejectedBy    verdict layer names that rejected
 * @property {readonly string[]} erroredIn     verdict layer names that errored
 * @property {readonly string[]} reasons       reject + error reasons, in order
 * @property {readonly object[]} layers        the verdicts, in execution order
 * @property {readonly string[]} order         layer IDS this result covers
 * @property {readonly string[]} skipped       layer NAMES that never ran (not passes)
 * @property {readonly string[]} residualRisks what the run did not establish
 * @property {number} startedAtMs
 * @property {number} finishedAtMs
 * @property {number} elapsedMs      wall time of the whole gate
 * @property {number} totalMs        sum of the layers' own self-reported ms
 */

/**
 * Run the full safety gate for one mint.
 *
 * Never throws: a usage error (bad mint, bad `deps.order`, a non-function layer
 * override) becomes a single `errored('gate', ...)` verdict, because a gate that
 * throws is a gate whose caller might read the exception as "no problem found".
 *
 * @param {string} mint base58 mint address, 32-44 chars
 * @param {object} [deps] seams, all optional:
 *   `layers` (layer id -> LayerFn override), `order` (layer ids), `importer`
 *   (module loader for lazily imported layers), `signal` (caller cancellation),
 *   `now` (clock), `logger`, `rpc` (one RpcClient shared by every fetcher), and
 *   any fetcher override accepted by `resolveFetchers` in ./gate-context.js
 *   (`getPair`/`getBestPair`, `getMintFacts`/`fetchMintFacts`, ...).
 * @returns {Promise<Readonly<GateResult>>} frozen
 */
export async function runGate(mint, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const budget = createBudget(SAFETY.totalGateTimeoutMs, now);
  const startedAtMs = budget.startedAt;
  const logger = normaliseLogger(deps.logger);

  /** @type {readonly string[]} */
  let order = LAYER_ORDER;
  /** @type {{forSignal: (signal?: AbortSignal) => object}} */
  let context;
  try {
    order = normaliseOrder(deps.order);
    assertLayerOverrides(deps.layers);
    assertImporter(deps.importer);
    // Validate the address BEFORE anything is fetched: a malformed mint must
    // cost zero requests and must never be forwarded to a provider.
    requireAddress(mint, 'runGate(mint)');
    // Constructing the context resolves (and type-checks) the fetchers. Nothing
    // is called here: every fetcher is lazy and memoised for the whole run.
    context = createGateContext({ mint, remainingMs: budget.remainingMs, deps, logger });
  } catch (err) {
    logger.warn(`gate: refusing to run for ${describeValue(mint)}: ${err?.message ?? err}`);
    return preflightFailure({ mint, err, order, startedAtMs, finishedAtMs: now() });
  }

  const verdicts = [];
  const skipped = [];
  const residualRisks = [];
  /** Set by the first REJECT (or, under failClosed, the first ERROR). */
  let decidedBy = null;

  for (const id of order) {
    const spec = LAYER_SPECS[id];

    // --- already decided: never run, never paid for, never called a pass ---
    if (decidedBy !== null) {
      skipped.push(spec.name);
      residualRisks.push(spec.unproven);
      continue;
    }

    // --- whole-gate budget gone: errored, NOT skipped (incomplete, not decided) ---
    const remainingMs = budget.remainingMs();
    if (remainingMs <= 0) {
      verdicts.push(budgetExhaustedVerdict(spec, budget));
      residualRisks.push(spec.unproven);
      continue;
    }

    const layerVerdict = await runLayer({
      spec,
      mint,
      context,
      layerFn: resolveLayerFn(spec, deps),
      // A layer may never outlive the gate: whichever budget is smaller wins.
      timeoutMs: Math.min(SAFETY.perLayerTimeoutMs, remainingMs),
      parentSignal: deps.signal,
      logger,
      now,
    });

    verdicts.push(layerVerdict);
    residualRisks.push(...residualRisksOf(layerVerdict));

    if (layerVerdict.outcome === OUTCOME.REJECT) {
      decidedBy = layerVerdict.layer;
      logger.info(`gate: ${mint} rejected by ${layerVerdict.layer}`);
    } else if (layerVerdict.outcome === OUTCOME.ERROR && SAFETY.failClosed) {
      // Fail closed: an unanswerable question decides the gate exactly like a
      // reject, and the layers after it are honestly reported as never run.
      decidedBy = layerVerdict.layer;
      logger.warn(`gate: ${mint} blocked by an ERROR in ${layerVerdict.layer} (failClosed)`);
    } else if (layerVerdict.outcome !== OUTCOME.PASS) {
      // ERROR with failClosed off: it did not decide the gate, but it proved
      // nothing either. Say so rather than let the silence read as a pass.
      residualRisks.push(spec.unproven);
    }
  }

  const finishedAtMs = now();
  return freezeResult({
    combined: combine(verdicts, SAFETY.failClosed),
    mint,
    order,
    skipped,
    residualRisks,
    startedAtMs,
    finishedAtMs,
  });
}

/**
 * Re-check an OPEN position: layers 0+1 only.
 *
 * Same machinery and the same fail-closed rules, so an ERROR here blocks exactly
 * as it does at entry -- which, for a held position, means exit.
 *
 * The result covers ONLY `RECHECK_LAYERS` (see `result.order`): layers 2-5 were
 * never requested, so a `buyable: true` recheck says "still mintable-safe and
 * still sellable", never "the full gate passed again".
 *
 * @param {string} mint
 * @param {object} [deps] as `runGate`; `deps.order` is overridden on purpose
 * @returns {Promise<Readonly<GateResult>>}
 */
export async function recheckGate(mint, deps = {}) {
  return runGate(mint, { ...deps, order: RECHECK_LAYERS });
}

/* -------------------------------------------------------------------------- */
/* one layer                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run one layer under a hard deadline and turn ANY failure into a verdict.
 * @returns {Promise<object>} a frozen verdict; never throws
 */
async function runLayer({ spec, mint, context, layerFn, timeoutMs, parentSignal, logger, now }) {
  const startedAt = now();
  try {
    const raw = await withTimeout((signal) => layerFn(mint, context.forSignal(signal)), {
      timeoutMs,
      parentSignal,
      label: spec.name,
      // A rejection that lost the race is still a real failure: log it rather
      // than let Node report it as an unhandled rejection.
      onLateError: (err) =>
        logger.warn(`gate: ${spec.name} failed after its deadline: ${err?.message ?? err}`),
    });
    return normaliseVerdict(raw, spec, Math.max(0, now() - startedAt));
  } catch (err) {
    const timedOut = isTimeoutError(err);
    const aborted = isAbortError(err);
    if (timedOut || aborted) {
      logger.warn(`gate: ${spec.name} produced no verdict (${aborted ? 'aborted' : 'timed out'})`);
    }
    return errored(
      spec.name,
      err,
      Object.freeze({
        layerId: spec.id,
        ran: true,
        timedOut,
        aborted,
        timeoutMs,
        /** A timeout is an ERROR, never a PASS: nothing here was established. */
        unproven: spec.unproven,
      }),
      Math.max(0, now() - startedAt),
    );
  }
}

/** The whole-gate budget ran out before this layer could start. */
function budgetExhaustedVerdict(spec, budget) {
  return errored(
    spec.name,
    timeoutError(
      `whole-gate budget of ${SAFETY.totalGateTimeoutMs}ms was exhausted before ` +
        `${spec.name} could run: the gate is INCOMPLETE, not decided`,
    ),
    Object.freeze({
      layerId: spec.id,
      /** Distinguishes "never started" from "started and timed out". */
      ran: false,
      timedOut: true,
      gateBudgetExhausted: true,
      elapsedMs: budget.elapsedMs(),
      unproven: spec.unproven,
    }),
    0,
  );
}

/* -------------------------------------------------------------------------- */
/* wiring                                                                     */
/* -------------------------------------------------------------------------- */

/** @returns {import('./gate-layers.js').LayerFn} */
function resolveLayerFn(spec, deps) {
  const override = isPlainObject(deps.layers) ? deps.layers[spec.id] : undefined;
  return typeof override === 'function' ? override : lazyLayer(spec, deps.importer);
}

function assertLayerOverrides(layers) {
  if (layers === undefined || layers === null) return;
  if (!isPlainObject(layers)) {
    throw new TypeError(
      `deps.layers must be an object of layer overrides, got ${describeValue(layers)}`,
    );
  }
  for (const [id, fn] of Object.entries(layers)) {
    if (!Object.hasOwn(LAYER_SPECS, id)) {
      throw new TypeError(
        `deps.layers has an unknown layer id "${id}" (known: ${LAYER_ORDER.join(', ')})`,
      );
    }
    if (typeof fn !== 'function') {
      throw new TypeError(`deps.layers.${id} must be a function, got ${describeValue(fn)}`);
    }
  }
}

function assertImporter(importer) {
  if (importer !== undefined && typeof importer !== 'function') {
    throw new TypeError(`deps.importer must be a function, got ${describeValue(importer)}`);
  }
}
