#!/usr/bin/env node
/**
 * Find candidates: enumerate live pools, screen them against the universe
 * filter, then run the safety gate on the survivors.
 *
 * WHAT THIS DOES NOT DO, AND CANNOT
 *   It does not find tokens that are "about to" pump. Nothing can. Every column
 *   it prints describes what has ALREADY happened -- the last five minutes of
 *   price, volume and buy/sell flow. The ranking is an ordering of observed
 *   acceleration, not a prediction, and the design record explains at length why
 *   the predictive version of this script is not honestly buildable.
 *
 * WHY THE SURVIVOR COUNT IS USUALLY TINY
 *   Solidus Labs found 98.6% of 7M+ pump.fun tokens fell below $1k liquidity or
 *   were outright rugs or manipulative schemes. A funnel that ends in zero or one
 *   candidate is this filter working, not this filter broken.
 *
 * Thin wiring only: the universe rules live in src/paper/engine.js and the
 * verdicts in src/safety/index.js. This file fetches, orders and prints.
 */

import pLimit from 'p-limit';
import { STRATEGY, UNIVERSE_PROFILES } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { getNewPools, getTopPools, getTrendingPools } from '../src/data/geckoterminal.js';
import { loadEnv } from '../src/env.js';
import { decideEntry, readSignals, universeReasons } from '../src/paper/engine.js';
import { emptyPortfolio } from '../src/paper/portfolio.js';
import { runGate } from '../src/safety/index.js';
import { EXIT, buildRpc, intFlag, isMain, line, parseArgs, pct, runMain, usd } from './lib/cli.js';
import { costsFor, solPriceFrom } from './lib/liveCosts.js';

/**
 * How many gates run at once. The RPC limiter caps request STARTS, but a gate is
 * several sequential calls, so unbounded fan-out would queue behind itself and
 * blow every layer's timeout. Small and deliberate.
 */
const GATE_CONCURRENCY = 3;
/** GeckoTerminal new_pools pages to walk. Each costs one of only 30 req/min. */
const DEFAULT_PAGES = 2;
const DEFAULT_LIMIT = 30;

const USAGE = `usage: npm run scan -- [--feed F] [--limit N] [--early] [--pages N] [--json]

Enumerates live Solana pools, screens them against the universe filter, and runs
the safety gate on whatever survives.

  --feed F    trending (default) | top | new
              trending = pools moving right now; the population the momentum
                         rules were written against
              top      = broadest enumeration, ordered by 24h volume
              new      = freshly created pools. These are MINUTES old with tiny
                         caps, so they fail the universe screen almost always --
                         useful for watching launches, not for finding entries
  --limit N   how many screened mints to gate (default ${DEFAULT_LIMIT})
  --pages N   pages to walk (default ${DEFAULT_PAGES}); each costs a request
  --early     use the UNIVERSE_PROFILES.early profile: smaller caps, younger pairs.
              NOTE this does not lower SAFETY.layer2.minLiquidityUsd, so most
              small caps will still be rejected by the gate. That floor is a
              separate, deliberate risk decision -- see src/config.js.
  --json      emit machine-readable output

  0 = ran and found candidates   1 = ran, nothing survived   2 = internal error
`;

/**
 * @param {readonly string[]} argv
 * @param {object} [deps] test seam
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const { flags } = parseArgs(argv);
  const out = deps.out ?? console.log;
  if (flags.help === true) {
    out(USAGE);
    return EXIT.OK;
  }

  const limit = intFlag(flags.limit, DEFAULT_LIMIT);
  const pages = intFlag(flags.pages, DEFAULT_PAGES);
  const universe = flags.early === true ? UNIVERSE_PROFILES.early : undefined;
  const profileName = flags.early === true ? 'early' : 'standard';

  const feed = typeof flags.feed === 'string' ? flags.feed : 'trending';
  const FEEDS = {
    trending: deps.getTrendingPools ?? getTrendingPools,
    top: deps.getTopPools ?? getTopPools,
    new: deps.getNewPools ?? getNewPools,
  };
  if (!Object.hasOwn(FEEDS, feed)) {
    out(`unknown --feed "${feed}". Expected one of: ${Object.keys(FEEDS).join(', ')}`);
    return EXIT.ERROR;
  }

  const env = (deps.loadEnv ?? loadEnv)();
  const rpc = deps.rpc ?? (await buildRpc(env));
  const now = deps.now ?? Date.now;
  const fetchPools = FEEDS[feed];
  const fetchPairs = deps.getBestPairs ?? getBestPairs;
  const gate = deps.runGate ?? runGate;

  // --- 1. enumerate: live pools only. There is no history endpoint. ----------
  const pools = [];
  for (let page = 1; page <= pages; page += 1) {
    pools.push(...(await fetchPools({ page })));
  }
  const mints = [...new Set(pools.map((p) => p.baseMint).filter(Boolean))];

  // --- 2. snapshot: batched 30 per request -----------------------------------
  const pairsByMint = await fetchPairs(mints);
  const pairs = [...pairsByMint.values()].filter((p) => p !== null);

  // --- 3. screen: the SAME rules the engine will apply later ------------------
  const at = now();
  const screenedAll = pairs.map((pair) => ({
    pair,
    reasons: universeReasons(pair, at, universe),
  }));
  const screened = screenedAll
    .filter((row) => row.reasons.length === 0)
    .map((row) => ({ pair: row.pair, signals: readSignals(row.pair, at) }));

  // Why the rest fell out. Without this a funnel ending in 0 is untunable: the
  // operator cannot tell "all too young" from "all too illiquid".
  const blockers = tallyBlockers(screenedAll);

  // Order by observed acceleration. This is an ORDERING, not a forecast.
  const ranked = screened
    .sort((a, b) => (b.signals.volumeAccelerationRatio ?? 0) - (a.signals.volumeAccelerationRatio ?? 0))
    .slice(0, limit);

  // --- 4. gate the survivors, with bounded concurrency ------------------------
  const gateLimit = pLimit(deps.concurrency ?? GATE_CONCURRENCY);
  const gated = await Promise.all(
    ranked.map((row) =>
      gateLimit(async () => ({ ...row, gate: await gate(row.pair.mint, { rpc }) })),
    ),
  );
  // A gate PASS says "not a theft vector". It does NOT say "worth buying" -- the
  // momentum rules are a separate question entirely, and printing only the gate
  // verdict invites reading BUYABLE as a trade signal. So the entry decision is
  // computed here too, using the SAME function the paper engine uses, and shown
  // in its own column.
  const solPriceUsd = solPriceFrom(gated.map((r) => r.pair));
  const entryCosts = costsFor({
    pairs: gated.map((r) => r.pair),
    gates: Object.fromEntries(gated.map((r) => [r.pair.mint, r.gate])),
    solPriceUsd,
  });
  const book = emptyPortfolio({});
  const withEntry = gated.map((row) => {
    const costBreakdown = entryCosts[row.pair.mint];
    const entry =
      costBreakdown === undefined
        ? Object.freeze({
            enter: false,
            reasons: Object.freeze(['round trip not priceable from this snapshot']),
          })
        : decideEntry({
            pair: row.pair,
            portfolio: book,
            gateResult: row.gate,
            costBreakdown,
            now: at,
            universe,
          });
    return { ...row, entry };
  });

  const buyable = withEntry.filter((row) => row.gate.buyable);
  const wouldEnter = withEntry.filter((row) => row.gate.buyable && row.entry.enter);

  const funnel = Object.freeze({
    profile: profileName,
    feed,
    poolsSeen: pools.length,
    uniqueMints: mints.length,
    withPairs: pairs.length,
    passedUniverse: screened.length,
    gated: gated.length,
    buyable: buyable.length,
    wouldEnter: wouldEnter.length,
  });

  if (flags.json === true) {
    out(
      JSON.stringify(
        {
          funnel,
          candidates: withEntry.map((row) => ({
            mint: row.pair.mint,
            symbol: row.pair.baseToken?.symbol ?? null,
            marketCapUsd: row.signals.marketCapUsd,
            liquidityUsd: row.signals.liquidityUsd,
            ageMinutes: row.signals.ageMinutes,
            priceChangeM5Pct: row.signals.priceChangeM5Pct,
            priceChangeH1Pct: row.signals.priceChangeH1Pct,
            buySellRatioM5: row.signals.buySellRatioM5,
            volumeAccelerationRatio: row.signals.volumeAccelerationRatio,
            buyable: row.gate.buyable,
            wouldEnter: row.entry.enter,
            entryBlockedBy: [...row.entry.reasons],
            rejectedBy: row.gate.rejectedBy,
            erroredIn: row.gate.erroredIn,
            skipped: row.gate.skipped,
          })),
        },
        null,
        2,
      ),
    );
    return buyable.length > 0 ? EXIT.OK : EXIT.NEGATIVE;
  }

  printReport({ out, funnel, gated: withEntry, buyable, universe, blockers });
  return buyable.length > 0 ? EXIT.OK : EXIT.NEGATIVE;
}

/**
 * Count how often each universe rule was the blocker, keyed by the rule's own
 * wording with the varying numbers stripped, so 50 different "market cap 41234
 * below floor" reasons collapse into one countable line.
 * @param {readonly {reasons: readonly string[]}[]} rows
 * @returns {readonly {label: string, count: number}[]} most common first
 */
function tallyBlockers(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const reason of row.reasons) {
      const label = reason
        .replace(/-?\d[\d_.,]*/g, 'N')
        .replace(/\s+/g, ' ')
        .trim();
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return Object.freeze(
    [...counts.entries()]
      .map(([label, count]) => Object.freeze({ label, count }))
      .sort((a, b) => b.count - a.count),
  );
}

function printReport({ out, funnel, gated, buyable, universe, blockers }) {
  const uni = universe ?? STRATEGY.universe;
  out(line('='));
  out(`SCAN  feed=${funnel.feed}  profile=${funnel.profile}  ` +
    `mcap ${usd(uni.minMarketCapUsd)}-${usd(uni.maxMarketCapUsd)}  ` +
    `age ${uni.minPairAgeMinutes}m-${uni.maxPairAgeHours}h`);
  out(line('='));
  out('FUNNEL');
  out(`  pools seen (live feed)     ${funnel.poolsSeen}`);
  out(`  unique mints              ${funnel.uniqueMints}`);
  out(`  with a Dexscreener pair   ${funnel.withPairs}`);
  out(`  passed the universe rules ${funnel.passedUniverse}`);
  out(`  safety gate run on        ${funnel.gated}`);
  out(`  SAFE (gate passed)        ${funnel.buyable}`);
  out(`  WOULD ENTER NOW           ${funnel.wouldEnter}   <- safe AND the rules fired`);

  if (blockers !== undefined && blockers.length > 0) {
    out('');
    out('WHY PAIRS FELL OUT AT THE UNIVERSE SCREEN (a pair can fail several rules)');
    for (const b of blockers.slice(0, 8)) {
      out(`  ${String(b.count).padStart(4)}x  ${b.label}`);
    }
    out('  N stands in for the varying numbers, so like reasons group together.');
  }
  out('');

  if (gated.length === 0) {
    out('Nothing reached the gate. That is the expected outcome most of the time:');
    out('98.6% of pump.fun tokens fell below $1k liquidity or were rugs (Solidus');
    out('Labs), so an empty funnel is the filter working, not the filter broken.');
    out(line('-'));
    return;
  }

  out(
    `${'MINT'.padEnd(12)}${'SYM'.padEnd(9)}${'MCAP'.padStart(11)}${'LIQ'.padStart(11)}` +
      `${'AGE'.padStart(7)}${'5m'.padStart(8)}${'1h'.padStart(8)}${'B/S'.padStart(6)}` +
      `${'ACCEL'.padStart(7)}  ${'SAFE?'.padEnd(27)}ENTER?`,
  );
  out(line('-'));
  for (const row of gated) {
    const s = row.signals;
    const verdict = row.gate.buyable
      ? 'SAFE'
      : `blocked (${[...row.gate.rejectedBy, ...row.gate.erroredIn].join(',') || 'n/a'})`;
    // SAFE and ENTER are different questions. SAFE says the creator probably
    // cannot steal from you; ENTER says the momentum rules fired. A token can
    // easily be one without the other, and usually is.
    const entryCol = !row.gate.buyable
      ? '-'
      : row.entry.enter
        ? 'YES -- rules fired'
        : `no (${shortEntryReason(row.entry.reasons)})`;
    out(
      `${row.pair.mint.slice(0, 10).padEnd(12)}` +
        `${(row.pair.baseToken?.symbol ?? '?').slice(0, 8).padEnd(9)}` +
        `${usd(s.marketCapUsd).padStart(11)}${usd(s.liquidityUsd).padStart(11)}` +
        `${(s.ageMinutes === null ? 'n/a' : `${Math.round(s.ageMinutes)}m`).padStart(7)}` +
        `${pct(s.priceChangeM5Pct).padStart(8)}${pct(s.priceChangeH1Pct).padStart(8)}` +
        `${(s.buySellRatioM5 === null ? 'n/a' : s.buySellRatioM5.toFixed(1)).padStart(6)}` +
        `${(s.volumeAccelerationRatio === null ? 'n/a' : s.volumeAccelerationRatio.toFixed(1)).padStart(7)}` +
        `  ${verdict.padEnd(27)}${entryCol}`,
    );
  }
  out(line('-'));
  out('ACCEL = vol(5m)x12 / vol(1h): is the move accelerating, or merely ongoing.');
  out('Ordering by it is an ORDERING OF WHAT ALREADY HAPPENED, not a forecast.');
  out('');
  out('SAFE?  = the safety gate: the creator probably cannot steal your tokens.');
  out('ENTER? = the momentum rules: would the strategy actually buy right now.');
  out('These are DIFFERENT QUESTIONS. Most tokens are one without the other, and');
  out('SAFE on its own is not a trade signal -- soft rugs pass every safety check.');
  out(line('-'));
}

/** The single most useful entry-rejection reason, trimmed to fit a column. */
function shortEntryReason(reasons) {
  if (reasons.length === 0) return 'no reason given';
  const first = reasons[0];
  const key = /5m change/.test(first)
    ? '5m move'
    : /1h change/.test(first)
      ? '1h move'
      : /buy\/sell/.test(first)
        ? 'being sold into'
        : /acceleration/.test(first)
          ? 'not accelerating'
          : /break-even|priceable/.test(first)
            ? 'costs too high'
            : first.split(':')[0];
  return reasons.length > 1 ? `${key} +${reasons.length - 1} more` : key;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
