#!/usr/bin/env node
/**
 * Print one labelling pass. THIN: the pass itself lives in
 * src/evidence/labeller.js and is also run by the recorder on a timer.
 *
 * YOU DO NOT NORMALLY NEED THIS COMMAND
 *   The recorder labels every RECORDER.autoLabelEveryMinutes, because leaving it
 *   to a person meant 136 snapshots accumulated with zero labels while everything
 *   looked healthy. This exists for when you want to see a pass in detail, force
 *   one now, or try different thresholds with --min-age-hours.
 *
 * One implementation, two callers: a second copy of the labelling rules would
 * drift from the one the recorder uses, and then the dataset would contain
 * labels produced by two slightly different definitions of "rugged".
 */

import { LABELS, RECORDER } from '../src/config.js';
import { runLabellingPass } from '../src/evidence/labeller.js';
import { LABEL } from '../src/evidence/outcome.js';
import { EXIT, isMain, line, parseArgs, runMain, usd } from './lib/cli.js';

const USAGE = `usage: npm run label -- [--dir PATH] [--dry-run] [--min-age-hours N]

Re-visits recorded tokens, measures what happened to their pool, and appends
outcome labels. Idempotent and cheap.

The recorder already does this every ${LABELS.autoLabelEveryMinutes} minutes, so you rarely need it.

  --dir PATH          recordings directory (default ${RECORDER.dir})
  --min-age-hours N   override LABELS.minAgeHoursBeforeLabelling (${LABELS.minAgeHoursBeforeLabelling})
  --dry-run           show what would be written, write nothing
  --json              machine-readable summary

  0 = labels written   1 = nothing to label   2 = internal error
`;

/** Re-exported so callers keep one definition of the fold. */
export { readDataset } from '../src/evidence/labeller.js';

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

  const thresholds =
    flags['min-age-hours'] === undefined
      ? LABELS
      : Object.freeze({ ...LABELS, minAgeHoursBeforeLabelling: Number(flags['min-age-hours']) });

  const pass = await (deps.runLabellingPass ?? runLabellingPass)(
    {
      dir: typeof flags.dir === 'string' ? flags.dir : RECORDER.dir,
      now: (deps.now ?? Date.now)(),
      dryRun: flags['dry-run'] === true,
      thresholds,
    },
    deps,
  );

  if (flags.json === true) {
    out(JSON.stringify(pass, null, 2));
    return pass.written > 0 ? EXIT.OK : EXIT.NEGATIVE;
  }

  out(line('='));
  out('OUTCOME LABELLING');
  out(line('='));
  out(`  files            ${pass.files}${pass.malformed > 0 ? `  (${pass.malformed} malformed lines skipped)` : ''}`);
  out(`  mints observed   ${pass.observed}`);
  out(`  already labelled ${pass.alreadyLabelled}`);
  out(`  due for a look   ${pass.due}`);

  if (pass.due === 0) {
    out('');
    out('Nothing to label. Either everything is current, or nothing has aged past');
    out(`${thresholds.minAgeHoursBeforeLabelling}h yet. Keep the recorder running.`);
    out(line('-'));
    return EXIT.NEGATIVE;
  }

  out('');
  out(
    `  source answered for ${pass.answered}/${pass.due} mints` +
      (pass.answered === 0 ? '  <- treating as an OUTAGE' : ''),
  );
  out('');
  for (const d of pass.decided.slice(0, 25)) {
    const mark = d.label === LABEL.RUGGED ? 'RUG ' : d.label === LABEL.SURVIVED ? 'LIVE' : '?   ';
    out(
      `  ${mark} ${d.observation.mint.slice(0, 10).padEnd(12)}` +
        `${(d.observation.symbol ?? '?').slice(0, 10).padEnd(12)}` +
        `${usd(d.evidence.liquidityBeforeUsd).padStart(11)} -> ${usd(d.evidence.liquidityAfterUsd).padStart(11)}` +
        `   ${d.reasons[0] ?? ''}`.slice(0, 74),
    );
  }
  if (pass.decided.length > 25) out(`  ... and ${pass.decided.length - 25} more`);

  const c = pass.counts;
  out('');
  out(
    `  rugged ${c[LABEL.RUGGED] ?? 0}   survived ${c[LABEL.SURVIVED] ?? 0}` +
      `   too-early ${c[LABEL.TOO_EARLY] ?? 0}   unknown ${c[LABEL.UNKNOWN] ?? 0}`,
  );

  if (pass.written === 0) {
    out('');
    out(`Nothing appended: ${pass.reason ?? 'no conclusive outcomes'}.`);
    out('An unknown is never written as a label, because a wrong "survived"');
    out('flatters the filter.');
    out(line('-'));
    return EXIT.NEGATIVE;
  }

  out('');
  out(`  appended ${pass.written} label(s) to ${pass.target}`);
  out('  (appended, never rewritten -- the raw observations are untouched)');
  out(line('-'));
  out('Now run:  npm run backtest:rug');
  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
