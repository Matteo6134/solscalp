#!/usr/bin/env node
/**
 * The dashboard. Built on Ink, so the terminal gets a real layout engine.
 *
 * WHY INK AND NOT HAND-ROLLED ANSI
 *   The previous version budgeted every column by hand against an unknown
 *   terminal width. One line a character too long wrapped, which pushed every
 *   line below it down and produced a screen of text sitting on top of itself --
 *   measured at 81 and 86 characters on an 80-column terminal. Ink measures and
 *   truncates for you, so that class of bug is gone structurally rather than
 *   patched. It also diffs frames instead of repainting, so no flicker, and its
 *   input handling works where raw-mode fiddling did not.
 *
 * THE THREE JOBS ARE ALREADY DECOUPLED
 *   The usual reason a terminal dashboard freezes is that the render loop waits
 *   on an API. That cause is absent here: this process makes NO upstream calls at
 *   all. scripts/lib/dashData.js reads the recorder's append-only JSONL, the
 *   recorder does the fetching in its own process, and keypresses are handled by
 *   Ink's input hook independently of the read timer. So the interface cannot be
 *   blocked by a slow Solana RPC, because it never talks to one.
 *
 * IT REMEMBERS
 *   The recording is the history. Closing this window loses nothing, and a
 *   restart re-reads hours of ticks and every sighting of every token.
 *
 * WHAT IT CANNOT DO
 *   It cannot see anything the recorder did not record. If the recorder dies this
 *   screen freezes -- so the header carries the snapshot age and turns red,
 *   because a frozen screen otherwise looks exactly like a calm market.
 */

import { Box, Text, render, useApp, useInput, useStdin } from 'ink';
import { createElement as h, useEffect, useState } from 'react';
import { RECORDER } from '../src/config.js';
import { EMPTY, buildDashData } from './lib/dashData.js';
import { EXIT, intFlag, isMain, parseArgs, runMain } from './lib/cli.js';

const MS_PER_SECOND = 1_000;
const VIEWS = Object.freeze(['live', 'history', 'evidence']);
const BLOCKS = Object.freeze(['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']);

const USAGE = `usage: npm run dash -- [--refresh S] [--view V] [--dir PATH]

One screen over the recorder's output. Makes no network calls of its own, so it
is safe to leave running next to the recorder and the bot.

  --refresh S  seconds between reads (default 3)
  --view V     start on live | history | evidence
  --dir PATH   recordings directory (default ${RECORDER.dir})

  1 / 2 / 3    switch view        <- / ->   also switch
  r            re-read now        q         quit
`;

/* ------------------------------------------------------------------ format */

const usd = (n) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : n < 10
      ? `$${n.toFixed(4)}`
      : `$${Math.round(n).toLocaleString('en-US')}`;

const pct = (n) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

const num = (n, d = 1) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d);

/** Colour by how far the pool has fallen. Semantic, not decorative. */
function tone(change) {
  if (change === null || change === undefined) return 'gray';
  if (change <= -90) return 'red';
  if (change <= -50) return 'yellow';
  return change < 0 ? 'white' : 'green';
}

/** One block character per sighting. Blank when too few points to be honest. */
function sparkline(series, width = 12, minPoints = 4) {
  const pts = series.filter((p) => Number.isFinite(p.liq));
  if (pts.length < minPoints) return '';
  const step = pts.length <= width ? 1 : (pts.length - 1) / (width - 1);
  const sampled =
    pts.length <= width
      ? pts
      : Array.from({ length: width }, (_, i) => pts[Math.round(i * step)]);
  const vals = sampled.map((p) => p.liq);
  const lo = Math.min(...vals);
  const span = Math.max(...vals) - lo;
  if (span === 0) return '▄'.repeat(sampled.length);
  return sampled
    .map((p) => BLOCKS[Math.min(7, Math.floor(((p.liq - lo) / span) * BLOCKS.length))])
    .join('');
}

/* -------------------------------------------------------------------- cells */

/**
 * Fit a column set into the available width, dropping the lowest-priority
 * columns first.
 *
 * Hard-coding widths that sum past the terminal is what produced the original
 * mess: Ink will truncate a cell's text, but it cannot create horizontal space,
 * so the row wraps and the layout comes apart anyway. Budgeting the columns is
 * the only fix that holds at any width.
 *
 * @param {readonly {key:string,w:number,keep?:number}[]} cols
 * @param {number} budget printable columns available
 */
export function fitColumns(cols, budget) {
  const ordered = [...cols].sort((a, b) => (b.keep ?? 0) - (a.keep ?? 0));
  const chosen = [];
  let used = 0;
  for (const c of ordered) {
    if (used + c.w > budget) continue;
    chosen.push(c);
    used += c.w;
  }
  // Restore the author's column order; priority only decided what survived.
  return cols.filter((c) => chosen.includes(c));
}


/** A fixed-width cell. Ink truncates, so no manual width arithmetic. */
const Cell = ({ w, children, ...rest }) =>
  h(Box, { width: w, flexShrink: 0 }, h(Text, { wrap: 'truncate', ...rest }, children));

const Head = ({ w, children }) =>
  h(Cell, { w, dimColor: true, bold: true }, children);

/* -------------------------------------------------------------------- views */

function ActivityStrip({ ticks, width }) {
  if (ticks.length === 0) return null;
  const w = Math.max(10, width);
  const step = ticks.length <= w ? 1 : (ticks.length - 1) / (w - 1);
  const sampled =
    ticks.length <= w ? ticks : Array.from({ length: w }, (_, i) => ticks[Math.round(i * step)]);
  const max = Math.max(1, ...sampled.map((t) => t.seen));
  const hits = ticks.filter((t) => t.safe > 0).length;
  const spanH =
    ticks.length > 1 ? (ticks[ticks.length - 1].ts - ticks[0].ts) / 3_600_000 : 0;

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      null,
      sampled.map((t, i) =>
        h(
          Text,
          { key: i, color: t.safe > 0 ? 'green' : t.seen > 0 ? 'cyan' : 'gray' },
          t.seen === 0 ? '·' : BLOCKS[Math.min(7, Math.floor((t.seen / max) * BLOCKS.length))],
        ),
      ),
    ),
    h(
      Text,
      { dimColor: true },
      `${ticks.length} scans over ${spanH.toFixed(1)}h · ${hits} found something the gate passed`,
    ),
  );
}

function LiveView({ data, width }) {
  if (data.ticks.length === 0) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: 'yellow', bold: true }, 'Nothing has been recorded yet.'),
      h(Text, null, ''),
      h(
        Text,
        { dimColor: true, wrap: 'wrap' },
        'This screen only shows what the recorder wrote, and it has written nothing. ' +
          'That is not a quiet market — it is no data.',
      ),
      h(Text, null, ''),
      h(Text, { bold: true }, 'Start it with:  npm run start'),
    );
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(ActivityStrip, { ticks: data.ticks, width: width - 5 }),
    h(Text, null, ''),
    data.lastScan.length === 0
      ? h(
          Text,
          { dimColor: true, wrap: 'wrap' },
          'The last scan saw nothing that cleared the universe screen. 98.6% of these ' +
            'tokens are rugs or under $1k liquidity, so an empty scan is the filter ' +
            'working — the strip above is the proof it is running.',
        )
      : h(
          Box,
          { flexDirection: 'column' },
          (() => {
            const cols = fitColumns(
              [
                { key: 'sym', w: 11, keep: 9, head: 'TOKEN', cell: (c) => [(c.symbol ?? '?').slice(0, 9), { bold: true }] },
                { key: 'safe', w: 9, keep: 8, head: 'SAFE?', cell: (c) => [c.gateBuyable ? 'SAFE' : 'blocked', { color: c.gateBuyable ? 'green' : 'red' }] },
                { key: 'enter', w: 7, keep: 8, head: 'ENTER?', cell: (c) => (c.gateBuyable ? [c.wouldEnter ? 'ENTER' : 'no', { color: c.wouldEnter ? 'green' : 'gray', bold: Boolean(c.wouldEnter) }] : ['—', { dimColor: true }]) },
                { key: 'mcap', w: 10, keep: 7, head: 'MCAP', cell: (c) => [usd(c.marketCapUsd), {}] },
                { key: 'liq', w: 10, keep: 6, head: 'LIQ', cell: (c) => [usd(c.liquidityUsd), {}] },
                { key: 'm5', w: 8, keep: 5, head: '5m', cell: (c) => [pct(c.priceChangeM5Pct), { color: (c.priceChangeM5Pct ?? 0) >= 0 ? 'green' : 'red' }] },
                { key: 'h1', w: 9, keep: 4, head: '1h', cell: (c) => [pct(c.priceChangeH1Pct), { color: (c.priceChangeH1Pct ?? 0) >= 0 ? 'green' : 'red' }] },
                { key: 'acc', w: 6, keep: 3, head: 'ACC', cell: (c) => [num(c.volumeAccelerationRatio, 1), {}] },
                { key: 'bs', w: 6, keep: 2, head: 'B/S', cell: (c) => [num(c.buySellRatioM5, 1), {}] },
                { key: 'age', w: 6, keep: 1, head: 'AGE', cell: (c) => [c.ageMinutes === null ? '—' : Math.round(c.ageMinutes) + 'm', {}] },
              ],
              width,
            );
            return h(
              Box,
              { flexDirection: 'column' },
              h(Box, null, ...cols.map((col) => h(Head, { key: col.key, w: col.w }, col.head))),
              ...data.lastScan.map((c) =>
                h(
                  Box,
                  { key: c.mint },
                  ...cols.map((col) => {
                    const [text, props] = col.cell(c);
                    return h(Cell, { key: col.key, w: col.w, ...props }, String(text));
                  }),
                ),
              ),
            );
          })(),
          h(Text, null, ''),
          h(
            Text,
            { dimColor: true, wrap: 'wrap' },
            'SAFE? is the gate — the creator probably cannot steal your tokens. ENTER? is ' +
              'the momentum rules. Different questions: most tokens are one without the other, ' +
              'and a soft rug passes every safety check.',
          ),
        ),
  );
}

function HistoryView({ data, rows, width }) {
  if (data.history.length === 0) {
    return h(Text, { dimColor: true }, 'Nothing recorded yet.');
  }
  const visible = data.history.slice(0, Math.max(3, rows - 9));
  const cols = fitColumns(
    [
      { key: 'sym', w: 11, keep: 9, head: 'TOKEN', cell: (r) => [(r.symbol ?? '?').slice(0, 9), { bold: true }] },
      { key: 'chg', w: 9, keep: 8, head: 'CHANGE', cell: (r) => [pct(r.changePct), { color: tone(r.changePct), bold: true }] },
      { key: 'trace', w: 13, keep: 7, head: 'TRACE', cell: (r) => [sparkline(r.series, 12), { color: tone(r.changePct) }] },
      { key: 'entry', w: 10, keep: 6, head: 'AT ENTRY', cell: (r) => [usd(r.entryLiquidityUsd), {}] },
      { key: 'now', w: 11, keep: 5, head: 'LATEST', cell: (r) => [usd(r.nowLiquidityUsd) + (r.measured ? '' : '~'), {}] },
      { key: 'label', w: 11, keep: 4, head: 'OUTCOME', cell: (r) => [r.label ?? 'unlabelled', { color: r.label === data.config.RUGGED ? 'red' : r.label === data.config.SURVIVED ? 'green' : 'gray' }] },
      { key: 'gate', w: 8, keep: 3, head: 'GATE', cell: (r) => [r.gateBuyable ? 'passed' : 'blocked', { color: r.gateBuyable ? 'green' : 'gray' }] },
      { key: 'seen', w: 6, keep: 2, head: 'SEEN', cell: (r) => [String(r.seen), {}] },
      { key: 'age', w: 5, keep: 1, head: 'AGE', cell: (r) => [r.ageHours.toFixed(0) + 'h', {}] },
    ],
    width,
  );
  return h(
    Box,
    { flexDirection: 'column' },
    h(Box, null, ...cols.map((col) => h(Head, { key: col.key, w: col.w }, col.head))),
    ...visible.map((r) =>
      h(
        Box,
        { key: r.mint },
        ...cols.map((col) => {
          const [text, props] = col.cell(r);
          return h(Cell, { key: col.key, w: col.w, ...props }, String(text));
        }),
      ),
    ),
    h(Text, null, ''),
    h(
      Text,
      { dimColor: true, wrap: 'wrap' },
      `${data.history.length} tokens recorded${visible.length < data.history.length ? `, showing ${visible.length}` : ''}. ` +
        'AT ENTRY is the first sighting. A ~ on LATEST means it is the last recorded value, ' +
        'not re-measured — that runs high, because the recorder stops watching a token the ' +
        'moment it drops out of the screen. Each TRACE block is one real sighting.',
    ),
  );
}

function EvidenceView({ data }) {
  const { tally, report, baseRatePct, minSample } = data.evidence;
  const rows = [
    ['snapshots recorded', String(tally.snapshots)],
    ['unique mints seen', String(tally.uniqueMints)],
    ['gate approved', String(tally.approved + tally.unlabelled)],
    ['  of those, labelled', String(tally.approved)],
    ['  still unlabelled', `${tally.unlabelled}   (counted as UNKNOWN, never as survived)`],
    ['gate blocked', String(tally.rejected)],
    ['  of those, labelled', `${tally.blockedLabelled}, rugged ${tally.blockedRugged}`],
  ];

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      { wrap: 'wrap' },
      h(Text, { bold: true }, 'The question: '),
      'of the tokens the gate approved, what fraction later rugged — against the ',
      h(Text, { bold: true }, `${baseRatePct}%`),
      ' population base rate?',
    ),
    h(Text, null, ''),
    ...rows.map(([k, v], i) =>
      h(Box, { key: i }, h(Cell, { w: 24, dimColor: true }, k), h(Text, null, v)),
    ),
    h(Text, null, ''),
    report.sufficient
      ? h(
          Box,
          { flexDirection: 'column' },
          h(
            Text,
            { bold: true },
            `approved-and-rugged  ${report.rugged}/${report.approved} = ${report.ruggedPct.toFixed(1)}%`,
          ),
          h(
            Text,
            null,
            `95% interval  ${report.interval.low.toFixed(1)}% .. ${report.interval.high.toFixed(1)}%` +
              `   lift ${report.liftPctPoints.toFixed(1)} points`,
          ),
          h(Text, null, ''),
          tally.blockedLabelled >= minSample
            ? h(
                Text,
                {
                  wrap: 'wrap',
                  color:
                    (tally.blockedRugged / tally.blockedLabelled) * 100 - report.ruggedPct <= 0
                      ? 'red'
                      : 'green',
                },
                `Control: what it REJECTED rugged at ` +
                  `${((tally.blockedRugged / tally.blockedLabelled) * 100).toFixed(1)}%. ` +
                  ((tally.blockedRugged / tally.blockedLabelled) * 100 - report.ruggedPct <= 0
                    ? 'The gate is NOT discriminating — it blocked a cohort no dirtier than the one it passed.'
                    : 'The gate blocked a dirtier cohort than it passed, which is what working looks like.'),
              )
            : h(
                Text,
                { dimColor: true, wrap: 'wrap' },
                `No control comparison yet: ${tally.blockedLabelled} labelled rejects, ${minSample} needed. ` +
                  'Beating the base rate alone cannot show the gate discriminates between tokens ' +
                  'rather than just discarding them.',
              ),
        )
      : h(
          Box,
          { flexDirection: 'column' },
          h(Text, { color: 'yellow', bold: true }, 'No rate reported'),
          h(Text, { dimColor: true, wrap: 'wrap' }, report.reason ?? ''),
          h(Text, null, ''),
          h(
            Text,
            { dimColor: true, wrap: 'wrap' },
            `Labelling runs automatically every ${data.config.autoLabelEveryMinutes} minutes, and a ` +
              `token needs ${data.config.minAgeHoursBeforeLabelling}h before its outcome means anything. ` +
              'This is the slow part and it cannot be rushed: the dataset cannot be reconstructed ' +
              'after the fact.',
          ),
        ),
  );
}

/* ---------------------------------------------------------------------- app */

function App({ dir, refreshMs, initialView }) {
  const { exit } = useApp();
  // Ink THROWS from useInput when the terminal has no raw mode -- which is the
  // likely cause of 'the keys do nothing': not a bug in the handler, but a
  // terminal that never delivers the keypress. Detect it and say so, rather than
  // crashing or silently ignoring input.
  const stdin = useStdin();
  // Coerce to a REAL boolean. Ink defaults isActive to true, and a default
  // parameter fires on `undefined` -- so passing the raw value through when it
  // is undefined silently enables input and Ink then throws 'Raw mode is not
  // supported'. isTTY is the source of truth; Ink's own flag was undefined here.
  const canType = stdin.isRawModeSupported === true || process.stdin.isTTY === true;
  const [view, setView] = useState(initialView);
  const [data, setData] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [reads, setReads] = useState(0);
  const [nudge, setNudge] = useState(0);

  const termCols = process.stdout.columns || 100;
  // The bordered box costs 2 columns, paddingX:1 costs 2 more. Budget against
  // what is actually left, not against the terminal width.
  const inner = Math.max(28, termCols - 6);
  const rows = process.stdout.rows || 30;

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const next = await buildDashData({ dir, now: Date.now() });
        if (!live) return;
        setData(next);
        setError(null);
        setReads((n) => n + 1);
      } catch (err) {
        if (live) setError(err?.message ?? String(err));
      }
    };
    read();
    const timer = setInterval(read, refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [dir, refreshMs, nudge]);

  // Input is handled independently of the read timer, so a keypress is never
  // waiting on anything.
  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) exit();
    else if (input === '1') setView(VIEWS[0]);
    else if (input === '2') setView(VIEWS[1]);
    else if (input === '3') setView(VIEWS[2]);
    else if (input === 'r') setNudge((n) => n + 1);
    else if (key.rightArrow || key.tab)
      setView((v) => VIEWS[(VIEWS.indexOf(v) + 1) % VIEWS.length]);
    else if (key.leftArrow)
      setView((v) => VIEWS[(VIEWS.indexOf(v) + VIEWS.length - 1) % VIEWS.length]);
  }, { isActive: canType });

  const age =
    data.recorder.snapshotAgeMs === null
      ? null
      : Math.round(data.recorder.snapshotAgeMs / MS_PER_SECOND);

  const status = data.recorder.healthy
    ? h(Text, { color: 'green' }, `recording · last snapshot ${age}s ago`)
    : age === null
      ? h(Text, { color: 'red', bold: true }, 'NO RECORDING — run: npm run start')
      : h(
          Text,
          { color: 'red', bold: true },
          `RECORDER STALE — ${age}s since last snapshot (expected every ` +
            `${data.recorder.expectedEverySeconds}s). This screen is FROZEN, not calm.`,
        );

  return h(
    Box,
    { flexDirection: 'column', width: inner },
    h(
      Box,
      { gap: 2 },
      h(Text, { bold: true }, 'SOLSCALP'),
      status,
      h(Text, { dimColor: true }, `profile ${data.recorder.profile ?? '?'}`),
    ),
    h(
      Box,
      { gap: 2, marginTop: 1 },
      ...VIEWS.map((v, i) =>
        h(
          Text,
          {
            key: v,
            bold: v === view,
            color: v === view ? 'cyan' : undefined,
            dimColor: v !== view,
          },
          `${i + 1} ${v.toUpperCase()}`,
        ),
      ),
      canType
        ? h(Text, { dimColor: true }, '· ←/→ switch · r reload · q quit')
        : h(
            Text,
            { color: 'yellow' },
            '· no keys here: use --view',
          ),
    ),
    h(
      Box,
      {
        borderStyle: 'round',
        borderDimColor: true,
        flexDirection: 'column',
        paddingX: 1,
        marginTop: 1,
        width: termCols,
      },
      error !== null
        ? h(Text, { color: 'red', wrap: 'wrap' }, `read failed: ${error}`)
        : view === 'history'
          ? h(HistoryView, { data, rows, width: inner })
          : view === 'evidence'
            ? h(EvidenceView, { data })
            : h(LiveView, { data, width: inner }),
    ),
    h(
      Box,
      { gap: 2 },
      h(
        Text,
        { dimColor: true },
        `book ${usd(data.config.bookSizeUsd)} · position ${usd(data.config.positionSizeUsd)} · ` +
          `mcap ${usd(data.config.minMarketCapUsd)}–${usd(data.config.maxMarketCapUsd)} · ` +
          `paper only · reads ${reads}`,
      ),
    ),
  );
}

/* --------------------------------------------------------------------- main */

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
  const refreshMs = intFlag(flags.refresh, 3) * MS_PER_SECOND;
  const initialView = VIEWS.includes(flags.view) ? flags.view : VIEWS[0];

  // --once renders a single frame and exits: the only way this screen is
  // testable, and useful for a quick look without taking over the terminal.
  if (flags.once === true) {
    const { buildDashData: build } = await import('./lib/dashData.js');
    const data = await build({ dir, now: Date.now() });
    const app = render(
      h(Box, { flexDirection: 'column' }, h(App, { dir, refreshMs: 1e9, initialView })),
      { patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 250));
    app.unmount();
    void data;
    return EXIT.OK;
  }

  const app = render(h(App, { dir, refreshMs, initialView }));
  await app.waitUntilExit();
  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
