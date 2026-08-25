#!/usr/bin/env node
/**
 * Label what actually happened to recorded tokens. The missing half of the
 * evidence engine.
 *
 * scripts/record.js writes every candidate with `outcome: null` and a comment
 * saying "filled in later by a labelling pass". This is that pass. Without it the
 * recording can never be scored and backtest-rug-filter.js prints "NO RATE
 * REPORTED" forever, however long you run the recorder.
 *
 * APPEND-ONLY, LIKE THE RECORDER
 *   The snapshots are never rewritten. Labels are appended as their own line
 *   type, and the backtest merges them on read. That keeps the raw observations
 *   exactly as they were taken -- if the thresholds in LABELS turn out wrong, the
 *   dataset can be relabelled from the stored evidence without re-collecting.
 *
 * IT LABELS BLOCKED TOKENS TOO, AND THAT IS THE POINT
 *   Labelling only the approvals tells you the filter's rug rate. Labelling the
 *   REJECTS as well tells you whether the filter is discriminating at all -- a
 *   gate that approves 10% ruggers is worthless if the ones it blocked rugged at
 *   the same rate. That comparison is the actual measure of skill, and it is free
 *   here because the rejects are already in the file.
 */

import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LABELS, RECORDER } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { LABEL, decideOutcome, shouldRelabel } from '../src/evidence/outcome.js';
import { EXIT, isMain, line, parseArgs, runMain, usd } from './lib/cli.js';

const USAGE = `usage: npm run label -- [--dir PATH] [--dry-run] [--min-age-hours N]

Re-visits recorded tokens, measures what happened to their pool, and appends
outcome labels. Run it whenever you like -- it is idempotent and cheap.

  --dir PATH          recordings directory (default ${RECORDER.dir})
  --min-age-hours N   override LABELS.minAgeHoursBeforeLabelling (${LABELS.minAgeHoursBeforeLabelling})
  --dry-run           show what would be written, write nothing
  --json              machine-readable summary

  0 = labels written   1 = nothing to label   2 = internal error
`;

/**
 * Fold the JSONL into: the first observation per mint, and the latest label per
 * mint. Pure, so the merge rules are testable without a disk.
 *
 * @param {readonly string[]} lines
 * @returns {{observations: Map<string, object>, labels: Map<string, object>, malformed: number}}
 */
export function readDataset(lines) {
  const observations = new Map();
  const labels = new Map();
  let malformed = 0;

  for (const raw of lines) {
    const text = raw.trim();
    if (text === '') continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      malformed += 1;
      continue;
    }
    if (record?.schemaVersion !== RECORDER.schemaVersion) {
      malformed += 1;
      continue;
    }

    if (record.type === LABELS.recordType) {
      for (const entry of record.labels ?? []) {
        if (typeof entry?.mint !== 'string') continue;
        const prior = labels.get(entry.mint);
        // Keep the most recent label for each mint.
        if (prior === undefined || (entry.ts ?? 0) >= (prior.ts ?? 0)) labels.set(entry.mint, entry);
      }
      continue;
    }

    for (const candidate of record.candidates ?? []) {
      if (typeof candidate?.mint !== 'string') continue;
      // FIRST observation wins: that is the decision the filter would have traded
      // on, and the liquidity we must measure the collapse against.
      if (!observations.has(candidate.mint)) {
        observations.set(candidate.mint, { ...candidate, recordedTs: record.ts });
      }
    }
  }
  return { observations, labels, malformed };
}

/**
 * @param {readonly string[]} argv
 * @param {object} [deps] test seam
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const { flags } = parseArgs(argv);
  const out = deps.out ?? console.log;
  if (flags.help === true) {
    out(USAGE);
    return EXIT.OK;
  }

  const dir = typeof flags.dir === 'string' ? flags.dir : RECORDER.dir;
  const now = (deps.now ?? Date.now)();
  const dryRun = flags['dry-run'] === true;
  const thresholds =
    flags['min-age-hours'] === undefined
      ? LABELS
      : Object.freeze({ ...LABELS, minAgeHoursBeforeLabelling: Number(flags['min-age-hours']) });

  let files;
  try {
    files = (await (deps.readdir ?? readdir)(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    out(`no recordings directory at ${dir}. Run "npm run record" first.`);
    return EXIT.NEGATIVE;
  }
  if (files.length === 0) {
    out(`no .jsonl recordings in ${dir}.`);
    return EXIT.NEGATIVE;
  }

  const lines = [];
  for (const file of files) {
    lines.push(...(await (deps.readFile ?? readFile)(join(dir, file), 'utf8')).split('\n'));
  }
  const { observations, labels, malformed } = readDataset(lines);

  const due = [...observations.values()].filter((o) => {
    const prior = labels.get(o.mint);
    return shouldRelabel({
      lastLabelledTs: prior?.ts ?? null,
      lastLabel: prior?.outcome ?? null,
      now,
      thresholds,
    });
  });

  out(line('='));
  out('OUTCOME LABELLING');
  out(line('='));
  out(`  files            ${files.length}${malformed > 0 ? `  (${malformed} malformed lines skipped)` : ''}`);
  out(`  mints observed   ${observations.size}`);
  out(`  already labelled ${labels.size}`);
  out(`  due for a look   ${due.length}`);

  if (due.length === 0) {
    out('');
    out('Nothing to label. Either everything is current, or nothing has aged past');
    out(`${thresholds.minAgeHoursBeforeLabelling}h yet. Keep the recorder running.`);
    out(line('-'));
    return EXIT.NEGATIVE;
  }

  // One batched lookup for every mint at once (30 per request, handled by the client).
  const fetchPairs = deps.getBestPairs ?? getBestPairs;
  let current;
  try {
    current = await fetchPairs(due.map((o) => o.mint));
  } catch (err) {
    out(`could not reach Dexscreener: ${err?.message ?? err}`);
    out('Refusing to label anything: an outage must not be recorded as dead pools.');
    return EXIT.ERROR;
  }
  // If NOTHING came back, the source is down rather than every pool being gone.
  const answered = [...current.values()].filter((p) => p !== null).length;
  const apiHealthy = answered > 0;

  const decided = due.map((o) => {
    const verdict = decideOutcome({
      recordedTs: o.recordedTs,
      recordedLiquidityUsd: o.liquidityUsd ?? null,
      recordedPriceUsd: o.priceUsd ?? null,
      current: current.get(o.mint) ?? null,
      now,
      apiHealthy,
      thresholds,
    });
    return { observation: o, ...verdict };
  });

  const writable = decided.filter(
    (d) => d.label === LABEL.RUGGED || d.label === LABEL.SURVIVED,
  );
  const counts = decided.reduce((acc, d) => ({ ...acc, [d.label]: (acc[d.label] ?? 0) + 1 }), {});

  out('');
  out(`  source answered for ${answered}/${due.length} mints` + (apiHealthy ? '' : '  <- treating as an OUTAGE'));
  out('');
  for (const d of decided.slice(0, 25)) {
    const mark = d.label === LABEL.RUGGED ? 'RUG ' : d.label === LABEL.SURVIVED ? 'LIVE' : '?   ';
    out(
      `  ${mark} ${d.observation.mint.slice(0, 10).padEnd(12)}` +
        `${(d.observation.symbol ?? '?').slice(0, 10).padEnd(12)}` +
        `${usd(d.evidence.liquidityBeforeUsd).padStart(11)} -> ${usd(d.evidence.liquidityAfterUsd).padStart(11)}` +
        `   ${d.reasons[0] ?? ''}`.slice(0, 74),
    );
  }
  if (decided.length > 25) out(`  ... and ${decided.length - 25} more`);

  out('');
  out(`  rugged ${counts[LABEL.RUGGED] ?? 0}   survived ${counts[LABEL.SURVIVED] ?? 0}` +
    `   too-early ${counts[LABEL.TOO_EARLY] ?? 0}   unknown ${counts[LABEL.UNKNOWN] ?? 0}`);

  if (writable.length === 0) {
    out('');
    out('No conclusive outcomes this pass. Nothing appended -- an unknown is never');
    out('written as a label, because a wrong "survived" flatters the filter.');
    out(line('-'));
    return EXIT.NEGATIVE;
  }

  const record = {
    schemaVersion: RECORDER.schemaVersion,
    type: LABELS.recordType,
    ts: now,
    iso: new Date(now).toISOString(),
    labels: writable.map((d) => ({
      mint: d.observation.mint,
      symbol: d.observation.symbol ?? null,
      outcome: d.label,
      ts: now,
      observedTs: d.observation.recordedTs,
      gateBuyable: d.observation.gate?.buyable ?? null,
      reasons: [...d.reasons],
      evidence: d.evidence,
    })),
  };

  if (dryRun) {
    out('');
    out(`--dry-run: would append ${writable.length} label(s), nothing written.`);
    out(line('-'));
    return EXIT.OK;
  }

  const target = join(dir, `${new Date(now).toISOString().slice(0, 10)}.jsonl`);
  await (deps.appendFile ?? appendFile)(target, `${JSON.stringify(record)}\n`, 'utf8');
  out('');
  out(`  appended ${writable.length} label(s) to ${target}`);
  out('  (appended, never rewritten -- the raw observations are untouched)');
  out(line('-'));
  out('Now run:  npm run backtest:rug');
  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
