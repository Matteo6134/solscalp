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
import { LABELS, RECORDER, STRATEGY, UNIVERSE_PROFILES } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { getTrendingPools } from '../src/data/geckoterminal.js';
import { loadEnv } from '../src/env.js';
import { runLabellingPass } from '../src/evidence/labeller.js';
import { decideEntry, readSignals, universeReasons } from '../src/paper/engine.js';
import { emptyPortfolio } from '../src/paper/portfolio.js';
import { costsFor, solPriceFrom } from './lib/liveCosts.js';
import { runGate } from '../src/safety/index.js';
import { EXIT, buildRpc, intFlag, isMain, parseArgs, runMain, say } from './lib/cli.js';

const GATE_CONCURRENCY = 3;
const MS_PER_SECOND = 1_000;
const ISO_DATE_LENGTH = 10;
/** Ceiling on the scan feed per tick, so a huge trending page cannot bloat a day's file. */
const MAX_SCANNED_RECORDED = 60;

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
export function buildRecord({ ts, profile, rows, entries = {}, scanned = [] }) {
  return {
    schemaVersion: RECORDER.schemaVersion,
    ts,
    iso: new Date(ts).toISOString(),
    profile,
    // EVERY pair this tick looked at, including the ones the screen threw out.
    //
    // Previously only survivors were stored, which made the recording unable to
    // answer "what did it consider?" -- and made the dashboard look frozen
    // whenever nothing passed, which is most ticks. Keeping the rejects turns an
    // empty screen into visible work.
    //
    // Deliberately tiny: symbol, mint, two numbers and the FIRST reject reason.
    // A full pair object here would multiply the file size by the rejection
    // ratio -- roughly 40x -- for data no decision reads. Additive field, so
    // every existing reader ignores it and schemaVersion does not move.
    scanned: scanned.slice(0, MAX_SCANNED_RECORDED).map((x) => ({
      symbol: x.symbol,
      mint: x.mint,
      marketCapUsd: x.marketCapUsd,
      liquidityUsd: x.liquidityUsd,
      rejectedBy: x.rejectedBy,
    })),
    candidates: rows.map(({ pair, signals, gate }) => {
    // Layer 1 measured the round trip; keep its price impacts so a consumer can
    // price a trade without re-quoting Jupiter. Without these, decideEntry has no
    // cost breakdown and correctly refuses every entry.
    const sim = gate.layers.find((l) => l.layer === 'layer1-sellsim')?.facts ?? {};
    const entry = entries[pair.mint] ?? null;
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
      // The ENTRY decision, computed once here and stored. It is a SEPARATE
      // question from the gate verdict -- safe is not the same as worth buying --
      // and storing it means every reader shows the same answer instead of each
      // re-deriving it from a different cost guess.
      wouldEnter: entry?.enter ?? null,
      entryBlockedBy: entry === null ? null : [...entry.reasons].slice(0, 3),
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
  const all = [...pairsByMint.values()].filter((p) => p !== null);

  // Judge once, keep both sides. The screen's verdict is needed for the rows to
  // gate AND for the scan feed, and calling universeReasons twice would risk the
  // two disagreeing.
  // readSignals ONCE per pair, and share it. The scan feed and the gated rows
  // need the same numbers, and reading them off the pair directly does not work:
  // market cap is derived (pair.marketCapUsd is undefined) and the symbol is
  // nested at pair.baseToken.symbol. Both silently recorded null until a
  // candidate showing "Hailey / $101,389" was compared against its own scan row.
  const judged = all.map((pair) => ({
    pair,
    signals: readSignals(pair, at),
    rejectedBy: universeReasons(pair, at, universe),
  }));
  const scanned = judged.map(({ pair, signals, rejectedBy }) => ({
    symbol: pair.baseToken?.symbol ?? null,
    mint: pair.mint,
    marketCapUsd: signals.marketCapUsd,
    liquidityUsd: signals.liquidityUsd,
    rejectedBy: rejectedBy.length > 0 ? rejectedBy[0] : null,
  }));
  const screened = judged
    .filter(({ rejectedBy }) => rejectedBy.length === 0)
    .map(({ pair, signals }) => ({ pair, signals }));

  const limit = pLimit(concurrency);
  const rows = await Promise.all(
    screened.map((row) => limit(async () => ({ ...row, gate: await gate(row.pair.mint, { rpc }) }))),
  );
  return { rows, scanned, poolsSeen: all.length };
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

  const useRadar = flags.radar === true;
  const defaultInterval = useRadar ? 5 : RECORDER.snapshotIntervalSeconds;
  const intervalS = intFlag(flags.interval, defaultInterval);
  const maxTicks = flags.ticks === undefined ? Infinity : intFlag(flags.ticks, 1);
  const universe = flags.early === true ? UNIVERSE_PROFILES.early : undefined;
  const profile = flags.early === true ? 'early' : 'standard';
  const dir = typeof flags.dir === 'string' ? flags.dir : RECORDER.dir;

  const fetchRadarMints = async () => {
    const fs = await import('fs');
    const path = await import('path');
    const f = path.join(process.cwd(), 'data', 'radar.txt');
    if (!fs.existsSync(f)) return [];
    const content = fs.readFileSync(f, 'utf-8');
    fs.writeFileSync(f, ''); // clear it
    const mints = [...new Set(content.split('\n').map(m => m.trim()).filter(Boolean))];
    return mints.map(m => ({ baseMint: m }));
  };

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
  // Label on a timer rather than on demand. Starts at 0 so the first pass runs
  // on the first tick: if the process has been down, there is catching up to do.
  let lastLabelAt = 0;
  let labelled = 0;
  // Read the interval ONCE and refuse a missing one loudly. The first version of
  // this read RECORDER.autoLabelEveryMinutes while the value lives on LABELS, so
  // the comparison was 'ts >= NaN' -- always false -- and labelling silently never
  // ran. A maintenance job that quietly does nothing is the worst outcome here,
  // because the dataset keeps growing and stays unscoreable while looking healthy.
  const labelEveryMs = LABELS.autoLabelEveryMinutes * 60 * MS_PER_SECOND;
  if (!Number.isFinite(labelEveryMs) || labelEveryMs <= 0) {
    throw new TypeError(
      `LABELS.autoLabelEveryMinutes must be a positive number, got ${String(LABELS.autoLabelEveryMinutes)}`,
    );
  }
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on('SIGINT', stop);

  while (!stopped && ticks < maxTicks) {
    const ts = now();
    try {
      const fetchCombinedPools = async (opts) => {
        const trending = await (deps.getTrendingPools ?? getTrendingPools)(opts).catch(() => []);
        const radar = useRadar ? await fetchRadarMints() : [];
        const map = new Map();
        for (const p of [...trending, ...radar]) {
          if (p?.baseMint) map.set(p.baseMint, p);
        }
        return [...map.values()];
      };

      const { rows, scanned } = await collect({
        universe,
        rpc,
        now,
        fetchPools: fetchCombinedPools,
        fetchPairs: deps.getBestPairs ?? getBestPairs,
        gate: deps.runGate ?? runGate,
        concurrency: deps.concurrency ?? GATE_CONCURRENCY,
      });
      // Price the round trip and ask the entry rules, once, here. No extra
      // network: the impacts come from the gate's own layer-1 verdict.
      const solPriceUsd = solPriceFrom(rows.map((r) => r.pair));
      const costs = costsFor({
        pairs: rows.map((r) => r.pair),
        gates: Object.fromEntries(rows.map((r) => [r.pair.mint, r.gate])),
        solPriceUsd,
      });
      const book = emptyPortfolio({});
      const entries = Object.fromEntries(
        rows.map((r) => {
          const cost = costs[r.pair.mint];
          if (cost === undefined) return [r.pair.mint, null];
          try {
            return [
              r.pair.mint,
              decideEntry({
                pair: r.pair,
                portfolio: book,
                gateResult: r.gate,
                costBreakdown: cost,
                now: ts,
                universe,
              }),
            ];
          } catch {
            // An unpriceable round trip is a refusal, not a crash.
            return [r.pair.mint, null];
          }
        }),
      );
      const record = buildRecord({ ts, profile, rows, entries, scanned });
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
    // --- periodic labelling: maintenance of the dataset we just appended to ---
    if (ts - lastLabelAt >= labelEveryMs) {
      lastLabelAt = ts;
      try {
        const pass = await (deps.runLabellingPass ?? runLabellingPass)({ dir, now: ts });
        labelled += pass.written;
        if (pass.written > 0) {
          const c = pass.counts;
          out(
            `[label] wrote ${pass.written} outcome(s): ` +
              `${c.rugged ?? 0} rugged, ${c.survived ?? 0} survived ` +
              `(${labelled} total this run)`,
          );
        } else if (pass.reason !== 'nothing due') {
          out(`[label] ${pass.reason}`);
        }
      } catch (err) {
        // Labelling must never be able to stop the recording. The snapshots are
        // the irreplaceable part; a label can always be recomputed later.
        out(`[label failed, recording continues] ${err?.message ?? err}`);
      }
    }

    ticks += 1;
    if (!stopped && ticks < maxTicks) await sleep(intervalS * MS_PER_SECOND);
  }

  out(`stopped after ${written} snapshot(s)`);
  return written > 0 ? EXIT.OK : EXIT.NEGATIVE;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
