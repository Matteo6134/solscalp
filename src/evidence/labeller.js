/**
 * One labelling pass over the recording. Shared by the CLI and the recorder.
 *
 * WHY THIS IS NOT A COMMAND YOU RUN
 *   Labelling is periodic maintenance of the dataset, not something a person
 *   should have to remember. If it only ever happens when someone types
 *   `npm run label`, then the one number this project exists to produce silently
 *   depends on human diligence -- and 136 snapshots had already accumulated with
 *   zero labels before anyone noticed.
 *
 *   So the recorder runs it on a timer. It is the process that already owns
 *   data/recordings and already talks to Dexscreener, which matters: the limits
 *   are per IP and the rate limiters are per process, so adding a second
 *   labelling process would recreate the starvation that took the bot down.
 *   One owner per upstream, one owner per directory.
 *
 * APPEND-ONLY
 *   Labels are appended as their own line type; the raw observations are never
 *   rewritten. If the thresholds in LABELS turn out wrong, the dataset can be
 *   relabelled from the stored evidence without re-collecting anything.
 */

import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LABELS, RECORDER } from '../config.js';
import { getBestPairs } from '../data/dexscreener.js';
import { LABEL, decideOutcome, shouldRelabel } from './outcome.js';
import { extractFeatures } from '../ml/features.js';
import { defaultModel } from '../ml/model.js';

const ISO_DATE_LENGTH = 10;

/**
 * Fold the JSONL into the first observation per mint and the latest label per mint.
 * @param {readonly string[]} lines
 */
export function readDataset(lines) {
  const observations = new Map();
  const labels = new Map();
  let malformed = 0;

  for (const raw of lines) {
    const text = raw.trim();
    if (text === '') continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      malformed += 1;
      continue;
    }
    if (record?.schemaVersion !== RECORDER.schemaVersion) {
      malformed += 1;
      continue;
    }

    if (record.type === LABELS.recordType) {
      for (const entry of record.labels ?? []) {
        if (typeof entry?.mint !== 'string') continue;
        const prior = labels.get(entry.mint);
        if (prior === undefined || (entry.ts ?? 0) >= (prior.ts ?? 0)) labels.set(entry.mint, entry);
      }
      continue;
    }

    for (const candidate of record.candidates ?? []) {
      if (typeof candidate?.mint !== 'string') continue;
      // FIRST observation wins: that is the decision the filter would have traded
      // on, and the liquidity any collapse must be measured against.
      if (!observations.has(candidate.mint)) {
        observations.set(candidate.mint, { ...candidate, recordedTs: record.ts });
      }
    }
  }
  return { observations, labels, malformed };
}

/**
 * Run one pass. Pure of any printing: returns what it did so the caller decides
 * how loudly to say it.
 *
 * @param {object} [p]
 * @param {string} [p.dir]
 * @param {number} [p.now]
 * @param {boolean} [p.dryRun]
 * @param {object} [p.thresholds]
 * @param {object} [deps] `readdir`, `readFile`, `appendFile`, `getBestPairs`
 * @returns {Promise<Readonly<object>>} a summary; `written` is what reached disk
 */
export async function runLabellingPass(
  { dir = RECORDER.dir, now = Date.now(), dryRun = false, thresholds = LABELS } = {},
  deps = {},
) {
  const list = deps.readdir ?? readdir;
  const read = deps.readFile ?? readFile;
  const append = deps.appendFile ?? appendFile;
  const fetchPairs = deps.getBestPairs ?? getBestPairs;

  let files;
  try {
    files = (await list(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return summary({ reason: `no recordings directory at ${dir}` });
  }
  if (files.length === 0) return summary({ reason: `no .jsonl recordings in ${dir}` });

  const lines = [];
  for (const file of files) {
    lines.push(...(await read(join(dir, file), 'utf8')).split('\n'));
  }
  const { observations, labels, malformed } = readDataset(lines);

  const due = [...observations.values()].filter((o) => {
    const prior = labels.get(o.mint);
    return shouldRelabel({
      lastLabelledTs: prior?.ts ?? null,
      lastLabel: prior?.outcome ?? null,
      now,
      thresholds,
    });
  });

  if (due.length === 0) {
    return summary({
      files: files.length,
      malformed,
      observed: observations.size,
      alreadyLabelled: labels.size,
      reason: 'nothing due',
    });
  }

  let current;
  try {
    current = await fetchPairs(due.map((o) => o.mint));
  } catch (err) {
    // Refuse to label anything during an outage: recording an outage as dead
    // pools would fabricate a spectacular rug rate.
    return summary({
      files: files.length,
      malformed,
      observed: observations.size,
      alreadyLabelled: labels.size,
      due: due.length,
      reason: `data source unreachable (${err?.message ?? err}) -- labelled nothing`,
    });
  }
  const answered = [...current.values()].filter((p) => p !== null).length;
  const apiHealthy = answered > 0;

  const decided = due.map((o) => ({
    observation: o,
    ...decideOutcome({
      recordedTs: o.recordedTs,
      recordedLiquidityUsd: o.liquidityUsd ?? null,
      recordedPriceUsd: o.priceUsd ?? null,
      current: current.get(o.mint) ?? null,
      now,
      apiHealthy,
      thresholds,
    }),
  }));

  const writable = decided.filter((d) => d.label === LABEL.RUGGED || d.label === LABEL.SURVIVED);
  const counts = decided.reduce(
    (acc, d) => ({ ...acc, [d.label]: (acc[d.label] ?? 0) + 1 }),
    {},
  );

  if (writable.length === 0 || dryRun) {
    return summary({
      files: files.length,
      malformed,
      observed: observations.size,
      alreadyLabelled: labels.size,
      due: due.length,
      answered,
      counts,
      decided,
      reason: dryRun ? 'dry run' : 'no conclusive outcomes',
    });
  }

  const record = {
    schemaVersion: RECORDER.schemaVersion,
    type: LABELS.recordType,
    ts: now,
    iso: new Date(now).toISOString(),
    labels: writable.map((d) => ({
      mint: d.observation.mint,
      symbol: d.observation.symbol ?? null,
      outcome: d.label,
      ts: now,
      observedTs: d.observation.recordedTs,
      gateBuyable: d.observation.gate?.buyable ?? null,
      reasons: [...d.reasons],
      evidence: d.evidence,
    })),
  };
  const target = join(dir, `${new Date(now).toISOString().slice(0, ISO_DATE_LENGTH)}.jsonl`);
  await append(target, `${JSON.stringify(record)}\n`, 'utf8');

  // --- Online Continuous ML Training ---
  let trainedCount = 0;
  for (const d of writable) {
    if (d.label === 'survived' || d.label === 'rugged') {
      const obs = d.observation;
      const features = extractFeatures({
        pair: {
          liquidityUsd: obs.liquidityUsd,
          marketCap: obs.marketCapUsd,
          ageMinutes: obs.ageMinutes,
          volumeUsd: { m5: obs.volumeM5Usd, h1: obs.volumeH1Usd },
          priceChangePct: { m5: obs.priceChangeM5Pct, h1: obs.priceChangeH1Pct },
          buySellRatioM5: obs.buySellRatioM5,
        },
        signals: obs,
        gateResult: obs.gate ?? {},
        costBreakdown: obs.roundTrip ?? {},
      });
      defaultModel.trainOne(features, d.label === 'survived' ? 1.0 : 0.0);
      trainedCount++;
    }
  }
  if (trainedCount > 0) {
    defaultModel.save();
  }

  return summary({
    files: files.length,
    malformed,
    observed: observations.size,
    alreadyLabelled: labels.size,
    due: due.length,
    answered,
    counts,
    decided,
    written: writable.length,
    target,
  });
}

function summary(over) {
  return Object.freeze({
    files: 0,
    malformed: 0,
    observed: 0,
    alreadyLabelled: 0,
    due: 0,
    answered: 0,
    counts: Object.freeze({}),
    decided: Object.freeze([]),
    written: 0,
    target: null,
    reason: null,
    ...over,
  });
}
