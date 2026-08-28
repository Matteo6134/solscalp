import { describe, it, expect } from 'vitest';
import { extractFeatures, FEATURE_DIM } from '../../src/ml/features.js';
import { TokenSurvivalModel } from '../../src/ml/model.js';

describe('Machine Learning Module', () => {
  it('extracts valid normalized feature vector', () => {
    const vec = extractFeatures({
      pair: {
        liquidityUsd: 50_000,
        marketCap: 250_000,
        ageMinutes: 10,
        volumeUsd: { m5: 12_000, h1: 60_000 },
        priceChangePct: { m5: 15, h1: 45 },
        buySellRatioM5: 2.1,
      },
      signals: {
        liquidityUsd: 50_000,
        marketCapUsd: 250_000,
        ageMinutes: 10,
        volumeM5Usd: 12_000,
        volumeH1Usd: 60_000,
        buySellRatioM5: 2.1,
        priceChangeM5Pct: 15,
        priceChangeH1Pct: 45,
      },
      gateResult: { buyable: true },
      costBreakdown: { entryUsd: 0.5, exitUsd: 0.5 },
    });

    expect(vec.length).toBe(FEATURE_DIM);
    for (let i = 0; i < vec.length; i++) {
      expect(Number.isFinite(vec[i])).toBe(true);
    }
  });

  it('predicts probabilities strictly between 0 and 1', () => {
    const model = new TokenSurvivalModel();
    const mockFeatures = new Float64Array(FEATURE_DIM).fill(0.5);

    const prob = model.predict(mockFeatures);
    expect(prob).toBeGreaterThanOrEqual(0);
    expect(prob).toBeLessThanOrEqual(1);
  });

  it('learns from positive and negative feedback via online SGD', () => {
    const model = new TokenSurvivalModel({ learningRate: 0.2 });
    const features = new Float64Array(FEATURE_DIM).fill(0.8);

    const initialProb = model.predict(features);

    for (let i = 0; i < 10; i++) {
      model.trainOne(features, 0.0);
    }
    const ruggedProb = model.predict(features);
    expect(ruggedProb).toBeLessThan(initialProb);

    for (let i = 0; i < 20; i++) {
      model.trainOne(features, 1.0);
    }
    const survivedProb = model.predict(features);
    expect(survivedProb).toBeGreaterThan(ruggedProb);
  });
});
