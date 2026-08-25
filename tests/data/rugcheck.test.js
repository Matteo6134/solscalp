import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * rugcheck.js imports `request` from undici directly and exposes no injection
 * seam, so the module boundary is mocked here. Nothing in this file opens a
 * socket.
 */
const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...args) => requestMock(...args) }));

const { getInsiderGraph, getTokenReport, getWalletRisk } = await import(
  '../../src/data/rugcheck.js'
);

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const WALLET = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';

/** Stub one HTTP response. */
const respond = (payload, statusCode = 200) => {
  requestMock.mockImplementationOnce(async () => ({
    statusCode,
    body: { text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) },
  }));
};

const report = (over = {}) => ({
  mint: MINT,
  score_normalised: 10,
  score: 4_200,
  rugged: false,
  risks: [],
  topHolders: [],
  totalHolders: 500,
  totalMarketLiquidity: 80_000,
  markets: [],
  creator: WALLET,
  token: { supply: 1e15, decimals: 6, mintAuthority: null, freezeAuthority: null },
  ...over,
});

afterEach(() => {
  requestMock.mockReset();
});

describe('getTokenReport -- SCORE DIRECTION (higher = riskier)', () => {
  it('preserves score_normalised verbatim, without inverting it', async () => {
    // Inverting this would turn layer 5's veto into an "only buy scams" filter.
    respond(report({ score_normalised: 87 }));
    const r = await getTokenReport(MINT);

    expect(r.scoreNormalised).toBe(87);
  });

  it('keeps a clean token at a LOW score', async () => {
    respond(report({ score_normalised: 0 }));

    expect((await getTokenReport(MINT)).scoreNormalised).toBe(0);
  });

  it('accepts a camelCase variant in case the API renames the field', async () => {
    respond({ ...report(), score_normalised: undefined, scoreNormalised: 33 });

    expect((await getTokenReport(MINT)).scoreNormalised).toBe(33);
  });

  it('THROWS when score_normalised is absent -- never substitutes the legacy score', async () => {
    // the two live on different scales; substituting would silently move the threshold
    respond({ ...report(), score_normalised: undefined, score: 4_200 });

    await expect(getTokenReport(MINT)).rejects.toThrow(/no usable score_normalised/);
  });

  it('throws on a negative score rather than clamping', async () => {
    respond(report({ score_normalised: -5 }));

    await expect(getTokenReport(MINT)).rejects.toThrow(/negative/);
  });

  it('FLAGS a score above the documented range instead of clamping it', async () => {
    respond(report({ score_normalised: 250 }));
    const r = await getTokenReport(MINT);

    expect(r.scoreNormalised).toBe(250);
    expect(r.scoreOutOfDocumentedRange).toBe(true);
  });

  it('does not flag a score exactly at 100', async () => {
    respond(report({ score_normalised: 100 }));

    expect((await getTokenReport(MINT)).scoreOutOfDocumentedRange).toBe(false);
  });
});

describe('getTokenReport -- normalisation', () => {
  it('surfaces the rugged flag only when strictly true', async () => {
    respond(report({ rugged: true }));
    expect((await getTokenReport(MINT)).rugged).toBe(true);

    respond(report({ rugged: 'yes' }));
    expect((await getTokenReport(MINT)).rugged).toBe(false);
  });

  it('normalises risks and names an unnamed one', async () => {
    respond(report({ risks: [{ level: 'danger', score: '30' }, 'junk', null] }));
    const r = await getTokenReport(MINT);

    expect(r.risks).toHaveLength(1);
    expect(r.risks[0].name).toBe('unnamed-risk');
    expect(r.risks[0].score).toBe(30);
  });

  it('takes the HIGHEST lpLockedPct across markets, since burn is per-pool', async () => {
    respond(report({ markets: [{ lp: { lpLockedPct: 12 } }, { lp: { lpLockedPct: 96, lpMint: 'LP' } }] }));
    const r = await getTokenReport(MINT);

    expect(r.lpLockedPct).toBe(96);
    expect(r.marketCount).toBe(2);
  });

  it('reports lpLockedPct as null when no market declares one', async () => {
    respond(report({ markets: [{}] }));

    expect((await getTokenReport(MINT)).lpLockedPct).toBeNull();
  });

  it('marks insider holders and keeps percentages', async () => {
    respond(report({ topHolders: [{ address: 'A', pct: 9.5, insider: true }] }));
    const r = await getTokenReport(MINT);

    expect(r.topHolders[0].insider).toBe(true);
    expect(r.topHolders[0].pct).toBe(9.5);
  });

  it('returns a frozen report', async () => {
    respond(report());
    const r = await getTokenReport(MINT);

    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.risks)).toBe(true);
  });

  it('throws on a non-object payload', async () => {
    respond([1, 2, 3]);

    await expect(getTokenReport(MINT)).rejects.toThrow(/not an object/);
  });
});

describe('getTokenReport -- transport fails closed', () => {
  it('throws on a non-2xx status, quoting it', async () => {
    respond({ error: 'nope' }, 503);

    await expect(getTokenReport(MINT)).rejects.toThrow(/HTTP 503/);
  });

  it('throws on unparseable JSON', async () => {
    respond('<html>rate limited</html>');

    await expect(getTokenReport(MINT)).rejects.toThrow(/unparseable JSON/);
  });

  it('throws when the request itself fails', async () => {
    requestMock.mockImplementationOnce(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(getTokenReport(MINT)).rejects.toThrow(/request failed/);
  });

  it('rejects a malformed address before any request is made', async () => {
    await expect(getTokenReport('not-a-mint')).rejects.toThrow(/base58/);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('getInsiderGraph', () => {
  it('reports the largest cluster percentage', async () => {
    respond({ networks: [{ id: 'n1', pct: 4 }, { id: 'n2', pct: 21 }] });
    const g = await getInsiderGraph(MINT);

    expect(g.largestClusterPct).toBe(21);
    expect(g.totalInsiderPct).toBe(25);
  });

  it('returns 0 for an explicitly empty network list -- a real answer', async () => {
    respond({ networks: [] });

    expect((await getInsiderGraph(MINT)).largestClusterPct).toBe(0);
  });

  it('reports largestClusterPct as NULL when any cluster hides its share', async () => {
    // unknown must never flatten to 0, which would read as "clean" to layer 3
    respond({ networks: [{ id: 'n1', pct: 12 }, { id: 'n2', nodes: [] }] });
    const g = await getInsiderGraph(MINT);

    expect(g.largestClusterPct).toBeNull();
    expect(g.totalInsiderPct).toBeNull();
  });

  it('accepts a bare array envelope', async () => {
    respond([{ id: 'n1', pct: 3 }]);

    expect((await getInsiderGraph(MINT)).largestClusterPct).toBe(3);
  });

  it('throws on an unrecognisable envelope', async () => {
    respond({ nope: true });

    await expect(getInsiderGraph(MINT)).rejects.toThrow(/no recognisable network array/);
  });

  it('deduplicates member addresses', async () => {
    respond({ networks: [{ id: 'n', pct: 1, nodes: ['A', 'A', { address: 'B' }] }] });
    const g = await getInsiderGraph(MINT);

    expect(g.networks[0].addresses).toEqual(['A', 'B']);
  });
});

describe('getWalletRisk', () => {
  it('derives priorRugRate from counts when both are present', async () => {
    respond({ rugCount: 3, mintCount: 12 });
    const w = await getWalletRisk(WALLET);

    expect(w.priorRugRate).toBe(0.25);
  });

  it('leaves priorRugRate NULL when the denominator is unknown', async () => {
    respond({ rugCount: 3 });

    expect((await getWalletRisk(WALLET)).priorRugRate).toBeNull();
  });

  it('leaves priorRugRate null on a zero denominator rather than dividing', async () => {
    respond({ rugCount: 0, mintCount: 0 });

    expect((await getWalletRisk(WALLET)).priorRugRate).toBeNull();
  });

  it('throws when NO recognisable field is present', async () => {
    respond({ unrelated: 1 });

    await expect(getWalletRisk(WALLET)).rejects.toThrow(/no recognisable fields/);
  });

  it('accepts a risk level alone', async () => {
    respond({ level: 'high' });
    const w = await getWalletRisk(WALLET);

    expect(w.riskLevel).toBe('high');
    expect(w.riskScore).toBeNull();
  });

  it('rejects a malformed address before any request', async () => {
    await expect(getWalletRisk('bad')).rejects.toThrow(/base58/);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
