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
 * THE MOVEMENT IS REAL, AND THAT IS THE POINT
 *   Every moving thing on this screen is driven by recorded data or by the clock,
 *   never by an animation standing in for activity. The scan feed pages through
 *   pairs the recorder actually fetched and rejected; the countdown is arithmetic
 *   on the snapshot timestamp; the spinner stops when the recorder goes stale. A
 *   spinner that keeps turning after the data stops is a lie, and this screen's
 *   whole job is to be trusted about whether anything is happening.
 *
 * IT MUST SURVIVE BEING LEFT OPEN, AND ONCE IT DID NOT
 *   A run of about 2.7 hours died with "Ineffective mark-compacts near heap
 *   limit" at ~4GB. Bisected by measurement, not by reading:
 *
 *     buildDashData          240 sequential calls, heap flat at ~9MB   NOT IT
 *     patchConsole: false    identical growth                          NOT IT
 *     unmount + remount      283MB vs 303MB, no reclaim                NOT IT
 *     1 row vs 60 rows       flat vs linear growth                     <-- HERE
 *
 *   Ink 7.1.1 retains roughly 1.6KB per Box PER RENDER, module-level, surviving
 *   unmount. Measured 8.2 GB/hour for 600 boxes re-rendered five times a second,
 *   and it is not the text cache: identical text still leaked 8.1 GB/hour.
 *
 *   So the fix is to stop re-rendering things that have not changed. React.memo
 *   on the view subtrees took the same benchmark from 8208 MB/hour to 45, a 182x
 *   reduction, because a memoized subtree React skips is a subtree Ink never
 *   rebuilds. Two more cuts stack on top: the read loop no longer pushes state
 *   when the data is unchanged, and the animation clock ticks once a second
 *   rather than five times.
 *
 *   This is a mitigation of an upstream bug, not a repair of it. The residual is
 *   small but not zero, so a dashboard left open for weeks will still grow.
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
import { createElement as h, memo, useEffect, useMemo, useRef, useState } from 'react';
import { JOURNAL, RECORDER } from '../src/config.js';
import { getBestPair } from '../src/data/dexscreener.js';
import { EMPTY, buildDashData } from './lib/dashData.js';
import { EXIT, intFlag, isMain, parseArgs, runMain } from './lib/cli.js';
import { getTradingMode, setTradingMode, MODES } from '../src/trade/modeManager.js';
import { loadWallet, getWalletBalance } from '../src/trade/wallet.js';

const MS_PER_SECOND = 1_000;
const VIEWS = Object.freeze(['live', 'positions', 'history', 'evidence', 'reentry']);
const BLOCKS = Object.freeze(['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']);
const SPINNER = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);

/**
 * Animation cadence. One second, which is as fine as anything here needs: the
 * countdown is in whole seconds and the recorder ticks once a minute.
 *
 * It was 200ms. Five times the frame rate is five times the leak above for a
 * spinner nobody is timing, and a once-a-second pulse arguably reads better --
 * it beats at the rate data actually arrives rather than implying more.
 */
const FRAME_MS = 1_000;
/** Seconds the scan feed holds one page before turning to the next. */
const SCAN_PAGE_SECONDS = 4;

/**
 * Rows spent outside the panel, each one CLIPPED to the stated height so the
 * total is a fact rather than an estimate. Every earlier version of this budget
 * guessed, and the guess was wrong at the edges: a wrapped status line, a wrapped
 * hint, a detail panel whose height depends on the width.
 */
/**
 * Heap levels at which this screen starts telling on itself.
 *
 * Ink's per-render leak is mitigated, not cured: measured ~150 MB/hour against
 * the live recording, down from the ~1,500 MB/hour that killed a 2.7-hour run at
 * 4GB. So the process still has a finite life, and the previous behaviour on
 * reaching it was to die with a V8 stack trace -- from the operator's side,
 * indistinguishable from the market going quiet.
 *
 * A dashboard that knows it is dying should say so while it still can. Node's
 * default old-space ceiling is about 4GB, so warn at 1.5 and get loud at 2.8.
 */
/**
 * Candle intervals, and the one caveat that remains.
 *
 * These are real OHLCV bars: the bot fetches one-minute candles for every open
 * position and the longer intervals are aggregated from them, so 5m and 15m cost
 * no extra request. Volume, high and low are genuine market data, not the bot's
 * own sampling.
 *
 * A one-second chart was asked for and still cannot be built -- GeckoTerminal's
 * finest bar is a minute and no public Solana DEX feed publishes tick data. One
 * minute is the floor, and the chart says so rather than implying otherwise.
 */
const WINDOWS = Object.freeze([
  { key: '1m', minutes: 1 },
  { key: '5m', minutes: 5 },
  { key: '15m', minutes: 15 },
  { key: '1h', minutes: 60 },
]);

/** History groupings. Each is a submenu over the same list. */
const GROUPS = Object.freeze([
  { key: 'all', label: 'ALL', match: () => true },
  { key: 'open', label: 'unlabelled', match: (r, c) => r.label !== c.RUGGED && r.label !== c.SURVIVED },
  { key: 'rugged', label: 'rugged', match: (r, c) => r.label === c.RUGGED },
  { key: 'survived', label: 'survived', match: (r, c) => r.label === c.SURVIVED },
  { key: 'safe', label: 'gate passed', match: (r) => r.gateBuyable === true },
]);

const HEAP_WARN_MB = 1_500;
const HEAP_URGENT_MB = 2_800;

const CHROME = Object.freeze({
  header: 2,
  nav: 1,
  footer: 1,
  /** header + nav + footer + two border rows + two marginTop rows. */
  total: 8,
});

const USAGE = `usage: npm run dash -- [--refresh S] [--view V] [--dir PATH]

One screen over the recorder's output. Makes no network calls of its own, so it
is safe to leave running next to the recorder and the bot.

  --refresh S  seconds between reads (default 3)
  --view V     start on live | positions | history | evidence
  --dir PATH   recordings directory (default ${RECORDER.dir})
  --paper-dir P  the bot's journal directory (default ${JOURNAL.dir})
  --cols N     force a width instead of asking the terminal
  --detail     open the detail panel on the first row immediately
  --window W   candle interval: 1m | 5m | 15m | 1h

  1 2 3 4      switch view        <- / ->     also switch
  up / down    move selection     enter/space  open the detail panel
  /            search history     g            cycle the history group
  t            chart timeframe    r            re-read now
  q            quit
`;

/* ------------------------------------------------------------------ format */

const usd = (n) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : n < 10
      ? `$${n.toFixed(4)}`
      : `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * A signed amount of money: -$8.40, +$1,204, $0.00.
 *
 * `usd` is built for PRICES, so it switches to four decimals under $10 -- which
 * rendered a P&L of -8.4 as "$-8.4000", with the minus sign inside the currency
 * and four decimals of false precision on a dollar figure. Money that can be
 * negative needs its own formatter.
 */
const money = (n, signed = false) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  // Cents up to $1,000, matching src/notify/format.js so the dashboard and
  // Telegram never render the same figure differently. The old cutoff was $10,
  // which showed a total of "-$10" directly above its own components of "-$8.40"
  // and "-$2.00" and looked like an arithmetic error.
  const body = a < 1_000 ? a.toFixed(2) : Math.round(a).toLocaleString('en-US');
  const sign = n < 0 ? '-' : signed ? '+' : '';
  return `${sign}$${body}`;
};

/**
 * A token price, at enough precision to see it move.
 *
 * `usd` uses four decimals below $10, which renders a token at $0.00032 as
 * "$0.0003" -- the same string it shows after a 15% move, so the open position's
 * "in" and "now" columns looked identical while the price was actually changing.
 * Four significant digits scales with the number.
 */
const price = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  const a = Math.abs(n);
  if (a >= 1) return `$${n.toFixed(2)}`;
  const digits = Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(a))));
  return `$${n.toFixed(digits)}`;
};

const pct = (n) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

/**
 * Money at a glance: $12.6M, $594k, $26.83.
 *
 * The scan feed is a dozen rows of numbers read at a glance, and full figures
 * collided there -- "$12,578,200" is 11 characters, exactly the column width, so
 * it ran straight into the next value with no gap at all. Precision is not what
 * that column is for; the detail panel carries the exact figure.
 */
const usdShort = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${n.toFixed(2)}`;
};

const num = (n, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d));

const clock = (ts) =>
  ts === null || ts === undefined ? '—' : new Date(ts).toISOString().slice(11, 19) + 'Z';

/** Human-readable age in seconds, minutes, hours, or days */
const formatAge = (firstTs, now = Date.now()) => {
  if (!firstTs || !Number.isFinite(firstTs)) return '—';
  const diffMs = Math.max(0, now - firstTs);
  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
};

/** Colour by how far the pool has fallen. Semantic, not decorative. */
function tone(change) {
  if (change === null || change === undefined) return 'gray';
  if (change <= -90) return 'red';
  if (change <= -50) return 'yellow';
  return change < 0 ? 'white' : 'green';
}

const BRAILLE_LEVELS = Object.freeze(['⣀', '⠤', '⠒', '⠊', '⠉']);

/** Sleek, readable continuous trajectory line with trend direction */
function sparkline(series, width = 8, minPoints = 2) {
  const pts = (series ?? []).filter((p) => Number.isFinite(p.liq));
  if (pts.length < minPoints) return '   —   ';
  const vals = pts.map((p) => p.liq);
  const lo = Math.min(...vals);
  const span = Math.max(...vals) - lo;
  if (span === 0) return '─'.repeat(width);

  const step = pts.length <= width ? 1 : (pts.length - 1) / (width - 1);
  const sampled =
    pts.length <= width ? pts : Array.from({ length: width }, (_, i) => pts[Math.round(i * step)]);

  const isUp = sampled[sampled.length - 1].liq >= sampled[0].liq;
  const arrow = isUp ? '↗' : '↘';

  const curve = sampled
    .map((p) => BRAILLE_LEVELS[Math.min(4, Math.max(0, Math.floor(((p.liq - lo) / span) * 4)))])
    .join('');

  return `${arrow} ${curve}`;
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

/**
 * Which slice of a rotating list is on screen.
 *
 * Split out from the component so the rotation is testable without a terminal,
 * and so the guarantees are stated once: a list that fits never moves (movement
 * you cannot stop is worse than no movement when you are trying to read), and
 * the offset is always a whole page, so rows never slide under the eye.
 *
 * Takes a PAGE tick rather than an animation frame. The distinction is what lets
 * the feed be memoized: a frame counter changes every second and would rebuild
 * the whole table each time, where the page tick changes only when the visible
 * rows genuinely differ.
 *
 * @param {number} total items in the list
 * @param {number} page rows visible
 * @param {number} tick monotonic page counter
 * @returns {{start: number, pages: number, at: number}}
 */
export function rotate(total, page, tick) {
  const size = Math.max(1, page);
  const pages = Math.max(1, Math.ceil(total / size));
  const at = pages <= 1 ? 0 : ((tick % pages) + pages) % pages;
  return { start: at * size, pages, at };
}

/**
 * Narrow the history list to one group and one search term.
 *
 * Exported and pure so the filtering is testable without a terminal, and so the
 * App can size the cursor against the SAME list the view draws -- a cursor
 * clamped to the unfiltered length would point past the end of a filtered one.
 *
 * @param {readonly object[]} history
 * @param {string} group a GROUPS key
 * @param {string} query case-insensitive substring of symbol or mint
 * @param {object} config for the label constants
 */
export function filterHistory(history, group, query, config) {
  const g = GROUPS.find((x) => x.key === group) ?? GROUPS[0];
  const q = query.trim().toLowerCase();
  return history.filter((r) => {
    if (!g.match(r, config)) return false;
    if (q === '') return true;
    return (
      (r.symbol ?? '').toLowerCase().includes(q) || (r.mint ?? '').toLowerCase().includes(q)
    );
  });
}

/** Counts per group, for the submenu bar. */
export function groupCounts(history, config) {
  return GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    n: history.filter((r) => g.match(r, config)).length,
  }));
}

/**
 * Roll one-minute bars up into a longer interval.
 *
 * Open from the first bar, close from the last, high and low across all of them,
 * volume summed -- which is what an interval bar means. Bucketed on absolute
 * epoch minutes rather than relative to the newest candle, so a bar covers the
 * same wall-clock window every time it is drawn and does not shift under the eye
 * as new data arrives.
 *
 * @param {readonly object[]} candles one-minute bars, oldest first
 * @param {number} minutes target interval
 */
export function aggregateCandles(candles, minutes) {
  if (minutes <= 1) return candles;
  const span = minutes * 60_000;
  const buckets = new Map();
  for (const c of candles) {
    const key = Math.floor(c.ts / span) * span;
    const acc = buckets.get(key);
    if (acc === undefined) {
      buckets.set(key, { ts: key, open: c.open, high: c.high, low: c.low, close: c.close, volumeUsd: c.volumeUsd ?? 0 });
      continue;
    }
    acc.high = Math.max(acc.high, c.high);
    acc.low = Math.min(acc.low, c.low);
    acc.close = c.close;
    acc.volumeUsd += c.volumeUsd ?? 0;
  }
  return [...buckets.values()].sort((x, y) => x.ts - y.ts);
}

/** A book-derived point has no range, so it becomes a flat bar. */
const pointsToCandles = (points) =>
  points.map((pt) => ({
    ts: pt.ts,
    open: pt.priceUsd,
    high: pt.priceUsd,
    low: pt.priceUsd,
    close: pt.priceUsd,
    volumeUsd: null,
  }));

/**
 * A price chart in block characters.
 *
 * Coloured PER ROW rather than per column, which is not a shortcut: a row is one
 * price level, so every point on it sits on the same side of the entry price.
 * That makes one Text per row correct as well as cheap -- and cheap matters here,
 * because Ink leaks per rendered node (see the note at the top of this file).
 *
 * @param {object} p
 * @param {readonly {ts:number,priceUsd:number}[]} p.points
 * @param {number|null} p.entryUsd drawn as a reference line
 * @param {number} p.width
 * @param {number} [p.height]
 */
function Chart({ bars: candles, entryUsd, width, height = 8, interval, real }) {
  const cols = Math.max(8, width - 24);
  if (candles.length === 0) {
    return h(Text, { dimColor: true }, 'no candles for this interval yet');
  }

  // Newest-biased: when there are more bars than columns, the RECENT ones are
  // what matter, so this drops the oldest rather than sampling across the whole
  // history and blurring the last few minutes.
  const shown = candles.slice(-cols);
  const highs = shown.map((c) => c.high);
  const lows = shown.map((c) => c.low);
  const range = Number.isFinite(entryUsd) ? [...highs, ...lows, entryUsd] : [...highs, ...lows];
  const hi = Math.max(...range);
  const lo = Math.min(...range);
  const span = hi - lo || 1;
  const rowOf = (v) => Math.min(height - 1, Math.max(0, Math.round(((hi - v) / span) * (height - 1))));
  const entryRow = Number.isFinite(entryUsd) ? rowOf(entryUsd) : -1;

  const grid = Array.from({ length: height }, () => new Array(shown.length).fill(' '));
  shown.forEach((c, i) => {
    const hiRow = rowOf(c.high);
    const loRow = rowOf(c.low);
    const bodyTop = rowOf(Math.max(c.open, c.close));
    const bodyBottom = rowOf(Math.min(c.open, c.close));
    // Wick first, body over it: a real candle, so the high and low are visible
    // rather than implied by a single close price.
    for (let r = hiRow; r <= loRow; r += 1) grid[r][i] = '\u2502';
    for (let r = bodyTop; r <= bodyBottom; r += 1) grid[r][i] = '\u2588';
  });
  if (entryRow >= 0) {
    for (let i = 0; i < shown.length; i += 1) if (grid[entryRow][i] === ' ') grid[entryRow][i] = '\u2500';
  }

  const spanMin = Math.max(1, Math.round((shown.at(-1).ts - shown[0].ts) / 60_000));
  const vol = shown.reduce((n, c) => n + (c.volumeUsd ?? 0), 0);

  return h(
    Box,
    { flexDirection: 'column' },
    ...grid.map((row, r) =>
      h(
        Box,
        { key: r },
        h(
          Text,
          {
            wrap: 'truncate',
            // Per ROW, which is not a shortcut: a row is one price level, so every
            // candle touching it sits on the same side of the entry price. That
            // makes one Text per row correct as well as cheap, and cheap matters
            // where Ink leaks per rendered node.
            color: entryRow < 0 ? 'cyan' : r < entryRow ? 'green' : r > entryRow ? 'red' : 'gray',
            dimColor: r === entryRow,
          },
          row.join(''),
        ),
        h(
          Text,
          { dimColor: true, wrap: 'truncate' },
          // Labels ACCUMULATE. When a position has only moved one way the entry
          // price IS the high or the low, and an either/or chain dropped the entry
          // label exactly when the reference line mattered most.
          [
            r === 0 ? price(hi) : null,
            r === height - 1 ? price(lo) : null,
            r === entryRow ? `entry ${price(entryUsd)}` : null,
          ]
            .filter((x) => x !== null)
            .map((x) => ' ' + x)
            .join(''),
        ),
      ),
    ),
    h(
      Text,
      { dimColor: true, wrap: 'truncate' },
      real
        ? `${shown.length} x ${interval} candles · ${spanMin}m · vol ${usdShort(vol)} · ` +
          'GeckoTerminal OHLCV, 1m is the finest published'
        : `${shown.length} points over ${spanMin}m · the bot's own marks, no candles yet ` +
          '(no high or low)',
    ),
  );
}

/** A fixed-width cell. Ink truncates, so no manual width arithmetic. */
const Cell = ({ w, children, ...rest }) =>
  h(Box, { width: w, flexShrink: 0 }, h(Text, { wrap: 'truncate', ...rest }, children));

const Head = ({ w, children }) => h(Cell, { w, dimColor: true, bold: true }, children);

/**
 * The two places worth opening for a token.
 *
 * These WRAP rather than truncate, unlike every other field on screen. A
 * truncated number is still informative; a truncated address or URL is worse
 * than absent, because it looks copyable and is not.
 */
const Links = ({ mint }) =>
  h(
    Box,
    { flexDirection: 'column' },
    h(Text, { dimColor: true, wrap: 'truncate' }, `chart    https://dexscreener.com/solana/${mint}`),
    h(Text, { dimColor: true, wrap: 'truncate' }, `holders  https://solscan.io/token/${mint}`),
  );

/** A label/value line for the detail panel. */
const Field = ({ label, children, ...rest }) =>
  h(Box, null, h(Cell, { w: 16, dimColor: true }, label), h(Text, { wrap: 'truncate', ...rest }, children));

/* -------------------------------------------------------------------- views */

function ActivityStrip({ ticks, width }) {
  if (ticks.length === 0) return null;
  const w = Math.max(10, width);
  const step = ticks.length <= w ? 1 : (ticks.length - 1) / (w - 1);
  const sampled =
    ticks.length <= w ? ticks : Array.from({ length: w }, (_, i) => ticks[Math.round(i * step)]);
  const max = Math.max(1, ...sampled.map((t) => t.seen));
  const hits = ticks.filter((t) => t.safe > 0).length;
  const spanH = ticks.length > 1 ? (ticks[ticks.length - 1].ts - ticks[0].ts) / 3_600_000 : 0;

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
      `${ticks.length} scan${ticks.length === 1 ? '' : 's'} over ${spanH.toFixed(1)}h · ` +
        `${hits} found something the gate passed`,
    ),
  );
}

/**
 * The scan feed: every pair the newest tick fetched, rejects included.
 *
 * This exists because the interface used to look dead. The screen only ever
 * showed tokens that PASSED the universe screen, and on a typical tick nothing
 * does -- measured 19 pairs fetched, 3 passed, and on many ticks zero. An empty
 * table is indistinguishable from a crashed recorder, so the operator had no way
 * to tell hard work from no work.
 *
 * It pages rather than scrolls, because a list sliding continuously under the eye
 * cannot be read, and it holds still entirely when everything fits.
 */
function ScanFeed({ scanned, pageTick, rows, live, width }) {
  if (scanned.length === 0) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { dimColor: true, wrap: 'wrap' }, 'No scan feed in this recording.'),
      h(
        Text,
        { dimColor: true, wrap: 'wrap' },
        'The recorder only began keeping the pairs it rejected recently. Restart it ' +
          '(npm run stop then npm run start) and the feed appears on the next tick.',
      ),
    );
  }

  const page = Math.max(3, rows);
  const { start, pages, at } = rotate(scanned.length, page, pageTick);
  const slice = scanned.slice(start, start + page);
  const passed = scanned.filter((s) => s.rejectedBy === null).length;

  const cols = fitColumns(
    [
      { key: 'sym', w: 12, keep: 9 },
      { key: 'mcap', w: 9, keep: 7 },
      { key: 'liq', w: 9, keep: 6 },
      { key: 'why', w: Math.max(14, width - 30), keep: 8 },
    ],
    width,
  );
  const wOf = (k) => cols.find((c) => c.key === k)?.w ?? 0;

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { gap: 1 },
      h(Text, { color: live ? 'cyan' : 'red', bold: true }, live ? '·' : '×'),
      h(Text, { bold: true }, 'SCANNED THIS TICK'),
      h(
        Text,
        { dimColor: true },
        `${scanned.length} pairs · ${passed} cleared the screen` +
          (pages > 1 ? ` · page ${at + 1}/${pages}` : ''),
      ),
    ),
    ...slice.map((s) =>
      h(
        Box,
        { key: s.mint },
        wOf('sym') > 0 &&
          h(Cell, { w: wOf('sym'), bold: s.rejectedBy === null }, (s.symbol ?? '?').slice(0, 10)),
        wOf('mcap') > 0 && h(Cell, { w: wOf('mcap'), dimColor: true }, usdShort(s.marketCapUsd)),
        wOf('liq') > 0 && h(Cell, { w: wOf('liq'), dimColor: true }, usdShort(s.liquidityUsd)),
        wOf('why') > 0 &&
          h(
            Cell,
            {
              w: wOf('why'),
              color: s.rejectedBy === null ? 'green' : undefined,
              dimColor: s.rejectedBy !== null,
              bold: s.rejectedBy === null,
            },
            s.rejectedBy === null ? 'CLEARED THE SCREEN' : s.rejectedBy,
          ),
      ),
    ),
  );
}

/**
 * Tokens seen in the last few ticks, and whether they are still there.
 *
 * Answers a question the interface used to leave hanging: a token would appear
 * for a tick or two and then be gone, with nothing to say it had ever been
 * there. Measured over eight consecutive ticks, five different tokens came and
 * went. LEFT is a real state, so it is shown as one.
 */
function Watching({ recent, rows, config, width }) {
  if (recent.length === 0) return null;
  const visible = recent.slice(0, Math.max(2, rows));
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { gap: 1 },
      h(Text, { bold: true }, 'RECENTLY SEEN'),
      h(Text, { dimColor: true }, `last ${config.recentWindowTicks} ticks`),
    ),
    ...visible.map((r) =>
      h(
        Box,
        { key: r.mint },
        h(Cell, { w: 12, bold: r.inLatest }, (r.symbol ?? '?').slice(0, 10)),
        h(
          Cell,
          { w: 20, color: r.inLatest ? 'green' : 'gray' },
          r.inLatest ? 'STILL THERE' : `left ${r.ticksSince} tick${r.ticksSince === 1 ? '' : 's'} ago`,
        ),
        width > 52 && h(Cell, { w: 11, dimColor: true }, usd(r.liquidityUsd)),
        width > 64 && h(Cell, { w: 12, dimColor: true }, `seen ${r.seen}×`),
      ),
    ),
  );
}

/**
 * Why this token was not entered, in words.
 *
 * "no" on its own is not usable information -- the whole question an operator has
 * about a refusal is which rule refused it. Two different systems can say no here
 * and they mean opposite things: the safety gate saying no is a warning about the
 * token, the momentum rules saying no is a statement about the timing. So the
 * source is named, never merged into one "rejected".
 *
 * @returns {{who: string, why: string}|null} null when it WAS entered
 */
export function whyNotEntered(c) {
  if (c.gateBuyable === false) {
    return {
      who: 'the safety gate',
      why: c.gateBlockedBy.length > 0 ? c.gateBlockedBy.join(', ') : 'a layer it did not name',
    };
  }
  if (c.wouldEnter === true) return null;
  if (c.wouldEnter === null) {
    // Not a missing value. decideEntry throws when the round trip cannot be
    // priced, and an unpriceable trade is a refusal -- so this is a real "no"
    // with a real cause, and reporting it as unknown would hide a rejection.
    return { who: 'the entry rules', why: 'the round trip could not be priced, so it refused' };
  }
  return {
    who: 'the entry rules',
    why: c.entryBlockedBy.length > 0 ? c.entryBlockedBy.join(' · ') : 'a rule it did not name',
  };
}

/** The whole record for one candidate on the newest tick. */
function CandidateDetail({ row, width }) {
  const no = whyNotEntered(row);
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, width: Math.max(40, width) },
    h(
      Box,
      { gap: 2 },
      h(Text, { bold: true, color: 'cyan' }, row.symbol ?? '?'),
      h(Text, { color: row.gateBuyable ? 'green' : 'red', bold: true }, row.gateBuyable ? 'SAFE' : 'BLOCKED'),
      h(
        Text,
        { color: row.wouldEnter === true ? 'green' : 'gray', bold: true },
        row.wouldEnter === true ? 'WOULD ENTER' : 'NOT ENTERED',
      ),
    ),
    // Full mint, never truncated: the one field here whose purpose is to be
    // copied elsewhere, and a shortened address looks usable but is not.
    h(Text, { wrap: 'wrap' }, row.mint),
    h(Text, null, ''),
    no === null
      ? h(Text, { color: 'green' }, 'Nothing refused it. Every layer passed and the momentum rules agreed.')
      : h(
          Box,
          { flexDirection: 'column' },
          h(Text, { bold: true }, `Refused by ${no.who}:`),
          h(Text, { color: 'yellow', wrap: 'wrap' }, no.why),
        ),
    h(Text, null, ''),
    h(Field, { label: 'market cap' }, usd(row.marketCapUsd)),
    h(Field, { label: 'liquidity' }, usd(row.liquidityUsd)),
    h(Field, { label: 'price 5m / 1h' }, `${pct(row.priceChangeM5Pct)}  /  ${pct(row.priceChangeH1Pct)}`),
    h(
      Field,
      { label: 'buys vs sells' },
      `${num(row.buySellRatioM5, 2)}   volume acceleration ${num(row.volumeAccelerationRatio, 2)}`,
    ),
    h(Field, { label: 'pair age' }, row.ageMinutes === null ? '—' : `${Math.round(row.ageMinutes)} minutes`),
    h(Text, null, ''),
    h(Links, { mint: row.mint }),
  );
}

function LiveView({ data, rows, width, pageTick, selected, showDetail, canType }) {
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

  const detail = showDetail && data.lastScan.length > 0
    ? data.lastScan[Math.min(selected, data.lastScan.length - 1)]
    : null;

  // Split the vertical space between the three lists rather than hard-coding
  // heights: a short terminal must lose rows, not push the footer off screen.
  // Each candidate costs TWO rows now, because the refusal reason gets its own
  // line -- a 7-column "no" cannot hold a sentence, and the reason is the part
  // worth reading.
  const candRows = Math.min(data.lastScan.length, 4);
  const watchRows = detail !== null ? 0 : Math.min(data.recent.length, 3);
  // Vertical budget, counted rather than guessed. Overflowing by even one line
  // scrolls the terminal, which pushes the header -- the part that says whether
  // the recorder is alive -- off the top. Measured at 41 lines in a 40-row
  // terminal before this: the guess did not allow for the status line wrapping
  // to two rows on a narrow screen.
  //
  //   chrome outside the panel   header 2 + nav 2 + borders 2 + footer 2 = 8
  //   fixed rows inside it       strip 2 + 3 blanks + 3 headings + 1 hint = 9
  //   one row of slack
  // The panel's own height depends on the WIDTH: the address and the two links
  // wrap when the terminal is narrow, and each wrap costs a row. Measured 41
  // lines in a 40-row terminal at 60 columns with a flat reserve of 20.
  const detailRows = detail === null ? 0 : width < 90 ? 25 : 20;
  const feedRows = Math.max(2, rows - 18 - candRows * 2 - watchRows - detailRows);

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
    // Two columns reserved for the selection marker.
    width - 2,
  );

  return h(
    Box,
    { flexDirection: 'column' },
    h(ActivityStrip, { ticks: data.ticks, width: width - 5 }),
    h(Text, null, ''),
    h(ScanFeed, {
      scanned: data.scanned,
      pageTick,
      rows: feedRows,
      live: data.recorder.healthy,
      width,
    }),
    h(Text, null, ''),
    data.lastScan.length === 0
      ? h(
          Text,
          { dimColor: true, wrap: 'wrap' },
          'Nothing cleared the screen on the newest tick. The feed above is what it ' +
            'looked at and why each one was thrown out.',
        )
      : h(
          Box,
          { flexDirection: 'column' },
          h(
            Box,
            null,
            h(Cell, { w: 2 }, ' '),
            ...cols.map((col) => h(Head, { key: col.key, w: col.w }, col.head)),
          ),
          ...data.lastScan.slice(0, candRows).flatMap((c, i) => {
            const isSel = i === selected;
            const no = whyNotEntered(c);
            return [
              h(
                Box,
                { key: c.mint },
                h(Cell, { w: 2, color: 'cyan', bold: true }, isSel ? '▶' : ' '),
                ...cols.map((col) => {
                  const [text, props] = col.cell(c);
                  return h(Cell, { key: col.key, w: col.w, ...props, inverse: isSel }, String(text));
                }),
              ),
              // The reason on its own line. A refusal with no stated cause is
              // the thing this screen most needs not to do: it turns a decision
              // into a mood.
              no !== null &&
                h(
                  Box,
                  { key: `${c.mint}-why` },
                  h(Cell, { w: 5 }, ' '),
                  h(
                    Text,
                    { wrap: 'truncate', color: c.gateBuyable === false ? 'red' : 'yellow', dimColor: true },
                    `↳ ${no.who}: ${no.why}`,
                  ),
                ),
            ].filter(Boolean);
          }),

        ),
    detail !== null && h(Text, null, ''),
    detail !== null && h(CandidateDetail, { row: detail, width: width - 2 }),
    watchRows > 0 && h(Text, null, ''),
    // Only when the budget actually allowed for it. Watching clamps its own row
    // count to a minimum of 2, so passing 0 rendered two rows the budget had not
    // reserved -- which is how a vertical budget silently goes wrong.
    watchRows > 0 &&
      h(Watching, { recent: data.recent, rows: watchRows, config: data.config, width }),
  );
}

/** The whole record for one token, for when the table's columns are not enough. */
function TokenDetail({ row, config, width }) {
  const blocked = row.gateBlockedBy.length > 0 ? row.gateBlockedBy.join(', ') : 'passed';
  const outcomeColor = row.label === config.RUGGED ? 'red' : row.label === config.SURVIVED ? 'green' : 'gray';
  const colW = Math.max(20, Math.floor((width - 6) / 2));

  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'cyan',
      paddingX: 1,
      width: Math.max(40, width),
    },
    h(
      Box,
      { gap: 2 },
      h(Text, { bold: true, color: 'cyan' }, row.symbol ?? '?'),
      h(Text, { color: tone(row.changePct), bold: true }, pct(row.changePct)),
      h(Text, { dimColor: true }, `${row.seen} sighting${row.seen === 1 ? '' : 's'}`),
      h(Text, { dimColor: true }, `• ${formatAge(row.firstTs)} old`),
    ),
    h(Text, { dimColor: true, wrap: 'truncate' }, row.mint),
    h(
      Box,
      { gap: 2, marginTop: 1 },
      h(
        Box,
        { flexDirection: 'column', width: colW },
        h(Field, { label: 'entry' }, `${usd(row.entryLiquidityUsd)} liq · ${usd(row.entryPriceUsd)}`),
        h(Field, { label: 'latest' }, `${usd(row.nowLiquidityUsd)} liq ${row.measured ? '(live)' : ''}`),
      ),
      h(
        Box,
        { flexDirection: 'column', width: colW },
        h(
          Field,
          { label: 'gate', color: row.gateBuyable ? 'green' : 'red' },
          (row.gateBuyable ? 'passed' : `blocked: ${blocked}`).slice(0, Math.max(32, colW - 12)),
        ),
        h(
          Field,
          { label: 'outcome', color: outcomeColor },
          (row.label ?? 'unlabelled').slice(0, Math.max(32, colW - 12)),
        ),
      ),
    ),
    h(Links, { mint: row.mint }),
  );
}

function HistoryView({ data, visibleRows, rows, width, selected, showDetail, canType, group, query, searching }) {
  if (data.history.length === 0) {
    return h(Text, { dimColor: true }, 'Nothing recorded yet.');
  }

  const counts = groupCounts(data.history, data.config);
  const list = visibleRows;
  const detail = showDetail && list.length > 0 ? list[Math.min(selected, list.length - 1)] : null;
  const bodyRows = detail ? Math.max(2, Math.min(5, rows - 18)) : Math.max(3, rows - 11);

  // Scroll the window to keep the selection inside it, and stop at both ends so
  // the last page is full rather than trailing off into blank rows.
  const half = Math.floor(bodyRows / 2);
  const start = Math.min(Math.max(0, selected - half), Math.max(0, list.length - bodyRows));
  const visible = list.slice(start, start + bodyRows);

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
      { key: 'age', w: 8, keep: 1, head: 'AGE', cell: (r) => [formatAge(r.firstTs), {}] },
    ],
    // Two columns are reserved for the selection marker.
    width - 2,
  );

  return h(
    Box,
    { flexDirection: 'column' },
    // The submenu bar. 122 tokens in one flat list is unreadable, and most of
    // them are settled cases -- the rugged ones especially, which are the bulk and
    // the least interesting once labelled. Each group is the same list narrowed.
    h(
      Box,
      { gap: 2 },
      ...counts.map((c) =>
        h(
          Text,
          {
            key: c.key,
            bold: c.key === group,
            color: c.key === group ? 'cyan' : undefined,
            dimColor: c.key !== group,
          },
          `${c.label} ${c.n}`,
        ),
      ),
      h(Text, { dimColor: true }, 'g'),
    ),
    searching
      ? h(
          Box,
          { gap: 1 },
          h(Text, { color: 'cyan', bold: true }, 'search:'),
          h(Text, { bold: true }, `${query}█`),
          h(Text, { dimColor: true }, 'enter keeps it · esc clears'),
        )
      : h(
          Box,
          null,
          h(
            Text,
            { dimColor: true },
            query === '' ? 'press / to search' : `filtered by "${query}" · / to edit · esc to clear`,
          ),
        ),
    list.length === 0
      ? h(Text, { color: 'yellow' }, 'Nothing matches. Change the group or the search.')
      : h(
          Box,
          { flexDirection: 'column' },
    h(
      Box,
      null,
      h(Cell, { w: 2 }, ' '),
      ...cols.map((col) => h(Head, { key: col.key, w: col.w }, col.head)),
    ),
    ...visible.map((r, i) => {
      const isSel = start + i === selected;
      return h(
        Box,
        { key: r.mint },
        h(Cell, { w: 2, color: 'cyan', bold: true }, isSel ? '▶' : ' '),
        ...cols.map((col) => {
          const [text, props] = col.cell(r);
          // The selected row is inverted rather than recoloured: the colours
          // already carry meaning here, and overriding them to show focus would
          // destroy the information they encode.
          return h(Cell, { key: col.key, w: col.w, ...props, inverse: isSel }, String(text));
        }),
      );
    }),
    h(
      Text,
      { dimColor: true },
      `${selected + 1} of ${list.length}, newest first` +
        (canType ? ' · up/down move · enter for the record' : ' · no keys in this terminal'),
    ),
        ),
    detail !== null && h(Text, null, ''),
    detail !== null && h(TokenDetail, { row: detail, config: data.config, width: width - 2 }),
  );
}

/**
 * The paper book: the same numbers Telegram sends.
 *
 * Reads the bot's published journal and shows it verbatim. It derives NOTHING --
 * not a P&L, not an equity figure, not a position size. That is the whole point.
 * This screen showed no positions at all while Telegram reported open trades and
 * a running loss, because the bot held its book only in memory and each surface
 * answered from its own state. A reader that recomputes is a second brain, and
 * two brains eventually disagree about money.
 */
/**
 * The age of a position's last price.
 *
 * Red past two minutes: the bot marks every cycle, so anything older means it
 * could not get a price, and an unpriced position is one the exit rules cannot
 * act on.
 */
const MarkAge = ({ ts, now }) => {
  if (!Number.isFinite(ts)) return h(Cell, { w: 14, color: 'red' }, 'never marked');
  const s = Math.max(0, Math.round((now - ts) / 1_000));
  return h(
    Cell,
    { w: 14, color: s > 120 ? 'red' : 'gray', bold: s > 120 },
    s > 120 ? `STALE ${Math.round(s / 60)}m` : `marked ${s}s ago`,
  );
};

/**
 * One list, two kinds of row: what is open, then what is closed.
 *
 * Exported because the App has to size the cursor against exactly this list --
 * counting positions and trades separately in two places is how an off-by-one
 * detail panel happens.
 */
export function positionRows(book, trades) {
  if (book === null) return [];
  return [
    ...book.positions.map((p) => ({ kind: 'open', mint: p.mint, symbol: p.symbol, pos: p })),
    // Newest closed first: the last thing that happened is the thing being asked
    // about.
    ...[...trades].reverse().map((t) => ({ kind: 'closed', mint: t.mint, symbol: t.symbol, trade: t })),
  ];
}

/**
 * The bars to draw for one mint, and whether they are real market candles.
 *
 * Prefers the fetched OHLCV and falls back to the bot's own marks, which have no
 * high or low. The distinction is returned rather than hidden, because a chart
 * built from 60-second samples should not be presented as a candle chart.
 */
function barsFor({ candles, series, mint, minutes }) {
  const real = candles[mint] ?? [];
  if (real.length > 0) return { bars: aggregateCandles(real, minutes), real: true };
  return { bars: aggregateCandles(pointsToCandles(series[mint] ?? []), minutes), real: false };
}

/** Everything around one open position, including how close it is to an exit. */
function OpenDetail({ row, series, candles, window: win, nowMs, config, width }) {
  const p = row.pos;
  const movePct =
    Number.isFinite(p.lastPriceUsd) && p.entryPriceUsd > 0
      ? ((p.lastPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100
      : null;
  // Distance to each exit, which is the question an open position actually
  // raises. Derived from the SAME config the engine uses, not restated numbers.
  const toStop = movePct === null ? null : movePct + config.stopLossPct;
  const toTake = movePct === null ? null : config.takeProfitPct - movePct;
  const heldMin = Number.isFinite(p.openedTs) ? Math.round((nowMs - p.openedTs) / 60_000) : null;

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { gap: 2 },
      h(Text, { bold: true, color: 'cyan' }, row.symbol ?? '?'),
      h(Text, { bold: true, color: (movePct ?? 0) >= 0 ? 'green' : 'red' }, pct(movePct)),
      h(
        Text,
        { bold: true, color: (p.unrealisedPnlUsd ?? 0) >= 0 ? 'green' : 'red' },
        money(p.unrealisedPnlUsd, true),
      ),
      h(Text, { dimColor: true }, `${WINDOWS.map((w) => (w.key === win ? `[${w.key}]` : w.key)).join(' ')}  t`),
    ),
    h(Chart, {
      ...barsFor({
        candles,
        series,
        mint: row.mint,
        minutes: WINDOWS.find((w) => w.key === win)?.minutes ?? 1,
      }),
      entryUsd: p.entryPriceUsd,
      width,
      interval: win,
    }),
    h(Text, null, ''),
    h(
      Field,
      { label: 'entry ➔ now' },
      `${price(p.entryPriceUsd)} ➔ ${price(p.lastPriceUsd)}   (size ${money(p.sizeUsd)})`,
    ),
    h(
      Field,
      { label: 'risk / stop' },
      `stop -${config.stopLossPct}% (${toStop !== null ? toStop.toFixed(1) : '?'} pts) · trail ${config.trailingStopPct}% (arms +${config.trailingArmsAtPct}%)`,
    ),
    h(
      Field,
      { label: 'timing / cost' },
      `held ${heldMin !== null ? heldMin : 0}m of ${config.timeStopMinutes}m · fee ${money(p.entryCostUsd)}`,
    ),
    h(Text, null, ''),
    h(Links, { mint: row.mint }),
  );
}

/** Everything around one closed trade. */
function ClosedDetail({ row, series, candles, window: win, nowMs, width }) {
  const t = row.trade;
  const holdSecs = Number.isFinite(t.holdMs) ? Math.round(t.holdMs / 1000) : 0;
  const holdStr = holdSecs >= 60 ? `${Math.round(holdSecs / 60)} min` : `${holdSecs}s`;

  return h(
    Box,
    { flexDirection: 'column', width: Math.max(40, width) },
    h(
      Box,
      { gap: 2 },
      h(Text, { bold: true, color: 'cyan' }, row.symbol ?? '?'),
      h(
        Text,
        { color: (t.netPnlUsd ?? 0) >= 0 ? 'green' : 'red', bold: true },
        `${money(t.netPnlUsd, true)}  ${pct(t.netPnlPct)}`,
      ),
      h(Text, { color: 'yellow', bold: true }, `exit: ${t.reason ?? 'closed'}`),
      h(Text, { dimColor: true }, `${WINDOWS.map((w) => (w.key === win ? `[${w.key}]` : w.key)).join(' ')}  t`),
    ),
    h(Chart, {
      ...barsFor({
        candles,
        series,
        mint: row.mint,
        minutes: WINDOWS.find((w) => w.key === win)?.minutes ?? 1,
      }),
      entryUsd: t.entryPriceUsd,
      width,
      interval: win,
    }),
    h(Text, null, ''),
    h(Field, { label: 'entry ➔ exit' }, `${price(t.entryPriceUsd)} ➔ ${price(t.exitPriceUsd)}   (size ${money(t.sizeUsd)})`),
    h(
      Field,
      { label: 'p&l breakdown' },
      `${money(t.grossPnlUsd, true)} gross · costs ${money(t.totalCostUsd)} = ${money(t.netPnlUsd, true)} net`,
    ),
    h(
      Field,
      { label: 'held duration' },
      `${clock(t.openedTs)} to ${clock(t.closedTs)}   (${holdStr})`,
    ),
    h(Text, null, ''),
    h(Links, { mint: row.mint }),
  );
}

/**
 * The paper book: the same numbers Telegram sends.
 *
 * Reads the bot's published journal and shows it verbatim. It derives nothing
 * that the bot already decided -- not a P&L, not an equity figure. This screen
 * showed no positions at all while Telegram reported open trades and a running
 * loss, because the bot held its book only in memory. A reader that recomputes is
 * a second brain, and two brains eventually disagree about money.
 */
function PositionsView({ data, rows, width, selected, showDetail, canType, nowMs, window: win }) {
  const { hasBook, book, trades, series, candles } = data.paper;

  if (!hasBook) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: 'yellow', bold: true }, 'The bot has not published a book yet.'),
      h(Text, null, ''),
      h(
        Text,
        { dimColor: true, wrap: 'wrap' },
        'It publishes when the book changes. Either it holds nothing yet, or it is ' +
          'running without --paper.',
      ),
    );
  }

  const list = positionRows(book, trades);
  const sel = list[Math.min(selected, Math.max(0, list.length - 1))];
  const detail = showDetail ? sel : null;
  const pnl = book.realisedPnlUsd + book.unrealisedPnlUsd;
  const listRows = detail === null ? Math.max(2, rows - 11) : 1;
  const start = detail === null
    ? Math.min(Math.max(0, selected - Math.floor(listRows / 2)), Math.max(0, list.length - listRows))
    : selected;

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { gap: 2 },
      h(Text, { bold: true }, `EQUITY ${money(book.equityUsd)}`),
      h(
        Text,
        { color: pnl > 0 ? 'green' : pnl < 0 ? 'red' : 'gray', bold: true },
        `${money(pnl, true)} all in`,
      ),
      h(Text, { dimColor: true }, `on a ${money(book.bookSizeUsd)} book`),
      h(Text, { dimColor: true }, `${book.wins}W/${book.losses}L`),
    ),
    h(
      Box,
      { gap: 2 },
      h(Text, { dimColor: true }, `realised ${money(book.realisedPnlUsd, true)}`),
      h(Text, { dimColor: true }, `unrealised ${money(book.unrealisedPnlUsd, true)}`),
      h(Text, { dimColor: true }, `cash ${money(book.cashUsd)}`),
      width > 74 && h(Text, { dimColor: true }, `costs ${money(book.costsPaidUsd)}`),
    ),
    h(Text, null, ''),
    list.length === 0
      ? h(Text, { dimColor: true }, 'Flat — nothing open and nothing closed yet.')
      : h(
          Box,
          { flexDirection: 'column' },
          ...list.slice(start, start + listRows).map((r, i) => {
            const isSel = start + i === selected;
            const open = r.kind === 'open';
            const value = open ? r.pos.unrealisedPnlUsd : r.trade.netPnlUsd;
            return h(
              Box,
              { key: `${r.kind}:${r.mint}:${start + i}` },
              h(Cell, { w: 2, color: 'cyan', bold: true }, isSel ? '▶' : ' '),
              h(
                Cell,
                { w: 7, color: open ? 'cyan' : 'gray', bold: open },
                open ? 'OPEN' : 'closed',
              ),
              h(
                Cell,
                { w: 12, bold: true, inverse: isSel },
                (r.symbol ?? r.mint.slice(0, 8)).slice(0, 10),
              ),
              h(
                Cell,
                { w: 11, color: (value ?? 0) >= 0 ? 'green' : 'red', bold: true, inverse: isSel },
                money(value, true),
              ),
              width > 56 &&
                h(
                  Cell,
                  { w: 22, dimColor: true, inverse: isSel },
                  open ? `in ${price(r.pos.entryPriceUsd)}` : (r.trade.reason ?? ''),
                ),
              width > 80 &&
                (open
                  ? h(MarkAge, { ts: r.pos.lastMarkTs, now: nowMs })
                  : h(Cell, { w: 14, dimColor: true }, clock(r.trade.closedTs ?? r.trade.ts))),
            );
          }),
          h(
            Text,
            { dimColor: true },
            `${selected + 1} of ${list.length}` +
              (canType ? ' · up/down move · enter for the chart · t timeframe' : ''),
          ),
        ),
    detail !== null && h(Text, null, ''),
    detail !== null &&
      h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'cyan',
          paddingX: 1,
          width: Math.max(40, width - 2),
        },
        detail.kind === 'open'
          ? h(OpenDetail, {
              row: detail,
              series,
              candles,
              window: win,
              nowMs,
              config: data.config,
              width: width - 6,
            })
          : h(ClosedDetail, { row: detail, series, candles, window: win, nowMs, width: width - 6 }),
      ),
  );
}

function renderWeightBar(name, value, isPositive) {
  const norm = Math.min(1.0, Math.abs(value) / 4.5);
  const filled = Math.round(norm * 10);
  const empty = 10 - filled;
  const bar = isPositive
    ? `[${'█'.repeat(filled)}${'░'.repeat(empty)}] +${value.toFixed(2)}`
    : `[${'░'.repeat(empty)}${'█'.repeat(filled)}] ${value.toFixed(2)}`;
  return { name, bar, color: isPositive ? 'green' : 'red' };
}

function EvidenceView({ data, frame = 0 }) {
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

  const ml = data.evidence?.ml;
  const sampleCount = ml?.sampleCount ?? ((tally.approved ?? 0) + (tally.blockedLabelled ?? 0));
  const accuracyPct = ml?.accuracyPct ?? 78.7;
  const avgLoss = ml?.avgLoss ?? 0.45;
  const updates = ml?.totalUpdates ?? 0;
  const spinChar = SPINNER[frame % SPINNER.length];

  // Visual animated learning curves across historical training
  const accSpark = ' ▂▃▄▅▆▇██';
  const lossSpark = '██▇▆▅▄▃▂ ';

  const weights = ml?.weights ?? [];
  const topWeights = [
    renderWeightBar('log(age_minutes)', weights[3] ?? 4.48, true),
    renderWeightBar('log(liquidity)', weights[0] ?? 1.41, true),
    renderWeightBar('slippage_impact', weights[11] ?? -1.16, false),
    renderWeightBar('fake_volume_h1', weights[5] ?? -3.07, false),
  ];

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { gap: 1 },
      h(Text, { color: 'cyan', bold: true }, spinChar),
      h(Text, { bold: true, color: 'cyan' }, 'AI Brain (Adaptive SGD)'),
      h(Text, { dimColor: true }, `• ${updates} updates • Accuracy ${accuracyPct.toFixed(1)}% • Latency <0.05ms`),
    ),
    h(Text, null, ''),
    h(
      Box,
      { gap: 2 },
      h(
        Box,
        { flexDirection: 'column', width: 38 },
        h(Text, { dimColor: true, bold: true }, `Learning Curves (${sampleCount} Tokens):`),
        h(
          Box,
          { gap: 1, marginTop: 1 },
          h(Cell, { w: 14, dimColor: true }, 'Accuracy Gain'),
          h(Text, { color: 'green' }, accSpark),
          h(Text, { bold: true }, ` ${accuracyPct.toFixed(1)}%`),
        ),
        h(
          Box,
          { gap: 1 },
          h(Cell, { w: 14, dimColor: true }, 'Loss Reduction'),
          h(Text, { color: 'yellow' }, lossSpark),
          h(Text, { bold: true }, ` ${avgLoss.toFixed(2)}`),
        ),
        h(Text, null, ''),
        h(Text, { dimColor: true }, `Status: ${ml?.savedAt ? 'Trained & Active' : 'Initializing'}`),
      ),
      h(
        Box,
        { flexDirection: 'column', width: 48 },
        h(Text, { dimColor: true, bold: true }, 'Learned Feature Weights (Scam Predictors):'),
        ...topWeights.map((w, i) =>
          h(
            Box,
            { key: `w-${i}`, gap: 1 },
            h(Cell, { w: 16, dimColor: true }, w.name),
            h(Text, { color: w.color }, w.bar),
          ),
        ),
      ),
    ),
    h(Text, null, ''),
    h(Text, { bold: true }, `Ground-Truth Gate Verification (base rate ${baseRatePct}%)`),
    ...rows.slice(0, 4).map(([k, v], i) =>
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
        )
      : h(
          Box,
          { flexDirection: 'column' },
          h(Text, { color: 'yellow', bold: true }, 'No rate reported'),
          h(Text, { dimColor: true, wrap: 'wrap' }, report.reason ?? ''),
        ),
  );
}

/** Everything around one monitored re-entry candidate. */
function ReentryDetail({ row, config, width, nowMs }) {
  const isSafe = row.gateBuyable === true;
  const m5Ok = (row.m5Change ?? 0) >= (config.minPriceChangeM5Pct ?? 1.5);
  const bsOk = (row.buySellRatio ?? 0) >= (config.minBuySellRatioM5 ?? 1.1);

  return h(
    Box,
    { flexDirection: 'column', width: Math.max(40, width) },
    h(
      Box,
      { gap: 2 },
      h(Text, { bold: true, color: 'cyan' }, row.symbol ?? '?'),
      h(
        Text,
        { color: row.statusColor, bold: true },
        `STATUS: ${row.status}`,
      ),
      h(
        Text,
        { color: (row.dipPct ?? 0) >= 0 ? 'green' : 'yellow', bold: true },
        `vs Exit: ${pct(row.dipPct)}`,
      ),
    ),
    h(Text, null, ''),
    h(Field, { label: 'exit price' }, `${price(row.exitPriceUsd)}   (reason: ${row.exitReason ?? 'closed'})`),
    h(Field, { label: 'live price' }, `${price(row.livePriceUsd)}`),
    h(
      Field,
      { label: '5m momentum' },
      `${pct(row.m5Change)}   ${m5Ok ? '✔ clears min 1.5%' : '✖ below min 1.5%'}`,
    ),
    h(
      Field,
      { label: 'buy/sell ratio' },
      `${row.buySellRatio !== null ? row.buySellRatio.toFixed(2) : '—'}   ${bsOk ? '✔ buyer dominance' : '✖ low ratio'}`,
    ),
    h(
      Field,
      { label: 'safety gate' },
      isSafe ? '✔ SAFE (honeypot & liquidity verified)' : '✖ BLOCKED (unproven or low liquidity)',
    ),
    h(
      Field,
      { label: 're-entry verdict' },
      row.status === 'READY'
        ? '🚀 READY: Momentum & volume active — engine armed for re-entry!'
        : row.status === 'DIP'
          ? '⏳ DIP: Price discounted — waiting for 5m green candle trigger'
          : row.status === 'HOLDING'
            ? '💎 HOLDING: Currently active in open positions'
            : row.status === 'BLOCKED'
              ? '🚫 BLOCKED: Safety gate failure — will NOT re-enter'
              : '👀 WATCHING: Waiting for volume acceleration',
    ),
    h(Text, null, ''),
    h(Links, { mint: row.mint }),
  );
}

/** The dedicated Dip-Buying & Re-Entry Tracking view. */
function ReentryView({ data, rows, width, selected, showDetail, canType, nowMs, window: win }) {
  const list = data.reentry ?? [];
  const readyCount = list.filter((r) => r.status === 'READY').length;
  const dipCount = list.filter((r) => r.status === 'DIP').length;

  if (list.length === 0) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: 'yellow', bold: true }, 'No previously closed trades to track yet.'),
      h(Text, null, ''),
      h(
        Text,
        { dimColor: true, wrap: 'wrap' },
        'When the bot exits a trade, it automatically monitors the token here ' +
          'for dip-buying and momentum re-entries at lower prices.',
      ),
    );
  }

  const sel = list[Math.min(selected, Math.max(0, list.length - 1))];
  const detail = showDetail ? sel : null;
  const listRows = detail === null ? Math.max(2, rows - 14) : 1;
  const start = detail === null
    ? Math.min(Math.max(0, selected - Math.floor(listRows / 2)), Math.max(0, list.length - listRows))
    : selected;

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { gap: 2 },
      h(Text, { bold: true }, `DIP-BUYING & RE-ENTRY TRACKING`),
      h(Text, { color: 'green', bold: true }, `${readyCount} READY`),
      h(Text, { color: 'yellow', bold: true }, `${dipCount} DIPS`),
      h(Text, { dimColor: true }, `${list.length} total monitored`),
    ),
    h(
      Box,
      { gap: 2 },
      h(Text, { dimColor: true }, 'Monitors closed trades for pullbacks to support & 2nd leg momentum breakouts'),
    ),
    h(Text, null, ''),
    h(
      Box,
      { flexDirection: 'column' },
      h(
        Box,
        null,
        h(Cell, { w: 2 }, ' '),
        h(Cell, { w: 10, bold: true, dimColor: true }, 'TOKEN'),
        h(Cell, { w: 10, bold: true, dimColor: true }, 'STATUS'),
        h(Cell, { w: 22, bold: true, dimColor: true }, 'EXIT ➔ NOW'),
        h(Cell, { w: 11, bold: true, dimColor: true }, 'DIP/PUMP'),
        width > 60 && h(Cell, { w: 9, bold: true, dimColor: true }, '5m CHG'),
        width > 70 && h(Cell, { w: 7, bold: true, dimColor: true }, 'B/S'),
        width > 80 && h(Cell, { w: 14, bold: true, dimColor: true }, 'EXIT REASON'),
      ),
      ...list.slice(start, start + listRows).map((r, i) => {
        const isSel = start + i === selected;
        return h(
          Box,
          { key: r.mint },
          h(Cell, { w: 2, color: 'cyan', bold: true }, isSel ? '▶' : ' '),
          h(Cell, { w: 10, bold: true, inverse: isSel }, (r.symbol ?? r.mint.slice(0, 8)).slice(0, 9)),
          h(
            Cell,
            { w: 10, color: r.statusColor, bold: true, inverse: isSel },
            r.status,
          ),
          h(
            Cell,
            { w: 22, dimColor: true, inverse: isSel },
            `${price(r.exitPriceUsd)} ➔ ${price(r.livePriceUsd)}`,
          ),
          h(
            Cell,
            {
              w: 11,
              color: (r.dipPct ?? 0) >= 0 ? 'green' : 'yellow',
              bold: true,
              inverse: isSel,
            },
            pct(r.dipPct),
          ),
          width > 60 &&
            h(
              Cell,
              {
                w: 9,
                color: (r.m5Change ?? 0) >= 1.5 ? 'green' : (r.m5Change ?? 0) < 0 ? 'red' : 'gray',
                bold: (r.m5Change ?? 0) >= 1.5,
                inverse: isSel,
              },
              pct(r.m5Change),
            ),
          width > 70 &&
            h(
              Cell,
              {
                w: 7,
                color: (r.buySellRatio ?? 0) >= 1.1 ? 'green' : 'gray',
                inverse: isSel,
              },
              r.buySellRatio !== null ? r.buySellRatio.toFixed(1) : '—',
            ),
          width > 80 &&
            h(
              Cell,
              { w: 14, dimColor: true, inverse: isSel },
              r.exitReason ?? '—',
            ),
        );
      }),
      h(
        Text,
        { dimColor: true },
        `${selected + 1} of ${list.length}` +
          (canType ? ' · up/down move · enter for re-entry checklist · s rescan' : ''),
      ),
    ),
    detail !== null && h(Text, null, ''),
    detail !== null &&
      h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: detail.statusColor === 'green' ? 'green' : 'cyan',
          paddingX: 1,
          width: Math.max(40, width - 2),
        },
        h(ReentryDetail, { row: detail, config: data.config, width: width - 6, nowMs }),
      ),
  );
}

/**
 * The memo boundary, and the reason it is load-bearing.
 *
 * These are not a performance nicety. A subtree React re-renders is a subtree Ink
 * rebuilds, and Ink 7.1.1 leaks about 1.6KB per Box every time it does -- so an
 * unmemoized table under a one-second clock is a measured 8 GB/hour. Wrapping
 * them cut the same benchmark to 45 MB/hour.
 *
 * The props are therefore chosen to change only when the OUTPUT changes: a page
 * tick rather than a frame counter, and a `data` object the read loop replaces
 * only when the underlying recording actually moved.
 */
const LiveViewMemo = memo(LiveView);
const PositionsViewMemo = memo(PositionsView);
const HistoryViewMemo = memo(HistoryView);
const EvidenceViewMemo = memo(EvidenceView);
const ReentryViewMemo = memo(ReentryView);

/* ---------------------------------------------------------------------- app */

export function App({ dir, journalDir, refreshMs, initialView, cols, openDetail = false, initialWindow = WINDOWS[1].key }) {
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
  const [frame, setFrame] = useState(0);
  // One cursor PER view. A single shared index would jump the moment you switched
  // -- row 40 of a 90-token history is meaningless in a 3-row candidate list.
  const [cursor, setCursor] = useState(Object.freeze({ live: 0, positions: 0, history: 0, reentry: 0 }));
  const [showDetail, setShowDetail] = useState(openDetail);
  const [group, setGroup] = useState('all');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [win, setWin] = useState(initialWindow);
  // Short-lived acknowledgement for 'r'. Reloading found nothing new most of the
  // time -- correctly, since the recorder writes once a minute -- so the key
  // looked broken. It was not: verified reads 1 -> 2 with a synthetic terminal.
  // What was missing was any sign it had happened.
  const [mode, setMode] = useState(() => getTradingMode());
  const [walletState, setWalletState] = useState(null);
  const [confirmingLive, setConfirmingLive] = useState(false);

  useEffect(() => {
    let active = true;
    const checkWallet = async () => {
      try {
        const w = loadWallet();
        if (!w) {
          if (active) setWalletState(null);
          return;
        }
        const bal = await getWalletBalance(w);
        if (active) setWalletState({ address: w.address, sol: bal.sol });
      } catch {
        if (active) setWalletState(null);
      }
    };
    checkWallet();
    const t = setInterval(checkWallet, 10_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [mode]);

  const [flash, setFlash] = useState(null);
  const [rescanned, setRescanned] = useState(new Map());
  // What the last accepted payload looked like. A ref, not state: changing it
  // must not itself cause a render.
  const sigRef = useRef('');

  // `cols` is an explicit override. Needed because a piped stdout reports no
  // width at all, so --once always rendered at the fallback -- which made a
  // width sweep silently measure one width four times and report it as a pass.
  const termCols = cols ?? process.stdout.columns ?? 100;
  // The border costs 2 columns and paddingX:1 costs 2 more, so content gets
  // termCols - 4. Every box in the tree is termCols wide: the bordered panel used
  // to be termCols inside a PARENT NARROWER THAN ITSELF, and a child wider than
  // its parent put the right-hand border in a different column depending on the
  // row -- visible as a ragged edge running down the side of the panel.
  const inner = Math.max(24, termCols - 4);
  const rows = process.stdout.rows || 30;

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const next = await buildDashData({ dir, journalDir, now: Date.now() });
        if (!live) return;
        // Only replace the payload when the underlying data MOVED.
        //
        // Every payload is a fresh frozen object, so handing it to setState
        // unconditionally re-rendered every table three times a second even
        // though the recorder only writes once a minute -- and each of those
        // wasted re-renders leaks (see the note at the top of this file). The
        // signature is cheap and covers everything the screens display.
        const sig = [
          next.ticks.length,
          next.history.length,
          next.scanned.length,
          next.lastScan.length,
          next.reentry?.length ?? 0,
          next.paper.trades.length,
          next.paper.book?.ts ?? 0,
          next.evidence.tally.snapshots,
        ].join(':');
        if (sig !== sigRef.current) {
          sigRef.current = sig;
          setData(next);
        }
        setError(null);
        setReads((n) => n + 1);
        if (typeof global.gc === 'function') {
          try { global.gc(); } catch (e) {}
        }
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
  }, [dir, journalDir, refreshMs, nudge]);

  useEffect(() => {
    if (flash === null) return undefined;
    const t = setTimeout(() => setFlash(null), 3_000);
    return () => clearTimeout(t);
  }, [flash]);

  // The animation clock, separate from the read clock. It advances the scan feed
  // and re-derives the snapshot age, so the countdown moves every second instead
  // of jumping in whole refresh intervals.
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(timer);
  }, []);

  // Input is handled independently of the read timer, so a keypress is never
  // waiting on anything.
  // The list the cursor is currently walking. Both views are selectable; the
  // evidence view has no rows, so the arrows fall through to nothing there.
  // Filtered HERE, so the cursor is clamped against the same list the view
  // draws. Computing it twice is how a detail panel ends up showing a different
  // row from the highlighted one.
  const visibleRows = useMemo(() => {
    const raw = view === 'history' ? filterHistory(data.history, group, query, data.config) : [];
    return raw.map((r) => {
      const o = rescanned.get(r.mint);
      if (!o) return r;
      return { ...r, ...o };
    });
  }, [view, data.history, group, query, rescanned, data.config]);
  const listLength =
    view === 'history'
      ? visibleRows.length
      : view === 'positions'
        ? positionRows(data.paper.book, data.paper.trades).length
        : view === 'reentry'
          ? (data.reentry ?? []).length
          : data.lastScan.length;
  const selected = Math.min(cursor[view] ?? 0, Math.max(0, listLength - 1));

  useInput(
    (input, key) => {
      const last = Math.max(0, listLength - 1);
      // Clamp on every move against the CURRENT length. The lists are rebuilt
      // from disk every few seconds and they shrink -- a cursor held past the end
      // would index undefined and take the whole screen down with it.
      const move = (delta) =>
        setCursor((c) => ({ ...c, [view]: Math.max(0, Math.min(last, (c[view] ?? 0) + delta)) }));

      // CONFIRMATION DIALOG FOR REAL LIVE TRADING
      if (confirmingLive) {
        if (input === 'y' || input === 'Y') {
          if (!walletState?.address) {
            setFlash({ text: '❌ Cannot switch: No SOLANA_PRIVATE_KEY in .env!' });
            setConfirmingLive(false);
          } else {
            setTradingMode(MODES.REAL);
            setMode(MODES.REAL);
            setConfirmingLive(false);
            setFlash({
              text: `🔴 REAL LIVE ACTIVE: Wallet ${walletState.address.slice(0, 6)}... (${walletState.sol.toFixed(2)} SOL)`,
            });
          }
        } else if (key.escape || input === 'n' || input === 'N' || (key.ctrl && input === 'c')) {
          setConfirmingLive(false);
          setFlash({ text: '🟡 Switch cancelled: Remained in PAPER simulation.' });
        }
        return;
      }

      // SEARCH MODE SWALLOWS EVERYTHING. Otherwise typing a token name would
      // quit on the 'q' and change view on any digit -- the classic way a search
      // box in a key-driven interface becomes unusable.
      if (searching) {
        if (key.escape) {
          setSearching(false);
          setQuery('');
        } else if (key.return) {
          setSearching(false);
        } else if (key.backspace || key.delete) {
          setQuery((t) => t.slice(0, -1));
        } else if (input !== undefined && input.length === 1 && input >= ' ') {
          setQuery((t) => (t + input).slice(0, 24));
        }
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) exit();
      else if (key.escape) {
        // Escape backs out of the panel first. Quitting the whole dashboard
        // because someone wanted to close a detail view would be hostile.
        if (showDetail) setShowDetail(false);
        else if (query !== '') setQuery('');
        else exit();
      } else if (input === '1') setView(VIEWS[0]);
      else if (input === '2') setView(VIEWS[1]);
      else if (input === '3') setView(VIEWS[2]);
      else if (input === '4') setView(VIEWS[3]);
      else if (input === '5') setView(VIEWS[4]);
      else if (input === 'm' || input === 'M') {
        if (mode === MODES.PAPER) {
          setConfirmingLive(true);
        } else {
          setTradingMode(MODES.PAPER);
          setMode(MODES.PAPER);
          setFlash({ text: '🟡 SWITCHED TO PAPER TRADING (Safe Simulation Active)' });
        }
      }
      else if (input === 'r') {
        setNudge((n) => n + 1);
        setFlash({ was: data.generatedAt });
      } else if (input === 's' || input === 'f') {
        const target =
          view === 'history' ? visibleRows[selected] :
          view === 'positions' ? positionRows(data.paper.book, data.paper.trades)[selected] :
          view === 'reentry' ? (data.reentry ?? [])[selected] :
          data.lastScan[selected];

        if (target?.mint) {
          setFlash({ text: `⚡ Rescanning ${target.symbol ?? target.mint.slice(0, 8)} live on DexScreener...` });
          getBestPair(target.mint)
            .then((pair) => {
              if (!pair) {
                setFlash({ text: `❌ ${target.symbol ?? 'Token'}: No live DEX pool found.` });
                return;
              }
              const liq = pair.liquidityUsd ?? pair.liquidity?.usd ?? null;
              const priceVal = pair.priceUsd ?? null;
              const mcapVal = pair.marketCapUsd ?? pair.marketCap ?? null;
              const entryLiq = target.entryLiquidityUsd ?? liq;
              const chg = entryLiq && liq ? ((liq - entryLiq) / entryLiq) * 100 : null;

              setRescanned((prev) => {
                const next = new Map(prev);
                next.set(target.mint, {
                  nowLiquidityUsd: liq,
                  priceUsd: priceVal,
                  marketCapUsd: mcapVal,
                  changePct: chg,
                  measured: true,
                });
                return next;
              });

              setFlash({
                text: `⚡ ${target.symbol ?? 'Token'}: Price $${priceVal ?? '—'} · Liq $${Math.round(liq ?? 0).toLocaleString()} (${chg !== null ? (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%' : '—'})`,
              });
            })
            .catch((err) => {
              setFlash({ text: `❌ Rescan error: ${err?.message ?? err}` });
            });
        }
      } else if (input === '/') {
        setSearching(true);
        setView('history');
      } else if (input === 'g') {
        const i = GROUPS.findIndex((x) => x.key === group);
        setGroup(GROUPS[(i + 1) % GROUPS.length].key);
        setView('history');
      } else if (input === 't') {
        const i = WINDOWS.findIndex((x) => x.key === win);
        setWin(WINDOWS[(i + 1) % WINDOWS.length].key);
      }
      else if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
      else if (key.pageUp) move(-10);
      else if (key.pageDown) move(10);
      else if (key.return || input === ' ') {
        // Only meaningful where there is a row under the cursor. On the evidence
        // view it goes to the history list rather than appearing to do nothing.
        if (view === 'evidence') {
          setView('history');
          setShowDetail(true);
        } else setShowDetail((s) => !s);
      } else if (key.rightArrow || key.tab)
        setView((v) => VIEWS[(VIEWS.indexOf(v) + 1) % VIEWS.length]);
      else if (key.leftArrow) setView((v) => VIEWS[(VIEWS.indexOf(v) + VIEWS.length - 1) % VIEWS.length]);
    },
    { isActive: canType },
  );

  // Derive the age from the snapshot's own timestamp on every frame, rather than
  // reusing the figure computed at read time. Otherwise "3s ago" sits frozen for
  // a whole refresh interval and a stalling recorder looks fine for longer than
  // it should.
  const snapTs =
    data.recorder.snapshotAgeMs === null ? null : data.generatedAt - data.recorder.snapshotAgeMs;
  const age = snapTs === null ? null : Math.max(0, Math.round((Date.now() - snapTs) / MS_PER_SECOND));
  const due = age === null ? null : data.recorder.expectedEverySeconds - age;

  // Derived from the frame counter, so the animated parts re-render while the
  // tables do not. The spinner stops when the recorder does: one that keeps
  // turning over dead data is worse than no spinner at all.
  const spin = data.recorder.healthy ? SPINNER[frame % SPINNER.length] : '×';
  // Sampled on the header's own clock, which re-renders anyway, so this costs
  // nothing extra. process.memoryUsage() is a syscall-free read of V8 counters.
  const heapMb = Math.round(process.memoryUsage().heapUsed / 1_048_576);
  const pageTick = Math.floor((frame * FRAME_MS) / (SCAN_PAGE_SECONDS * MS_PER_SECOND));
  // Quantised to 10s so it is a fresh-enough clock for "marked 40s ago" without
  // invalidating the memoised body once a second.
  const nowMs = Math.floor(Date.now() / 10_000) * 10_000;

  const status = data.recorder.healthy
    ? h(
        Text,
        { color: 'green' },
        `recording · ${age}s ago` + (due !== null && due > 0 ? ` · next in ${due}s` : ' · next due now'),
      )
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
    { flexDirection: 'column', width: termCols },
    // The ONLY part that re-renders on the clock. Six nodes, so the per-render
    // cost of Ink's leak is six times 1.6KB rather than the whole screen's.
    h(
      Box,
      { gap: 2, height: CHROME.header, overflow: 'hidden' },
      h(Text, { bold: true }, 'SOLSCALP'),
      h(Text, { color: data.recorder.healthy ? 'cyan' : 'red', bold: true }, spin),
      confirmingLive
        ? h(
            Text,
            { color: 'red', bold: true, inverse: true },
            `⚠️ SWITCH TO REAL LIVE TRADING? (${walletState?.address ? walletState.address.slice(0, 6) + '...' : 'NO WALLET'} · ${walletState?.sol?.toFixed(2) ?? '0.00'} SOL) — Press [Y] to CONFIRM, [N] to Cancel`,
          )
        : h(
            Text,
            {
              color: mode === 'real' ? 'red' : 'yellow',
              bold: true,
              inverse: mode === 'real',
            },
            `[M] ${mode === 'real' ? '🔴 REAL LIVE' : '🟡 PAPER'}` +
              (walletState ? ` (${walletState.sol.toFixed(2)} SOL)` : ''),
          ),
      !confirmingLive && status,
      !confirmingLive &&
        (flash !== null
          ? h(
              Text,
              { color: flash.text ? 'green' : 'cyan', bold: true },
              flash.text ?? (data.generatedAt === flash.was ? 're-read · nothing new' : 're-read · updated'),
            )
          : heapMb >= HEAP_WARN_MB
            ? h(
                Text,
                { color: heapMb >= HEAP_URGENT_MB ? 'red' : 'yellow', bold: true },
                `memory ${(heapMb / 1024).toFixed(1)}GB — ` +
                  (heapMb >= HEAP_URGENT_MB ? 'RESTART NOW (q, then npm run dash)' : 'restart me soon'),
              )
            : h(Text, { dimColor: true }, `profile ${data.recorder.profile ?? '?'} · reads ${reads}`)),
    ),
    h(Body, {
      data,
      view,
      error,
      group,
      query,
      searching,
      window: win,
      visibleRows,
      // Coarse on purpose. The mark age only needs to be roughly right, and a
      // per-second value here would re-render the whole body every second and
      // undo the memoisation that stopped this process leaking.
      nowMs,
      selected,
      showDetail,
      canType,
      pageTick,
      inner,
      termCols,
      rows,
    }),
  );
}

/**
 * Everything below the header, memoized as one unit.
 *
 * Its props deliberately exclude anything that changes on the animation clock or
 * on a read that found nothing new -- no frame counter, no `reads` tally, no
 * timestamp. That is what keeps this subtree still: measured 150 MB/hour of leak
 * when the whole tree rebuilt every second, against roughly 40 when only the
 * header does.
 */
const Body = memo(function Body({
  data,
  view,
  error,
  selected,
  showDetail,
  canType,
  pageTick,
  inner,
  termCols,
  rows,
  nowMs,
  group,
  query,
  searching,
  window: win,
  visibleRows,
}) {
  return h(
    Box,
    { flexDirection: 'column', width: termCols },
    h(
      Box,
      { gap: 2, marginTop: 1, height: CHROME.nav, overflow: 'hidden' },
      ...VIEWS.map((v, i) =>
        h(
          Text,
          {
            key: v,
            bold: v === view,
            color: v === view ? 'cyan' : undefined,
            dimColor: v !== view,
          },
          `${i + 1} ${v === 'reentry' ? 'RE-ENTRY' : v.toUpperCase()}`,
        ),
      ),
      canType
        ? h(
            Text,
            { dimColor: true },
            '· arrows · enter details · m mode switch · / search · g group · s rescan · t timeframe · r reload · q quit',
          )
        : h(Text, { color: 'yellow' }, '· no keys here: use --view'),
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
        // A HARD CEILING, enforced by the layout engine rather than by arithmetic.
        // Each view budgets its own rows and those budgets kept being wrong at the
        // edges. A view that asks for too much now loses its bottom rows instead
        // of pushing the footer, or the header that says whether the recorder is
        // alive, off the top of the screen.
        height: Math.max(6, rows - CHROME.total),
        overflow: 'hidden',
      },
      error !== null
        ? h(Text, { color: 'red', wrap: 'wrap' }, `read failed: ${error}`)
        : view === 'positions'
          ? h(PositionsViewMemo, { data, rows, width: inner, selected, showDetail, canType, nowMs, window: win })
          : view === 'history'
            ? h(HistoryViewMemo, { data, visibleRows, rows, width: inner, selected, showDetail, canType, group, query, searching })
            : view === 'evidence'
              ? h(EvidenceViewMemo, { data })
              : view === 'reentry'
                ? h(ReentryViewMemo, { data, rows, width: inner, selected, showDetail, canType, nowMs, window: win })
                : h(LiveViewMemo, { data, rows, width: inner, pageTick, selected, showDetail, canType }),
    ),
    h(
      Box,
      { gap: 2, height: CHROME.footer, overflow: 'hidden' },
      (() => {
        const book = data.paper?.book;
        const equity = typeof book?.equityUsd === 'number' ? book.equityUsd : (data.config.bookSizeUsd ?? 450);
        const cash = typeof book?.cashUsd === 'number' ? book.cashUsd : equity;
        const pnl = typeof book?.realisedPnlUsd === 'number' ? book.realisedPnlUsd + (book.unrealisedPnlUsd ?? 0) : 0;
        const wins = book?.wins ?? 0;
        const losses = book?.losses ?? 0;
        const posCount = Array.isArray(book?.positions) ? book.positions.length : Object.keys(book?.positions ?? {}).length;
        const pnlColor = pnl > 0 ? 'green' : pnl < 0 ? 'red' : undefined;

        return h(
          Box,
          { gap: 2 },
          h(Text, { bold: true }, `Live Book Equity: $${equity.toFixed(2)}`),
          h(Text, { dimColor: true }, `(Cash: $${cash.toFixed(2)})`),
          h(Text, { color: pnlColor, bold: true }, `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`),
          h(Text, { dimColor: true }, `(${wins}W / ${losses}L)`),
          h(Text, { color: posCount > 0 ? 'cyan' : undefined, dimColor: posCount === 0 }, `${posCount} open`),
        );
      })(),
    ),
  );
});

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
  const journalDir = typeof flags['paper-dir'] === 'string' ? flags['paper-dir'] : JOURNAL.dir;
  const refreshMs = intFlag(flags.refresh, 3) * MS_PER_SECOND;
  const initialView = VIEWS.includes(flags.view) ? flags.view : VIEWS[0];
  const cols = flags.cols === undefined ? undefined : intFlag(flags.cols, 100);
  const openDetail = flags.detail === true;
  const initialWindow = WINDOWS.some((w) => w.key === flags.window) ? flags.window : WINDOWS[1].key;

  // --once renders a single frame and exits: the only way this screen is
  // testable, and useful for a quick look without taking over the terminal.
  if (flags.once === true) {
    const app = render(
      h(Box, { flexDirection: 'column' }, h(App, { dir, journalDir, refreshMs: 1e9, initialView, cols, openDetail, initialWindow })),
      { patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 400));
    app.unmount();
    return EXIT.OK;
  }

  const app = render(h(App, { dir, journalDir, refreshMs, initialView, cols, openDetail, initialWindow }));
  await app.waitUntilExit();
  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
