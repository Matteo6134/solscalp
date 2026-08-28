import { describe, it, expect } from 'vitest';
import { fetchJitoTipFloor, getOptimalJitoTipLamports, getRandomTipAccount, JITO_TIP_ACCOUNTS } from '../../src/rpc/jito.js';

describe('Jito MEV & Dynamic Priority Tip Module', () => {
  it('picks valid Jito tip account from official list', () => {
    const account = getRandomTipAccount();
    expect(JITO_TIP_ACCOUNTS).toContain(account);
  });

  it('fetches tip floor percentiles', async () => {
    const floor = await fetchJitoTipFloor();
    expect(typeof floor).toBe('object');
    expect(floor).not.toBeNull();
    expect(typeof floor.landed_tips_50th_percentile).toBe('number');
  });

  it('calculates optimal tip lamports within sanity bounds', async () => {
    const tipLow = await getOptimalJitoTipLamports({ speed: 'low' });
    const tipHigh = await getOptimalJitoTipLamports({ speed: 'high' });
    const tipUltra = await getOptimalJitoTipLamports({ speed: 'ultra' });

    expect(tipLow).toBeGreaterThanOrEqual(5_000);
    expect(tipHigh).toBeGreaterThanOrEqual(tipLow);
    expect(tipUltra).toBeGreaterThanOrEqual(tipHigh);
    expect(tipUltra).toBeLessThanOrEqual(10_000_000);
  });
});
