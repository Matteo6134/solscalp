#!/usr/bin/env node
/**
 * The stateful view: every token ever recorded, and what became of it.
 *
 * WHY THIS EXISTS
 *   A stream of alerts cannot answer "what happened to the things you showed me".
 *   Each message is a moment; there is no state, so the same token appearing and
 *   vanishing reads as the tool being inconsistent when it is actually the market
 *   being exactly as lethal as the base rate says. This puts every token on one
 *   page with its outcome, so the pattern is legible instead of anecdotal.
 *
 * IT RE-FETCHES. IT DOES NOT TRUST THE RECORDING'S TAIL.
 *   This is the subtle part. scripts/record.js only observes a token WHILE IT
 *   PASSES THE SCREEN. The moment liquidity collapses the token drops out of the
 *   candidate set and stops being recorded -- so the last recorded value is the
 *   last HEALTHY reading, never the outcome. Measured on real data: one mint's
 *   final recorded liquidity was $61,861 while its actual live pool held $2,623.
 *
 *   Any report built from "last recorded liquidity" would therefore be
 *   systematically flattering, and would show a portfolio of survivors that do
 *   not exist. So the reference point comes from the recording (the FIRST
 *   observation, which is the decision the filter would have traded on) and the
 *   current value is always fetched live.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LABELS, RECORDER } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { LABEL, decideOutcome } from '../src/evidence/outcome.js';
import { EXIT, isMain, line, parseArgs, pct, runMain, usd } from './lib/cli.js';

const MS_PER_HOUR = 3_600_000;

const USAGE = `usage: npm run watchlist -- [--dir PATH] [--json] [--safe-only]

Every token the recorder has ever seen, with its CURRENT state fetched live.

  --dir PATH   recordings directory (default ${RECORDER.dir})
  --json       machine-readable output
  --safe-only  only tokens the gate PASSED (default: everything scanned)
`;

/**
 * Fold the recording into one row per mint: the FIRST observation (the decision
 * the filter would have acted on) plus how many times it was seen.
 * @param {readonly string[]} lines
 */
export function buildWatchlist(lines) {
  const rows = new Map();
  const labels = new Map();
  /** Every scan tick, so the report can show that scanning is CONTINUOUS. */
  const ticks = [];

  for (const raw of lines) {
    const text = raw.trim();
    if (text === '') continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    if (record?.schemaVersion !== RECORDER.schemaVersion) continue;

    if (record.type === LABELS.recordType) {
      for (const entry of record.labels ?? []) {
        if (typeof entry?.mint === 'string') labels.set(entry.mint, entry);
      }
      continue;
    }

    const candidates = record.candidates ?? [];
    ticks.push({
      ts: record.ts,
      seen: candidates.length,
      safe: candidates.filter((c) => c.gate?.buyable === true).length,
    });

    for (const c of candidates) {
      if (typeof c?.mint !== 'string') continue;
      const existing = rows.get(c.mint);
      if (existing === undefined) {
        rows.set(c.mint, {
          mint: c.mint,
          symbol: c.symbol ?? null,
          firstTs: record.ts,
          lastSeenTs: record.ts,
          seen: 1,
          entryLiquidityUsd: c.liquidityUsd ?? null,
          entryPriceUsd: c.priceUsd ?? null,
          entryMarketCapUsd: c.marketCapUsd ?? null,
          gateBuyable: c.gate?.buyable ?? null,
          gateBlockedBy: [...(c.gate?.rejectedBy ?? []), ...(c.gate?.erroredIn ?? [])],
          // The observed trace. Every repeat sighting is a real datapoint, which
          // is what makes a sparkline here evidence rather than decoration.
          series: [{ ts: record.ts, liq: c.liquidityUsd ?? null }],
        });
      } else {
        existing.seen += 1;
        existing.lastSeenTs = record.ts;
        existing.series.push({ ts: record.ts, liq: c.liquidityUsd ?? null });
      }
    }
  }

  for (const [mint, entry] of labels) {
    const row = rows.get(mint);
    if (row !== undefined) row.storedLabel = entry.outcome;
  }
  return { rows: [...rows.values()], ticks };
}

/** Down-sample to at most  points, keeping first and last. */
export function thin(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

/** Block characters, low to high. Eight levels is all a terminal cell affords. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * A sparkline of a token's observed liquidity, normalised to its own range.
 *
 * Returns spaces when there is not enough signal to draw honestly: a two-point
 * "trend" is a straight line pretending to be information, and this project's
 * whole discipline is not overstating what the data supports.
 */
export function sparkline(series, width = 12, minPoints = 4) {
  const pts = thin(
    series.filter((p) => typeof p.liq === 'number' && Number.isFinite(p.liq)),
    width,
  );
  if (pts.length < minPoints) return ' '.repeat(width);
  const values = pts.map((p) => p.liq);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  // Flat is real information, and it is not the same as unknown.
  if (span === 0) return '▄'.repeat(pts.length).padEnd(width);
  return pts
    .map((p) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((p.liq - lo) / span) * BLOCKS.length))])
    .join('')
    .padEnd(width);
}

/**
 * The scan-activity strip: one column per tick.
 *
 * This is the answer to "show me it is still working". A scan that reports zero
 * candidates looks identical to a dead scanner in any summary number, and telling
 * those apart is the entire question when nothing is being found.
 */
export function activityStrip(ticks, width = 60) {
  if (ticks.length === 0) return '';
  const pts = thin(ticks, width);
  const max = Math.max(1, ...pts.map((t) => t.seen));
  return pts
    .map((t) =>
      t.seen === 0
        ? '·'
        : BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((t.seen / max) * BLOCKS.length))],
    )
    .join('');
}

/**
 * @param {readonly string[]} argv
 * @param {object} [deps]
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

  let files;
  try {
    files = (await (deps.readdir ?? readdir)(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    out(`no recordings at ${dir}. Run "npm run record" first.`);
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

  const { rows: allRows, ticks } = buildWatchlist(lines);
  // Default is EVERYTHING the scanner looked at, not just what it chose: seeing
  // the rejects is how you tell a working filter from a dead one.
  const rows = flags['safe-only'] === true ? allRows.filter((r) => r.gateBuyable === true) : allRows;
  if (rows.length === 0) {
    out('nothing recorded yet that matches.');
    return EXIT.NEGATIVE;
  }

  // Current state is always fetched live -- never read off the recording's tail.
  const current = await (deps.getBestPairs ?? getBestPairs)(rows.map((r) => r.mint));
  const answered = [...current.values()].filter((p) => p !== null).length;
  const apiHealthy = answered > 0;

  const enriched = rows
    .map((r) => {
      const pair = current.get(r.mint) ?? null;
      const verdict = decideOutcome({
        recordedTs: r.firstTs,
        recordedLiquidityUsd: r.entryLiquidityUsd,
        recordedPriceUsd: r.entryPriceUsd,
        current: pair,
        now,
        apiHealthy,
      });
      return {
        ...r,
        currentLiquidityUsd: pair?.liquidityUsd ?? null,
        currentPriceUsd: pair?.priceUsd ?? null,
        changePct: verdict.evidence.liquidityDropPct === null ? null : -verdict.evidence.liquidityDropPct,
        ageHours: (now - r.firstTs) / MS_PER_HOUR,
        outcome: verdict.label,
        outcomeReason: verdict.reasons[0] ?? '',
      };
    })
    .sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));

  if (flags.json === true) {
    out(JSON.stringify({ generatedAt: new Date(now).toISOString(), rows: enriched }, null, 2));
    return EXIT.OK;
  }

  const rugged = enriched.filter((r) => r.outcome === LABEL.RUGGED).length;
  const survived = enriched.filter((r) => r.outcome === LABEL.SURVIVED).length;

  out(line('='));
  out(`WATCHLIST -- ${enriched.length} tokens, current values fetched live`);
  out(line('='));
  out(
    `${'TOKEN'.padEnd(12)}${'LIQ@ENTRY'.padStart(11)}${'LIQ NOW'.padStart(11)}` +
      `${'CHANGE'.padStart(9)}${'AGE'.padStart(6)}${'SEEN'.padStart(6)}  OUTCOME`,
  );
  out(line('-'));
  for (const r of enriched) {
    out(
      (r.symbol ?? '?').slice(0, 11).padEnd(12) +
        usd(r.entryLiquidityUsd).padStart(11) +
        usd(r.currentLiquidityUsd).padStart(11) +
        (r.changePct === null ? 'n/a' : pct(r.changePct)).padStart(9) +
        `${r.ageHours.toFixed(0)}h`.padStart(6) +
        String(r.seen).padStart(6) +
        '  ' +
        r.outcome,
    );
  }
  out(line('-'));
  out(`  collapsed ${rugged}   still trading ${survived}   too early ${enriched.length - rugged - survived}`);
  if (rugged + survived < 30) {
    out(`  ${rugged + survived} conclusive so far -- 30 needed before any rate means anything.`);
  }

  if (typeof flags.html === 'string') {
    const html = htmlReport(enriched, new Date(now).toISOString().replace('T', ' ').slice(0, 16));
    await (deps.writeFile ?? writeFile)(flags.html, html, 'utf8');
    out('');
    out(`  HTML report written to ${flags.html}`);
  }
  out(line('-'));
  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
