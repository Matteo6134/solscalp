#!/usr/bin/env node
/**
 * The one screen. Reads the recording; never fetches.
 *
 * WHY IT READS INSTEAD OF SCANNING
 *   This used to run its own enumerate -> screen -> gate cycle. That made it a
 *   third process competing for the same per-IP rate limits as the recorder and
 *   the bot, and the limiters live inside each process and cannot see each other,
 *   so they starved one another until the loser spent every cycle reporting 429s.
 *
 *   Reading the recorder's append-only JSONL instead fixes three things at once:
 *     - it costs NOTHING upstream, so it is safe to leave open forever;
 *     - it has HISTORY, because the recording is the history -- hours of ticks
 *       and every sighting of every token, not just this instant;
 *     - it REMEMBERS, because a restart re-reads the file. Nothing is lost by
 *       closing the window, which was not true of the in-memory version.
 *
 * WHAT IT CANNOT DO
 *   It cannot see anything the recorder did not record. If the recorder stops,
 *   this screen freezes at the last snapshot -- so the header always shows the
 *   snapshot's AGE and turns red when it goes stale. A dashboard that looks calm
 *   while its source of truth is dead is worse than no dashboard.
 *
 * Views: [1] LIVE  [2] HISTORY  [3] EVIDENCE.  q or Ctrl+C to quit.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LABELS, RECORDER, RISK, STRATEGY } from '../src/config.js';
import { LABEL } from '../src/evidence/outcome.js';
import { isRecorderHealthy, latestSnapshot } from '../src/evidence/tail.js';
import { readSignals } from '../src/paper/engine.js';
import { BASE_RATE_PCT, MIN_SAMPLE, scoreRugFilter, tallyRecords } from './backtest-rug-filter.js';
import { EXIT, isMain, intFlag, parseArgs, pct, runMain, usd } from './lib/cli.js';
import { ANSI, pad, pane, paint, size, withScreen } from './lib/tui.js';
import { activityStrip, buildWatchlist, sparkline } from './watchlist.js';

const MS_PER_SECOND = 1_000;
const MS_PER_HOUR = 3_600_000;
const HEADER_ROWS = 2;
const VIEWS = Object.freeze(['live', 'history', 'evidence']);

const USAGE = `usage: npm run dash -- [--refresh S] [--dir PATH]

One screen over the recorder's output. Makes no network calls of its own, so it
is safe to leave running next to the recorder and the bot.

  --refresh S  seconds between reads (default 5)
  --view V     start on live | history | evidence
  --dir PATH   recordings directory (default ${RECORDER.dir})

  [1] LIVE      what the last scan saw, and the scan-activity history
  [2] HISTORY   every token ever recorded, with its trace and outcome
  [3] EVIDENCE  the labelled outcomes and what they do and do not support
  [q] quit
`;

/* -------------------------------------------------------------------- read */

/** Everything the screen needs, straight off disk. No network. */
async function readState({ dir, now }, deps = {}) {
  const list = deps.readdir ?? readdir;
  const read = deps.readFile ?? readFile;
  let files = [];
  try {
    files = (await list(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    /* no directory yet: everything below degrades to empty, which is honest */
  }
  const lines = [];
  for (const file of files) {
    try {
      lines.push(...(await read(join(dir, file), 'utf8')).split('\n'));
    } catch {
      /* a file that vanished mid-read is not worth failing the whole screen for */
    }
  }
  const { rows, ticks } = buildWatchlist(lines);
  const snap = await latestSnapshot({ dir, now }, deps);
  return { files, lines, rows, ticks, snap };
}

/* -------------------------------------------------------------------- views */

function headerLines(state) {
  const { snap, ticks } = state;
  const ageS = snap.snapshotAgeMs === null ? null : Math.round(snap.snapshotAgeMs / MS_PER_SECOND);
  const healthy = isRecorderHealthy(snap.snapshotAgeMs, RECORDER.snapshotIntervalSeconds);
  const spanH = ticks.length > 1 ? (ticks[ticks.length - 1].ts - ticks[0].ts) / MS_PER_HOUR : 0;

  const status = healthy
    ? `${ANSI.green}recording${ANSI.reset} ${ANSI.grey}(last snapshot ${ageS}s ago)${ANSI.reset}`
    : ageS === null
      ? `${ANSI.red}NO RECORDING${ANSI.reset} ${ANSI.grey}- run: npm run start${ANSI.reset}`
      : `${ANSI.red}RECORDER STALE${ANSI.reset} ${ANSI.grey}(${ageS}s since last snapshot; ` +
        `expected every ${RECORDER.snapshotIntervalSeconds}s - this screen is FROZEN, ` +
        `not calm)${ANSI.reset}`;

  const tabs = VIEWS.map((v, i) =>
    v === state.view
      ? `${ANSI.bold}${ANSI.cyan}[${i + 1}] ${v.toUpperCase()}${ANSI.reset}`
      : `${ANSI.grey}[${i + 1}] ${v}${ANSI.reset}`,
  ).join('  ');

  return [
    `${ANSI.bold}SOLSCALP${ANSI.reset}  ${status}   ${ANSI.grey}` +
      `${ticks.length} scans over ${spanH.toFixed(1)}h${ANSI.reset}`,
    `${tabs}   ${ANSI.grey}[q] quit  paper only, nothing here can sign${ANSI.reset}`,
  ];
}

function liveView(state, cols, rows) {
  const { snap, ticks } = state;
  const at = state.now;
  const withHits = ticks.filter((t) => t.safe > 0).length;

  const lines = [
    `${ANSI.grey}scan activity${ANSI.reset}  ${activityStrip(ticks, Math.max(20, cols - 30))}`,
    `${ANSI.grey}${ticks.length} scans, ${withHits} found something the gate passed` +
      `   profile ${snap.profile ?? '?'}${ANSI.reset}`,
    '',
  ];

  if (ticks.length === 0) {
    // Nothing has ever scanned. Saying "the filter is working" here would be a
    // lie of exactly the kind this project exists to avoid: an empty screen
    // because nothing ran is not an empty screen because nothing qualified.
    lines.push(`${ANSI.yellow}Nothing has been recorded yet.${ANSI.reset}`);
    lines.push('');
    lines.push(`${ANSI.grey}This screen only shows what the recorder wrote, and the recorder has${ANSI.reset}`);
    lines.push(`${ANSI.grey}not written anything. That is not a quiet market -- it is no data.${ANSI.reset}`);
    lines.push('');
    lines.push(`${ANSI.bold}Start it with:  npm run start${ANSI.reset}`);
    return pane({ title: 'LAST SCAN', lines, cols, rows });
  }

  if (snap.candidates.length === 0) {
    lines.push(`${ANSI.grey}The last scan saw nothing that cleared the universe screen.${ANSI.reset}`);
    lines.push(`${ANSI.grey}98.6% of these tokens are rugs or under $1k liquidity, so an empty${ANSI.reset}`);
    lines.push(`${ANSI.grey}scan is the filter working. The strip above is the proof it is running.${ANSI.reset}`);
    return pane({ title: 'LAST SCAN', lines, cols, rows });
  }

  lines.push(
    `${ANSI.grey}${pad('TOKEN', 11)}${pad('MCAP', 10)}${pad('LIQ', 10)}${pad('5m', 8)}` +
      `${pad('1h', 9)}${pad('B/S', 6)}${pad('ACC', 6)}${pad('SEEN', 6)}${pad('SAFE?', 22)}` +
      `ENTER?${ANSI.reset}`,
  );

  for (const c of snap.candidates) {
    const pair = snap.pairs.find((p) => p.mint === c.mint);
    const s = pair ? readSignals(pair, at) : {};
    const row = state.rows.find((r) => r.mint === c.mint);
    const gate = snap.gateResults[c.mint];
    const safe = gate?.buyable
      ? `${ANSI.green}SAFE${ANSI.reset}`
      : `${ANSI.red}blocked${ANSI.reset} ${ANSI.grey}${(gate?.rejectedBy?.[0] ?? gate?.erroredIn?.[0] ?? '').slice(0, 13)}${ANSI.reset}`;
    // The entry decision is a SEPARATE question from safety, and collapsing the
    // two is the most expensive misreading available here.
    const enter = !gate?.buyable
      ? `${ANSI.grey}-${ANSI.reset}`
      : (c.wouldEnter ?? false)
        ? `${ANSI.bold}${ANSI.green}YES${ANSI.reset}`
        : `${ANSI.grey}no${ANSI.reset}`;
    lines.push(
      pad((c.symbol ?? '?').slice(0, 10), 11) +
        pad(usd(s.marketCapUsd ?? c.marketCapUsd), 10) +
        pad(usd(s.liquidityUsd ?? c.liquidityUsd), 10) +
        pad(pct(c.priceChangeM5Pct), 8) +
        pad(pct(c.priceChangeH1Pct), 9) +
        pad(c.buySellRatioM5 === null ? 'n/a' : c.buySellRatioM5.toFixed(1), 6) +
        pad(c.volumeAccelerationRatio === null ? 'n/a' : c.volumeAccelerationRatio.toFixed(1), 6) +
        pad(String(row?.seen ?? 1), 6) +
        pad(safe, 22) +
        enter,
    );
  }
  return pane({
    title: 'LAST SCAN',
    lines,
    cols,
    rows,
    note: 'SAFE? = gate   ENTER? = momentum rules',
  });
}

function historyView(state, cols, rows) {
  // Every token ever recorded, worst first. The trace is real: one point per
  // sighting, which is why it is evidence rather than decoration.
  const enriched = state.rows
    .map((r) => {
      const lastLiq = [...r.series].reverse().find((p) => typeof p.liq === 'number')?.liq ?? null;
      // The labeller re-fetched to decide; its measurement is the honest "now".
      // The recording's own tail is not: the recorder stops observing a token the
      // moment it falls out of the screen, so its last value is the last HEALTHY
      // reading rather than the outcome.
      const measured = r.labelEvidence?.liquidityAfterUsd ?? null;
      const nowLiq = measured ?? lastLiq;
      const change =
        r.entryLiquidityUsd && nowLiq !== null && r.entryLiquidityUsd > 0
          ? ((nowLiq - r.entryLiquidityUsd) / r.entryLiquidityUsd) * 100
          : null;
      return { ...r, nowLiq, change, measured: measured !== null };
    })
    .sort((a, b) => (a.change ?? 0) - (b.change ?? 0));

  const lines = [
    `${ANSI.grey}${pad('TOKEN', 11)}${pad('LIQ@ENTRY', 11)}${pad('LATEST', 11)}${pad('CHANGE', 9)}` +
      `${pad('TRACE', 14)}${pad('SEEN', 6)}${pad('AGE', 6)}${pad('GATE', 9)}OUTCOME${ANSI.reset}`,
  ];
  for (const r of enriched) {
    const label = r.storedLabel ?? '';
    const tone =
      label === LABEL.RUGGED ? ANSI.red : label === LABEL.SURVIVED ? ANSI.green : ANSI.grey;
    lines.push(
      pad((r.symbol ?? '?').slice(0, 10), 11) +
        pad(usd(r.entryLiquidityUsd), 11) +
        pad(usd(r.nowLiq) + (r.measured ? '' : `${ANSI.grey}~${ANSI.reset}`), 11) +
        pad(r.change === null ? 'n/a' : pct(r.change), 9) +
        pad(sparkline(r.series, 12), 14) +
        pad(String(r.seen), 6) +
        pad(`${((state.now - r.firstTs) / MS_PER_HOUR).toFixed(0)}h`, 6) +
        pad(r.gateBuyable ? `${ANSI.green}passed${ANSI.reset}` : `${ANSI.grey}blocked${ANSI.reset}`, 9) +
        `${tone}${label || 'unlabelled'}${ANSI.reset}`,
    );
  }
  return pane({
    title: `HISTORY - ${enriched.length} tokens ever recorded`,
    lines,
    cols,
    rows,
    note: '~ = last recorded, not re-measured',
  });
}

function evidenceView(state, cols, rows) {
  const tally = tallyRecords(state.lines);
  const report = scoreRugFilter(tally);
  const lines = [
    `${ANSI.bold}THE QUESTION${ANSI.reset} ${ANSI.grey}of the tokens the gate APPROVED,` +
      ` what fraction later rugged?${ANSI.reset}`,
    '',
    `  snapshots recorded   ${tally.snapshots}`,
    `  unique mints seen    ${tally.uniqueMints}`,
    `  gate approved        ${tally.approved + tally.unlabelled}`,
    `    labelled           ${tally.approved}`,
    `    ${ANSI.grey}still unlabelled   ${tally.unlabelled}  <- counted as UNKNOWN, never as survived${ANSI.reset}`,
    `  gate blocked         ${tally.rejected}`,
    `    ${ANSI.grey}labelled ${tally.blockedLabelled}, of those rugged ${tally.blockedRugged}${ANSI.reset}`,
    '',
  ];

  if (!report.sufficient) {
    lines.push(`${ANSI.yellow}NO RATE REPORTED${ANSI.reset}`);
    lines.push(`  ${report.reason}`);
    lines.push('');
    lines.push(
      `${ANSI.grey}  Labelling runs automatically every ${LABELS.autoLabelEveryMinutes} min; a token needs` +
        ` ${LABELS.minAgeHoursBeforeLabelling}h before${ANSI.reset}`,
    );
    lines.push(`${ANSI.grey}  its outcome means anything. This is the slow part and cannot be rushed:${ANSI.reset}`);
    lines.push(`${ANSI.grey}  the dataset cannot be reconstructed after the fact.${ANSI.reset}`);
  } else {
    lines.push(
      `${ANSI.bold}  approved-and-rugged  ${report.rugged}/${report.approved} = ` +
        `${report.ruggedPct.toFixed(1)}%${ANSI.reset}`,
    );
    lines.push(`  95% interval         ${report.interval.low.toFixed(1)}% .. ${report.interval.high.toFixed(1)}%`);
    lines.push(`  population base rate ${BASE_RATE_PCT}%`);
    lines.push(`  lift                 ${report.liftPctPoints.toFixed(1)} percentage points`);
    lines.push('');
    if (tally.blockedLabelled >= MIN_SAMPLE) {
      const blockedPct = (tally.blockedRugged / tally.blockedLabelled) * 100;
      const gap = blockedPct - report.ruggedPct;
      lines.push(`${ANSI.bold}  CONTROL: rejected-and-rugged ${blockedPct.toFixed(1)}%${ANSI.reset}`);
      lines.push(`  separation ${gap.toFixed(1)} points`);
      lines.push(
        gap <= 0
          ? `${ANSI.red}  NOT DISCRIMINATING: what it blocked rugged no more often than what it passed.${ANSI.reset}`
          : `${ANSI.green}  The gate blocked a dirtier cohort than it passed.${ANSI.reset}`,
      );
    } else {
      lines.push(
        `${ANSI.grey}  No control comparison yet: ${tally.blockedLabelled} labelled rejects, ` +
          `${MIN_SAMPLE} needed. Beating the base rate alone cannot show it discriminates.${ANSI.reset}`,
      );
    }
  }
  return pane({ title: 'EVIDENCE', lines, cols, rows });
}

function footerLines(state, cols) {
  const book = `${ANSI.grey}book ${usd(RISK.bookSizeUsd)}  position ${usd(RISK.positionSizeUsd)}  ` +
    `mcap ${usd(STRATEGY.universe.minMarketCapUsd)}-${usd(STRATEGY.universe.maxMarketCapUsd)}${ANSI.reset}`;
  return [pad(book, cols)];
}

function render(state) {
  const { cols, rows } = size();
  const header = headerLines(state);
  const footer = footerLines(state, cols);
  const body = Math.max(6, rows - HEADER_ROWS - footer.length - 1);
  const view =
    state.view === 'history'
      ? historyView(state, cols, body)
      : state.view === 'evidence'
        ? evidenceView(state, cols, body)
        : liveView(state, cols, body);
  paint([...header, ...view, ...footer]);
}

/* -------------------------------------------------------------------- main */

/**
 * @param {readonly string[]} argv
 * @param {object} [injected]
 * @returns {Promise<number>}
 */
export async function main(argv, injected = {}) {
  const { flags } = parseArgs(argv);
  if (flags.help === true) {
    (injected.out ?? console.log)(USAGE);
    return EXIT.OK;
  }
  const dir = typeof flags.dir === 'string' ? flags.dir : RECORDER.dir;
  const refreshMs = intFlag(flags.refresh, 5) * MS_PER_SECOND;
  const now = injected.now ?? Date.now;
  const sleep = injected.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxCycles = flags.cycles === undefined ? Infinity : intFlag(flags.cycles, 1);

  // --view picks the starting pane, so a view can be scripted or captured without
  // keystrokes (and so this screen is testable at all).
  let view = VIEWS.includes(flags.view) ? flags.view : VIEWS[0];
  let running = true;

  // Raw mode so a single keypress switches view without waiting for Enter.
  const stdin = injected.stdin ?? process.stdin;
  const interactive = typeof stdin.setRawMode === 'function' && stdin.isTTY;
  if (interactive) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (key) => {
      if (key === 'q' || key === '') running = false;
      else if (key === '1') view = VIEWS[0];
      else if (key === '2') view = VIEWS[1];
      else if (key === '3') view = VIEWS[2];
    });
  }

  await withScreen(async () => {
    let cycles = 0;
    while (running && cycles < maxCycles) {
      const at = now();
      let state;
      try {
        state = { ...(await readState({ dir, now: at }, injected)), view, now: at };
      } catch (err) {
        state = {
          files: [], lines: [], rows: [], ticks: [],
          snap: { snapshotAgeMs: null, candidates: [], pairs: [], gateResults: {}, profile: null },
          view, now: at, error: err?.message ?? String(err),
        };
      }
      render(state);
      cycles += 1;
      if (running && cycles < maxCycles) {
        // Poll in slices so a keypress is felt immediately rather than after a
        // whole refresh interval.
        for (let waited = 0; waited < refreshMs && running; waited += 120) {
          await sleep(Math.min(120, refreshMs - waited));
        }
      }
    }
  });

  if (interactive) {
    stdin.setRawMode(false);
    stdin.pause();
  }
  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
