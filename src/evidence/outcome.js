/**
 * Deciding what actually happened to a recorded token. PURE -- no network, no clock.
 *
 * WHAT THIS PROVES
 *   Whether a token's pool collapsed between when it was recorded and now,
 *   measured against the thresholds in LABELS. The raw before/after figures come
 *   back with the label, so a future change to those thresholds can relabel the
 *   whole dataset without re-collecting a single snapshot.
 *
 * WHAT IT DOES NOT PROVE
 *   WHY it collapsed. A liquidity pull, a slow bleed, a dev distributing into
 *   buyers and a token nobody wanted all look identical from the outside, and
 *   this returns `rugged` for the pool outcome, not a claim about intent. In
 *   particular a SOFT RUG -- the pattern the design record puts at 93% of
 *   Raydium pools -- produces the same reading as ordinary market failure. The
 *   label answers "did holders lose their money", not "was it a crime".
 *
 * UNKNOWN IS A LABEL, AND IT IS THE DEFAULT
 *   Every path that cannot measure the outcome returns UNKNOWN rather than
 *   guessing. That is the same fail-closed instinct as the gate, pointed at the
 *   dataset instead: a wrong `survived` inflates the filter's apparent skill,
 *   which is precisely the self-deception this project is built to avoid. An
 *   unlabelled token costs sample size; a wrongly-labelled one costs the truth.
 */

import { LABELS } from '../config.js';

const MS_PER_HOUR = 3_600_000;
const PCT = 100;

/** The label vocabulary. `backtest-rug-filter.js` counts `rugged` against these. */
export const LABEL = Object.freeze({
  RUGGED: 'rugged',
  SURVIVED: 'survived',
  /** Not old enough to judge yet. Ask again later. */
  TOO_EARLY: 'too-early',
  /** We could not measure it. Never counted as either outcome. */
  UNKNOWN: 'unknown',
});

/** @returns {number|null} finite number or null. Unknown stays unknown. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const dropPct = (before, after) =>
  before === null || after === null || before <= 0 ? null : ((before - after) / before) * PCT;

/**
 * Decide what happened to one recorded candidate.
 *
 * @param {object} p
 * @param {number} p.recordedTs        epoch ms when the snapshot was taken
 * @param {number|null} p.recordedLiquidityUsd
 * @param {number|null} p.recordedPriceUsd
 * @param {object|null} p.current      the pair as it looks NOW, or null if none exists
 * @param {number} p.now               epoch ms
 * @param {boolean} p.apiHealthy       did the data source answer for OTHER mints in
 *   this batch? A missing pair only means "the pool is gone" when the API is
 *   demonstrably working; otherwise it means "we could not look", which is UNKNOWN.
 * @param {object} [p.thresholds]      defaults to LABELS
 * @returns {Readonly<{label: string, reasons: readonly string[], evidence: object}>}
 */
export function decideOutcome({
  recordedTs,
  recordedLiquidityUsd,
  recordedPriceUsd,
  current,
  now,
  apiHealthy,
  thresholds = LABELS,
}) {
  const ageHours = (now - recordedTs) / MS_PER_HOUR;
  const before = num(recordedLiquidityUsd);
  const priceBefore = num(recordedPriceUsd);
  const after = current === null || current === undefined ? null : num(current.liquidityUsd);
  const priceAfter = current === null || current === undefined ? null : num(current.priceUsd);

  const evidence = Object.freeze({
    ageHours: Number(ageHours.toFixed(2)),
    liquidityBeforeUsd: before,
    liquidityAfterUsd: after,
    liquidityDropPct: (() => {
      const d = dropPct(before, after);
      return d === null ? null : Number(d.toFixed(2));
    })(),
    priceBeforeUsd: priceBefore,
    priceAfterUsd: priceAfter,
    priceDropPct: (() => {
      const d = dropPct(priceBefore, priceAfter);
      return d === null ? null : Number(d.toFixed(2));
    })(),
    pairStillExists: current !== null && current !== undefined,
    thresholds: Object.freeze({ ...thresholds }),
  });

  const out = (label, reasons) =>
    Object.freeze({ label, reasons: Object.freeze(reasons), evidence });

  if (!Number.isFinite(recordedTs)) {
    return out(LABEL.UNKNOWN, ['the snapshot has no usable timestamp']);
  }
  if (ageHours < thresholds.minAgeHoursBeforeLabelling) {
    return out(LABEL.TOO_EARLY, [
      `only ${ageHours.toFixed(1)}h old; ${thresholds.minAgeHoursBeforeLabelling}h required ` +
        'before an outcome means anything',
    ]);
  }

  // No pair now. Only conclusive when the source is demonstrably answering.
  if (!evidence.pairStillExists) {
    return apiHealthy
      ? out(LABEL.RUGGED, ['no pair exists any more: the pool is gone'])
      : out(LABEL.UNKNOWN, [
          'no pair returned, but the data source was not answering for other mints ' +
            'either -- refusing to read an outage as a dead pool',
        ]);
  }

  // The pair exists but we cannot read its depth: that is unmeasured, not alive.
  if (after === null) {
    return out(LABEL.UNKNOWN, ['the pair exists but reports no liquidity figure']);
  }

  const reasons = [];
  if (after <= thresholds.ruggedBelowLiquidityUsd) {
    reasons.push(
      `liquidity ${after.toFixed(0)} USD is at or below the ${thresholds.ruggedBelowLiquidityUsd} ` +
        'USD floor: a dead pool',
    );
  }
  if (evidence.liquidityDropPct !== null && evidence.liquidityDropPct >= thresholds.ruggedLiquidityDropPct) {
    reasons.push(
      `liquidity fell ${evidence.liquidityDropPct.toFixed(1)}% from ${before.toFixed(0)} USD, ` +
        `at or past the ${thresholds.ruggedLiquidityDropPct}% collapse threshold`,
    );
  }
  if (evidence.priceDropPct !== null && evidence.priceDropPct >= thresholds.ruggedPriceDropPct) {
    reasons.push(
      `price fell ${evidence.priceDropPct.toFixed(1)}%, at or past the ` +
        `${thresholds.ruggedPriceDropPct}% threshold: the pool can outlive the token`,
    );
  }

  if (reasons.length > 0) return out(LABEL.RUGGED, reasons);

  // Survived is only claimable when we actually measured something.
  if (before === null && priceBefore === null) {
    return out(LABEL.UNKNOWN, [
      'nothing was recorded to compare against, so no change can be measured',
    ]);
  }
  return out(LABEL.SURVIVED, [
    `still trading with ${after.toFixed(0)} USD liquidity after ${ageHours.toFixed(1)}h`,
  ]);
}

/**
 * Should this mint be (re)labelled on this pass?
 *
 * Labels are APPENDED, never overwritten -- the recording is append-only -- so
 * without a cooldown every run would add another line for every mint.
 * @param {object} p
 * @param {number|null} p.lastLabelledTs epoch ms of the most recent label, or null
 * @param {string|null} p.lastLabel      what it said last time
 * @param {number} p.now
 * @param {object} [p.thresholds]
 * @returns {boolean}
 */
export function shouldRelabel({ lastLabelledTs, lastLabel, now, thresholds = LABELS }) {
  if (lastLabelledTs === null || lastLabelledTs === undefined) return true;
  // `rugged` is terminal: a dead pool does not come back, so stop paying to look.
  if (lastLabel === LABEL.RUGGED) return false;
  return now - lastLabelledTs >= thresholds.relabelAfterHours * MS_PER_HOUR;
}
