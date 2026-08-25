#!/usr/bin/env node
/**
 * The one honest backtest this project accepts.
 *
 * THE QUESTION IT ANSWERS
 *   Of the tokens the filter APPROVED, what fraction later rugged -- measured
 *   against the ~98.6% base rate for the population as a whole?
 *
 * WHY THIS ONE IS LEGITIMATE WHEN CANDLE BACKTESTING IS NOT
 *   1. The features are on-chain FACTS (mint flags, LP state, deployer history),
 *      not fakeable volume.
 *   2. The label is OBJECTIVE: did it rug, yes or no.
 *   3. The population is COMPLETE, because scripts/record.js wrote down every
 *      candidate as it appeared -- including the ones that died. No survivorship
 *      bias, because nothing was selected after the fact.
 *
 * WHAT IT REFUSES TO DO
 *   Report a percentage on a sample too small to mean anything. Ten approvals and
 *   one rug is not "10%" -- it is "no idea", and saying 10% would be the most
 *   misleading output this repo could produce. Below MIN_SAMPLE the report states
 *   that plainly instead of printing a number.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LABELS, RECORDER } from '../src/config.js';
import { EXIT, isMain, line, parseArgs, runMain } from './lib/cli.js';

/**
 * Population base rate: Solidus Labs found 98.6% of 7M+ pump.fun tokens fell
 * below $1k liquidity or were rugs / manipulative schemes. The filter has to beat
 * this to have demonstrated anything at all.
 */
export const BASE_RATE_PCT = 98.6;

/**
 * Below this many LABELLED approvals, no rate is reported. Chosen so the 95%
 * Wilson interval on a small observed rate is narrower than the effect being
 * claimed; at n=30 a 0/30 result still only bounds the true rate below ~11.4%,
 * which is already a meaningful claim against a 98.6% base rate.
 */
export const MIN_SAMPLE = 30;

const Z_95 = 1.959_963_985;

/**
 * Wilson score interval for a binomial proportion. Preferred over the normal
 * approximation because the interesting cases here are extreme (0 or near-0
 * successes), exactly where the normal approximation is worst -- it would happily
 * report a negative lower bound.
 * @param {number} successes
 * @param {number} n
 * @param {number} [z]
 * @returns {Readonly<{low: number, high: number}>} as PERCENTAGES
 */
export function wilsonInterval(successes, n, z = Z_95) {
  if (!Number.isInteger(successes) || successes < 0) {
    throw new RangeError(`successes must be a non-negative integer, got ${successes}`);
  }
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`n must be a positive integer, got ${n}`);
  }
  if (successes > n) throw new RangeError(`successes ${successes} exceeds n ${n}`);

  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Object.freeze({
    low: Math.max(0, (centre - spread) / denom) * 100,
    high: Math.min(1, (centre + spread) / denom) * 100,
  });
}

/**
 * Score the filter.
 *
 * @param {object} p
 * @param {number} p.approved   tokens the filter said were buyable AND that carry a label
 * @param {number} p.rugged     of those, how many later rugged
 * @param {number} [p.unlabelled] approvals with no outcome yet (reported, never assumed clean)
 * @param {number} [p.rejected] tokens the filter blocked (context only)
 * @param {number} [p.baseRatePct]
 * @param {number} [p.minSample]
 * @returns {Readonly<object>} frozen report; `sufficient: false` when n is too small
 */
export function scoreRugFilter({
  approved,
  rugged,
  unlabelled = 0,
  rejected = 0,
  baseRatePct = BASE_RATE_PCT,
  minSample = MIN_SAMPLE,
}) {
  for (const [name, value] of Object.entries({ approved, rugged, unlabelled, rejected })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
    }
  }
  if (rugged > approved) {
    throw new RangeError(`rugged ${rugged} exceeds approved ${approved}`);
  }

  const base = Object.freeze({
    approved,
    rugged,
    survived: approved - rugged,
    unlabelled,
    rejected,
    baseRatePct,
    minSample,
  });

  if (approved < minSample) {
    return Object.freeze({
      ...base,
      sufficient: false,
      ruggedPct: null,
      interval: null,
      liftPctPoints: null,
      reason:
        `only ${approved} labelled approval(s); ${minSample} are required before a rate ` +
        'is meaningful. Reporting a percentage on this sample would be the most ' +
        'misleading thing this tool could print.',
    });
  }

  const ruggedPct = (rugged / approved) * 100;
  return Object.freeze({
    ...base,
    sufficient: true,
    ruggedPct,
    interval: wilsonInterval(rugged, approved),
    /** Percentage POINTS better than the population base rate. Positive is good. */
    liftPctPoints: baseRatePct - ruggedPct,
    reason: null,
  });
}

/**
 * Read every recorded JSONL file and fold it into approval/label counts.
 *
 * A candidate with no `outcome` is UNLABELLED, never counted as survived: the
 * whole point of this file is to avoid flattering the filter with silence.
 * @param {readonly string[]} lines raw JSONL lines
 */
export function tallyRecords(lines) {
  const seen = new Map();
  /** mint -> outcome, from the label records scripts/label.js appends. */
  const appendedLabels = new Map();
  let malformed = 0;
  // Counted from records actually parsed, NOT from lines.length: splitting a
  // trailing-newline file yields an empty final element, which would inflate the
  // snapshot count by one per file and make the sample look bigger than it is.
  let snapshots = 0;

  for (const raw of lines) {
    const text = raw.trim();
    if (text === '') continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      // A truncated final line is expected if a recorder was killed mid-write.
      malformed += 1;
      continue;
    }
    if (record?.schemaVersion !== RECORDER.schemaVersion) {
      malformed += 1;
      continue;
    }

    // Label records are appended by the labeller rather than editing the
    // snapshots in place, so the raw observations stay exactly as taken.
    if (record.type === LABELS.recordType) {
      for (const entry of record.labels ?? []) {
        if (typeof entry?.mint !== 'string') continue;
        const prior = appendedLabels.get(entry.mint);
        if (prior === undefined || (entry.ts ?? 0) >= (prior.ts ?? 0)) {
          appendedLabels.set(entry.mint, entry);
        }
      }
      continue;
    }

    snapshots += 1;
    for (const candidate of record.candidates ?? []) {
      if (typeof candidate?.mint !== 'string') continue;
      // Keep the FIRST verdict for a mint: that is the decision the filter would
      // actually have traded on. Later snapshots are the same token, re-observed.
      if (!seen.has(candidate.mint)) seen.set(candidate.mint, candidate);
      else if (candidate.outcome !== null && seen.get(candidate.mint).outcome === null) {
        // ...but a later inline label is still a label for that first decision.
        seen.set(candidate.mint, { ...seen.get(candidate.mint), outcome: candidate.outcome });
      }
    }
  }

  // Merge appended labels onto the first observation of each mint.
  const all = [...seen.values()].map((c) => {
    const appended = appendedLabels.get(c.mint);
    return appended === undefined ? c : { ...c, outcome: c.outcome ?? appended.outcome };
  });

  const isLabelled = (c) => c.outcome !== null && c.outcome !== undefined;
  const approvals = all.filter((c) => c.gate?.buyable === true);
  const blocked = all.filter((c) => c.gate?.buyable !== true);
  const labelled = approvals.filter(isLabelled);
  const blockedLabelled = blocked.filter(isLabelled);

  return Object.freeze({
    snapshots,
    malformed,
    uniqueMints: all.length,
    approved: labelled.length,
    rugged: labelled.filter((c) => c.outcome === 'rugged').length,
    unlabelled: approvals.length - labelled.length,
    rejected: blocked.length,
    /**
     * The control cohort. A filter that approves 10% ruggers has proved nothing
     * if the tokens it BLOCKED rugged at 10% too -- that would mean it is
     * discarding candidates without discriminating. This is the comparison that
     * actually measures skill, and it is free because the rejects are already in
     * the file.
     */
    blockedLabelled: blockedLabelled.length,
    blockedRugged: blockedLabelled.filter((c) => c.outcome === 'rugged').length,
  });
}

/**
 * @param {readonly string[]} argv
 * @param {object} [deps] test seam
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const { flags } = parseArgs(argv);
  const out = deps.out ?? console.log;
  const dir = typeof flags.dir === 'string' ? flags.dir : RECORDER.dir;

  if (flags.help === true) {
    out(`usage: npm run backtest:rug -- [--dir PATH] [--json]

Reads the JSONL written by scripts/record.js and reports: of the tokens the
safety gate APPROVED, what fraction later rugged, against the ${BASE_RATE_PCT}% base rate.
Refuses to report a rate on fewer than ${MIN_SAMPLE} labelled approvals.
`);
    return EXIT.OK;
  }

  let files;
  try {
    files = (await (deps.readdir ?? readdir)(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    out(`no recordings directory at ${dir}. Run "npm run record" first -- there is`);
    out('no historical dataset to fall back on, by design (see the design record).');
    return EXIT.NEGATIVE;
  }
  if (files.length === 0) {
    out(`no .jsonl recordings in ${dir}. Run "npm run record" first.`);
    return EXIT.NEGATIVE;
  }

  const lines = [];
  for (const file of files) {
    const text = await (deps.readFile ?? readFile)(join(dir, file), 'utf8');
    lines.push(...text.split('\n'));
  }

  const tally = tallyRecords(lines);
  const report = scoreRugFilter(tally);

  if (flags.json === true) {
    out(JSON.stringify({ files, tally, report }, null, 2));
    return report.sufficient ? EXIT.OK : EXIT.NEGATIVE;
  }

  out(line('='));
  out('RUG-FILTER BACKTEST');
  out(line('='));
  out(`  files read          ${files.length}   (${tally.snapshots} snapshots)`);
  if (tally.malformed > 0) out(`  malformed lines     ${tally.malformed} (skipped)`);
  out(`  unique mints seen   ${tally.uniqueMints}`);
  out(`  gate approved       ${tally.approved + tally.unlabelled}`);
  out(`    of those, labelled ${tally.approved}`);
  out(`    still unlabelled   ${tally.unlabelled}  <- counted as UNKNOWN, not as survived`);
  out(`  gate blocked        ${tally.rejected}`);
  out(`    of those, labelled ${tally.blockedLabelled}   rugged ${tally.blockedRugged}`);
  out('');

  if (!report.sufficient) {
    out(`NO RATE REPORTED: ${report.reason}`);
    out('');
    out('Keep the recorder running. This is the slow part, and there is no way to');
    out('shortcut it: the dataset cannot be reconstructed after the fact.');
    out(line('-'));
    return EXIT.NEGATIVE;
  }

  out(`  APPROVED-AND-RUGGED  ${report.rugged}/${report.approved} = ${report.ruggedPct.toFixed(1)}%`);
  out(`  95% interval         ${report.interval.low.toFixed(1)}% .. ${report.interval.high.toFixed(1)}%`);
  out(`  population base rate ${report.baseRatePct}%`);
  out(`  lift                 ${report.liftPctPoints.toFixed(1)} percentage points`);
  out('');
  out(`  Read as: of ${report.approved} tokens this filter approved, ${report.rugged} later rugged.`);
  out('  The interval is what matters, not the point estimate.');

  // The control cohort. Beating the population base rate is not enough on its
  // own: if the tokens the gate BLOCKED rugged at the same rate as the ones it
  // approved, the gate is discarding candidates without discriminating between
  // them, and the lift above is just the population it happened to sample from.
  if (tally.blockedLabelled >= MIN_SAMPLE) {
    const blockedPct = (tally.blockedRugged / tally.blockedLabelled) * 100;
    const gap = blockedPct - report.ruggedPct;
    out('');
    out(line('-'));
    out('  CONTROL COHORT -- the tokens the gate REJECTED');
    out(`  rejected-and-rugged  ${tally.blockedRugged}/${tally.blockedLabelled} = ${blockedPct.toFixed(1)}%`);
    out(`  approved-and-rugged  ${report.rugged}/${report.approved} = ${report.ruggedPct.toFixed(1)}%`);
    out(`  separation           ${gap.toFixed(1)} percentage points`);
    out('');
    if (gap <= 0) {
      out('  THE GATE IS NOT DISCRIMINATING. What it blocked rugged no more often');
      out('  than what it approved, so the filter is not distinguishing between them.');
      out('  That is the finding, and it matters more than the rate above.');
    } else {
      out('  The gate blocked a dirtier cohort than it approved, which is what a');
      out('  working filter looks like. Sample size still governs how much to believe.');
    }
  } else {
    out('');
    out(`  (No control comparison: only ${tally.blockedLabelled} labelled rejects, ${MIN_SAMPLE} needed.`);
    out('   Beating the base rate alone cannot show the gate discriminates.)');
  }
  out(line('-'));
  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
