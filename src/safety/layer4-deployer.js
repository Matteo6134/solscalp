/**
 * Layer 4 -- deployer reputation from prior mints.
 *
 * WHAT A PASS HERE PROVES -- almost nothing, stated plainly
 * --------------------------------------------------------
 * A PASS means only this: for the wallet that PAID for this mint's creation, no
 * prior rug RATE above SAFETY.layer4.maxDeployerPriorRugRate was reported inside
 * the lookback window. That is a weak statement on purpose, because:
 *
 *   - **A rugger simply uses a fresh address.** Creating a new keypair is free and
 *     instant, so the modal serial scammer has an empty history by construction. A
 *     clean deployer record is therefore consistent with a first-time launcher, a
 *     careful scammer and an honest project alike -- it does not distinguish them.
 *   - Funding a mint is not the same as creating it: a wallet can bankroll a launch
 *     without ever being the fee payer we inspect.
 *   - `mintCount` from `fetchDeployerHistory` is a FLOOR, not a census (public RPC
 *     prunes history and the walk is page/inspection capped).
 *   - `priorRugRate` is a third party's number over a third party's window. We never
 *     divide someone else's rug count by our own mint count.
 *
 * So this layer is a SCORING SIGNAL with one veto: a deployer with a demonstrated
 * rug rate above the ceiling is rejected. Everything else it can honestly say is
 * said in `facts.unverified` / `facts.scoreDown`, exactly as layer 2 reports
 * unverifiable LP ownership.
 *
 * WHAT IS *NOT* DONE HERE
 * -----------------------
 * No network call, no clustering, no wallet-graph inference: the deployer comes
 * from `ctx.getCreator()` and its history from `ctx.getDeployerHistory(address)`,
 * both memoised by the orchestrator for the whole gate run.
 *
 * FAIL CLOSED. `priorRugRate === null` is UNKNOWN and is NEVER read as 0 -- zero
 * would assert "this deployer has never rugged", the most dangerous sentence in
 * this repo. Unknown is governed by config (`rejectUnknownDeployer`), never by
 * arithmetic. Anything thrown, malformed or timed out becomes errored(), which the
 * gate treats as a REJECT.
 */

import { SAFETY } from '../config.js';
import { isPlainObject, stringOrNull } from '../data/payload.js';
import { errored, pass, reject } from './verdict.js';

export const LAYER = 'layer4-deployer';

/** Fraction -> percent, for human-readable reasons only. Never a threshold. */
const PCT_MAX = 100;
/** `priorRugRate` is a FRACTION (rugged / created), so anything outside this is junk. */
const RATE_MIN = 0;
const RATE_MAX = 1;

/**
 * Honest, machine-readable statement of this layer's epistemic limits, so a PASS
 * can never be logged as "the deployer is trustworthy".
 */
export const DEPLOYER_LIMITATION = Object.freeze({
  layer: LAYER,
  method: 'fee-payer identity + reported prior rug rate',
  proven: Object.freeze([
    'no prior rug rate above the configured ceiling was reported for the wallet that ' +
      "paid this mint's creation fee",
  ]),
  notProven: Object.freeze([
    'that the deployer is not a serial rugger on a fresh address -- creating a new ' +
      'keypair is free, so an empty history is exactly what a scammer looks like',
    'that the wallet inspected is the entity behind the launch (a funder need never be ' +
      'the fee payer)',
    'that the reported mint count is complete: it is a floor, capped by RPC history ' +
      'pruning and by the walk / inspection budget',
    'anything at all when priorRugRate is null: that is UNKNOWN, not zero',
  ]),
  residualRisk:
    'a deployer using a fresh address is free to do so and it costs nothing, so a PASS ' +
    'here proves very little: it only says that no prior rug rate above the ceiling was ' +
    'found for the fee payer of this mint, not that the launcher has no history',
});

/**
 * The two unknowns that `rejectUnknownDeployer` governs. Informational gaps (a
 * truncated mint count) score the token down but never flip the verdict.
 */
const UNKNOWN_DEPLOYER =
  'deployer identity: the mint creator could not be established (public RPC prunes ' +
  'deep signature history), so no reputation was checked at all';
const UNKNOWN_RUG_RATE =
  'prior rug rate: UNKNOWN (null), which is NOT 0 -- no rate was reported for this ' +
  'wallet and none is derivable from chain history alone';

/** Stricter than `toNumberOrNull`: at this boundary a numeric string is a shape error. */
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** @returns {number|null} finite number, or null for an absent/null field. */
function nullableNumber(value, what) {
  if (value === null || value === undefined) return null;
  if (!isFiniteNumber(value) || value < 0) {
    throw new TypeError(
      `${what} must be null or a non-negative finite number, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Thresholds, with an override seam.
 *
 * `SAFETY.layer4` is frozen, so a caller (or a test) cannot flip
 * `rejectUnknownDeployer` by mutating config -- and must not try. Overrides arrive
 * either as the optional third argument or on `ctx.layer4`; the argument wins, then
 * ctx, then config. The orchestrator's `(mint, ctx)` call path is unaffected.
 */
function resolveThresholds(ctx, options) {
  const fromCtx = isPlainObject(ctx?.layer4) ? ctx.layer4 : {};
  const opts = isPlainObject(options) ? options : {};

  const maxDeployerPriorRugRate =
    opts.maxDeployerPriorRugRate ??
    fromCtx.maxDeployerPriorRugRate ??
    SAFETY.layer4.maxDeployerPriorRugRate;
  const rejectUnknownDeployer =
    opts.rejectUnknownDeployer ??
    fromCtx.rejectUnknownDeployer ??
    SAFETY.layer4.rejectUnknownDeployer;

  if (
    !isFiniteNumber(maxDeployerPriorRugRate) ||
    maxDeployerPriorRugRate < RATE_MIN ||
    maxDeployerPriorRugRate > RATE_MAX
  ) {
    throw new TypeError(
      `maxDeployerPriorRugRate must be a fraction in ${RATE_MIN}-${RATE_MAX}, ` +
        `got ${String(maxDeployerPriorRugRate)}`,
    );
  }
  if (typeof rejectUnknownDeployer !== 'boolean') {
    throw new TypeError(
      `rejectUnknownDeployer must be a boolean, got ${String(rejectUnknownDeployer)}`,
    );
  }

  return Object.freeze({
    maxDeployerPriorRugRate,
    rejectUnknownDeployer,
    deployerHistoryLookbackDays: SAFETY.layer4.deployerHistoryLookbackDays,
  });
}

/**
 * `fetchCreator` returns null when the creator is unknowable -- a VALUE, handled by
 * the unknown-deployer path. A non-null result with no usable address is a SHAPE
 * error and throws, because a malformed answer is not the same as "nobody knows".
 * @returns {{address: string|null, createdAtMs: number|null, signature: string|null}}
 */
function readCreator(record) {
  if (record === null || record === undefined) {
    return { address: null, createdAtMs: null, signature: null };
  }
  if (!isPlainObject(record)) {
    throw new TypeError(
      'ctx.getCreator() must resolve to an object or null, got ' +
        (Array.isArray(record) ? 'an array' : typeof record),
    );
  }
  const address = stringOrNull(record.creator);
  if (address === null) {
    throw new TypeError(
      `ctx.getCreator().creator must be a non-empty address string, got ${String(record.creator)}`,
    );
  }
  return {
    address,
    // createdAtMs may legitimately be null: the block time can be pruned while the
    // creator stays known (contract addendum 5).
    createdAtMs: nullableNumber(record.createdAtMs, 'ctx.getCreator().createdAtMs'),
    signature: stringOrNull(record.signature),
  };
}

/**
 * Validate the history at the boundary and pull out the decisive field.
 *
 * `priorRugRate` is decisive, so an ABSENT key -- or an explicit `undefined` --
 * throws: the fetcher contracts to always include it, and treating "missing" as
 * "unknown" would let a foreign shape take the softer branch. Only `null` is the
 * fetcher explicitly reporting UNKNOWN.
 * The informational counters are read leniently, because no decision reads them.
 */
function readHistory(history, deployer) {
  if (!isPlainObject(history)) {
    throw new TypeError(
      `ctx.getDeployerHistory(${deployer}) must resolve to an object, got ` +
        (Array.isArray(history) ? 'an array' : typeof history),
    );
  }
  if (!Object.hasOwn(history, 'priorRugRate')) {
    throw new TypeError(
      `ctx.getDeployerHistory(${deployer}) returned no priorRugRate field ` +
        `(keys: ${Object.keys(history).join(',') || 'none'}); unknown must be an ` +
        'explicit null, never an absent key',
    );
  }
  const raw = history.priorRugRate;
  if (raw === undefined) {
    throw new TypeError(
      `priorRugRate for ${deployer} is undefined; unknown must be an explicit null ` +
        '(undefined becomes NaN in arithmetic, which is how a rate check silently dies)',
    );
  }
  let priorRugRate = null;
  if (raw !== null) {
    if (!isFiniteNumber(raw) || raw < RATE_MIN || raw > RATE_MAX) {
      throw new TypeError(
        `priorRugRate for ${deployer} must be null or a fraction in ` +
          `${RATE_MIN}-${RATE_MAX}, got ${String(raw)}`,
      );
    }
    priorRugRate = raw;
  }

  return {
    priorRugRate,
    mintCount: nullableNumber(history.mintCount, 'deployerHistory.mintCount'),
    ruggedCount: nullableNumber(history.ruggedCount, 'deployerHistory.ruggedCount'),
    mintCountIsLowerBound: history.mintCountIsLowerBound === true,
    scannedTransactions: nullableNumber(
      history.scannedTransactions,
      'deployerHistory.scannedTransactions',
    ),
    knownMints: Object.freeze(
      Array.isArray(history.knownMints)
        ? history.knownMints.filter((m) => stringOrNull(m) !== null)
        : [],
    ),
    lookbackDays: nullableNumber(history.lookbackDays, 'deployerHistory.lookbackDays'),
    source: stringOrNull(history.source),
    /** Already shaped for this convention by fetchDeployerHistory. */
    unverified: Array.isArray(history.unverified)
      ? history.unverified.filter((u) => stringOrNull(u) !== null)
      : [],
  };
}

/** Merge without duplicating: our decisive entries first, the fetcher's after. */
function mergeUnverified(own, fromHistory) {
  return Object.freeze([...new Set([...own, ...fromHistory])]);
}

const unknownOr = (value) => (value === null ? 'unknown' : String(value));

/**
 * Layer 4: has the wallet that created this mint rugged before?
 *
 * Never throws. Unknown is never zero.
 *
 * @param {string} mint mint address (informational here: the decisive inputs are ctx's)
 * @param {Readonly<{ getCreator: () => Promise<object|null>,
 *   getDeployerHistory: (address: string, deps?: object) => Promise<object>,
 *   signal?: AbortSignal, layer4?: object }>} ctx gate context
 * @param {{ rejectUnknownDeployer?: boolean, maxDeployerPriorRugRate?: number }} [options]
 *   override seam for the frozen config values -- see resolveThresholds
 * @returns {Promise<ReturnType<typeof pass>>} frozen verdict for 'layer4-deployer'
 */
export async function checkDeployer(mint, ctx, options = {}) {
  const startedAt = Date.now();
  const mintLabel = stringOrNull(mint);
  const baseFacts = Object.freeze({
    mint: mintLabel,
    deployer: null,
    deployerKnown: false,
    priorRugRate: null,
    priorRugRateKnown: false,
    residualRisk: DEPLOYER_LIMITATION.residualRisk,
  });

  try {
    if (mintLabel === null) {
      throw new TypeError(`checkDeployer: mint must be a non-empty string, got ${String(mint)}`);
    }
    if (!isPlainObject(ctx)) {
      throw new TypeError(`checkDeployer: ctx must be an object, got ${typeof ctx}`);
    }
    if (typeof ctx.getCreator !== 'function') {
      throw new TypeError('checkDeployer: ctx.getCreator must be a function');
    }
    if (typeof ctx.getDeployerHistory !== 'function') {
      throw new TypeError('checkDeployer: ctx.getDeployerHistory must be a function');
    }
    const thresholds = resolveThresholds(ctx, options);

    const creator = readCreator(await ctx.getCreator());

    /** Build the frozen facts for whichever branch we end on. */
    const factsFor = ({ history, unverified }) =>
      Object.freeze({
        mint: mintLabel,
        deployer: creator.address,
        deployerKnown: creator.address !== null,
        createdAtMs: creator.createdAtMs,
        creationSignature: creator.signature,
        priorRugRate: history?.priorRugRate ?? null,
        /** Explicit, so `null` can never be read as a clean record. */
        priorRugRateKnown: (history?.priorRugRate ?? null) !== null,
        mintCount: history?.mintCount ?? null,
        ruggedCount: history?.ruggedCount ?? null,
        mintCountIsLowerBound: history === undefined ? null : history.mintCountIsLowerBound,
        scannedTransactions: history?.scannedTransactions ?? null,
        knownMints: history?.knownMints ?? Object.freeze([]),
        lookbackDays: history?.lookbackDays ?? thresholds.deployerHistoryLookbackDays,
        historySource: history?.source ?? null,
        unverified,
        /** True when something the orchestrator should score down went unverified. */
        scoreDown: unverified.length > 0,
        thresholds,
        residualRisk: DEPLOYER_LIMITATION.residualRisk,
        limitation: DEPLOYER_LIMITATION,
      });

    // --- unknown deployer: nothing was checked, so say so ---------------------
    if (creator.address === null) {
      const facts = factsFor({
        history: undefined,
        unverified: mergeUnverified([UNKNOWN_DEPLOYER, UNKNOWN_RUG_RATE], []),
      });
      const ms = Date.now() - startedAt;
      return thresholds.rejectUnknownDeployer
        ? reject(
            LAYER,
            [
              'deployer unknown and rejectUnknownDeployer is set: an unidentifiable ' +
                'creator cannot be checked against the prior-rug-rate ceiling',
            ],
            facts,
            ms,
          )
        : pass(LAYER, facts, ms);
    }

    // The walk can cost a signature page plus ~25 getParsedTransaction calls, which at
    // LIMITS.rpc.requestsPerSecond can outrun SAFETY.perLayerTimeoutMs, so this layer's
    // budget signal is handed down (addendum 10); a one-arg fetcher just ignores it.
    const history = readHistory(
      await ctx.getDeployerHistory(creator.address, { signal: ctx.signal }),
      creator.address,
    );

    const own = [];
    if (history.priorRugRate === null) own.push(UNKNOWN_RUG_RATE);
    const facts = factsFor({
      history,
      unverified: mergeUnverified(own, history.unverified),
    });
    const ms = Date.now() - startedAt;

    // --- the one veto: a DEMONSTRATED rate above the ceiling ------------------
    // Strict null check first: `null > 0.25` is false, so an unknown rate would
    // otherwise slip through this comparison and be reported as a clean deployer.
    if (
      history.priorRugRate !== null &&
      history.priorRugRate > thresholds.maxDeployerPriorRugRate
    ) {
      return reject(
        LAYER,
        [
          `deployer ${creator.address} has a prior rug rate of ` +
            `${(history.priorRugRate * PCT_MAX).toFixed(1)}% (${history.priorRugRate}), ` +
            `above the ceiling ${(thresholds.maxDeployerPriorRugRate * PCT_MAX).toFixed(1)}%: ` +
            `${unknownOr(history.ruggedCount)} rugged of ${unknownOr(history.mintCount)} ` +
            `known mints over ${unknownOr(history.lookbackDays)} days ` +
            `(source: ${history.source ?? 'none'})`,
        ],
        facts,
        ms,
      );
    }

    // --- unknown rate on a KNOWN deployer: scored down, or vetoed by config ---
    if (history.priorRugRate === null) {
      return thresholds.rejectUnknownDeployer
        ? reject(
            LAYER,
            [
              `deployer ${creator.address} has no known prior rug rate and ` +
                'rejectUnknownDeployer is set: null is UNKNOWN, not 0, so the ceiling ' +
                'could not be applied',
            ],
            facts,
            ms,
          )
        : pass(LAYER, facts, ms);
    }

    return pass(LAYER, facts, ms);
  } catch (err) {
    // FAIL CLOSED: an unreadable deployer history is not a clean deployer history.
    return errored(LAYER, err, baseFacts, Date.now() - startedAt);
  }
}
