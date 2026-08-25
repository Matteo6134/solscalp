/**
 * Layer 3 -- holder and insider-cluster concentration.
 *
 * WHAT A PASS FROM THIS LAYER PROVES
 * ----------------------------------
 * Of the holders the node actually returned, and after removing the pool's own
 * vaults and the burn address, no single VISIBLE wallet clears
 * SAFETY.layer3.maxSingleHolderPct, the visible top-10 does not clear
 * maxTop10HolderPct, and no insider cluster RugCheck could see clears
 * maxInsiderClusterPct. In one sentence: no single visible wallet or visible
 * cluster holds enough to nuke the price on its own.
 *
 * WHAT IT DOES *NOT* PROVE (read this before trusting a PASS)
 * ----------------------------------------------------------
 *  - NOT that one entity is not simply spread across many unlinkable wallets.
 *    Splitting a 40% position over 40 wallets funded through fresh hops costs a
 *    few cents and defeats every number computed here.
 *  - NOT dispersion. getTokenLargestAccounts returns at most ~20 token ACCOUNTS,
 *    and one person holding through 30 accounts looks like 30 holders. Every
 *    percentage here is a FLOOR on concentration, never a ceiling.
 *  - NOT anything about a SOFT RUG. A dev quietly selling into buyers breaks no
 *    rule and moves no threshold; only holder-flow monitoring over time catches
 *    that, and this layer is a single snapshot.
 *  - NOT that the exclusion set was complete. src/rpc/holders.js leaves
 *    `holder.owner === null` unless owner resolution was paid for, so a vault
 *    matchable only by its OWNER stays in the maths. That direction is safe --
 *    it inflates measured concentration, i.e. a false REJECT, never a false
 *    PASS -- but it is recorded in `facts.unverified` so a reject caused by an
 *    unexcluded vault is never read as real concentration.
 *
 * FAIL CLOSED. Unknown supply, unreadable holders, mixed units, an unavailable
 * insider graph or an all-excluded holder list are ERROR / REJECT, never a zero.
 * `Date.now()` appears only to measure wall time; no decision reads a clock.
 */

import { KNOWN, SAFETY } from '../config.js';
import {
  TOP_N_HOLDERS,
  buildExclusionSet,
  computeConcentration,
  normaliseHolders,
  readSupply,
  resolveInsiderClusterPct,
} from './holderConcentration.js';
import {
  assertSameUnit,
  assertUsablePct,
  collectPoolAddresses,
  isPlainObject,
  optionalEvidence,
  readHoldersResponse,
} from './holderInputs.js';
import { errored, pass, reject } from './verdict.js';

export const LAYER = 'layer3-holders';

/** Digits used when a percentage is quoted in a human-readable reason string. */
const PCT_DIGITS = 2;

/** Honest, machine-readable statement of this layer's epistemic limits. */
export const CONCENTRATION_LIMITATION = Object.freeze({
  layer: LAYER,
  method: 'single-snapshot largest-accounts + RugCheck insider graph',
  proven: Object.freeze([
    'no single VISIBLE wallet holds more than SAFETY.layer3.maxSingleHolderPct of supply',
    'the VISIBLE top-10 (LP vaults and the burn address excluded) is under maxTop10HolderPct',
    'no insider cluster RugCheck could see is above maxInsiderClusterPct',
  ]),
  notProven: Object.freeze([
    'that one entity is not spread across many unlinkable wallets, which is cheap and common',
    'dispersion: getTokenLargestAccounts caps at ~20 token accounts, so every figure is a floor',
    'anything about a soft rug: a dev selling into buyers breaks no threshold measured here',
    'that the exclusion set was complete when holder owners were not resolved',
    'that the distribution is the same one block later; this is one snapshot',
  ]),
  residualRisk:
    'holder concentration is a FLOOR measured from at most ~20 visible token accounts at one ' +
    'instant: a sybil-split whale and a soft rug both pass this layer untouched',
});

/** @param {number} value */
const fmtPct = (value) => `${value.toFixed(PCT_DIGITS)}%`;

/**
 * Layer 3: holder and insider-cluster concentration.
 *
 * Never throws: every failure is an ERROR verdict, which the gate blocks on.
 *
 * Thresholds come from SAFETY.layer3 and are compared with `>`, so a value
 * EXACTLY at a limit passes -- the same direction layers 1 and 2 use.
 *
 * @param {string} mint
 * @param {Readonly<{ getHolders: () => Promise<object>,
 *   getInsiderGraph: () => Promise<object>,
 *   getPair?: () => Promise<object|null>,
 *   getTokenReport?: () => Promise<object|null> }>} ctx gate context
 * @returns {Promise<ReturnType<typeof pass>>} frozen verdict for 'layer3-holders'
 */
export async function checkHolders(mint, ctx) {
  const startedAt = Date.now();
  const cfg = SAFETY.layer3;
  const baseFacts = Object.freeze({
    mint: typeof mint === 'string' ? mint : String(mint),
    topN: TOP_N_HOLDERS,
    thresholds: Object.freeze({ ...cfg }),
    proves: CONCENTRATION_LIMITATION.proven,
    notProven: CONCENTRATION_LIMITATION.notProven,
    residualRisk: CONCENTRATION_LIMITATION.residualRisk,
  });

  try {
    if (typeof mint !== 'string' || mint.length === 0) {
      throw new TypeError(`checkHolders: mint must be a mint address, got ${String(mint)}`);
    }
    if (!isPlainObject(ctx)) {
      throw new TypeError(`checkHolders: ctx must be the gate context object, got ${typeof ctx}`);
    }
    if (typeof ctx.getHolders !== 'function') {
      throw new TypeError('checkHolders: ctx.getHolders must be a function');
    }
    if (typeof ctx.getInsiderGraph !== 'function') {
      // Unknown insider concentration is an ERROR by design; it is never a zero.
      throw new TypeError(
        'checkHolders: ctx.getInsiderGraph must be a function -- unknown insider ' +
          'concentration cannot be treated as zero',
      );
    }

    /** @type {string[]} */
    const gaps = [];
    /** @type {string[]} */
    const unverified = [];

    // Pair and report feed the exclusion set only. Losing them can only INFLATE
    // measured concentration, so they are recorded as gaps, not as failures.
    const pair = await optionalEvidence(ctx.getPair, 'ctx.getPair()', gaps);
    const report = await optionalEvidence(ctx.getTokenReport, 'ctx.getTokenReport()', gaps);

    const poolAddresses = collectPoolAddresses(pair, report);
    const exclusion = buildExclusionSet({ poolAddresses: poolAddresses.map((p) => p.address) });

    const { list, supply: supplyInput, declaredField } = readHoldersResponse(await ctx.getHolders());
    const { holders, amountField } = normaliseHolders(list);
    assertSameUnit({ declared: declaredField, read: amountField, supply: supplyInput });
    const supply = readSupply(supplyInput, amountField);

    const concentration = computeConcentration({ holders, supply, exclusion });

    // Insider graph: a null/unavailable graph makes resolveInsiderClusterPct throw,
    // which becomes errored() below. That is the designed behaviour -- never a 0.
    const insiderGraph = await ctx.getInsiderGraph();
    const insiderClusterPct = assertUsablePct(
      resolveInsiderClusterPct(insiderGraph, { concentration, exclusion }),
      'insider cluster share of supply',
    );

    const unresolvedOwners = holders.filter((h) => h.owner === null).length;
    const knownVaults = poolAddresses.filter((p) => p.address !== KNOWN.INCINERATOR);
    if (unresolvedOwners > 0) unverified.push('holderOwners');
    if (knownVaults.length === 0) unverified.push('poolAddresses');
    if (pair === null) unverified.push('pair');
    if (report === null) unverified.push('rugcheckMarkets');

    const reasons = [];

    // --- 0. nothing left to measure: unknown, not clean ---
    if (concentration.consideredCount === 0) {
      reasons.push(
        `every one of ${concentration.holderCount} returned holders was excluded as a pool ` +
          'vault or burn address: real holder concentration is UNKNOWN, not zero',
      );
    }

    // --- 1. single whale ---
    if (concentration.singleLargestPct > cfg.maxSingleHolderPct) {
      const top = concentration.top[0];
      reasons.push(
        `largest visible holder ${top?.address ?? 'unknown'} holds ` +
          `${fmtPct(concentration.singleLargestPct)} of supply, above the ` +
          `${cfg.maxSingleHolderPct}% limit: one wallet can nuke the price alone`,
      );
    }

    // --- 2. top-10 aggregate ---
    if (concentration.topNPct > cfg.maxTop10HolderPct) {
      reasons.push(
        `top ${concentration.topN} visible holders hold ${fmtPct(concentration.topNPct)} of ` +
          `supply, above the ${cfg.maxTop10HolderPct}% limit (${concentration.excluded.length} ` +
          'pool/burn addresses already excluded)',
      );
    }

    // --- 3. insider cluster ---
    if (insiderClusterPct > cfg.maxInsiderClusterPct) {
      reasons.push(
        `largest insider cluster holds ${fmtPct(insiderClusterPct)} of supply, above the ` +
          `${cfg.maxInsiderClusterPct}% limit: wallets funded from a common source are a ` +
          'bundled launch posing as demand',
      );
    }

    // A reject measured with an incomplete exclusion set may be an artefact of an
    // unexcluded vault rather than real concentration. Said out loud, not buried.
    if (reasons.length > 0 && unverified.length > 0) {
      reasons.push(
        `NOTE: measured with an incomplete exclusion set (${unverified.join(', ')}); an ` +
          'unexcluded LP vault can look exactly like real concentration',
      );
    }

    const facts = Object.freeze({
      ...baseFacts,
      supply: concentration.supply,
      amountField,
      holderCount: concentration.holderCount,
      consideredCount: concentration.consideredCount,
      unresolvedOwnerCount: unresolvedOwners,
      /** Exact, unrounded: this is recorded evidence. Rounding lives in the reasons. */
      singleLargestPct: concentration.singleLargestPct,
      topNPct: concentration.topNPct,
      insiderClusterPct,
      top: concentration.top,
      /** Per-holder exclusions WITH the reason each one was not counted. */
      excluded: concentration.excluded,
      exclusion: Object.freeze({
        addresses: exclusion.addresses,
        size: exclusion.size,
        /** address -> why layer 3 collected it. Auditable, not a boolean. */
        sources: poolAddresses,
      }),
      insiderGraph: Object.freeze({
        networkCount: Array.isArray(insiderGraph)
          ? insiderGraph.length
          : isPlainObject(insiderGraph) && Array.isArray(insiderGraph.networks)
            ? insiderGraph.networks.length
            : null,
        /** What the graph itself claimed, before we recomputed from balances. */
        largestClusterPctReported:
          isPlainObject(insiderGraph) && typeof insiderGraph.largestClusterPct === 'number'
            ? insiderGraph.largestClusterPct
            : null,
      }),
      /** What could not be established. Mirrors layer 2's convention exactly. */
      unverified: Object.freeze([...unverified]),
      evidenceGaps: Object.freeze([...gaps]),
      scoreDown: unverified.length > 0,
    });

    const ms = Date.now() - startedAt;
    return reasons.length > 0 ? reject(LAYER, reasons, facts, ms) : pass(LAYER, facts, ms);
  } catch (err) {
    // FAIL CLOSED: unmeasurable concentration is not measured-and-fine.
    return errored(LAYER, err, baseFacts, Date.now() - startedAt);
  }
}
