/**
 * Everything the dashboard shows, read off disk. No network, no rendering.
 *
 * Split out from the UI for two reasons. It makes the data testable without a
 * terminal, and it makes the decoupling the operator asked about structural:
 * this function is the only thing that touches the filesystem, the UI only ever
 * reads its output, and neither can block the other.
 *
 * NOTHING HERE CALLS AN UPSTREAM API.
 *   The dashboard used to run its own scan, which made it a third process
 *   competing for the same per-IP rate limits as the recorder and the bot. It now
 *   reads the recorder's append-only JSONL, so it cannot be rate limited, it is
 *   safe to leave open forever, and it survives a restart because the recording
 *   is the memory. It also means a slow API can never freeze the interface --
 *   the usual cause of a stuck terminal dashboard simply is not present.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JOURNAL, LABELS, RECORDER, RISK, STRATEGY } from '../../src/config.js';
import { LABEL } from '../../src/evidence/outcome.js';
import { isRecorderHealthy, latestSnapshot } from '../../src/evidence/tail.js';
import { loadJournal } from '../../src/paper/journal.js';
import { BASE_RATE_PCT, MIN_SAMPLE, scoreRugFilter, tallyRecords } from '../backtest-rug-filter.js';
import { buildWatchlist } from '../watchlist.js';

const MS_PER_HOUR = 3_600_000;
/** How many recorder ticks a departed token stays visible for. */
export const RECENT_WINDOW_TICKS = 10;

/**
 * @param {object} [p]
 * @param {string} [p.dir]
 * @param {number} [p.now]
 * @param {object} [deps] `readdir` / `readFile` seams
 * @returns {Promise<Readonly<object>>} frozen payload
 */
export async function buildDashData({ dir = RECORDER.dir, journalDir = JOURNAL.dir, now = Date.now() } = {}, deps = {}) {
  const list = deps.readdir ?? readdir;
  const read = deps.readFile ?? readFile;

  let files = [];
  try {
    files = (await list(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    /* no directory yet: every field below degrades to empty, which is honest */
  }
  const lines = [];
  for (const file of files) {
    try {
      lines.push(...(await read(join(dir, file), 'utf8')).split('\n'));
    } catch {
      /* a file that vanished mid-read must not fail the whole screen */
    }
  }

  // The BOT's book, read rather than re-derived.
  //
  // This screen used to show no positions at all while Telegram showed open
  // trades and a running loss, because the bot held its portfolio only in memory
  // and this process had no way to see it. Two sources of truth, guaranteed to
  // disagree. Now the bot publishes and this reads: whatever the numbers are,
  // both screens quote the same ones.
  const journal = await loadJournal({ dir: journalDir }, deps);

  const { rows, ticks } = buildWatchlist(lines);
  const snap = await latestSnapshot({ dir, now }, deps);
  const tally = tallyRecords(lines);
  const report = scoreRugFilter(tally);

  const history = rows
    .map((r) => {
      const lastLiq = [...r.series].reverse().find((p) => typeof p.liq === 'number')?.liq ?? null;
      // The labeller RE-FETCHED to decide, so its figure is the honest "now".
      // The recording's own tail is not: the recorder stops observing a token the
      // moment it drops out of the screen, so its last stored value is the last
      // HEALTHY reading rather than the outcome. Measured: one mint's final
      // recorded liquidity was $61,861 against a live pool of $2,623.
      const measured = r.labelEvidence?.liquidityAfterUsd ?? null;
      const nowLiq = measured ?? lastLiq;
      const changePct =
        r.entryLiquidityUsd && nowLiq !== null && r.entryLiquidityUsd > 0
          ? ((nowLiq - r.entryLiquidityUsd) / r.entryLiquidityUsd) * 100
          : null;
      return Object.freeze({
        mint: r.mint,
        symbol: r.symbol,
        seen: r.seen,
        ageHours: (now - r.firstTs) / MS_PER_HOUR,
        firstTs: r.firstTs,
        lastSeenTs: r.lastSeenTs,
        entryPriceUsd: r.entryPriceUsd ?? null,
        entryMarketCapUsd: r.entryMarketCapUsd ?? null,
        entryLiquidityUsd: r.entryLiquidityUsd,
        nowLiquidityUsd: nowLiq,
        measured: measured !== null,
        changePct,
        gateBuyable: r.gateBuyable,
        gateBlockedBy: Object.freeze([...(r.gateBlockedBy ?? [])]),
        label: r.storedLabel ?? null,
        series: Object.freeze(r.series.filter((p) => typeof p.liq === 'number')),
      });
    })
    .sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));

  // A token is in the recording only while it passes the screen, and the feed
  // itself rotates, so the set changes almost every tick: measured over 8
  // consecutive ticks, Hailey and BADGERS left, C4T arrived and left, Hezbollah
  // and Pistacio arrived, Pistacio left. Showing only the newest snapshot makes
  // that look like tokens vanishing at random.
  //
  // So keep a window of what was seen recently and mark whether it is still
  // there. LEFT is a real state worth seeing, not an absence to hide -- though
  // the recording cannot say WHICH of the two reasons applies, because a token
  // that stopped trending and a token that stopped qualifying both simply stop
  // being recorded. That limit is stated in the UI rather than papered over.
  const latestTickTs = ticks.length > 0 ? ticks[ticks.length - 1].ts : null;
  const windowMs = RECENT_WINDOW_TICKS * RECORDER.snapshotIntervalSeconds * 1000;
  const recent =
    latestTickTs === null
      ? []
      : rows
          .filter((r) => r.lastSeenTs >= latestTickTs - windowMs)
          .map((r) => {
            const ticksSince = ticks.filter((t) => t.ts > r.lastSeenTs).length;
            const inLatest = r.lastSeenTs === latestTickTs;
            return Object.freeze({
              mint: r.mint,
              symbol: r.symbol,
              seen: r.seen,
              inLatest,
              ticksSince,
              lastSeenTs: r.lastSeenTs,
              firstTs: r.firstTs,
              gateBuyable: r.gateBuyable,
              gateBlockedBy: Object.freeze([...(r.gateBlockedBy ?? [])]),
              liquidityUsd:
                [...r.series].reverse().find((x) => Number.isFinite(x.liq))?.liq ?? null,
            });
          })
          .sort((a, b) => b.lastSeenTs - a.lastSeenTs || (a.symbol ?? '').localeCompare(b.symbol ?? ''));

  return Object.freeze({
    generatedAt: now,
    recorder: Object.freeze({
      snapshotAgeMs: snap.snapshotAgeMs,
      healthy: isRecorderHealthy(snap.snapshotAgeMs, RECORDER.snapshotIntervalSeconds),
      expectedEverySeconds: RECORDER.snapshotIntervalSeconds,
      profile: snap.profile,
      fileCount: files.length,
    }),
    ticks,
    recent: Object.freeze(recent),
    // The full sweep of the newest tick, rejects included, each with the FIRST
    // reason the screen threw it out. This is what makes the interface show
    // continuous work: most ticks approve nothing, and without the rejects there
    // is nothing on screen to distinguish "scanning hard, liked none of it" from
    // "dead". Empty for recordings written before the recorder kept them.
    scanned: Object.freeze(snap.scanned ?? []),
    lastScan: Object.freeze(
      snap.candidates.map((c) =>
        Object.freeze({
          mint: c.mint,
          symbol: c.symbol,
          marketCapUsd: c.marketCapUsd,
          liquidityUsd: c.liquidityUsd,
          priceChangeM5Pct: c.priceChangeM5Pct,
          priceChangeH1Pct: c.priceChangeH1Pct,
          buySellRatioM5: c.buySellRatioM5,
          volumeAccelerationRatio: c.volumeAccelerationRatio,
          ageMinutes: c.ageMinutes,
          gateBuyable: c.gate?.buyable === true,
          gateBlockedBy: Object.freeze([
            ...(c.gate?.rejectedBy ?? []),
            ...(c.gate?.erroredIn ?? []),
          ]),
          wouldEnter: c.wouldEnter ?? null,
          entryBlockedBy: Object.freeze([...(c.entryBlockedBy ?? [])]),
        }),
      ),
    ),
    history: Object.freeze(history),
    paper: Object.freeze({
      hasBook: journal.hasBook,
      book: journal.book,
      trades: journal.trades,
      // A Map would work, but the payload is frozen and compared by identity in
      // the UI; a plain object keeps it consistent with everything else here.
      series: Object.freeze(Object.fromEntries(journal.series)),
      // Real OHLCV, fetched by the bot. The chart prefers these; the book-derived
      // series above is the fallback for a position whose candles never arrived.
      candles: Object.freeze(Object.fromEntries(journal.candles)),
    }),
    evidence: Object.freeze({
      tally,
      report,
      baseRatePct: BASE_RATE_PCT,
      minSample: MIN_SAMPLE,
    }),
    config: Object.freeze({
      bookSizeUsd: RISK.bookSizeUsd,
      positionSizeUsd: RISK.positionSizeUsd,
      minMarketCapUsd: STRATEGY.universe.minMarketCapUsd,
      maxMarketCapUsd: STRATEGY.universe.maxMarketCapUsd,
      recentWindowTicks: RECENT_WINDOW_TICKS,
      stopLossPct: STRATEGY.exit.stopLossPct,
      takeProfitPct: STRATEGY.exit.takeProfitPct,
      trailingStopPct: STRATEGY.exit.trailingStopPct,
      trailingArmsAtPct: STRATEGY.exit.trailingArmsAtPct,
      timeStopMinutes: STRATEGY.exit.timeStopMinutes,
      autoLabelEveryMinutes: LABELS.autoLabelEveryMinutes,
      minAgeHoursBeforeLabelling: LABELS.minAgeHoursBeforeLabelling,
      RUGGED: LABEL.RUGGED,
      SURVIVED: LABEL.SURVIVED,
    }),
  });
}

/** An empty payload, for the first frame before any read completes. */
export const EMPTY = Object.freeze({
  generatedAt: 0,
  recorder: Object.freeze({
    snapshotAgeMs: null,
    healthy: false,
    expectedEverySeconds: RECORDER.snapshotIntervalSeconds,
    profile: null,
    fileCount: 0,
  }),
  ticks: Object.freeze([]),
  recent: Object.freeze([]),
  scanned: Object.freeze([]),
  lastScan: Object.freeze([]),
  history: Object.freeze([]),
  paper: Object.freeze({
    hasBook: false,
    book: null,
    trades: Object.freeze([]),
    series: Object.freeze({}),
    candles: Object.freeze({}),
  }),
  evidence: Object.freeze({
    tally: Object.freeze({
      snapshots: 0, uniqueMints: 0, approved: 0, rugged: 0, unlabelled: 0,
      rejected: 0, blockedLabelled: 0, blockedRugged: 0, malformed: 0,
    }),
    report: Object.freeze({ sufficient: false, reason: 'no data read yet' }),
    baseRatePct: BASE_RATE_PCT,
    minSample: MIN_SAMPLE,
  }),
  config: Object.freeze({
    bookSizeUsd: RISK.bookSizeUsd,
    positionSizeUsd: RISK.positionSizeUsd,
    minMarketCapUsd: STRATEGY.universe.minMarketCapUsd,
    maxMarketCapUsd: STRATEGY.universe.maxMarketCapUsd,
    recentWindowTicks: RECENT_WINDOW_TICKS,
    stopLossPct: STRATEGY.exit.stopLossPct,
    takeProfitPct: STRATEGY.exit.takeProfitPct,
    trailingStopPct: STRATEGY.exit.trailingStopPct,
    trailingArmsAtPct: STRATEGY.exit.trailingArmsAtPct,
    timeStopMinutes: STRATEGY.exit.timeStopMinutes,
    autoLabelEveryMinutes: LABELS.autoLabelEveryMinutes,
    minAgeHoursBeforeLabelling: LABELS.minAgeHoursBeforeLabelling,
    RUGGED: LABEL.RUGGED,
    SURVIVED: LABEL.SURVIVED,
  }),
});
