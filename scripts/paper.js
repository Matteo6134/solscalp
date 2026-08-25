#!/usr/bin/env node
/**
 * Paper trading on live snapshots. NO KEYPAIR EXISTS IN THIS REPO AND NOTHING
 * HERE CAN SIGN A TRANSACTION.
 *
 * This is a ledger of hypotheticals: it reads real prices, applies the real
 * rules, charges the real modelled costs, and writes the result to memory. That
 * is the only evidence source available that is immune to survivorship and
 * lookahead bias -- because there is no history to cheat on. It is slow. There is
 * no faster honest option.
 *
 * The random-entry baseline runs alongside only with --baseline. It is diagnostic
 * scaffolding: it answers "is the strategy better than luck", and if the answer
 * is no, that is the headline result and it gets printed as one.
 */

import pLimit from 'p-limit';
import { MODES, RISK, SAFETY, STRATEGY, UNIVERSE_PROFILES } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { getTrendingPools } from '../src/data/geckoterminal.js';
import { loadEnv } from '../src/env.js';
import { createBaselineDecider, createRng } from '../src/baseline/monkey.js';
import { costsFor, solPriceFrom } from './lib/liveCosts.js';
import { createEngineState, stepEngine } from '../src/paper/engine.js';
import { emptyPortfolio, portfolioEquityUsd } from '../src/paper/portfolio.js';
import { recheckGate, runGate } from '../src/safety/index.js';
import { EXIT, buildRpc, intFlag, isMain, line, parseArgs, runMain, usd } from './lib/cli.js';

const GATE_CONCURRENCY = 3;
const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;

const USAGE = `usage: npm run paper -- [--ticks N] [--interval S] [--early] [--baseline]

Runs the strategy on live snapshots. Paper only -- there is no keypair.

  --ticks N     stop after N ticks (default 20)
  --interval S  seconds between ticks (default ${STRATEGY.tickSeconds})
  --early       screen with UNIVERSE_PROFILES.early
  --baseline    also run the random-entry control group and compare
`;

/** @param {object} book @returns {string} one summary line */
function summarise(label, book) {
  const closed = book.closedTrades;
  const wins = closed.filter((t) => t.win).length;
  const winPct = closed.length === 0 ? 0 : (wins / closed.length) * 100;
  const avgHoldMin =
    closed.length === 0
      ? 0
      : closed.reduce((s, t) => s + t.holdMs, 0) / closed.length / MS_PER_MINUTE;
  return (
    `${label.padEnd(10)} equity ${usd(portfolioEquityUsd(book)).padStart(10)}  ` +
    `net ${usd(book.realisedPnlUsd).padStart(9)}  ` +
    `trades ${String(closed.length).padStart(3)}  ` +
    `win ${winPct.toFixed(0).padStart(3)}%  ` +
    `costs ${usd(book.costsPaidUsd).padStart(8)}  ` +
    `avg hold ${avgHoldMin.toFixed(1)}m`
  );
}

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

  const env = (deps.loadEnv ?? loadEnv)();
  // Structural, not defensive: loadEnv throws on MODE=live, so this can only be
  // paper. Asserted anyway, because the cost of being wrong here is real money.
  if (env.mode !== MODES.PAPER || env.isLive !== false) {
    out(`refusing to run: mode is "${env.mode}". This script is paper-only.`);
    return EXIT.ERROR;
  }

  const maxTicks = intFlag(flags.ticks, 20);
  const intervalS = intFlag(flags.interval, STRATEGY.tickSeconds);
  const universe = flags.early === true ? UNIVERSE_PROFILES.early : undefined;
  const withBaseline = flags.baseline === true;

  const rpc = deps.rpc ?? (await buildRpc(env));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fetchPools = deps.getTrendingPools ?? getTrendingPools;
  const fetchPairs = deps.getBestPairs ?? getBestPairs;
  const gate = deps.runGate ?? runGate;
  const recheck = deps.recheckGate ?? recheckGate;

  out(line('='));
  out('PAPER TRADING -- no keypair exists in this repo; nothing here can sign.');
  out(`book ${usd(RISK.bookSizeUsd)}  position ${usd(RISK.positionSizeUsd)}  ` +
    `max ${RISK.maxConcurrentPositions} concurrent  profile=${universe ? 'early' : 'standard'}`);
  if (withBaseline) out('random-entry baseline running alongside (identical exits)');
  out(line('='));

  let strategy = createEngineState({ portfolio: emptyPortfolio({}), label: 'strategy' });
  let baseline = createEngineState({ portfolio: emptyPortfolio({}), label: 'baseline' });
  const baselineDecider = createBaselineDecider(createRng());
  let lastRecheckAt = 0;

  for (let tickNo = 1; tickNo <= maxTicks; tickNo += 1) {
    const ts = now();
    try {
      const pools = await fetchPools({ page: 1 });
      const mints = [...new Set(pools.map((p) => p.baseMint).filter(Boolean))];
      // Held positions must be priced every tick even if they left the feed.
      const held = Object.keys(strategy.portfolio.positions);
      const pairsByMint = await fetchPairs([...new Set([...mints, ...held])]);
      const pairs = [...pairsByMint.values()].filter((p) => p !== null);
      const solPriceUsd = solPriceFrom(pairs);

      const gateLimit = pLimit(deps.concurrency ?? GATE_CONCURRENCY);
      const gateResults = Object.fromEntries(
        await Promise.all(
          pairs.map((pair) => gateLimit(async () => [pair.mint, await gate(pair.mint, { rpc })])),
        ),
      );

      // A held token can BECOME a honeypot: re-run layers 0+1 on a timer.
      let gateRechecks = {};
      if (held.length > 0 && ts - lastRecheckAt >= SAFETY.recheckOpenPositionsSeconds * MS_PER_SECOND) {
        gateRechecks = Object.fromEntries(
          await Promise.all(
            held.map((mint) => gateLimit(async () => [mint, await recheck(mint, { rpc })])),
          ),
        );
        lastRecheckAt = ts;
      }

      const costs = costsFor({ pairs, gates: gateResults, solPriceUsd });
      const tick = { ts, pairs, gateResults, gateRechecks, costs, universe };

      strategy = stepEngine(strategy, tick);
      if (withBaseline) {
        baseline = stepEngine(baseline, { ...tick, entryDecider: baselineDecider });
      }

      const opens = strategy.actions.filter((a) => a.kind === 'open');
      const closes = strategy.actions.filter((a) => a.kind === 'close');
      out(
        `tick ${String(tickNo).padStart(3)}  ${pairs.length} pairs  ` +
          `${Object.values(gateResults).filter((g) => g.buyable).length} buyable  ` +
          `+${opens.length}/-${closes.length}  ` +
          `equity ${usd(portfolioEquityUsd(strategy.portfolio))}` +
          (strategy.killSwitch.tripped ? '  [KILL SWITCH]' : ''),
      );
      for (const a of closes) out(`        closed ${a.mint.slice(0, 8)} (${a.reason})`);
      if (strategy.killSwitch.tripped) {
        out(`kill switch tripped: ${strategy.killSwitch.reasons.join('; ')}`);
        break;
      }
    } catch (err) {
      out(`[tick ${tickNo} failed, continuing] ${err?.message ?? err}`);
    }
    if (tickNo < maxTicks) await sleep(intervalS * MS_PER_SECOND);
  }

  out('');
  out(line('='));
  out('RESULT');
  out(summarise('strategy', strategy.portfolio));
  if (withBaseline) {
    out(summarise('baseline', baseline.portfolio));
    out('');
    const s = strategy.portfolio.realisedPnlUsd;
    const b = baseline.portfolio.realisedPnlUsd;
    if (strategy.portfolio.closedCount === 0 && baseline.portfolio.closedCount === 0) {
      out('Neither run closed a trade. No comparison is possible yet -- run longer.');
    } else if (s <= b) {
      out('HEADLINE: the strategy did NOT beat random entry. On this sample the');
      out('momentum rules added nothing, and that is the finding, not a bug.');
    } else {
      out('The strategy beat random entry on this sample. Sample size is everything');
      out('here -- a handful of trades is noise, not evidence.');
    }
  }
  out(line('='));
  out('Paper only. No order was ever placed.');
  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
