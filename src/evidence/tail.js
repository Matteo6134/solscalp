/**
 * Read the recorder's latest snapshot instead of fetching the market again.
 *
 * WHY THIS EXISTS
 *   The recorder and the bot were both calling GeckoTerminal's trending_pools
 *   every cycle. The limit is 30 req/min PER IP, and the rate limiters in
 *   src/data are per-process and cannot see each other, so two well-behaved
 *   processes still exhausted the shared budget between them and the bot spent
 *   its time reporting 429s.
 *
 *   Adding intervals only postpones that. The actual fix is that exactly ONE
 *   process should talk to each upstream, and everything else should read what it
 *   wrote. The recorder already fetches the pools, screens them, runs the full
 *   six-layer gate and writes the verdicts to an append-only JSONL. That file is
 *   a better source for the bot than the network: it costs nothing, it cannot be
 *   rate limited, and it guarantees the alerts describe exactly the same
 *   observation the dataset will later be scored on.
 *
 * WHAT IT DOES NOT DO
 *   It does not make the bot independent. If the recorder stops, this returns
 *   nothing new and the bot has nothing to say -- which is correct, and is why
 *   `snapshotAgeMs` is returned: a consumer must be able to tell "the market is
 *   quiet" from "my source of truth died". Silence from a dead recorder must
 *   never read as silence from a calm market.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KNOWN, LABELS, RECORDER } from '../config.js';

const MS_PER_MINUTE = 60_000;

/**
 * Rebuild a Dexscreener-shaped `pair` from a recorded candidate.
 *
 * The engine's readSignals() expects the wire shape, and reconstructing it here
 * keeps ONE definition of the momentum maths rather than a second copy that
 * could drift from the one the recorder used.
 *
 * Older recordings predate the raw-counter fields. Those come back with the
 * counters absent, which readSignals correctly reports as UNKNOWN -- and unknown
 * means no entry. A pre-upgrade snapshot therefore degrades to "cannot decide",
 * never to a guess.
 *
 * @param {object} c a candidate from a recorded snapshot
 * @param {number} ts the snapshot's timestamp
 */
export function candidateToPair(c, ts) {
  const ageMinutes = typeof c.ageMinutes === 'number' ? c.ageMinutes : null;
  return Object.freeze({
    mint: c.mint,
    pairAddress: c.pairAddress ?? null,
    dexId: c.dexId ?? null,
    priceUsd: c.priceUsd ?? null,
    liquidityUsd: c.liquidityUsd ?? null,
    marketCap: c.marketCapUsd ?? null,
    fdv: c.marketCapUsd ?? null,
    baseToken: Object.freeze({ address: c.mint, symbol: c.symbol ?? null }),
    // Recorded explicitly once the raw counters landed; older snapshots fall back
    // to WSOL, which is what the universe screen already required to record it.
    quoteToken: Object.freeze({ address: c.quoteMint ?? KNOWN.WSOL }),
    volumeUsd: Object.freeze({ m5: c.volumeM5Usd ?? null, h1: c.volumeH1Usd ?? null }),
    priceChangePct: Object.freeze({
      m5: c.priceChangeM5Pct ?? null,
      h1: c.priceChangeH1Pct ?? null,
    }),
    txns: c.txns ?? Object.freeze({}),
    pairCreatedAtMs:
      c.pairCreatedAtMs ?? (ageMinutes === null ? null : ts - ageMinutes * MS_PER_MINUTE),
    fetchedAtMs: ts,
    /** Marks the provenance, so a consumer can never mistake this for a live read. */
    fromRecording: true,
  });
}

/**
 * The most recent snapshot on disk.
 *
 * @param {object} [p]
 * @param {string} [p.dir]
 * @param {number} [p.now]
 * @param {object} [deps]
 * @returns {Promise<Readonly<{ts: number|null, snapshotAgeMs: number|null,
 *   candidates: readonly object[], pairs: readonly object[],
 *   gateResults: Record<string, object>, profile: string|null, fileCount: number}>}>
 */
export async function latestSnapshot({ dir = RECORDER.dir, now = Date.now() } = {}, deps = {}) {
  const list = deps.readdir ?? readdir;
  const read = deps.readFile ?? readFile;

  let files;
  try {
    files = (await list(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return empty(0);
  }
  if (files.length === 0) return empty(0);

  // Newest file first; a day boundary means the newest may be nearly empty, so
  // walk backwards until a real snapshot is found.
  for (const file of [...files].reverse()) {
    let text;
    try {
      text = await read(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const raw = lines[i].trim();
      if (raw === '') continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        // A torn final line is expected if the recorder was killed mid-write.
        continue;
      }
      if (record?.schemaVersion !== RECORDER.schemaVersion) continue;
      // Compare against the real constant. An earlier version tested
      // `RECORDER.labelType`, which does not exist -- so it read `undefined ===
      // undefined` for every ordinary snapshot and skipped the entire recording
      // as if it were all label records.
      if (record.type === LABELS.recordType) continue;
      if (!Array.isArray(record.candidates)) continue;

      const candidates = record.candidates.filter((c) => typeof c?.mint === 'string');
      return Object.freeze({
        ts: record.ts,
        snapshotAgeMs: now - record.ts,
        profile: record.profile ?? null,
        candidates: Object.freeze(candidates),
        // Every pair the tick LOOKED at, rejects included. Optional: recordings
        // written before the recorder started keeping them have no such field,
        // and an older file must degrade to empty rather than crash a reader.
        scanned: Object.freeze(Array.isArray(record.scanned) ? record.scanned : []),
        pairs: Object.freeze(candidates.map((c) => candidateToPair(c, record.ts))),
        // The recorder already ran the gate. Re-running it would be a second
        // verdict on the same instant, and the two could disagree.
        gateResults: Object.freeze(
          Object.fromEntries(
            candidates.map((c) => [
              c.mint,
              Object.freeze({
                buyable: c.gate?.buyable === true,
                complete: c.gate?.complete === true,
                rejectedBy: Object.freeze([...(c.gate?.rejectedBy ?? [])]),
                erroredIn: Object.freeze([...(c.gate?.erroredIn ?? [])]),
                skipped: Object.freeze([...(c.gate?.skipped ?? [])]),
                reasons: Object.freeze([...(c.gate?.reasons ?? [])]),
                // Rebuild just enough of the layer-1 verdict for the cost model:
                // scripts/lib/liveCosts.js reads the round-trip price impacts off
                // this shape. Recordings taken before those were stored yield
                // nulls here, which costsFor treats as "not priceable" -- and
                // decideEntry then refuses the entry rather than guessing a cost.
                layers: Object.freeze([
                  Object.freeze({
                    layer: 'layer1-sellsim',
                    outcome: c.gate?.buyable === true ? 'PASS' : 'REJECT',
                    reasons: Object.freeze([]),
                    facts: Object.freeze({
                      buyPriceImpactPct: c.roundTrip?.buyPriceImpactPct ?? null,
                      sellPriceImpactPct: c.roundTrip?.sellPriceImpactPct ?? null,
                      roundTripLossPct: c.roundTrip?.roundTripLossPct ?? null,
                      fromRecording: true,
                    }),
                    ms: 0,
                  }),
                ]),
                residualRisks: Object.freeze([]),
                fromRecording: true,
              }),
            ]),
          ),
        ),
        fileCount: files.length,
      });
    }
  }
  return empty(files.length);
}

function empty(fileCount) {
  return Object.freeze({
    ts: null,
    snapshotAgeMs: null,
    profile: null,
    candidates: Object.freeze([]),
    scanned: Object.freeze([]),
    pairs: Object.freeze([]),
    gateResults: Object.freeze({}),
    fileCount,
  });
}

/**
 * Is the recorder still alive?
 *
 * A consumer that cannot answer this will report a quiet market when its source
 * of truth has actually died -- the single most misleading thing it could do.
 * @param {number|null} snapshotAgeMs
 * @param {number} expectedIntervalSeconds
 * @param {number} [toleranceMultiple] how many missed ticks before we call it stale
 */
export function isRecorderHealthy(snapshotAgeMs, expectedIntervalSeconds, toleranceMultiple = 10) {
  if (snapshotAgeMs === null) return false;
  return snapshotAgeMs <= expectedIntervalSeconds * 1_000 * toleranceMultiple;
}
