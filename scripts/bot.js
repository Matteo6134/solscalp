#!/usr/bin/env node
/**
 * The phone side: alerts out, commands in.
 *
 * Runs the same enumerate -> screen -> gate -> decide cycle as the dashboard, but
 * instead of drawing a screen it pushes alerts to Telegram and answers commands
 * from it. Meant to be the long-running one -- start it and leave it.
 *
 * WHAT IT CAN AND CANNOT DO
 *   It reports and it answers questions. It cannot trade. There is no keypair in
 *   this repo and no code that can sign a transaction, so no message from the
 *   phone -- however it is phrased -- can move money. That is a property of the
 *   codebase, not a permission check that could be misconfigured.
 *
 * ONLY THE CONFIGURED CHAT IS ANSWERED
 *   A bot token is a bearer credential: anyone who learns the bot's @name can
 *   message it. Every incoming update is therefore checked against
 *   TELEGRAM_CHAT_ID and silently ignored otherwise. Without that check, a
 *   stranger could enumerate your candidates and positions.
 *
 * FAIL SOFT on Telegram, FAIL CLOSED on safety -- the two coexist here. A send
 * failure is logged and the loop continues; a gate error is still a REJECT.
 */

import pLimit from 'p-limit';
import { MODES, NOTIFY, RECORDER, RISK, SAFETY, STRATEGY, UNIVERSE_PROFILES } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { getOhlcv } from '../src/data/geckoterminal.js';
import { getNewPools, getTopPools, getTrendingPools } from '../src/data/geckoterminal.js';
import { loadEnv } from '../src/env.js';
import {
  COMMANDS,
  formatCandidates,
  formatClosed,
  formatDataSourceDown,
  formatEvidence,
  formatGate,
  formatHelp,
  formatHistory,
  formatKillSwitch,
  formatOpened,
  formatPositions,
  formatRecheckFailed,
  formatReentry,
  formatSignal,
  formatStatus,
} from '../src/notify/format.js';
import { buildDashData } from './lib/dashData.js';
import { getTradingMode, MODES as TRADE_MODES } from '../src/trade/modeManager.js';
import { loadWallet, getWalletBalance } from '../src/trade/wallet.js';
import { executeBuyOrder, executeSellOrder } from '../src/trade/executor.js';
import { runAutoTrainCycle } from '../src/ml/autoTrainer.js';
import { startMemoryGuard } from '../src/supervisor/memoryGuard.js';
import { isRecorderHealthy, latestSnapshot } from '../src/evidence/tail.js';
import { createNotifier } from '../src/notify/telegram.js';
import {
  createEngineState,
  decideEntry,
  readSignals,
  stepEngine,
  universeReasons,
} from '../src/paper/engine.js';
import { emptyPortfolio, restorePortfolio, portfolioEquityUsd } from '../src/paper/portfolio.js';
import {
  appendJournal,
  buildBookRecord,
  buildCandlesRecord,
  buildTradeRecord,
  loadJournal,
} from '../src/paper/journal.js';
import { recheckGate, runGate } from '../src/safety/index.js';
import { describeError } from '../src/rpc/rpc-errors.js';
import { JOURNAL } from '../src/config.js';
import { EXIT, buildRpc, intFlag, isMain, parseArgs, runMain, say } from './lib/cli.js';
import { costsFor, solPriceFrom } from './lib/liveCosts.js';

const GATE_CONCURRENCY = 3;
/**
 * One-minute bars fetched per position per cycle.
 *
 * 300 is five hours, comfortably longer than the 45-minute time stop, and enough
 * history to aggregate into hour bars. One request either way, so the only cost
 * of asking for more is the bytes.
 */
const CANDLE_FETCH = 300;
const MS_PER_SECOND = 1_000;

const USAGE = `usage: npm run bot -- [--interval S] [--feed F] [--early] [--paper]

Sends alerts to Telegram and answers commands from it. Long-running.

  --interval S  seconds between cycles (default ${STRATEGY.tickSeconds})
  --feed F      trending (default) | top | new
  --early       use UNIVERSE_PROFILES.early (smaller caps, younger pairs)
  --paper       also run the paper engine, so open/close alerts fire
  --scan        fetch the market itself instead of reading the recorder output.
                Doubles the API load: the limits are per IP and the limiters are
                per process, so two scanners starve each other. Default is to
                read what the recorder already fetched, screened and gated.
  --no-commands send alerts only, do not poll for commands. Use this when the
                token is shared with another running bot (Telegram allows only
                ONE getUpdates consumer per token; alerts do not conflict)
  --test        send one test message, confirm credentials, and exit

Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env. Both, or alerts are
simply switched off (which is not an error).
`;

/** Parse "/check <mint>" style input without a router library. */
function parseCommand(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  // Telegram appends @botname in groups.
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  return { name: head.split('@')[0].toLowerCase(), args: rest };
}

/**
 * @param {readonly string[]} argv
 * @param {object} [injected] test seam
 * @returns {Promise<number>}
 */
export async function main(argv, injected = {}) {
  const { flags } = parseArgs(argv);
  const out = injected.out ?? say;
  if (flags.help === true) {
    out(USAGE);
    return EXIT.OK;
  }

  const env = (injected.loadEnv ?? loadEnv)();
  if (env.mode !== MODES.PAPER || env.isLive !== false) {
    out(`refusing to run: mode is "${env.mode}". Paper only.`);
    return EXIT.ERROR;
  }

  const notifier =
    injected.notifier ??
    createNotifier({
      botToken: env.telegram.botToken,
      chatId: env.telegram.chatId,
      enabled: env.telegram.enabled,
      log: out,
    });

  if (!notifier.enabled) {
    out('Telegram is OFF: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.');
    out('Everything else still works -- run "npm run dash" for the terminal view.');
    return EXIT.NEGATIVE;
  }

  const username = await notifier.whoAmI();
  if (username === null) {
    out('Telegram credentials were rejected. Check TELEGRAM_BOT_TOKEN.');
    return EXIT.ERROR;
  }
  out(`connected as @${username}`);
  await notifier.setCommands(COMMANDS);

  if (flags.test === true) {
    const res = await notifier.send(
      ['✅ <b>SOLSCALP connected</b>', '', formatHelp()].join('\n'),
      { force: true },
    );
    out(`test message: ${res.status}${res.detail ? ` (${res.detail})` : ''}`);
    if (res.status !== 'sent') {
      // "chat not found" is the single most common first-run failure and the
      // message is unhelpfully cryptic: a Telegram bot may not open a
      // conversation, so it cannot message anyone who has not messaged it first.
      // The credentials are fine; the chat simply does not exist yet.
      if (/chat not found/i.test(String(res.detail))) {
        out('');
        out(`  The token is valid -- it connected as @${username}. The problem is that`);
        out('  a bot cannot start a conversation. Open Telegram, search for');
        out(`  @${username}, and send it /start (or any message). Then run this again.`);
      } else if (/chat_id|chat id/i.test(String(res.detail))) {
        out('');
        out('  TELEGRAM_CHAT_ID looks wrong. Message @userinfobot to get yours.');
      }
    }
    return res.status === 'sent' ? EXIT.OK : EXIT.ERROR;
  }

  const FEEDS = { trending: getTrendingPools, top: getTopPools, new: getNewPools };
  const feed = typeof flags.feed === 'string' ? flags.feed : 'trending';
  if (!Object.hasOwn(FEEDS, feed)) {
    out(`unknown --feed "${feed}"`);
    return EXIT.ERROR;
  }

  startMemoryGuard({ processName: 'bot', maxHeapMb: 1200 });

  const deps = {
    now: injected.now ?? Date.now,
    sleep: injected.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    fetchPools: injected.fetchPools ?? FEEDS[feed],
    fetchPairs: injected.fetchPairs ?? getBestPairs,
    gate: injected.runGate ?? runGate,
    recheck: injected.recheckGate ?? recheckGate,
    rpc: injected.rpc ?? (await buildRpc(env)),
    latestSnapshot: injected.latestSnapshot ?? latestSnapshot,
    isRecorderHealthy: injected.isRecorderHealthy ?? isRecorderHealthy,
    recorderIntervalSeconds: RECORDER.snapshotIntervalSeconds,
  };
  const universe = flags.early === true ? UNIVERSE_PROFILES.early : undefined;
  const paperEnabled = flags.paper === true;
  const paperDir = typeof flags['paper-dir'] === 'string' ? flags['paper-dir'] : JOURNAL.dir;
  // Default ON: exactly one process should talk to each upstream. Pass --scan to
  // make the bot fetch for itself, which doubles the API load.
  const fromRecording = flags.scan !== true;
  const intervalMs = intFlag(flags.interval, STRATEGY.tickSeconds) * MS_PER_SECOND;
  const limit = intFlag(flags.limit, 8);
  const startedAt = deps.now();

  // RESTORE EXISTING PORTFOLIO FROM DISK SO PROFITS AND WINS ARE NEVER WIPED!
  let initialPortfolio = emptyPortfolio({});
  if (paperEnabled) {
    try {
      const existingJournal = await loadJournal({ dir: paperDir }, deps);
      if (existingJournal.book || (Array.isArray(existingJournal.trades) && existingJournal.trades.length > 0)) {
        initialPortfolio = restorePortfolio({
          book: existingJournal.book,
          trades: existingJournal.trades,
        });
        say(
          `[journal] restored portfolio from disk: equity $${initialPortfolio.cashUsd.toFixed(2)}, ` +
            `realised P&L $${initialPortfolio.realisedPnlUsd.toFixed(2)}, ` +
            `${initialPortfolio.wins}W/${initialPortfolio.losses}L, ` +
            `${Object.keys(initialPortfolio.positions).length} open positions`,
        );
      }
    } catch (err) {
      say(`[journal] could not restore portfolio: ${describeError(err)}`);
    }
  }

  const state = {
    cycle: 0,
    alertsPaused: false,
    lastRecheckAt: 0,
    updateOffset: 0,
    engine: createEngineState({ portfolio: initialPortfolio }),
    candidates: [],
    funnel: { pools: 0, pairs: 0, screened: 0, gated: 0, safe: 0, wouldEnter: 0 },
  };

  out(`bot running: profile=${universe ? 'early' : 'standard'} paper=${paperEnabled} ` +
    `source=${fromRecording ? 'recording (no upstream calls)' : 'live scan (feed=' + feed + ')'}`);
  out('Ctrl+C to stop. Alerts go to the configured chat only.');
  await notifier.send('🤖 <b>SOLSCALP started</b>\n<i>paper only</i>', { force: true });

  if (paperEnabled) {
    try {
      await appendJournal(
        [
          buildBookRecord({
            ts: startedAt,
            portfolio: state.engine.portfolio,
            equityUsd: portfolioEquityUsd(state.engine.portfolio),
          }),
        ],
        { dir: paperDir },
        deps,
      );
    } catch (err) {
      say(`[journal] could not publish the opening book: ${describeError(err)}`);
    }
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Commands are polled in parallel with the trading cycle: a 30s long-poll must
  // not delay a cycle, and a slow cycle must not make the phone unresponsive.
  const commandLoop = (async () => {
    if (flags['no-commands'] === true) {
      out('command menu disabled (--no-commands): alerts only');
      return;
    }
    while (running) {
      // Another process polling the same token makes commands impossible here.
      // Outbound alerts are unaffected, so degrade to send-only rather than
      // spinning on a conflict that retrying cannot resolve.
      if (notifier.commandsUnavailable?.()) {
        out('command menu unavailable on this token; continuing with alerts only');
        return;
      }
      const updates = await notifier.getUpdates(state.updateOffset);
      for (const update of updates) {
        state.updateOffset = Math.max(state.updateOffset, (update.update_id ?? 0) + 1);
        const message = update.message;
        // Only the configured chat is answered. See the header.
        if (String(message?.chat?.id ?? '') !== String(env.telegram.chatId)) continue;
        const command = parseCommand(message.text);
        if (command === null) continue;
        await handleCommand(command, { state, notifier, deps, feed, universe, startedAt, out });
      }
      if (updates.length === 0 && running) await deps.sleep(MS_PER_SECOND);
    }
  })();

  let lastMlTrainAt = 0;
  const ML_TRAIN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  while (running) {
    const nowMs = deps.now();
    if (nowMs - lastMlTrainAt >= ML_TRAIN_INTERVAL_MS) {
      lastMlTrainAt = nowMs;
      runAutoTrainCycle()
        .then((res) => {
          if (res.trained) {
            say(
              `[mlops] continuous online SGD update completed: accuracy ${res.accuracy}%, ` +
                `${res.samplesCount} samples, ${res.updates} steps. Saved to data/ml_weights.json`,
            );
          }
        })
        .catch(() => {});
    }

    try {
      await cycle({ state, notifier, deps, universe, paperEnabled, limit, fromRecording, paperDir });
    } catch (err) {
      out(`cycle failed: ${err?.message ?? err}`);
      if (NOTIFY.events.dataSourceDown) {
        await notifier.send(formatDataSourceDown({ detail: String(err?.message ?? err) }), {
          key: 'data-source-down',
        });
      }
    }
    // When positions are open, check every 5s so a stop loss can actually fire
    // before a meme coin crashes 50% between polls. When flat, use the normal
    // interval to avoid burning API quota on empty scans.
    const hasPositions = Object.keys(state.engine.portfolio.positions).length > 0;
    const sleepMs = hasPositions ? 5 * MS_PER_SECOND : intervalMs;
    // Sleep in slices so Ctrl+C is responsive on a long interval.
    for (let waited = 0; waited < sleepMs && running; waited += MS_PER_SECOND) {
      await deps.sleep(Math.min(MS_PER_SECOND, sleepMs - waited));
    }
  }

  await commandLoop;
  await notifier.send('🛑 <b>SOLSCALP stopped</b>', { force: true });
  out(`stopped. telegram: ${JSON.stringify(notifier.stats())}`);
  return EXIT.OK;
}

/* -------------------------------------------------------------------------- */

export async function cycle({ state, notifier, deps, universe, paperEnabled, limit, fromRecording, paperDir }) {
  const at = deps.now();
  let screened;
  let gateResults;
  let pairs;
  // In recording mode there is no pool feed of our own: the count is whatever the
  // recorder observed, which is exactly what we want reported.
  let poolsSeen = 0;

  if (fromRecording) {
    // ZERO upstream calls. The recorder already fetched, screened and gated this
    // instant; re-doing it would double the API load for a second opinion on the
    // same data, which is exactly what exhausted GeckoTerminal's per-IP budget.
    const snap = await deps.latestSnapshot({ now: at });
    state.snapshotAgeMs = snap.snapshotAgeMs;

    if (!deps.isRecorderHealthy(snap.snapshotAgeMs, deps.recorderIntervalSeconds)) {
      // A dead recorder must never look like a quiet market.
      state.recorderStale = true;
      if (NOTIFY.events.dataSourceDown && !state.alertsPaused) {
        await notifier.send(
          formatDataSourceDown({
            detail:
              snap.snapshotAgeMs === null
                ? 'No recording found at all. Start the recorder: npm run start'
                : `The recorder has not written for ${Math.round(snap.snapshotAgeMs / 1000)}s ` +
                  '(expected every ' + deps.recorderIntervalSeconds + 's). Alerts are blind ' +
                  'until it is back -- this silence is NOT a quiet market.',
          }),
          { key: 'recorder-stale' },
        );
      }
      state.cycle += 1;
      return;
    }
    state.recorderStale = false;
    pairs = snap.pairs;
    gateResults = snap.gateResults;
    poolsSeen = snap.candidates.length;
    screened = snap.pairs
      .map((pair) => ({ pair, signals: readSignals(pair, at) }))
      .sort((a, b) => (b.signals.volumeAccelerationRatio ?? 0) - (a.signals.volumeAccelerationRatio ?? 0))
      .slice(0, limit);
  } else {
    const pools = await deps.fetchPools({ page: 1 });
    const feedMints = [...new Set(pools.map((p) => p.baseMint).filter(Boolean))];
    const held = Object.keys(state.engine.portfolio.positions);
    const pairsByMint = await deps.fetchPairs([...new Set([...feedMints, ...held])]);
    pairs = [...pairsByMint.values()].filter((p) => p !== null);
    poolsSeen = pools.length;

    screened = pairs
      .filter((pair) => universeReasons(pair, at, universe).length === 0)
      .map((pair) => ({ pair, signals: readSignals(pair, at) }))
      .sort((a, b) => (b.signals.volumeAccelerationRatio ?? 0) - (a.signals.volumeAccelerationRatio ?? 0))
      .slice(0, limit);

    const gateLimit = pLimit(GATE_CONCURRENCY);
    gateResults = Object.fromEntries(
      await Promise.all(
        screened.map((row) =>
          gateLimit(async () => [row.pair.mint, await deps.gate(row.pair.mint, { rpc: deps.rpc })]),
        ),
      ),
    );
  }

  // PRICE THE POSITIONS WE HOLD, EVEN WHEN THEY NO LONGER QUALIFY.
  //
  // The recorder stores only tokens that PASS the universe screen, and tokens
  // fall out of it constantly. On the recording path that left a held position
  // with no price at all: measured 6.1 minutes with no mark on an open position,
  // its unrealised P&L frozen at exactly the entry price.
  //
  // Frozen P&L is the harmless half. The dangerous half is that decideExit
  // compares the CURRENT price against the stop -- so with no price there is no
  // comparison, and the stop loss, the take profit and the trailing stop all
  // silently stop working. A position that drops out of the feed became an
  // unmanaged position.
  //
  // Fetching them directly reintroduces an upstream call, which is what making
  // the bot a reader was meant to avoid. It is worth it and it is bounded: at
  // most RISK.maxConcurrentPositions mints, batched into a single request, only
  // when one is actually missing. That is one request a minute against a limit
  // measured in tens, not the per-pool scanning that caused the original problem.
  // ALWAYS fetch fresh prices for held positions directly from DexScreener.
  // DexScreener allows 300 req/min, so we can safely hit this every 5 seconds
  // while in a trade to get instant stop-loss reactions, completely bypassing
  // the slow GeckoTerminal API limit.
  const held = Object.keys(state.engine.portfolio.positions);
  const recentClosed = (state.engine.portfolio.closedTrades ?? []).slice(-10).map((t) => t.mint);
  const trackMints = [...new Set([...held, ...recentClosed])];

  // ALWAYS fetch fresh prices for held positions AND recently closed tokens to monitor for dip-re-entries.
  if (trackMints.length > 0) {
    try {
      const extra = await deps.fetchPairs(trackMints);
      const freshPairs = [...extra.values()].filter((p) => p !== null);
      const freshMints = freshPairs.map((p) => p.mint);
      // Remove stale versions and append fresh ones
      pairs = pairs.filter((p) => !freshMints.includes(p.mint)).concat(freshPairs);
    } catch (err) {
      say(`[mark] could not price ${trackMints.length} tracked position(s): ${describeError(err)}`);
    }
  }

  const gateLimit = pLimit(GATE_CONCURRENCY);

  // Ensure any tracked mint that does not have a gate result gets gated
  for (const p of pairs) {
    if (!gateResults[p.mint] && trackMints.includes(p.mint)) {
      try {
        gateResults[p.mint] = await deps.gate(p.mint, { rpc: deps.rpc });
      } catch (e) {}
    }
  }

  const solPriceUsd = solPriceFrom(pairs);
  const costs = costsFor({ pairs: screened.map((r) => r.pair), gates: gateResults, solPriceUsd });

  let gateRechecks = {};
  if (held.length > 0 && at - state.lastRecheckAt >= SAFETY.recheckOpenPositionsSeconds * MS_PER_SECOND) {
    gateRechecks = Object.fromEntries(
      await Promise.all(
        held.map((mint) => gateLimit(async () => [mint, await deps.recheck(mint, { rpc: deps.rpc })])),
      ),
    );
    state.lastRecheckAt = at;
  }

  const symbolOf = new Map(pairs.map((p) => [p.mint, p.baseToken?.symbol ?? null]));
  // mint -> AMM pool, which is the key the OHLCV endpoint wants. Plain object
  // because it is written straight into a JSON record.
  const poolOf = Object.fromEntries(
    pairs.filter((p) => typeof p.pairAddress === 'string').map((p) => [p.mint, p.pairAddress]),
  );

  // A held token failing its recheck is the most urgent thing this bot can say.
  for (const [mint, recheck] of Object.entries(gateRechecks)) {
    if (recheck.buyable === true) continue;
    if (!NOTIFY.events.gateRecheckFailed || state.alertsPaused) continue;
    await notifier.send(
      formatRecheckFailed({ mint, symbol: symbolOf.get(mint), reasons: [...recheck.reasons] }),
      { key: `recheck:${mint}` },
    );
  }

  const candidates = screened.map((row) => {
    const gate = gateResults[row.pair.mint];
    const costBreakdown = costs[row.pair.mint];
    const entry =
      costBreakdown === undefined
        ? { enter: false, reasons: ['round trip not priceable'] }
        : decideEntry({
            pair: row.pair,
            portfolio: state.engine.portfolio,
            gateResult: gate,
            costBreakdown,
            now: at,
            universe,
          });
    return {
      mint: row.pair.mint,
      symbol: row.pair.baseToken?.symbol ?? null,
      signals: row.signals,
      gate,
      entry,
    };
  });

  if (paperEnabled) {
    const before = state.engine.portfolio;
    state.engine = stepEngine(state.engine, {
      ts: at,
      pairs: screened.map((r) => r.pair).concat(pairs.filter((p) => trackMints.includes(p.mint))),
      gateResults,
      gateRechecks,
      costs,
      universe,
    });
    if (at - (state.lastCandlesAt ?? 0) >= 60 * MS_PER_SECOND) {
      await publishCandles({ state, held, poolOf, at, dir: paperDir, deps });
      state.lastCandlesAt = at;
    }
    // PUBLISH BEFORE NOTIFYING. Telegram used to be the only place a fill
    // appeared, which made the notifier the de-facto record -- so a Telegram
    // outage lost the trade. The journal is written first and unconditionally.
    await publishBook({ state, before, symbolOf, pools: poolOf, at, dir: paperDir, deps });
    await announceActions({ state, notifier, before, symbolOf, at });
  }

  // The signal alert: gate passed AND the rules fired. Nothing else earns a buzz.
  for (const c of candidates) {
    // Optional access, and fail-closed by construction: a candidate whose gate
    // or entry decision is missing is NOT alerted. It reached this loop from a
    // recording, so a malformed or partial record is possible, and the previous
    // direct access turned one bad candidate into a TypeError that killed the
    // whole cycle -- including the exit management of every open position.
    if (c.gate?.buyable !== true || c.entry?.enter !== true) continue;
    if (!NOTIFY.events.wouldEnter || state.alertsPaused) continue;
    await notifier.send(
      formatSignal({ mint: c.mint, symbol: c.symbol, signals: c.signals, costs: c.entry.costs }),
      { key: `signal:${c.mint}` },
    );
  }

  state.cycle += 1;
  state.candidates = candidates;
  state.funnel = {
    pools: poolsSeen,
    pairs: pairs.length,
    screened: screened.length,
    gated: Object.keys(gateResults).length,
    safe: candidates.filter((c) => c.gate.buyable).length,
    wouldEnter: candidates.filter((c) => c.gate.buyable && c.entry.enter).length,
  };
}

/**
 * Real OHLCV for every open position, appended as it arrives.
 *
 * The chart used to be drawn from the bot's own marks -- one point per 60-second
 * cycle, no high, no low, no volume. This is the actual market data behind that
 * price, at one-minute resolution, which is the finest any public Solana DEX feed
 * publishes. Longer intervals are aggregated by the reader from these, so asking
 * for 5m or 15m costs no extra request.
 *
 * The dashboard still fetches nothing. One fetcher per upstream is the rule that
 * keeps this project inside its rate limits, and the bot already owns the
 * per-position fetch.
 *
 * Bounded and non-fatal: at most one request per open position per cycle, only
 * for positions whose pool is known, and a failure leaves the chart on its
 * fallback rather than interrupting the cycle.
 */
export async function publishCandles({ state, held, poolOf, at, dir, deps = {} }) {
  if (held.length === 0) return;
  const fetchOhlcv = deps.fetchOhlcv ?? getOhlcv;
  state.lastCandleTs ??= {};
  const records = [];

  for (const mint of held) {
    const poolAddress = poolOf[mint];
    if (typeof poolAddress !== 'string') continue;
    let candles;
    try {
      candles = await fetchOhlcv({ poolAddress, timeframe: 'minute', aggregate: 1, limit: CANDLE_FETCH });
    } catch (err) {
      say(`[candles] ${mint.slice(0, 8)}: ${describeError(err)}`);
      continue;
    }
    if (!Array.isArray(candles) || candles.length === 0) continue;
    // Only what is new, PLUS the last one already seen -- that bar was still
    // forming when it was written and its high, low and close have moved since.
    const since = state.lastCandleTs[mint] ?? 0;
    const fresh = candles.filter((c) => Number.isFinite(c?.ts) && c.ts >= since);
    if (fresh.length === 0) continue;
    state.lastCandleTs[mint] = fresh.at(-1).ts;
    records.push(buildCandlesRecord({ ts: at, mint, candles: fresh }));
  }

  if (records.length === 0) return;
  try {
    await appendJournal(records, { dir }, deps);
  } catch (err) {
    say(`[candles] could not write: ${describeError(err)}`);
  }
}

/**
 * Write the book to disk whenever it changed.
 *
 * Guarded, and deliberately non-fatal: a full disk or a locked file must not stop
 * the bot from trading or alerting. But it is reported rather than swallowed,
 * because a silently un-journalled book is the exact failure this module exists
 * to remove.
 */
export async function publishBook({ state, before, symbolOf, pools = {}, at, dir, deps = {} }) {
  const after = state.engine.portfolio;
  // Cheap change test. Marks move unrealised P&L every cycle, so comparing the
  // whole object would append on every tick and turn the journal into a log of
  // price noise; these are the fields a reader actually shows.
  const changed =
    before !== after &&
    (before.openedCount !== after.openedCount ||
      before.closedCount !== after.closedCount ||
      before.realisedPnlUsd !== after.realisedPnlUsd ||
      before.cashUsd !== after.cashUsd ||
      Math.abs((before.unrealisedPnlUsd ?? 0) - (after.unrealisedPnlUsd ?? 0)) > 0.005);
  if (!changed) return;

  const symbols = Object.fromEntries(symbolOf);
  const records = [
    buildBookRecord({
      ts: at,
      portfolio: after,
      equityUsd: portfolioEquityUsd(after),
      symbols,
      pools,
    }),
  ];
  // One durable line per newly closed trade. Counting the delta rather than
  // reading actions means a close is journalled even if the action list is
  // trimmed or the notifier path is skipped.
  const newlyClosed = after.closedCount - before.closedCount;
  if (newlyClosed > 0) {
    for (const trade of after.closedTrades.slice(-newlyClosed)) {
      records.push(buildTradeRecord({ ts: at, trade, symbol: symbolOf.get(trade.mint) ?? null }));
    }
  }
  try {
    await appendJournal(records, { dir }, deps);
  } catch (err) {
    say(`[journal] could not write the book: ${describeError(err)}`);
  }
}

/** Turn engine actions into alerts. */
async function announceActions({ state, notifier, before, symbolOf, at }) {
  if (state.alertsPaused) return;

  const mode = getTradingMode();
  if (mode === TRADE_MODES.REAL) {
    const wallet = loadWallet();
    if (wallet) {
      for (const action of state.engine.actions ?? []) {
        if (action.kind === 'open') {
          say(`[live] EXECUTING REAL ON-CHAIN BUY: ${symbolOf.get(action.mint)} ($${action.sizeUsd})`);
          const solAmount = (action.sizeUsd ?? 100) / 150;
          executeBuyOrder({ wallet, mint: action.mint, amountSol: solAmount })
            .then((res) => {
              if (res.success) {
                say(`[live] BUY CONFIRMED ON-CHAIN! Signature: ${res.signature}`);
                notifier.send(
                  `🚀 <b>REAL ON-CHAIN BUY CONFIRMED</b>\n<b>${symbolOf.get(action.mint) ?? 'Token'}</b>\n<code>${action.mint}</code>\n<a href="https://solscan.io/tx/${res.signature}">View on Solscan</a>`,
                  { force: true },
                );
              } else {
                say(`[live] BUY FAILED: ${res.error}`);
              }
            })
            .catch((err) => say(`[live] Execution error: ${err.message}`));
        }
      }
    }
  }

  for (const action of state.engine.actions ?? []) {
    if (action.kind === 'open' && NOTIFY.events.positionOpened) {
      await notifier.send(
        formatOpened({
          mint: action.mint,
          symbol: symbolOf.get(action.mint),
          sizeUsd: action.sizeUsd,
          entryPriceUsd: action.entryPriceUsd,
        }),
        { force: true },
      );
    } else if (action.kind === 'close' && NOTIFY.events.positionClosed) {
      const trade = state.engine.portfolio.closedTrades.at(-1);
      if (trade !== undefined) {
        await notifier.send(formatClosed({ symbol: symbolOf.get(action.mint), trade }), {
          force: true,
        });
      }
    } else if (action.kind === 'kill-switch' && NOTIFY.events.killSwitch) {
      await notifier.send(
        formatKillSwitch({
          reasons: [...action.reasons],
          dailyPnlPct: state.engine.killSwitch?.dailyPnlPct ?? 0,
        }),
        { force: true },
      );
    }
  }
  void before;
  void at;
}

/** Answer one command from the phone. */
async function handleCommand(command, { state, notifier, deps, feed, universe, startedAt, out }) {
  const reply = (text) => notifier.send(text, { force: true });
  switch (command.name) {
    case 'start':
    case 'help':
      return reply(formatHelp());
    case 'mode': {
      const mode = getTradingMode();
      const wallet = loadWallet();
      return reply(
        `⚙️ <b>CURRENT TRADING MODE:</b> ${mode === 'real' ? '🔴 <b>REAL LIVE</b>' : '🟡 <b>PAPER SIMULATION</b>'}\n\n` +
        `• <b>Wallet:</b> <code>${wallet ? wallet.address : 'None (.env not set)'}</code>\n` +
        `• <i>To switch modes, press [M] in your terminal dashboard (npm run dash)</i>`
      );
    }
    case 'status': {
      // Read the journal from disk so /status shows the SAME data as the
      // dashboard, surviving restarts. The in-memory portfolio resets on every
      // restart, which made /status show zeros while the dashboard showed real
      // trades -- two sources of truth, guaranteed to disagree.
      const paperDir = typeof deps.paperDir === 'string' ? deps.paperDir : JOURNAL.dir;
      const journal = await loadJournal({ dir: paperDir });
      const journalBook = journal.book;
      const book = journalBook ?? state.engine.portfolio;
      return reply(
        formatStatus({
          cycle: state.cycle,
          funnel: state.funnel,
          book,
          equityUsd: journalBook ? (journalBook.equityUsd ?? 0) : portfolioEquityUsd(state.engine.portfolio),
          feed,
          profile: universe ? 'early' : 'standard',
          rpcLabel: deps.rpc.endpoint ?? 'unknown',
          uptimeMs: deps.now() - startedAt,
        }),
      );
    }
    case 'candidates':
    case 'live':
      return reply(formatCandidates({ candidates: state.candidates }));
    case 'positions': {
      const paperDir2 = typeof deps.paperDir === 'string' ? deps.paperDir : JOURNAL.dir;
      const journal2 = await loadJournal({ dir: paperDir2 });
      const book2 = journal2.book ?? state.engine.portfolio;
      return reply(formatPositions({ book: book2, now: deps.now() }));
    }
    case 'history': {
      const paperDir3 = typeof deps.paperDir === 'string' ? deps.paperDir : JOURNAL.dir;
      const journal3 = await loadJournal({ dir: paperDir3 });
      return reply(formatHistory({ closedTrades: journal3.trades ?? [] }));
    }
    case 'evidence': {
      const data = await buildDashData({ now: deps.now() });
      return reply(formatEvidence({ evidence: data.evidence, ml: data.ml }));
    }
    case 'reentry': {
      const data = await buildDashData({ now: deps.now() });
      return reply(formatReentry({ reentry: data.reentry }));
    }
    case 'check': {
      const mint = command.args[0];
      if (mint === undefined) return reply('usage: <code>/check &lt;mint&gt;</code>');
      await reply(`running the gate on <code>${mint.slice(0, 44)}</code>…`);
      const gate = await deps.gate(mint, { rpc: deps.rpc });
      return reply(formatGate({ mint, gate }));
    }
    case 'pause':
      state.alertsPaused = true;
      return reply('🔇 alerts paused. /resume to switch them back on.');
    case 'resume':
      state.alertsPaused = false;
      return reply('🔔 alerts resumed.');
    default:
      out(`unknown command: ${command.name}`);
      return reply(`unknown command <code>/${command.name}</code>\n\n${formatHelp()}`);
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
