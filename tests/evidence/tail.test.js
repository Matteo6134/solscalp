import { describe, expect, it, vi } from 'vitest';
import { KNOWN, LABELS, RECORDER } from '../../src/config.js';
import { candidateToPair, isRecorderHealthy, latestSnapshot } from '../../src/evidence/tail.js';
import { readSignals } from '../../src/paper/engine.js';

const TS = 1_756_000_000_000;
const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const candidate = (over = {}) => ({
  mint: MINT,
  symbol: 'TKN',
  pairAddress: 'PAIR1',
  dexId: 'raydium',
  priceUsd: 0.001,
  marketCapUsd: 400_000,
  liquidityUsd: 50_000,
  ageMinutes: 120,
  volumeM5Usd: 5_000,
  volumeH1Usd: 30_000,
  priceChangeM5Pct: 6,
  priceChangeH1Pct: 12,
  buySellRatioM5: 2,
  volumeAccelerationRatio: 2,
  quoteMint: KNOWN.WSOL,
  pairCreatedAtMs: TS - 120 * 60_000,
  txns: { m5: { buys: 40, sells: 20 }, h1: { buys: 300, sells: 200 } },
  roundTrip: { buyPriceImpactPct: 0.004, sellPriceImpactPct: 0.005, roundTripLossPct: 1.2 },
  gate: {
    buyable: true,
    complete: true,
    passed: ['layer0-mint'],
    rejectedBy: [],
    erroredIn: [],
    skipped: [],
    reasons: [],
  },
  outcome: null,
  ...over,
});

const snapshotLine = (candidates, ts = TS) =>
  JSON.stringify({
    schemaVersion: RECORDER.schemaVersion,
    ts,
    iso: new Date(ts).toISOString(),
    profile: 'early',
    candidates,
  });

const labelLine = (ts = TS) =>
  JSON.stringify({
    schemaVersion: RECORDER.schemaVersion,
    type: LABELS.recordType,
    ts,
    labels: [{ mint: MINT, outcome: 'rugged', ts }],
  });

/** A fake fs with one directory of files. */
const fakeFs = (files) => ({
  readdir: vi.fn(async () => Object.keys(files)),
  readFile: vi.fn(async (path) => {
    const name = String(path).replace(/\\/g, '/').split('/').pop();
    if (!(name in files)) throw new Error(`ENOENT ${name}`);
    return files[name];
  }),
});

describe('candidateToPair', () => {
  it('rebuilds a pair the engine can read signals from', () => {
    const pair = candidateToPair(candidate(), TS);
    const s = readSignals(pair, TS);

    // the reconstruction must reproduce what the recorder itself measured
    expect(s.marketCapUsd).toBe(400_000);
    expect(s.liquidityUsd).toBe(50_000);
    expect(s.buySellRatioM5).toBe(2);
    expect(s.volumeAccelerationRatio).toBe(2);
    expect(s.priceChangeM5Pct).toBe(6);
    expect(s.quoteMint).toBe(KNOWN.WSOL);
    expect(Math.round(s.ageMinutes)).toBe(120);
  });

  it('marks its provenance so it cannot be mistaken for a live read', () => {
    expect(candidateToPair(candidate(), TS).fromRecording).toBe(true);
  });

  it('derives pairCreatedAtMs from age when the raw field is absent', () => {
    const pair = candidateToPair(candidate({ pairCreatedAtMs: undefined }), TS);

    expect(pair.pairCreatedAtMs).toBe(TS - 120 * 60_000);
  });

  it('leaves signals UNKNOWN for a pre-upgrade snapshot rather than guessing', () => {
    // recordings taken before the raw counters were stored have no txns; the
    // ratio must come back null, which blocks entry rather than inventing one
    const pair = candidateToPair(candidate({ txns: undefined }), TS);
    const s = readSignals(pair, TS);

    expect(s.buySellRatioM5).toBeNull();
  });

  it('falls back to WSOL as the quote when it was not recorded', () => {
    const pair = candidateToPair(candidate({ quoteMint: undefined }), TS);

    expect(pair.quoteToken.address).toBe(KNOWN.WSOL);
  });

  it('is frozen', () => {
    const pair = candidateToPair(candidate(), TS);

    expect(Object.isFrozen(pair)).toBe(true);
    expect(Object.isFrozen(pair.volumeUsd)).toBe(true);
  });
});

describe('latestSnapshot', () => {
  it('returns the NEWEST snapshot line, not the first', async () => {
    const fs = fakeFs({
      '2026-08-26.jsonl': [
        snapshotLine([candidate({ symbol: 'OLD' })], TS - 60_000),
        snapshotLine([candidate({ symbol: 'NEW' })], TS),
        '',
      ].join('\n'),
    });
    const snap = await latestSnapshot({ now: TS }, fs);

    expect(snap.candidates).toHaveLength(1);
    expect(snap.candidates[0].symbol).toBe('NEW');
    expect(snap.snapshotAgeMs).toBe(0);
  });

  it('reports the snapshot age, so a consumer can tell quiet from dead', async () => {
    const fs = fakeFs({ '2026-08-26.jsonl': `${snapshotLine([candidate()], TS - 300_000)}\n` });
    const snap = await latestSnapshot({ now: TS }, fs);

    expect(snap.snapshotAgeMs).toBe(300_000);
  });

  it('SKIPS label records and finds the real snapshot beneath them', async () => {
    // the bug this pins: an earlier version compared record.type against a
    // constant that does not exist, so `undefined === undefined` matched every
    // ordinary snapshot and the whole recording was skipped as labels
    const fs = fakeFs({
      '2026-08-26.jsonl': [snapshotLine([candidate()], TS), labelLine(TS), ''].join('\n'),
    });
    const snap = await latestSnapshot({ now: TS }, fs);

    expect(snap.candidates).toHaveLength(1);
    expect(snap.ts).toBe(TS);
  });

  it('walks back to an earlier file when the newest has no usable snapshot', async () => {
    const fs = fakeFs({
      '2026-08-25.jsonl': `${snapshotLine([candidate()], TS - 86_400_000)}\n`,
      '2026-08-26.jsonl': `${labelLine(TS)}\n`,
    });
    const snap = await latestSnapshot({ now: TS }, fs);

    expect(snap.candidates).toHaveLength(1);
  });

  it('skips a torn final line without throwing', async () => {
    const fs = fakeFs({
      '2026-08-26.jsonl': [snapshotLine([candidate()], TS), '{"schemaVersion":1,"cand'].join('\n'),
    });
    const snap = await latestSnapshot({ now: TS }, fs);

    expect(snap.candidates).toHaveLength(1);
  });

  it('ignores a record from a different schema version', async () => {
    const fs = fakeFs({
      '2026-08-26.jsonl': `${JSON.stringify({ schemaVersion: 999, ts: TS, candidates: [candidate()] })}\n`,
    });
    const snap = await latestSnapshot({ now: TS }, fs);

    expect(snap.candidates).toHaveLength(0);
    expect(snap.ts).toBeNull();
  });

  it('returns an empty result with a NULL age when there are no recordings', async () => {
    const snap = await latestSnapshot({ now: TS }, fakeFs({}));

    // null age, not zero: zero would read as "perfectly fresh"
    expect(snap.snapshotAgeMs).toBeNull();
    expect(snap.candidates).toEqual([]);
  });

  it('survives a missing directory', async () => {
    const fs = {
      readdir: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
      readFile: vi.fn(),
    };
    const snap = await latestSnapshot({ now: TS }, fs);

    expect(snap.snapshotAgeMs).toBeNull();
  });

  it('carries the gate verdict through instead of re-deciding it', async () => {
    const blocked = candidate({
      gate: {
        buyable: false,
        complete: true,
        passed: [],
        rejectedBy: ['layer2-liquidity'],
        erroredIn: [],
        skipped: ['layer3-holders'],
        reasons: ['liquidity too thin'],
      },
    });
    const fs = fakeFs({ '2026-08-26.jsonl': `${snapshotLine([blocked], TS)}\n` });
    const snap = await latestSnapshot({ now: TS }, fs);
    const gate = snap.gateResults[MINT];

    expect(gate.buyable).toBe(false);
    expect(gate.rejectedBy).toEqual(['layer2-liquidity']);
    expect(gate.skipped).toEqual(['layer3-holders']);
    expect(gate.fromRecording).toBe(true);
  });

  it('rebuilds the layer-1 facts the cost model needs', async () => {
    const fs = fakeFs({ '2026-08-26.jsonl': `${snapshotLine([candidate()], TS)}\n` });
    const snap = await latestSnapshot({ now: TS }, fs);
    const facts = snap.gateResults[MINT].layers[0].facts;

    expect(snap.gateResults[MINT].layers[0].layer).toBe('layer1-sellsim');
    expect(facts.buyPriceImpactPct).toBe(0.004);
    expect(facts.sellPriceImpactPct).toBe(0.005);
  });

  it('yields NULL impacts for a pre-upgrade snapshot, so no cost is invented', async () => {
    const fs = fakeFs({
      '2026-08-26.jsonl': `${snapshotLine([candidate({ roundTrip: undefined })], TS)}\n`,
    });
    const snap = await latestSnapshot({ now: TS }, fs);

    expect(snap.gateResults[MINT].layers[0].facts.buyPriceImpactPct).toBeNull();
  });
});

describe('isRecorderHealthy', () => {
  it('accepts a fresh snapshot', () => {
    expect(isRecorderHealthy(30_000, 60)).toBe(true);
  });

  it('rejects one older than the tolerance', () => {
    expect(isRecorderHealthy(60_000 * 5, 60, 4)).toBe(false);
  });

  it('treats a null age as unhealthy -- silence is not health', () => {
    expect(isRecorderHealthy(null, 60)).toBe(false);
  });

  it('accepts exactly at the tolerance boundary', () => {
    expect(isRecorderHealthy(60_000 * 4, 60, 4)).toBe(true);
  });
});
