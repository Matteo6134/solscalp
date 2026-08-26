#!/usr/bin/env node
/**
 * Forward recorder -- write down what the market looked like, as it happens.
 *
 * WHY THIS IS THE MOST IMPORTANT SCRIPT IN THE REPO
 *   The design record rejects historical candle backtesting for a structural
 *   reason: the universe is not retroactively enumerable. Dexscreener has no
 *   history endpoint and GeckoTerminal's pool feeds are live-only, so you cannot
 *   reconstruct "which pools existed at 14:05 with $50k liquidity". A window
 *   nobody sampled while it was live is gone forever.
 *
 *   Which means the ONLY honest dataset this project can ever have is the one it
 *   writes down itself, in real time, including the tokens that died. That is
 *   what this produces, and it is what scripts/backtest-rug-filter.js later reads.
 *
 * THE DATASET IS APPEND-ONLY AND IS NEVER REWRITTEN
 *   One JSON object per line, flushed per line, so a crash mid-run cannot corrupt
 *   what came before. Nothing here ever opens a file for truncation.
 *
 * SKIPPED IS RECORDED SEPARATELY FROM PASSED
 *   A layer that never ran is stored as `skipped`, never merged into the passes.
 *   Conflating them would silently poison every statistic later computed from
 *   this file -- it would claim the filter checked things it never looked at.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import pLimit from 'p-limit';
import { RECORDER, STRATEGY, UNIVERSE_PROFILES } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { getTrendingPools } from '../src/data/geckoterminal.js';
import { loadEnv } from '../src/env.js';
import { readSignals, universeReasons } from '../src/paper/engine.js';
import { runGate } from '../src/safety/index.js';
import { EXIT, buildRpc, intFlag, isMain, parseArgs, runMain, say } from './lib/cli.js';

const GATE_CONCURRENCY = 3;
const MS_PER_SECOND = 1_000;
const ISO_DATE_LENGTH = 10;

const USAGE = `usage: npm run record -- [--interval S] [--ticks N] [--early] [--dir PATH]

Appends JSONL snapshots of the candidate universe and its gate verdicts to
${RECORDER.dir}/YYYY-MM-DD.jsonl. Append-only; runs until interrupted.

  --interval S  seconds between snapshots (default ${RECORDER.snapshotIntervalSeconds})
  --ticks N     stop after N snapshots (default: run until Ctrl+C)
  --early       screen with UNIVERSE_PROFILES.early
  --dir PATH    output directory (default ${RECORDER.dir})
`;

/** UTC day bucket, so a file boundary is the same wherever the recorder runs. */
export const dayFile = (ts) => `${new Date(ts).toISOString().slice(0, ISO_DATE_LENGTH)}.jsonl`;

/**
 * Shape one snapshot line. Pure, so its structure is testable without a disk.
 * @returns {object} one JSONL record
 */
export function buildRecord({ ts, profile, rows }) {
  return {
    schemaVersion: RECORDER.schemaVersion,
    ts,
    iso: new Date(ts).toISOString(),
    profile,
    candidates: rows.map(({ pair, signals, gate }) => {
    // Layer 1 measured the round trip; keep its price impacts so a consumer can
    // price a trade without re-quoting Jupiter. Without these, decideEntry has no
    // cost breakdown and correctly refuses every entry.
    const sim = gate.layers.find((l) => l.layer === 'layer1-sellsim')?.facts ?? {};
    return ({
      mint: pair.mint,
      symbol: pair.baseToken?.symbol ?? null,
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      priceUsd: signals.priceUsd,
      marketCapUsd: signals.marketCapUsd,
      liquidityUsd: signals.liquidityUsd,
      ageMinutes: signals.ageMinutes,
      volumeM5Usd: signals.volumeM5Usd,
      volumeH1Usd: signals.volumeH1Usd,
      priceChangeM5Pct: signals.priceChangeM5Pct,
      priceChangeH1Pct: signals.priceChangeH1Pct,
      buySellRatioM5: signals.buySellRatioM5,
      volumeAccelerationRatio: signals.volumeAccelerationRatio,
      // Raw counters, so scripts/bot.js can rebuild these signals from the file
      // rather than paying for the same fetch a second time. Added after two
      // processes scanning the same endpoint exhausted GeckoTerminal's per-IP
      // budget between them.
      quoteMint: pair.quoteToken?.address ?? null,
      pairCreatedAtMs: pair.pairCreatedAtMs ?? null,
      txns: pair.txns ?? null,
      gate: {
        buyable: gate.buyable,
        complete: gate.complete,
        // These three are kept STRICTLY apart. See the header.
        passed: gate.layers.filter((l) => l.outcome === 'PASS').map((l) => l.layer),
        rejectedBy: [...gate.rejectedBy],
        erroredIn: [...gate.erroredIn],
        skipped: [...gate.skipped],
        reasons: [...gate.reasons],
        elapsedMs: gate.elapsedMs,
      },
      roundTrip: {
        buyPriceImpactPct: sim.buyPriceImpactPct ?? null,
        sellPriceImpactPct: sim.sellPriceImpactPct ?? null,
        roundTripLossPct: sim.roundTripLossPct ?? null,
      },
      // Filled in later by a labelling pass; never assumed.
      outcome: null,
    });
    }),
  };
}

/** One tick: enumerate, screen, gate, and return the rows to record. */
async function collect({ universe, rpc, now, fetchPools, fetchPairs, gate, concurrency }) {
  const pools = await fetchPools({ page: 1 });
  const mints = [...new Set(pools.map((p) => p.baseMint).filter(Boolean))];
  const pairsByMint = await fetchPairs(mints);
  const at = now();
  const screened = [...pairsByMint.values()]
    .filter((p) => p !== null)
    .filter((pair) => universeReasons(pair, at, universe).length === 0)
    .map((pair) => ({ pair, signals: readSignals(pair, at) }));

  const limit = pLimit(concurrency);
  return Promise.all(
    screened.map((row) => limit(async () => ({ ...row, gate: await gate(row.pair.mint, { rpc }) }))),
  );
}

/**
 * @param {readonly string[]} argv
 * @param {object} [deps] test seam
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const { flags } = parseArgs(argv);
  const out = deps.out ?? say;
  if (flags.help === true) {
    out(USAGE);
    return EXIT.OK;
  }

  const intervalS = intFlag(flags.interval, RECORDER.snapshotIntervalSeconds);
  const maxTicks = flags.ticks === undefined ? Infinity : intFlag(flags.ticks, 1);
  const universe = flags.early === true ? UNIVERSE_PROFILES.early : undefined;
  const profile = flags.early === true ? 'early' : 'standard';
  const dir = typeof flags.dir === 'string' ? flags.dir : RECORDER.dir;

  const env = (deps.loadEnv ?? loadEnv)();
  const rpc = deps.rpc ?? (await buildRpc(env));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const write = deps.appendFile ?? appendFile;

  await (deps.mkdir ?? mkdir)(dir, { recursive: true });

  out(`recording every ${intervalS}s into ${dir}/  (profile=${profile}) -- Ctrl+C to stop`);
  out('append-only: existing lines are never rewritten');

  let ticks = 0;
  let written = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on('SIGINT', stop);

  while (!stopped && ticks < maxTicks) {
    const ts = now();
    try {
      const rows = await collect({
        universe,
        rpc,
        now,
        fetchPools: deps.getTrendingPools ?? getTrendingPools,
        fetchPairs: deps.getBestPairs ?? getBestPairs,
        gate: deps.runGate ?? runGate,
        concurrency: deps.concurrency ?? GATE_CONCURRENCY,
      });
      const record = buildRecord({ ts, profile, rows });
      // One stringify, one newline, one append: a partial write cannot straddle
      // two records, so every earlier line stays independently parseable.
      await write(join(dir, dayFile(ts)), `${JSON.stringify(record)}\n`, 'utf8');
      written += 1;
      const buyable = record.candidates.filter((c) => c.gate.buyable).length;
      out(
        `[${record.iso}] tick ${written}: ${record.candidates.length} candidates, ` +
          `${buyable} buyable -> ${dayFile(ts)}`,
      );
    } catch (err) {
      // A failed tick must never kill the recorder: the next one may succeed, and
      // a gap in the data is far better than losing the run.
      out(`[tick failed, continuing] ${err?.message ?? err}`);
    }
    ticks += 1;
    if (!stopped && ticks < maxTicks) await sleep(intervalS * MS_PER_SECOND);
  }

  out(`stopped after ${written} snapshot(s)`);
  return written > 0 ? EXIT.OK : EXIT.NEGATIVE;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
