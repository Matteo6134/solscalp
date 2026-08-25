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
import { MODES, NOTIFY, RISK, SAFETY, STRATEGY, UNIVERSE_PROFILES } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { getNewPools, getTopPools, getTrendingPools } from '../src/data/geckoterminal.js';
import { loadEnv } from '../src/env.js';
import {
  COMMANDS,
  formatCandidates,
  formatClosed,
  formatDataSourceDown,
  formatGate,
  formatHelp,
  formatKillSwitch,
  formatOpened,
  formatPositions,
  formatRecheckFailed,
  formatSignal,
  formatStatus,
} from '../src/notify/format.js';
import { createNotifier } from '../src/notify/telegram.js';
import {
  createEngineState,
  decideEntry,
  readSignals,
  stepEngine,
  universeReasons,
} from '../src/paper/engine.js';
import { emptyPortfolio, portfolioEquityUsd } from '../src/paper/portfolio.js';
import { recheckGate, runGate } from '../src/safety/index.js';
import { EXIT, buildRpc, intFlag, isMain, parseArgs, runMain } from './lib/cli.js';
import { costsFor, solPriceFrom } from './lib/liveCosts.js';

const GATE_CONCURRENCY = 3;
const MS_PER_SECOND = 1_000;

const USAGE = `usage: npm run bot -- [--interval S] [--feed F] [--early] [--paper]

Sends alerts to Telegram and answers commands from it. Long-running.

  --interval S  seconds between cycles (default ${STRATEGY.tickSeconds})
  --feed F      trending (default) | top | new
  --early       use UNIVERSE_PROFILES.early (smaller caps, younger pairs)
  --paper       also run the paper engine, so open/close alerts fire
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
  const out = injected.out ?? console.log;
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
    return res.status === 'sent' ? EXIT.OK : EXIT.ERROR;
  }

  const FEEDS = { trending: getTrendingPools, top: getTopPools, new: getNewPools };
  const feed = typeof flags.feed === 'string' ? flags.feed : 'trending';
  if (!Object.hasOwn(FEEDS, feed)) {
    out(`unknown --feed "${feed}"`);
    return EXIT.ERROR;
  }

  const deps = {
    now: injected.now ?? Date.now,
    sleep: injected.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    fetchPools: injected.fetchPools ?? FEEDS[feed],
    fetchPairs: injected.fetchPairs ?? getBestPairs,
    gate: injected.runGate ?? runGate,
    recheck: injected.recheckGate ?? recheckGate,
    rpc: injected.rpc ?? (await buildRpc(env)),
  };
  const universe = flags.early === true ? UNIVERSE_PROFILES.early : undefined;
  const paperEnabled = flags.paper === true;
  const intervalMs = intFlag(flags.interval, STRATEGY.tickSeconds) * MS_PER_SECOND;
  const limit = intFlag(flags.limit, 8);
  const startedAt = deps.now();

  const state = {
    cycle: 0,
    alertsPaused: false,
    lastRecheckAt: 0,
    updateOffset: 0,
    engine: createEngineState({ portfolio: emptyPortfolio({}) }),
    candidates: [],
    funnel: { pools: 0, pairs: 0, screened: 0, gated: 0, safe: 0, wouldEnter: 0 },
  };

  out(`bot running: feed=${feed} profile=${universe ? 'early' : 'standard'} paper=${paperEnabled}`);
  out('Ctrl+C to stop. Alerts go to the configured chat only.');
  await notifier.send('🤖 <b>SOLSCALP started</b>\n<i>paper only</i>', { force: true });

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

  while (running) {
    try {
      await cycle({ state, notifier, deps, universe, paperEnabled, limit });
    } catch (err) {
      out(`cycle failed: ${err?.message ?? err}`);
      if (NOTIFY.events.dataSourceDown) {
        await notifier.send(formatDataSourceDown({ detail: String(err?.message ?? err) }), {
          key: 'data-source-down',
        });
      }
    }
    // Sleep in slices so Ctrl+C is responsive on a long interval.
    for (let waited = 0; waited < intervalMs && running; waited += MS_PER_SECOND) {
      await deps.sleep(Math.min(MS_PER_SECOND, intervalMs - waited));
    }
  }

  await commandLoop;
  await notifier.send('🛑 <b>SOLSCALP stopped</b>', { force: true });
  out(`stopped. telegram: ${JSON.stringify(notifier.stats())}`);
  return EXIT.OK;
}

/* -------------------------------------------------------------------------- */

async function cycle({ state, notifier, deps, universe, paperEnabled, limit }) {
  const pools = await deps.fetchPools({ page: 1 });
  const feedMints = [...new Set(pools.map((p) => p.baseMint).filter(Boolean))];
  const held = Object.keys(state.engine.portfolio.positions);
  const pairsByMint = await deps.fetchPairs([...new Set([...feedMints, ...held])]);
  const pairs = [...pairsByMint.values()].filter((p) => p !== null);

  const at = deps.now();
  const screened = pairs
    .filter((pair) => universeReasons(pair, at, universe).length === 0)
    .map((pair) => ({ pair, signals: readSignals(pair, at) }))
    .sort((a, b) => (b.signals.volumeAccelerationRatio ?? 0) - (a.signals.volumeAccelerationRatio ?? 0))
    .slice(0, limit);

  const gateLimit = pLimit(GATE_CONCURRENCY);
  const gateResults = Object.fromEntries(
    await Promise.all(
      screened.map((row) =>
        gateLimit(async () => [row.pair.mint, await deps.gate(row.pair.mint, { rpc: deps.rpc })]),
      ),
    ),
  );

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
      pairs: screened.map((r) => r.pair).concat(pairs.filter((p) => held.includes(p.mint))),
      gateResults,
      gateRechecks,
      costs,
      universe,
    });
    await announceActions({ state, notifier, before, symbolOf, at });
  }

  // The signal alert: gate passed AND the rules fired. Nothing else earns a buzz.
  for (const c of candidates) {
    if (!c.gate.buyable || !c.entry.enter) continue;
    if (!NOTIFY.events.wouldEnter || state.alertsPaused) continue;
    await notifier.send(
      formatSignal({ mint: c.mint, symbol: c.symbol, signals: c.signals, costs: c.entry.costs }),
      { key: `signal:${c.mint}` },
    );
  }

  state.cycle += 1;
  state.candidates = candidates;
  state.funnel = {
    pools: pools.length,
    pairs: pairs.length,
    screened: screened.length,
    gated: Object.keys(gateResults).length,
    safe: candidates.filter((c) => c.gate.buyable).length,
    wouldEnter: candidates.filter((c) => c.gate.buyable && c.entry.enter).length,
  };
}

/** Turn engine actions into alerts. */
async function announceActions({ state, notifier, before, symbolOf, at }) {
  if (state.alertsPaused) return;
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
    case 'status':
      return reply(
        formatStatus({
          cycle: state.cycle,
          funnel: state.funnel,
          book: state.engine.portfolio,
          equityUsd: portfolioEquityUsd(state.engine.portfolio),
          feed,
          profile: universe ? 'early' : 'standard',
          rpcLabel: deps.rpc.endpoint ?? 'unknown',
          uptimeMs: deps.now() - startedAt,
        }),
      );
    case 'candidates':
      return reply(formatCandidates({ candidates: state.candidates }));
    case 'positions':
      return reply(formatPositions({ book: state.engine.portfolio, now: deps.now() }));
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
