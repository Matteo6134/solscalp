/**
 * Layer 5 -- third-party veto (RugCheck). VETO ONLY, NEVER PRIMARY EVIDENCE.
 *
 * WHAT THIS LAYER PROVES
 * ----------------------
 * Exactly one thing, and only in the negative direction: at the instant we asked,
 * a third-party scanner had NOT flagged this token as rugged and its own risk score
 * was at or below SAFETY.layer5.maxRugcheckScoreNormalised.
 *
 * WHAT A PASS DOES *NOT* PROVE -- read this before trusting one
 * ------------------------------------------------------------
 * **THIRD-PARTY SILENCE IS NOT EVIDENCE OF SAFETY.** A scanner reports what it has
 * already modelled; a scam launched minutes ago, or one using a pattern the scanner
 * does not encode, scores 0. A 0 therefore means "nothing seen", not "nothing
 * there". This layer may only ever REMOVE a token from the buyable set. It must
 * never be the reason a token is bought, and it must never be allowed to
 * compensate for a weaker earlier layer: layers 0-4 look at on-chain facts, this
 * one looks at somebody else's opinion of them.
 *
 * SCORE DIRECTION -- asserted here, and proved by a test
 * -----------------------------------------------------
 * `scoreNormalised` is 0-100 where **HIGHER = RISKIER** (see the header of
 * src/data/rugcheck.js). The veto is therefore `score > ceiling`. Inverting that
 * comparison to `score < ceiling` would silently turn this layer into an
 * "only buy scams" filter -- it would pass exactly the tokens RugCheck flagged and
 * reject the clean ones. tests/safety/layer5-thirdparty.test.js pins the direction
 * with a 0-passes / 100-rejects pair.
 *
 * FAIL CLOSED. A score outside the documented 0-100 range means the API changed
 * scale, so the configured ceiling no longer means what it was set to mean: that is
 * a REJECT, never a clamp. A thrown, timed-out or unparseable report is errored(),
 * which the gate treats as a REJECT.
 */

import { SAFETY } from '../config.js';
import { isPlainObject, stringOrNull } from '../data/payload.js';
import { errored, pass, reject } from './verdict.js';

export const LAYER = 'layer5-thirdparty';

/**
 * RugCheck's OWN documented scale for `score_normalised`, not a tunable threshold:
 * the only threshold this layer has lives in SAFETY.layer5. A value outside this
 * range means the field no longer measures what the ceiling was calibrated against.
 */
const DOCUMENTED_SCORE_MIN = 0;
const DOCUMENTED_SCORE_MAX = 100;

/**
 * Honest, machine-readable statement of this layer's epistemic limits. Attached to
 * every verdict as `facts.limitation`, with the sentence itself in
 * `facts.residualRisk`, so a PASS can never be logged as "a scanner cleared it".
 */
export const THIRD_PARTY_LIMITATION = Object.freeze({
  layer: LAYER,
  role: 'veto-only',
  method: 'rugcheck token report: score_normalised + rugged flag',
  scoreDirection: 'scoreNormalised is 0-100 and HIGHER = RISKIER',
  proven: Object.freeze([
    'at one instant, a third-party scanner had not flagged this token as rugged and ' +
      'scored it at or below the configured ceiling',
  ]),
  notProven: Object.freeze([
    'that the token is safe: a scanner reports only patterns it already models, so a ' +
      'fresh or novel scam scores 0',
    'anything positive at all -- third-party silence is not evidence of safety',
    'that the score will still be below the ceiling in a minute: it is a third ' +
      "party's opinion, not an on-chain fact",
    'anything the earlier layers failed to establish: this layer can only subtract ' +
      'from the buyable set, never add to it',
  ]),
  residualRisk:
    'THIRD-PARTY SILENCE IS NOT EVIDENCE OF SAFETY: this layer is a veto only. A pass ' +
    'means the scanner had nothing to say about this token, which is exactly what a ' +
    'brand-new or novel scam also looks like -- never treat it as positive evidence',
});

/**
 * Deliberately stricter than `toNumberOrNull`: at a safety boundary a numeric
 * string means the report was never normalised, which is a shape error rather than
 * a number we may compare against a threshold.
 */
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The ceiling, with an override seam.
 *
 * `SAFETY.layer5` is frozen, so a caller (or a test) cannot retune it by mutating
 * config -- and must not try. Overrides arrive either as the optional third
 * argument or on `ctx.layer5`; the argument wins, then ctx, then config. The
 * orchestrator's `(mint, ctx)` call path is unaffected.
 */
function resolveMaxScore(ctx, options) {
  const fromCtx = isPlainObject(ctx?.layer5) ? ctx.layer5 : {};
  const opts = isPlainObject(options) ? options : {};
  const maxScore =
    opts.maxRugcheckScoreNormalised ??
    fromCtx.maxRugcheckScoreNormalised ??
    SAFETY.layer5.maxRugcheckScoreNormalised;

  if (
    !isFiniteNumber(maxScore) ||
    maxScore < DOCUMENTED_SCORE_MIN ||
    maxScore > DOCUMENTED_SCORE_MAX
  ) {
    throw new TypeError(
      `maxRugcheckScoreNormalised must be a number in ` +
        `${DOCUMENTED_SCORE_MIN}-${DOCUMENTED_SCORE_MAX}, got ${String(maxScore)}`,
    );
  }
  return maxScore;
}

/**
 * Individual risks, surfaced for the log. `null` (not `[]`) when the report carried
 * no risks array at all: "we were not told" is not "there are none".
 * @returns {readonly object[]|null}
 */
function readRisks(report) {
  if (!Array.isArray(report.risks)) return null;
  return Object.freeze(
    report.risks.filter(isPlainObject).map((r) =>
      Object.freeze({
        name: stringOrNull(r.name) ?? 'unnamed-risk',
        level: stringOrNull(r.level),
        score: isFiniteNumber(r.score) ? r.score : null,
        value: stringOrNull(r.value),
        description: stringOrNull(r.description),
      }),
    ),
  );
}

/**
 * Validate the report at the boundary. The two decisive fields must be readable:
 * an absent or non-numeric `scoreNormalised` and a non-boolean `rugged` mean we are
 * looking at some other shape, and an unreadable veto is an ERROR (fail closed),
 * never a silent pass.
 */
function readReport(report, mintLabel) {
  if (!isPlainObject(report)) {
    throw new TypeError(
      `ctx.getTokenReport() must resolve to an object, got ` +
        (Array.isArray(report) ? 'an array' : typeof report),
    );
  }
  if (!isFiniteNumber(report.scoreNormalised)) {
    throw new TypeError(
      `rugcheck report for ${mintLabel} has no usable scoreNormalised ` +
        `(got ${String(report.scoreNormalised)}); the legacy unbounded score is NEVER ` +
        'substituted, so this is unreadable and fails closed',
    );
  }
  if (typeof report.rugged !== 'boolean') {
    throw new TypeError(
      `rugcheck report for ${mintLabel} has a non-boolean rugged flag ` +
        `(got ${String(report.rugged)})`,
    );
  }
  return report;
}

/**
 * Layer 5: does a third-party scanner veto this token?
 *
 * Never throws. A pass is not evidence of safety and says so in its facts.
 *
 * @param {string} mint mint address (informational: the report comes from ctx)
 * @param {Readonly<{ getTokenReport: () => Promise<object>, layer5?: object }>} ctx
 * @param {{ maxRugcheckScoreNormalised?: number }} [options] override seam for the
 *   frozen config ceiling -- see resolveMaxScore
 * @returns {Promise<ReturnType<typeof pass>>} frozen verdict for 'layer5-thirdparty'
 */
export async function checkThirdParty(mint, ctx, options = {}) {
  const startedAt = Date.now();
  const mintLabel = stringOrNull(mint);
  const baseFacts = Object.freeze({
    mint: mintLabel,
    evidenceRole: THIRD_PARTY_LIMITATION.role,
    scoreNormalised: null,
    rugged: null,
    /** Stated on every verdict, pass or fail. */
    silenceIsNotEvidence: true,
    residualRisk: THIRD_PARTY_LIMITATION.residualRisk,
  });

  try {
    if (mintLabel === null) {
      throw new TypeError(`checkThirdParty: mint must be a non-empty string, got ${String(mint)}`);
    }
    if (!isPlainObject(ctx)) {
      throw new TypeError(`checkThirdParty: ctx must be an object, got ${typeof ctx}`);
    }
    if (typeof ctx.getTokenReport !== 'function') {
      throw new TypeError('checkThirdParty: ctx.getTokenReport must be a function');
    }
    const maxScore = resolveMaxScore(ctx, options);

    const report = readReport(await ctx.getTokenReport(), mintLabel);
    const score = report.scoreNormalised;
    const rugged = report.rugged;
    // Trust the client's own flag, and re-derive it here too: a report handed to us
    // by any other producer must not be able to hide a changed scale by omitting it.
    const outOfRange =
      report.scoreOutOfDocumentedRange === true ||
      score < DOCUMENTED_SCORE_MIN ||
      score > DOCUMENTED_SCORE_MAX;
    const risks = readRisks(report);

    const facts = Object.freeze({
      mint: mintLabel,
      evidenceRole: THIRD_PARTY_LIMITATION.role,
      scoreNormalised: score,
      /** Legacy unbounded score. Informational: never compared to the ceiling. */
      scoreRaw: isFiniteNumber(report.scoreRaw) ? report.scoreRaw : null,
      scoreDirection: THIRD_PARTY_LIMITATION.scoreDirection,
      maxRugcheckScoreNormalised: maxScore,
      documentedScoreRange: Object.freeze({
        min: DOCUMENTED_SCORE_MIN,
        max: DOCUMENTED_SCORE_MAX,
      }),
      scoreOutOfDocumentedRange: outOfRange,
      rugged,
      /** null means the report carried no risks array -- not "no risks found". */
      risks,
      riskNames: risks === null ? null : Object.freeze(risks.map((r) => r.name)),
      riskCount: risks === null ? null : risks.length,
      /** Extra context for the log; none of it is compared to a threshold here. */
      reportedLiquidityUsd: isFiniteNumber(report.liquidityUsd) ? report.liquidityUsd : null,
      reportedLpLockedPct: isFiniteNumber(report.lpLockedPct) ? report.lpLockedPct : null,
      reportedTotalHolders: isFiniteNumber(report.totalHolders) ? report.totalHolders : null,
      reportedCreator: stringOrNull(report.creator),
      graphInsidersDetected: isFiniteNumber(report.graphInsidersDetected)
        ? report.graphInsidersDetected
        : null,
      silenceIsNotEvidence: true,
      residualRisk: THIRD_PARTY_LIMITATION.residualRisk,
      limitation: THIRD_PARTY_LIMITATION,
    });

    const reasons = [];

    if (outOfRange) {
      // Fail closed rather than clamp: a rescaled score makes the ceiling meaningless.
      reasons.push(
        `rugcheck scoreNormalised ${score} is outside the documented ` +
          `${DOCUMENTED_SCORE_MIN}-${DOCUMENTED_SCORE_MAX} range: the API changed scale, ` +
          `so the ${maxScore} ceiling no longer means what it was set to mean ` +
          '(fail closed, never clamp)',
      );
    } else if (score > maxScore) {
      // DIRECTION: HIGHER = RISKIER, so the veto is `>`. `<` would pass only the
      // tokens RugCheck flagged -- an "only buy scams" filter.
      reasons.push(
        `rugcheck risk score ${score} exceeds the ceiling ${maxScore} ` +
          `(0-${DOCUMENTED_SCORE_MAX}, higher is riskier)` +
          (risks === null || risks.length === 0
            ? ''
            : `: ${risks.map((r) => `${r.name}${r.level === null ? '' : ` [${r.level}]`}`).join('; ')}`),
      );
    }

    if (rugged) {
      reasons.push(
        'rugcheck has flagged this token as RUGGED: a third party asserts the rug ' +
          'already happened, which is a veto regardless of the score',
      );
    }

    const ms = Date.now() - startedAt;
    return reasons.length > 0 ? reject(LAYER, reasons, facts, ms) : pass(LAYER, facts, ms);
  } catch (err) {
    // FAIL CLOSED: an unreadable veto is not an absent veto.
    return errored(LAYER, err, baseFacts, Date.now() - startedAt);
  }
}
