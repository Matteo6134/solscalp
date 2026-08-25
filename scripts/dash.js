#!/usr/bin/env node
/**
 * Live dashboard -- everything on one screen, refreshing.
 *
 * Replaces keeping four terminals open: one loop does the enumerate -> screen ->
 * gate -> price -> decide cycle once per interval and repaints four panes.
 *
 * THE TWO COLUMNS THAT MATTER, AND WHY THEY ARE SEPARATE
 *   SAFE?  -- the safety gate passed: the creator probably cannot steal from you.
 *   ENTER? -- the momentum rules fired: the strategy would actually buy.
 *   A token is usually one without the other. Collapsing them into a single
 *   "BUYABLE" invites reading a safety result as a trade signal, which is the
 *   most expensive misreading this project could encourage.
 *
 * PAPER ONLY. No keypair exists in this repo; the positions pane is a ledger of
 * hypotheticals and nothing here can sign a transaction.
 */

import pLimit from 'p-limit';
import { MODES, RISK, SAFETY, STRATEGY, UNIVERSE_PROFILES } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { getNewPools, getTopPools, getTrendingPools } from '../src/data/geckoterminal.js';
import { loadEnv } from '../src/env.js';
import { createEngineState, readSignals, stepEngine, universeReasons } from '../src/paper/engine.js';
import { emptyPortfolio, portfolioEquityUsd } from '../src/paper/portfolio.js';
import { recheckGate, runGate } from '../src/safety/index.js';
import { EXIT, buildRpc, intFlag, isMain, parseArgs, pct, runMain, usd } from './lib/cli.js';
import { costsFor, solPriceFrom } from './lib/liveCosts.js';
import { ANSI, pad, pane, paint, ring, size, withScreen } from './lib/tui.js';

const GATE_CONCURRENCY = 3;
const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const EVENT_CAPACITY = 200;
/** Rows reserved for the header line above the panes. */
const HEADER_ROWS = 2;

const USAGE = `usage: npm run dash -- [--interval S] [--feed F] [--early] [--limit N]

One screen, four panes, refreshing: status + candidates + paper book + events.
Ctrl+C to quit.

  --interval S  seconds between cycles (default ${STRATEGY.tickSeconds})
  --feed F      trending (default) | top | new
  --early       use the UNIVERSE_PROFILES.early profile (smaller caps, younger)
  --limit N     how many screened mints to gate per cycle (default 8)
  --paper       also run the paper engine, so the book pane fills up
`;

const clock = (ts) => new Date(ts).toISOString().slice(11, 19);

/**
 * Turn a 429 into an actionable sentence.
 *
 * The rate limiters in src/data are PER PROCESS: each `node scripts/...`
 * invocation starts with a fresh window and cannot see the others. GeckoTerminal
 * allows 30 req/min per IP, so running the dashboard alongside scan/record/paper
 * in separate terminals blows that shared budget even though every individual
 * process is behaving. This is the main reason the dashboard exists: one process,
 * one budget.
 * @param {unknown} err
 * @returns {string|null}
 */
function rateLimitHint(err) {
  const message = String(err?.message ?? err);
  if (!/429|rate limit|too many requests/i.test(message)) return null;
  const host = /geckoterminal/i.test(message)
    ? 'GeckoTerminal (30 req/min)'
    : /dexscreener/i.test(message)
      ? 'Dexscreener (60 req/min)'
      : 'a data source';
  return (
    `rate limited by ${host} -- the limit is per IP and shared across every ` +
    'process, so close other scan/record/paper terminals or raise --interval'
  );
}

/* -------------------------------------------------------------------------- */
/* panes                                                                      */
/* -------------------------------------------------------------------------- */

function statusPane(state, cols, rows) {
  const f = state.funnel;
  const rpcColour = state.rpcErrors > 0 ? ANSI.yellow : ANSI.green;
  const lines = [
    `${ANSI.bold}cycle${ANSI.reset} ${String(state.cycle).padEnd(6)}` +
      `${ANSI.bold}feed${ANSI.reset} ${pad(state.feed, 10)}` +
      `${ANSI.bold}profile${ANSI.reset} ${pad(state.profile, 10)}` +
      `${ANSI.bold}last${ANSI.reset} ${state.lastCycleMs}ms`,
    `${ANSI.bold}funnel${ANSI.reset}  ` +
      `pools ${pad(f.pools, 5)}pairs ${pad(f.pairs, 5)}` +
      `screened ${pad(f.screened, 5)}gated ${pad(f.gated, 5)}` +
      `${ANSI.green}safe ${pad(f.safe, 4)}${ANSI.reset}` +
      `${ANSI.cyan}would-enter ${f.wouldEnter}${ANSI.reset}`,
    `${ANSI.bold}rpc${ANSI.reset}     ${rpcColour}${state.rpcLabel}${ANSI.reset}` +
      `   ${ANSI.grey}errors this session: ${state.rpcErrors}${ANSI.reset}`,
  ];
  return pane({ title: 'STATUS', lines, cols, rows, note: clock(state.now) });
}

function candidatePane(state, cols, rows) {
  const header =
    `${pad('MINT', 11)}${pad('SYM', 9)}${pad('MCAP', 10)}${pad('LIQ', 9)}` +
    `${pad('AGE', 6)}${pad('5m', 8)}${pad('1h', 8)}${pad('B/S', 6)}${pad('ACC', 5)}` +
    `${pad('SAFE?', 12)}ENTER?`;
  const lines = [`${ANSI.grey}${header}${ANSI.reset}`];

  if (state.candidates.length === 0) {
    lines.push('');
    lines.push(`${ANSI.grey}  nothing has passed the universe screen yet.${ANSI.reset}`);
    lines.push(`${ANSI.grey}  98.6% of these tokens are rugs or sub-$1k liquidity, so an${ANSI.reset}`);
    lines.push(`${ANSI.grey}  empty list is the filter working, not the filter broken.${ANSI.reset}`);
    return pane({ title: 'CANDIDATES', lines, cols, rows });
  }

  for (const c of state.candidates) {
    const s = c.signals;
    const safe = c.gate.buyable
      ? `${ANSI.green}SAFE${ANSI.reset}`
      : `${ANSI.red}blocked${ANSI.reset}`;
    const safeWhy = c.gate.buyable
      ? ''
      : `${ANSI.grey}${[...c.gate.rejectedBy, ...c.gate.erroredIn][0] ?? ''}${ANSI.reset}`;
    const enter = !c.gate.buyable
      ? `${ANSI.grey}-${ANSI.reset}`
      : c.entry.enter
        ? `${ANSI.bold}${ANSI.green}YES${ANSI.reset}`
        : `${ANSI.grey}no${ANSI.reset}`;
    lines.push(
      pad(c.mint.slice(0, 10), 11) +
        pad((c.symbol ?? '?').slice(0, 8), 9) +
        pad(usd(s.marketCapUsd), 10) +
        pad(usd(s.liquidityUsd), 9) +
        pad(s.ageMinutes === null ? 'n/a' : `${Math.round(s.ageMinutes)}m`, 6) +
        pad(pct(s.priceChangeM5Pct), 8) +
        pad(pct(s.priceChangeH1Pct), 8) +
        pad(s.buySellRatioM5 === null ? 'n/a' : s.buySellRatioM5.toFixed(1), 6) +
        pad(s.volumeAccelerationRatio === null ? 'n/a' : s.volumeAccelerationRatio.toFixed(1), 5) +
        pad(`${safe} ${safeWhy}`, 12) +
        enter,
    );
  }
  return pane({
    title: 'CANDIDATES',
    lines,
    cols,
    rows,
    note: 'SAFE? = gate   ENTER? = rules fired',
  });
}

function bookPane(state, cols, rows) {
  const book = state.engine.portfolio;
  const closed = book.closedTrades;
  const wins = closed.filter((t) => t.win).length;
  const lines = [
    `${ANSI.bold}equity${ANSI.reset} ${pad(usd(portfolioEquityUsd(book)), 12)}` +
      `${ANSI.bold}realised${ANSI.reset} ${pad(usd(book.realisedPnlUsd), 11)}` +
      `${ANSI.bold}costs${ANSI.reset} ${pad(usd(book.costsPaidUsd), 10)}` +
      `${ANSI.bold}trades${ANSI.reset} ${closed.length} (${wins}W)`,
    state.paperEnabled
      ? `${ANSI.grey}open ${Object.keys(book.positions).length}/${RISK.maxConcurrentPositions}` +
        `   kill switch: ${state.engine.killSwitch?.tripped ? `${ANSI.red}TRIPPED` : 'ok'}${ANSI.reset}`
      : `${ANSI.grey}paper engine off -- pass --paper to trade these candidates${ANSI.reset}`,
    '',
  ];

  for (const [mint, p] of Object.entries(book.positions)) {
    const pnlPct = ((p.lastPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;
    const colour = pnlPct >= 0 ? ANSI.green : ANSI.red;
    lines.push(
      pad(mint.slice(0, 10), 11) +
        pad(usd(p.sizeUsd), 9) +
        pad(`${colour}${pct(pnlPct)}${ANSI.reset}`, 10) +
        pad(`held ${Math.round((state.now - p.openedTs) / MS_PER_MINUTE)}m`, 12) +
        `${ANSI.grey}peak ${usd(state.engine.peaks?.[mint] ?? p.entryPriceUsd)}${ANSI.reset}`,
    );
  }
  if (Object.keys(book.positions).length === 0 && state.paperEnabled) {
    lines.push(`${ANSI.grey}  no open positions${ANSI.reset}`);
  }
  return pane({ title: 'PAPER BOOK (no keypair exists)', lines, cols, rows });
}

function eventPane(state, cols, rows) {
  const lines = state.events
    .all()
    .slice(-(rows - 1))
    .map((e) => `${ANSI.grey}${clock(e.ts)}${ANSI.reset} ${e.colour ?? ''}${e.text}${ANSI.reset}`);
  return pane({ title: 'EVENTS', lines, cols, rows });
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

function render(state) {
  const { cols, rows } = size();
  const available = rows - HEADER_ROWS;
  // Candidates get the most room; the other three split what is left.
  const statusRows = 4;
  const bookRows = Math.max(4, Math.min(8, Math.floor(available * 0.25)));
  const eventRows = Math.max(4, Math.min(8, Math.floor(available * 0.25)));
  const candRows = Math.max(4, available - statusRows - bookRows - eventRows);

  const header =
    `${ANSI.bold}SOLSCALP${ANSI.reset} ${ANSI.grey}live dashboard -- paper only, ` +
    `nothing here can sign a transaction. Ctrl+C to quit.${ANSI.reset}`;

  paint([
    header,
    '',
    ...statusPane(state, cols, statusRows),
    ...candidatePane(state, cols, candRows),
    ...bookPane(state, cols, bookRows),
    ...eventPane(state, cols, eventRows),
  ]);
}

/* -------------------------------------------------------------------------- */
/* cycle                                                                      */
/* -------------------------------------------------------------------------- */

async function cycle(state, deps) {
  const startedAt = deps.now();
  const pools = [];
  for (let page = 1; page <= deps.pages; page += 1) {
    pools.push(...(await deps.fetchPools({ page })));
  }
  const feedMints = [...new Set(pools.map((p) => p.baseMint).filter(Boolean))];
  const held = Object.keys(state.engine.portfolio.positions);
  const pairsByMint = await deps.fetchPairs([...new Set([...feedMints, ...held])]);
  const pairs = [...pairsByMint.values()].filter((p) => p !== null);

  const at = deps.now();
  const screened = pairs
    .filter((pair) => universeReasons(pair, at, deps.universe).length === 0)
    .map((pair) => ({ pair, signals: readSignals(pair, at) }))
    .sort((a, b) => (b.signals.volumeAccelerationRatio ?? 0) - (a.signals.volumeAccelerationRatio ?? 0))
    .slice(0, deps.limit);

  const gateLimit = pLimit(GATE_CONCURRENCY);
  const gateResults = Object.fromEntries(
    await Promise.all(
      screened.map((row) =>
        gateLimit(async () => [row.pair.mint, await deps.gate(row.pair.mint, { rpc: deps.rpc })]),
      ),
    ),
  );

  const solPriceUsd = solPriceFrom(pairs);
  const costs = costsFor({
    pairs: screened.map((r) => r.pair),
    gates: gateResults,
    solPriceUsd,
  });

  // Recheck open positions on the configured timer: a held token can BECOME a
  // honeypot, and that is an immediate exit rather than a next-cycle concern.
  let gateRechecks = {};
  if (held.length > 0 && at - state.lastRecheckAt >= SAFETY.recheckOpenPositionsSeconds * MS_PER_SECOND) {
    gateRechecks = Object.fromEntries(
      await Promise.all(
        held.map((mint) => gateLimit(async () => [mint, await deps.recheck(mint, { rpc: deps.rpc })])),
      ),
    );
    state.lastRecheckAt = at;
  }

  const engine = deps.paperEnabled
    ? stepEngine(state.engine, {
        ts: at,
        pairs: screened.map((r) => r.pair).concat(pairs.filter((p) => held.includes(p.mint))),
        gateResults,
        gateRechecks,
        costs,
        universe: deps.universe,
      })
    : state.engine;

  for (const action of engine.actions ?? []) {
    if (action.kind === 'open') {
      state.events.push({ ts: at, text: `OPEN  ${action.mint.slice(0, 10)} @ ${usd(action.entryPriceUsd)}`, colour: ANSI.green });
    } else if (action.kind === 'close') {
      state.events.push({ ts: at, text: `CLOSE ${action.mint.slice(0, 10)} (${action.reason})`, colour: ANSI.yellow });
    } else if (action.kind === 'kill-switch') {
      state.events.push({ ts: at, text: `KILL SWITCH: ${action.reasons.join('; ')}`, colour: ANSI.red });
    }
  }

  const candidates = screened.map((row) => {
    const gate = gateResults[row.pair.mint];
    const costBreakdown = costs[row.pair.mint];
    const entry =
      costBreakdown === undefined
        ? { enter: false, reasons: ['round trip not priceable'] }
        : deps.decideEntry({
            pair: row.pair,
            portfolio: engine.portfolio,
            gateResult: gate,
            costBreakdown,
            now: at,
            universe: deps.universe,
          });
    return {
      mint: row.pair.mint,
      symbol: row.pair.baseToken?.symbol ?? null,
      signals: row.signals,
      gate,
      entry,
    };
  });

  const safe = candidates.filter((c) => c.gate.buyable);
  const wouldEnter = safe.filter((c) => c.entry.enter);
  const erroredLayers = candidates.flatMap((c) => c.gate.erroredIn);

  return {
    ...state,
    engine,
    candidates,
    now: at,
    cycle: state.cycle + 1,
    lastCycleMs: deps.now() - startedAt,
    rpcErrors: state.rpcErrors + (erroredLayers.length > 0 ? 1 : 0),
    funnel: {
      pools: pools.length,
      pairs: pairs.length,
      screened: screened.length,
      gated: Object.keys(gateResults).length,
      safe: safe.length,
      wouldEnter: wouldEnter.length,
    },
  };
}

/* -------------------------------------------------------------------------- */

/**
 * @param {readonly string[]} argv
 * @param {object} [injected] test seam
 * @returns {Promise<number>}
 */
export async function main(argv, injected = {}) {
  const { flags } = parseArgs(argv);
  if (flags.help === true) {
    (injected.out ?? console.log)(USAGE);
    return EXIT.OK;
  }

  const env = (injected.loadEnv ?? loadEnv)();
  if (env.mode !== MODES.PAPER || env.isLive !== false) {
    (injected.out ?? console.log)(`refusing to run: mode is "${env.mode}". Paper only.`);
    return EXIT.ERROR;
  }

  const feed = typeof flags.feed === 'string' ? flags.feed : 'trending';
  const FEEDS = { trending: getTrendingPools, top: getTopPools, new: getNewPools };
  if (!Object.hasOwn(FEEDS, feed)) {
    (injected.out ?? console.log)(`unknown --feed "${feed}"`);
    return EXIT.ERROR;
  }

  const { decideEntry } = await import('../src/paper/engine.js');
  const deps = {
    now: injected.now ?? Date.now,
    sleep: injected.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    fetchPools: injected.fetchPools ?? FEEDS[feed],
    fetchPairs: injected.fetchPairs ?? getBestPairs,
    gate: injected.runGate ?? runGate,
    recheck: injected.recheckGate ?? recheckGate,
    decideEntry: injected.decideEntry ?? decideEntry,
    rpc: injected.rpc ?? (await buildRpc(env)),
    universe: flags.early === true ? UNIVERSE_PROFILES.early : undefined,
    limit: intFlag(flags.limit, 8),
    pages: intFlag(flags.pages, 1),
    paperEnabled: flags.paper === true,
  };

  let state = {
    cycle: 0,
    now: deps.now(),
    lastCycleMs: 0,
    lastRecheckAt: 0,
    rpcErrors: 0,
    rpcLabel: deps.rpc.endpoint ?? 'unknown',
    feed,
    profile: flags.early === true ? 'early' : 'standard',
    paperEnabled: deps.paperEnabled,
    funnel: { pools: 0, pairs: 0, screened: 0, gated: 0, safe: 0, wouldEnter: 0 },
    candidates: [],
    engine: createEngineState({ portfolio: emptyPortfolio({}) }),
    events: ring(EVENT_CAPACITY),
  };

  const maxCycles = flags.cycles === undefined ? Infinity : intFlag(flags.cycles, 1);
  state.events.push({ ts: state.now, text: 'dashboard started -- paper only' });

  await withScreen(async () => {
    render(state);
    while (state.cycle < maxCycles) {
      try {
        state = await cycle(state, deps);
      } catch (err) {
        // A failed cycle must never kill the dashboard: the next one may work,
        // and a visible error line is more useful than a dead screen.
        state.events.push({
          ts: deps.now(),
          text: rateLimitHint(err) ?? `cycle failed: ${err?.message ?? err}`,
          colour: ANSI.red,
        });
        state = { ...state, cycle: state.cycle + 1, rpcErrors: state.rpcErrors + 1 };
      }
      render(state);
      if (state.cycle < maxCycles) {
        await deps.sleep(intFlag(flags.interval, STRATEGY.tickSeconds) * MS_PER_SECOND);
      }
    }
  });

  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
