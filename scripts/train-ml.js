/**
 * Machine Learning Pre-Training & Evaluation CLI.
 *
 * Trains the TokenSurvivalModel on all historical recorded observations and labels.
 * Evaluates performance and saves the weights to data/ml_weights.json.
 */

import fs from 'fs';
import path from 'path';
import { extractFeatures, FEATURE_NAMES } from '../src/ml/features.js';
import { TokenSurvivalModel, DEFAULT_MODEL_PATH } from '../src/ml/model.js';

const dir = path.join(process.cwd(), 'data', 'recordings');

function loadDataset() {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const observations = new Map(); // mint -> candidate
  const labels = new Map(); // mint -> outcome

  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'labels') {
          for (const l of rec.labels ?? []) {
            if (l.mint && l.outcome) {
              labels.set(l.mint, l.outcome);
            }
          }
        }
        if (Array.isArray(rec.candidates)) {
          for (const c of rec.candidates) {
            if (c.mint && !observations.has(c.mint)) {
              observations.set(c.mint, c);
            }
          }
        }
      } catch (e) {}
    }
  }

  const samples = [];
  for (const [mint, outcome] of labels.entries()) {
    if (outcome !== 'rugged' && outcome !== 'survived') continue;
    const obs = observations.get(mint);
    if (!obs) continue;

    const features = extractFeatures({
      pair: {
        liquidityUsd: obs.liquidityUsd,
        marketCap: obs.marketCapUsd,
        ageMinutes: obs.ageMinutes,
        volumeUsd: { m5: obs.volumeM5Usd, h1: obs.volumeH1Usd },
        priceChangePct: { m5: obs.priceChangeM5Pct, h1: obs.priceChangeH1Pct },
        buySellRatioM5: obs.buySellRatioM5,
      },
      signals: {
        liquidityUsd: obs.liquidityUsd,
        marketCapUsd: obs.marketCapUsd,
        ageMinutes: obs.ageMinutes,
        volumeM5Usd: obs.volumeM5Usd,
        volumeH1Usd: obs.volumeH1Usd,
        buySellRatioM5: obs.buySellRatioM5,
        priceChangeM5Pct: obs.priceChangeM5Pct,
        priceChangeH1Pct: obs.priceChangeH1Pct,
      },
      gateResult: obs.gate ?? {},
      costBreakdown: obs.roundTrip ?? {},
    });

    const target = outcome === 'survived' ? 1.0 : 0.0;
    samples.push({ mint, symbol: obs.symbol, features, target, outcome });
  }

  return { samples, totalObservations: observations.size, totalLabels: labels.size };
}

async function main() {
  console.log('=== SOLSCALP Machine Learning Model Training ===');
  const { samples, totalObservations, totalLabels } = loadDataset();

  console.log(`Loaded ${totalObservations} candidate observations.`);
  console.log(`Found ${totalLabels} ground-truth labels.`);
  console.log(`Matched ${samples.length} labelled samples with full feature vectors.`);

  if (samples.length === 0) {
    console.error('No matched samples found. Please ensure data/recordings has valid labelled data.');
    process.exit(1);
  }

  const survivedCount = samples.filter((s) => s.target === 1.0).length;
  const ruggedCount = samples.filter((s) => s.target === 0.0).length;
  console.log(`Class distribution: ${survivedCount} Survived (1.0), ${ruggedCount} Rugged (0.0)\n`);

  const model = new TokenSurvivalModel({ learningRate: 0.08, l2Penalty: 0.0005 });

  console.log('Training model across 30 epochs...');
  const result = model.trainBatch(samples, 30);

  console.log(`\n--- Training Results ---`);
  console.log(`Accuracy: ${result.accuracyPct.toFixed(2)}%`);
  console.log(`Log Loss: ${result.avgLoss.toFixed(4)}`);
  console.log(`Total Gradient Updates: ${result.totalUpdates}\n`);

  console.log('--- Learned Feature Weights ---');
  for (let i = 0; i < FEATURE_NAMES.length; i++) {
    const w = model.weights[i];
    const bar = w >= 0 ? '+' : '-';
    console.log(`  ${bar} ${FEATURE_NAMES[i].padEnd(22)} : ${w.toFixed(4)}`);
  }
  console.log(`  = Bias Term             : ${model.bias.toFixed(4)}\n`);

  model.save(DEFAULT_MODEL_PATH);
  console.log(`Model weights saved to ${DEFAULT_MODEL_PATH}`);
}

main().catch(console.error);
