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

import { readdir, readFile, stat } from 'node:fs/promises';
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

import fs from 'node:fs';

/** In-memory incremental state: only parses newly appended lines, keeping heap under 25MB */
let cachedIncrementalState = {
  file: '',
  byteOffset: 0,
  remainder: '',
  rowsMap: new Map(),
  labelsMap: new Map(),
  ticks: [],
  tally: null,
  report: null,
};

function processLineIntoWatchlist(line, state) {
  const text = line.trim();
  if (!text) return;
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return;
  }
  if (record?.schemaVersion !== RECORDER.schemaVersion) return;

  if (record.type === LABELS.recordType) {
    for (const entry of record.labels ?? []) {
      if (typeof entry?.mint === 'string') {
        state.labelsMap.set(entry.mint, entry);
        const row = state.rowsMap.get(entry.mint);
        if (row) {
          row.storedLabel = entry.outcome;
          row.labelEvidence = entry.evidence ?? null;
        }
      }
    }
    return;
  }

  const candidates = record.candidates ?? [];
  state.ticks.push({
    ts: record.ts,
    seen: candidates.length,
    safe: candidates.filter((c) => c.gate?.buyable === true).length,
  });
  if (state.ticks.length > 300) {
    state.ticks.shift();
  }

  const allPools = [
    ...candidates,
    ...(record.scanned ?? []).map((s) => ({
      mint: s.mint,
      symbol: s.symbol,
      liquidityUsd: s.liquidityUsd,
      marketCapUsd: s.marketCapUsd,
      gate: { buyable: false, rejectedBy: s.rejectedBy ? [s.rejectedBy] : [] },
    })),
  ];

  for (const c of allPools) {
    if (typeof c?.mint !== 'string') continue;
    const existing = state.rowsMap.get(c.mint);
    if (existing === undefined) {
      state.rowsMap.set(c.mint, {
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
        series: [{ ts: record.ts, liq: c.liquidityUsd ?? null }],
        storedLabel: state.labelsMap.get(c.mint)?.outcome ?? null,
        labelEvidence: state.labelsMap.get(c.mint)?.evidence ?? null,
      });
    } else {
      existing.seen += 1;
      existing.lastSeenTs = record.ts;
      if (c.liquidityUsd !== undefined && c.liquidityUsd !== null) {
        existing.series.push({ ts: record.ts, liq: c.liquidityUsd });
        // Keep max 25 sparkline points per mint to avoid RAM leak
        if (existing.series.length > 25) {
          existing.series.splice(1, 1);
        }
      }
    }
  }
}

/**
 * @param {object} [p]
 * @param {string} [p.dir]
 * @param {number} [p.now]
 * @param {object} [deps] `readdir` / `readFile` / `stat` seams
 * @returns {Promise<Readonly<object>>} frozen payload
 */
export async function buildDashData({ dir = RECORDER.dir, journalDir = JOURNAL.dir, now = Date.now() } = {}, deps = {}) {
  const list = deps.readdir ?? readdir;
  const read = deps.readFile ?? readFile;
  const getStat = deps.stat ?? stat;

  let files = [];
  try {
    files = (await list(dir)).filter((f) => f.endsWith('.jsonl')).sort().slice(-1);
  } catch {
    /* no directory yet */
  }

  let rows = [];
  let ticks = [];
  let report = null;

  if (files.length > 0) {
    const file = files[0];
    const fullPath = join(dir, file);
    try {
      if (deps.readFile || deps.readdir || deps.stat) {
        const raw = await read(fullPath, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        const wl = buildWatchlist(lines);
        rows = wl.rows;
        ticks = wl.ticks;
        report = scoreRugFilter(tallyRecords(lines));
      } else {
        const fileStat = await getStat(fullPath);

        if (cachedIncrementalState.file !== file || fileStat.size < cachedIncrementalState.byteOffset) {
          cachedIncrementalState = {
            file,
            byteOffset: 0,
            remainder: '',
            rowsMap: new Map(),
            labelsMap: new Map(),
            ticks: [],
            tally: tallyRecords([]),
            report: null,
          };
        }

        if (fileStat.size > cachedIncrementalState.byteOffset) {
          const fd = fs.openSync(fullPath, 'r');
          const chunkSize = 128 * 1024;
          while (cachedIncrementalState.byteOffset < fileStat.size) {
            const bytesToRead = Math.min(chunkSize, fileStat.size - cachedIncrementalState.byteOffset);
            const buf = Buffer.alloc(bytesToRead);
            fs.readSync(fd, buf, 0, bytesToRead, cachedIncrementalState.byteOffset);
            cachedIncrementalState.byteOffset += bytesToRead;

            const chunkStr = cachedIncrementalState.remainder + buf.toString('utf8');
            const lines = chunkStr.split('\n');
            cachedIncrementalState.remainder = lines.pop() || '';

            for (const line of lines) {
              processLineIntoWatchlist(line, cachedIncrementalState);
            }
          }
          fs.closeSync(fd);

          cachedIncrementalState.report = scoreRugFilter(cachedIncrementalState.tally);
        }

        rows = [...cachedIncrementalState.rowsMap.values()];
        ticks = cachedIncrementalState.ticks;
        report = cachedIncrementalState.report;
      }
    } catch {
      /* a file that vanished mid-read must not fail the whole screen */
    }
  }

  // The BOT's book, read rather than re-derived.
  const journal = await loadJournal({ dir: journalDir }, deps);
  const snap = await latestSnapshot({ dir, now }, deps);

  let ml = null;
  try {
    const raw = await read(join(process.cwd(), 'data', 'ml_weights.json'), 'utf8');
    ml = JSON.parse(raw);
  } catch (e) {}

let cachedViewData = {
  byteOffset: 0,
  history: [],
  recent: [],
  latestTickTs: null,
};

function getFormattedViews(rows, ticks, now, byteOffset) {
  if (cachedViewData.byteOffset === byteOffset && cachedViewData.history.length > 0) {
    return cachedViewData;
  }

  const sortedRows = rows
    .slice()
    .sort((a, b) => (b.lastSeenTs ?? b.firstTs ?? 0) - (a.lastSeenTs ?? a.firstTs ?? 0));

  const history = sortedRows
    .slice(0, 100)
    .map((r) => {
      const lastLiq = [...r.series].reverse().find((p) => typeof p.liq === 'number')?.liq ?? null;
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
    });

  const latestTickTs = ticks.length > 0 ? ticks[ticks.length - 1].ts : null;
  const windowMs = RECENT_WINDOW_TICKS * RECORDER.snapshotIntervalSeconds * 1000;
  const recent =
    latestTickTs === null
      ? []
      : sortedRows
          .filter((r) => r.lastSeenTs >= latestTickTs - windowMs)
          .slice(0, 50)
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
              liquidityUsd:
                [...r.series].reverse().find((x) => Number.isFinite(x.liq))?.liq ?? null,
            });
          });

  cachedViewData = { byteOffset, history, recent, latestTickTs };
  return cachedViewData;
}

  const { history, recent, latestTickTs } = getFormattedViews(rows, ticks, now, cachedIncrementalState.byteOffset);

  const uniqueClosedTrades = new Map();
  for (const t of journal.trades) {
    uniqueClosedTrades.set(t.mint, t);
  }

  const snapPairsByMint = new Map((snap.pairs ?? []).map((p) => [p.mint, p]));
  const historyByMint = new Map(history.map((h) => [h.mint, h]));
  const heldPositions = Array.isArray(journal.book?.positions)
    ? journal.book.positions
    : Object.values(journal.book?.positions ?? {});
  const heldMints = new Set(heldPositions.map((p) => p.mint));

  const reentry = [...uniqueClosedTrades.values()]
    .map((t) => {
      const pair = snapPairsByMint.get(t.mint);
      const hist = historyByMint.get(t.mint);
      const livePrice = pair?.priceUsd ? Number(pair.priceUsd) : (hist?.entryPriceUsd ?? t.exitPriceUsd);
      const dipPct =
        livePrice && t.exitPriceUsd
          ? ((livePrice - t.exitPriceUsd) / t.exitPriceUsd) * 100
          : null;
      const m5Change = pair?.priceChange?.m5 !== undefined ? Number(pair.priceChange.m5) : null;
      const h1Change = pair?.priceChange?.h1 !== undefined ? Number(pair.priceChange.h1) : null;
      const buys = pair?.txns?.m5?.buys;
      const sells = pair?.txns?.m5?.sells;
      const buySellRatio = buys !== undefined && sells !== undefined ? buys / Math.max(1, sells) : null;
      const gate = snap.gateResults?.[t.mint];
      const gateBuyable = gate ? gate.buyable === true : hist?.gateBuyable ?? null;
      const isHolding = heldMints.has(t.mint);

      let status = 'WATCHING';
      let statusColor = 'gray';
      if (isHolding) {
        status = 'HOLDING';
        statusColor = 'cyan';
      } else if (gateBuyable === false) {
        status = 'BLOCKED';
        statusColor = 'red';
      } else if (m5Change !== null && m5Change >= 1.5 && (buySellRatio === null || buySellRatio >= 1.1)) {
        status = 'READY';
        statusColor = 'green';
      } else if (dipPct !== null && dipPct < 0) {
        status = 'DIP';
        statusColor = 'yellow';
      }

      return Object.freeze({
        mint: t.mint,
        symbol: t.symbol ?? hist?.symbol ?? t.mint.slice(0, 8),
        exitPriceUsd: t.exitPriceUsd,
        livePriceUsd: livePrice,
        dipPct,
        m5Change,
        h1Change,
        buySellRatio,
        exitReason: t.reason,
        closedTs: t.closedTs ?? t.ts,
        holdMs: t.holdMs,
        gateBuyable,
        status,
        statusColor,
        isHolding,
      });
    })
    .sort((a, b) => (b.closedTs ?? 0) - (a.closedTs ?? 0));

  return Object.freeze({
    generatedAt: now,
    recorder: Object.freeze({
      snapshotAgeMs: snap.snapshotAgeMs,
      healthy: isRecorderHealthy(snap.snapshotAgeMs, RECORDER.snapshotIntervalSeconds),
      expectedEverySeconds: RECORDER.snapshotIntervalSeconds,
      profile: snap.profile,
      fileCount: files.length,
    }),
    reentry: Object.freeze(reentry),
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
      tally: cachedIncrementalState.tally ?? tallyRecords([]),
      report,
      baseRatePct: BASE_RATE_PCT,
      minSample: MIN_SAMPLE,
      ml,
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
  reentry: Object.freeze([]),
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
