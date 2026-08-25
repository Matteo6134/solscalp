/**
 * Layer 3 tests. The failure paths ARE the feature, so most of this file is
 * about what must NOT happen: unknown insider concentration must never read as
 * zero, mixed units must never understate concentration, and an LP vault must
 * never be mistaken for a whale.
 */

import { describe, expect, it, vi } from 'vitest';
import { KNOWN, SAFETY } from '../../src/config.js';
import { LAYER_SPECS, loadLayerFn } from '../../src/safety/gate-layers.js';
import {
  CONCENTRATION_LIMITATION,
  LAYER,
  checkHolders,
} from '../../src/safety/layer3-holders.js';
import {
  assertUsablePct,
  collectPoolAddresses,
  readAddress,
  readMarkets,
} from '../../src/safety/holderInputs.js';
import { OUTCOME } from '../../src/safety/verdict.js';

const cfg = SAFETY.layer3;
/** base58 has no 0, O, I or l, so every tag below sticks to the safe alphabet. */
const ADDRESS_LEN = 44;
const pad = (tag) => `${tag}${'1'.repeat(ADDRESS_LEN)}`.slice(0, ADDRESS_LEN);

const MINT = pad('MNT9');
const PAIR = pad('PARADDR');
const VAULT_A = pad('VAULTA');
const VAULT_B = pad('VAULTB');
const MARKET = pad('MARKET');
const WHALE = pad('WHALE');
const holderAddr = (n) => pad(`HLDR${n}`);
const ownerAddr = (n) => pad(`AWNER${n}`);

/** Raw base units. 1e9 makes every threshold percentage exact in binary. */
const SUPPLY = 1_000_000_000;
const unitsForPct = (pct) => (pct / 100) * SUPPLY;

const holder = (address, amount, extra = {}) =>
  Object.freeze({ address, owner: null, amount, isLpVault: false, insider: false, ...extra });

/** N holders of `pct` each, with owners resolved (so nothing is unverified). */
const evenHolders = (count, pct) =>
  Object.freeze(
    Array.from({ length: count }, (_, i) =>
      holder(holderAddr(i), unitsForPct(pct), { owner: ownerAddr(i) }),
    ),
  );

/** The shape src/rpc/holders.js actually returns. Frozen: nothing may mutate it. */
const holdersResponse = (holders, supply = SUPPLY) =>
  Object.freeze({ holders: Object.freeze([...holders]), amountField: 'amount', supply });

/** RugCheck's normalised insider graph with no clusters at all. */
const cleanGraph = () =>
  Object.freeze({ mint: MINT, networks: Object.freeze([]), largestClusterPct: 0, totalInsiderPct: 0 });

const graphDeclaring = (pct) =>
  Object.freeze({
    mint: MINT,
    networks: Object.freeze([Object.freeze({ id: 'network-0', addresses: Object.freeze([]), pct })]),
    largestClusterPct: pct,
  });

/** A cluster that reports members but no percentage: it must be recomputed. */
const graphWithMembers = (addresses) =>
  Object.freeze({
    mint: MINT,
    networks: Object.freeze([
      Object.freeze({ id: 'network-0', addresses: Object.freeze([...addresses]), pct: null }),
    ]),
    largestClusterPct: null,
  });

/** RugCheck report: markets live under `raw` in the normalised shape. */
const reportWithMarkets = (markets) =>
  Object.freeze({
    mint: MINT,
    scoreNormalised: 3,
    raw: Object.freeze({ markets: Object.freeze([...markets]) }),
  });

const makeCtx = (over = {}) =>
  Object.freeze({
    getHolders: async () => holdersResponse(evenHolders(12, 1)),
    getInsiderGraph: async () => cleanGraph(),
    getPair: async () => Object.freeze({ pairAddress: PAIR }),
    getTokenReport: async () => reportWithMarkets([]),
    ...over,
  });

const reasonText = (v) => v.reasons.join(' | ');

/* ========================================================================== */
/* the happy path, stated once so every rejection below means something       */
/* ========================================================================== */

describe('checkHolders - a well distributed token', () => {
  it('passes, with nothing unverified and exact percentages in the facts', async () => {
    const v = await checkHolders(MINT, makeCtx());

    expect(v.layer).toBe(LAYER);
    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.reasons).toEqual([]);
    expect(v.facts.holderCount).toBe(12);
    expect(v.facts.consideredCount).toBe(12);
    expect(v.facts.singleLargestPct).toBe(1);
    expect(v.facts.topNPct).toBe(10);
    expect(v.facts.insiderClusterPct).toBe(0);
    expect(v.facts.unverified).toEqual([]);
    expect(v.facts.scoreDown).toBe(false);
    expect(v.facts.unresolvedOwnerCount).toBe(0);
  });

  it('reports thresholds straight from config and freezes every fact', async () => {
    const v = await checkHolders(MINT, makeCtx());

    expect(v.facts.thresholds).toEqual({ ...cfg });
    expect(v.facts.topN).toBe(10);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.facts)).toBe(true);
    expect(Object.isFrozen(v.facts.exclusion)).toBe(true);
    expect(Object.isFrozen(v.facts.insiderGraph)).toBe(true);
    expect(Object.isFrozen(v.facts.unverified)).toBe(true);
  });

  it('states its residual risk: a sybil-split whale and a soft rug both pass', async () => {
    const v = await checkHolders(MINT, makeCtx());

    expect(v.facts.residualRisk).toBe(CONCENTRATION_LIMITATION.residualRisk);
    expect(CONCENTRATION_LIMITATION.notProven.join(' ')).toMatch(/unlinkable wallets/i);
    expect(CONCENTRATION_LIMITATION.notProven.join(' ')).toMatch(/soft rug/i);
    expect(v.facts.notProven.join(' ')).toMatch(/floor/i);
  });

  it('never mutates the holder response it was given', async () => {
    const response = holdersResponse(evenHolders(12, 1));
    const snapshot = JSON.stringify(response);

    await checkHolders(MINT, makeCtx({ getHolders: async () => response }));

    expect(JSON.stringify(response)).toBe(snapshot);
  });

  it('is discoverable by the orchestrator through the layer registry', async () => {
    const fn = await loadLayerFn(LAYER_SPECS.layer3, async () =>
      import('../../src/safety/layer3-holders.js'),
    );

    expect(fn).toBe(checkHolders);
    expect(LAYER).toBe(LAYER_SPECS.layer3.name);
  });
});

/* ========================================================================== */
/* concentration rejections + threshold boundaries                            */
/* ========================================================================== */

describe('checkHolders - single holder concentration', () => {
  it('rejects one whale above maxSingleHolderPct and names the wallet', async () => {
    const holders = [
      holder(WHALE, unitsForPct(cfg.maxSingleHolderPct + 4), { owner: ownerAddr(99) }),
      ...evenHolders(5, 1),
    ];
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(reasonText(v)).toContain(WHALE);
    expect(reasonText(v)).toMatch(/12\.00%/);
    expect(reasonText(v)).toContain(`${cfg.maxSingleHolderPct}%`);
    expect(reasonText(v)).toMatch(/nuke the price alone/i);
    expect(v.facts.singleLargestPct).toBe(cfg.maxSingleHolderPct + 4);
  });

  it('passes a holder EXACTLY at maxSingleHolderPct (the limit is `>`)', async () => {
    const holders = [
      holder(WHALE, unitsForPct(cfg.maxSingleHolderPct), { owner: ownerAddr(99) }),
      ...evenHolders(5, 1),
    ];
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.facts.singleLargestPct).toBe(cfg.maxSingleHolderPct);
    expect(v.outcome).toBe(OUTCOME.PASS);
  });

  it('rejects a holder one ten-thousandth of a percent over the limit', async () => {
    const holders = [
      holder(WHALE, unitsForPct(cfg.maxSingleHolderPct) + 1_000, { owner: ownerAddr(99) }),
      ...evenHolders(5, 1),
    ];
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.facts.singleLargestPct).toBeGreaterThan(cfg.maxSingleHolderPct);
    expect(v.outcome).toBe(OUTCOME.REJECT);
  });
});

describe('checkHolders - top-10 concentration', () => {
  it('rejects a top-10 above maxTop10HolderPct even when every wallet is small', async () => {
    // 10 x 3% = 30% > 25%, yet no single holder is near the 8% single-wallet limit.
    const v = await checkHolders(
      MINT,
      makeCtx({ getHolders: async () => holdersResponse(evenHolders(12, 3)) }),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.topNPct).toBe(30);
    expect(reasonText(v)).toMatch(/top 10 visible holders hold 30\.00%/);
    expect(reasonText(v)).toContain(`${cfg.maxTop10HolderPct}%`);
    // The single-wallet test must NOT have fired: 3% is well under 8%.
    expect(reasonText(v)).not.toMatch(/nuke the price alone/i);
  });

  it('passes a top-10 EXACTLY at maxTop10HolderPct and counts only the top 10', async () => {
    // 10 x 2.5% == 25.00%, plus five more holders that must not be counted.
    const holders = [...evenHolders(10, 2.5), ...evenHolders(5, 1).map((h, i) =>
      holder(holderAddr(100 + i), h.amount, { owner: ownerAddr(100 + i) }),
    )];
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.facts.topNPct).toBe(cfg.maxTop10HolderPct);
    expect(v.facts.holderCount).toBe(15);
    expect(v.facts.top).toHaveLength(10);
    expect(v.outcome).toBe(OUTCOME.PASS);
  });
});

/* ========================================================================== */
/* the exclusion set: getting this wrong makes healthy tokens look rugged     */
/* ========================================================================== */

describe('checkHolders - LP vault exclusion', () => {
  const vaultHolders = () =>
    Object.freeze([
      holder(VAULT_A, unitsForPct(70), { owner: ownerAddr(1) }),
      ...evenHolders(8, 1),
    ]);

  it('excludes a vault named by rugcheck markets[].liquidityA and does not falsely reject', async () => {
    const ctx = makeCtx({
      getHolders: async () => holdersResponse(vaultHolders()),
      getTokenReport: async () =>
        reportWithMarkets([{ pubkey: MARKET, liquidityA: VAULT_A, liquidityB: VAULT_B }]),
    });

    const v = await checkHolders(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.topNPct).toBe(8);
    expect(v.facts.consideredCount).toBe(8);
    const excluded = v.facts.excluded.find((e) => e.address === VAULT_A);
    expect(excluded.reason).toBe('address in exclusion set');
    expect(v.facts.exclusion.sources.map((s) => s.source)).toContain(
      'rugcheckReport.markets[0].liquidityA',
    );
    expect(v.facts.exclusion.sources.map((s) => s.address)).toContain(MARKET);
  });

  it('counts that same vault when no exclusion source exists - a false REJECT, never a false PASS', async () => {
    const ctx = makeCtx({
      getHolders: async () => holdersResponse(vaultHolders()),
      getPair: async () => null,
      getTokenReport: async () => null,
    });

    const v = await checkHolders(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.unverified).toContain('poolAddresses');
    expect(v.facts.scoreDown).toBe(true);
    // The reject must say it may be an artefact, not real concentration.
    expect(reasonText(v)).toMatch(/incomplete exclusion set/i);
    expect(reasonText(v)).toMatch(/can look exactly like real concentration/i);
  });

  it('excludes a vault matched only by its OWNER (the pair address)', async () => {
    const holders = [
      holder(VAULT_A, unitsForPct(70), { owner: PAIR }),
      ...evenHolders(8, 1),
    ];
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.excluded.find((e) => e.address === VAULT_A).reason).toBe(
      'owner in exclusion set',
    );
  });

  it('excludes a holder the fetcher itself flagged as an LP vault', async () => {
    const holders = [
      holder(VAULT_A, unitsForPct(70), { owner: ownerAddr(1), isLpVault: true }),
      ...evenHolders(8, 1),
    ];
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.excluded.find((e) => e.address === VAULT_A).reason).toBe(
      'flagged as LP vault by the caller',
    );
  });

  it('excludes burned supply sitting in the incinerator, always', async () => {
    const holders = [
      holder(KNOWN.INCINERATOR, unitsForPct(80), { owner: ownerAddr(1) }),
      ...evenHolders(8, 1),
    ];
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.exclusion.addresses).toContain(KNOWN.INCINERATOR);
  });

  it('rejects when EVERY returned holder was excluded: unknown is not zero', async () => {
    const holders = [
      holder(VAULT_A, unitsForPct(60), { owner: PAIR }),
      holder(VAULT_B, unitsForPct(30), { owner: PAIR }),
    ];
    const ctx = makeCtx({
      getHolders: async () => holdersResponse(holders),
      getTokenReport: async () => reportWithMarkets([{ pubkey: MARKET, liquidityB: VAULT_B }]),
    });

    const v = await checkHolders(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.consideredCount).toBe(0);
    expect(reasonText(v)).toMatch(/UNKNOWN, not zero/);
  });

  it('records the exclusion gap when the pair fetch fails, without failing the layer', async () => {
    const getPair = vi.fn(async () => {
      throw new Error('dexscreener 429');
    });
    const v = await checkHolders(MINT, makeCtx({ getPair }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.unverified).toContain('pair');
    expect(v.facts.scoreDown).toBe(true);
    expect(v.facts.evidenceGaps.join(' ')).toContain('dexscreener 429');
  });

  it('records the exclusion gap when the rugcheck report fetch fails', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({
        getTokenReport: async () => {
          throw new Error('rugcheck 503');
        },
      }),
    );

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.unverified).toContain('rugcheckMarkets');
    expect(v.facts.evidenceGaps.join(' ')).toContain('rugcheck 503');
  });

  it('records the gap when the context supplies no pair fetcher at all', async () => {
    const ctx = Object.freeze({
      getHolders: async () => holdersResponse(evenHolders(12, 1)),
      getInsiderGraph: async () => cleanGraph(),
      getTokenReport: async () => reportWithMarkets([]),
    });

    const v = await checkHolders(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.evidenceGaps.join(' ')).toMatch(/ctx\.getPair\(\) was not provided/);
    expect(v.facts.unverified).toContain('poolAddresses');
  });

  it('flags unresolved holder owners, because a vault may be matchable only by owner', async () => {
    // fetchHolders leaves owner === null unless deps.resolveOwners is injected.
    const holders = Array.from({ length: 6 }, (_, i) => holder(holderAddr(i), unitsForPct(1)));
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.unverified).toContain('holderOwners');
    expect(v.facts.unresolvedOwnerCount).toBe(6);
    expect(v.facts.scoreDown).toBe(true);
  });
});

/* ========================================================================== */
/* insider clusters: unknown must never become zero                           */
/* ========================================================================== */

describe('checkHolders - insider clusters', () => {
  it('rejects a declared cluster above maxInsiderClusterPct', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({ getInsiderGraph: async () => graphDeclaring(cfg.maxInsiderClusterPct + 7) }),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.insiderClusterPct).toBe(cfg.maxInsiderClusterPct + 7);
    expect(reasonText(v)).toMatch(/largest insider cluster holds 22\.00%/);
    expect(reasonText(v)).toMatch(/bundled launch posing as demand/);
    expect(v.facts.insiderGraph.largestClusterPctReported).toBe(22);
  });

  it('passes a cluster EXACTLY at maxInsiderClusterPct', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({ getInsiderGraph: async () => graphDeclaring(cfg.maxInsiderClusterPct) }),
    );

    expect(v.facts.insiderClusterPct).toBe(cfg.maxInsiderClusterPct);
    expect(v.outcome).toBe(OUTCOME.PASS);
  });

  it('recomputes a cluster with no declared percentage from member balances', async () => {
    // Three members at 6% each == 18% > 15%.
    const holders = evenHolders(12, 6);
    const members = [holders[0].address, holders[1].address, holders[2].address];
    const v = await checkHolders(
      MINT,
      makeCtx({
        getHolders: async () => holdersResponse(holders),
        getInsiderGraph: async () => graphWithMembers(members),
      }),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.insiderClusterPct).toBeCloseTo(18, 9);
    expect(reasonText(v)).toMatch(/largest insider cluster holds 18\.00%/);
    expect(v.facts.insiderGraph.networkCount).toBe(1);
  });

  it('ERRORS on a null insider graph instead of passing it as zero', async () => {
    const v = await checkHolders(MINT, makeCtx({ getInsiderGraph: async () => null }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.outcome).not.toBe(OUTCOME.PASS);
    expect(reasonText(v)).toMatch(/insider graph unavailable/i);
    expect(reasonText(v)).toMatch(/refusing to treat unknown insider concentration as zero/i);
  });

  it('ERRORS when the context has no insider-graph fetcher', async () => {
    const ctx = Object.freeze({
      getHolders: async () => holdersResponse(evenHolders(12, 1)),
      getPair: async () => Object.freeze({ pairAddress: PAIR }),
    });

    const v = await checkHolders(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/getInsiderGraph must be a function/);
    expect(reasonText(v)).toMatch(/cannot be treated as zero/);
  });

  it('ERRORS when the insider-graph request throws (network failure)', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({
        getInsiderGraph: async () => {
          throw new Error('rugcheck insider graph HTTP 500');
        },
      }),
    );

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toContain('rugcheck insider graph HTTP 500');
  });

  it('ERRORS on a cluster that reports neither a percentage nor a resolvable member', async () => {
    const graph = Object.freeze({
      mint: MINT,
      networks: Object.freeze([Object.freeze({ id: 'network-0' })]),
      largestClusterPct: null,
    });

    const v = await checkHolders(MINT, makeCtx({ getInsiderGraph: async () => graph }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/neither a percentage nor any resolvable/);
  });

  it('ERRORS on an insider percentage outside 0-100 rather than comparing nonsense', async () => {
    const v = await checkHolders(MINT, makeCtx({ getInsiderGraph: async () => graphDeclaring(140) }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/insider cluster share of supply is 140, outside 0-100/);
  });

  it('ERRORS on a graph shape it cannot recognise at all', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({ getInsiderGraph: async () => Object.freeze({ mint: MINT }) }),
    );

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/no recognisable network array/);
  });

  it('accepts a graph that declares only a headline percentage', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({ getInsiderGraph: async () => Object.freeze({ largestClusterPct: 3 }) }),
    );

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.insiderClusterPct).toBe(3);
    expect(v.facts.insiderGraph.networkCount).toBeNull();
    expect(v.facts.insiderGraph.largestClusterPctReported).toBe(3);
  });

  it('accepts a graph the API returned as a bare array of clusters', async () => {
    const graph = Object.freeze([Object.freeze({ pct: 2 })]);
    const v = await checkHolders(MINT, makeCtx({ getInsiderGraph: async () => graph }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.insiderClusterPct).toBe(2);
    expect(v.facts.insiderGraph.networkCount).toBe(1);
  });
});

/* ========================================================================== */
/* units and denominators: the one direction that could cause a false PASS     */
/* ========================================================================== */

describe('checkHolders - units and supply', () => {
  it('ERRORS when the holder list mixes uiAmount with raw amount', async () => {
    const holders = Object.freeze([
      Object.freeze({ address: holderAddr(1), amount: unitsForPct(1) }),
      Object.freeze({ address: holderAddr(2), uiAmount: 5 }),
    ]);
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/mixes balance units/);
  });

  it('ERRORS on ui-amount balances over a raw supply (it would understate concentration)', async () => {
    // No declared amountField, so only the unit-inference guard can catch this.
    const response = Object.freeze({
      holders: Object.freeze([
        Object.freeze({ address: holderAddr(1), uiAmount: 5 }),
        Object.freeze({ address: holderAddr(2), uiAmount: 3 }),
      ]),
      supply: SUPPLY,
    });
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => response }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/understates concentration by 10\*\*decimals/);
  });

  it('accepts ui-amount balances when the supply carries the same field', async () => {
    const response = Object.freeze({
      holders: Object.freeze([
        Object.freeze({ address: holderAddr(1), uiAmount: 5, owner: ownerAddr(1) }),
        Object.freeze({ address: holderAddr(2), uiAmount: 3, owner: ownerAddr(2) }),
      ]),
      amountField: 'uiAmount',
      supply: Object.freeze({ amount: String(SUPPLY), uiAmount: 100 }),
    });

    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => response }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.amountField).toBe('uiAmount');
    expect(v.facts.supply).toBe(100);
    expect(v.facts.singleLargestPct).toBe(5);
  });

  it('ERRORS when the fetcher declares one unit and the entries carry another', async () => {
    const response = Object.freeze({
      holders: evenHolders(3, 1),
      amountField: 'uiAmount',
      supply: SUPPLY,
    });

    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => response }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/declared balances in 'uiAmount' but the entries carry 'amount'/);
  });

  it('ERRORS when a holder balance exceeds total supply (different units)', async () => {
    const holders = Object.freeze([holder(WHALE, SUPPLY * 10, { owner: ownerAddr(1) })]);
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/different units/);
  });

  it('ERRORS on a missing supply instead of inventing a denominator', async () => {
    const response = Object.freeze({ holders: evenHolders(3, 1), amountField: 'amount' });
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => response }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/supply is unknown or unparseable/);
  });

  it('ERRORS on a zero supply (0/0 would compare false against every threshold)', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({ getHolders: async () => holdersResponse(evenHolders(3, 1), 0) }),
    );

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/supply must be positive/);
  });

  it('ERRORS on a bare holder array, which carries no supply at all', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({ getHolders: async () => Object.freeze([...evenHolders(3, 1)]) }),
    );

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/supply is unknown or unparseable/);
  });

  it('reads an RPC-style { value: [...] } envelope with a totalSupply', async () => {
    const response = Object.freeze({
      value: Object.freeze([...evenHolders(4, 2)]),
      totalSupply: SUPPLY,
    });

    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => response }));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.holderCount).toBe(4);
    expect(v.facts.topNPct).toBe(8);
  });

  it('reads a supply supplied as a numeric string', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({ getHolders: async () => holdersResponse(evenHolders(12, 1), String(SUPPLY)) }),
    );

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.supply).toBe(SUPPLY);
  });
});

/* ========================================================================== */
/* unreadable inputs: every one of them is an ERROR, never a PASS             */
/* ========================================================================== */

describe('checkHolders - fail closed on bad input', () => {
  it('ERRORS when the holders request throws', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({
        getHolders: async () => {
          throw new Error('getTokenLargestAccounts timed out');
        },
      }),
    );

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toContain('getTokenLargestAccounts timed out');
    // Even an ERROR verdict carries the context needed to log it.
    expect(v.facts.mint).toBe(MINT);
    expect(v.facts.thresholds).toEqual({ ...cfg });
  });

  it('ERRORS when getHolders returns null', async () => {
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => null }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/ctx\.getHolders\(\) returned null/);
  });

  it('ERRORS when a holder entry has no address', async () => {
    const holders = Object.freeze([Object.freeze({ amount: unitsForPct(1) })]);
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/holder\[0\] has no address/);
  });

  it('ERRORS when a holder entry has no usable balance field', async () => {
    const holders = Object.freeze([Object.freeze({ address: holderAddr(1), balance: 5 })]);
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/no usable balance field/);
  });

  it('ERRORS when a holder entry is not an object', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({ getHolders: async () => holdersResponse(Object.freeze([null])) }),
    );

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/holder\[0\] is not an object/);
  });

  it('ERRORS on a negative balance', async () => {
    const holders = Object.freeze([Object.freeze({ address: holderAddr(1), amount: -1 })]);
    const v = await checkHolders(MINT, makeCtx({ getHolders: async () => holdersResponse(holders) }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/negative balance/);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a number', 42],
  ])('ERRORS on %s as the mint, without throwing', async (_label, badMint) => {
    const v = await checkHolders(badMint, makeCtx());

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/mint must be a mint address/);
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['undefined', undefined],
  ])('ERRORS on %s as the context, without throwing', async (_label, badCtx) => {
    const v = await checkHolders(MINT, badCtx);

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/ctx must be the gate context object/);
  });

  it('ERRORS when the context has no holders fetcher', async () => {
    const v = await checkHolders(MINT, Object.freeze({ getInsiderGraph: async () => cleanGraph() }));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonText(v)).toMatch(/ctx\.getHolders must be a function/);
  });

  it('always returns a verdict for this layer, whatever went wrong', async () => {
    const cases = [
      await checkHolders(MINT, {}),
      await checkHolders(MINT, makeCtx({ getHolders: async () => 7 })),
      await checkHolders(MINT, makeCtx({ getInsiderGraph: async () => undefined })),
    ];

    for (const v of cases) {
      expect(v.layer).toBe(LAYER);
      expect(v.outcome).toBe(OUTCOME.ERROR);
      expect(Object.isFrozen(v)).toBe(true);
      expect(typeof v.ms).toBe('number');
    }
  });
});

/* ========================================================================== */
/* the extracted input helpers                                                */
/* ========================================================================== */

describe('holderInputs', () => {
  it('reads an address from a string or from a wrapper object, and rejects junk', () => {
    expect(readAddress(VAULT_A)).toBe(VAULT_A);
    expect(readAddress({ address: VAULT_A })).toBe(VAULT_A);
    expect(readAddress({ pubkey: VAULT_A })).toBe(VAULT_A);
    expect(readAddress('short')).toBeNull();
    expect(readAddress(`0O${VAULT_A}`)).toBeNull();
    expect(readAddress(null)).toBeNull();
    expect(readAddress(42)).toBeNull();
    expect(readAddress({})).toBeNull();
  });

  it('finds markets under `markets` or under `raw.markets`, and nowhere else', () => {
    expect(readMarkets({ markets: [1] })).toEqual([1]);
    expect(readMarkets({ raw: { markets: [2] } })).toEqual([2]);
    expect(readMarkets({ raw: {} })).toEqual([]);
    expect(readMarkets(null)).toEqual([]);
  });

  it('always includes the incinerator and records where each address came from', () => {
    const sources = collectPoolAddresses(
      { pairAddress: PAIR },
      reportWithMarkets([{ pubkey: MARKET, liquidityA: VAULT_A }]),
    );

    expect(sources[0]).toEqual({
      address: KNOWN.INCINERATOR,
      source: 'config.KNOWN.INCINERATOR (burned supply)',
    });
    expect(sources.map((s) => s.address)).toEqual([KNOWN.INCINERATOR, PAIR, MARKET, VAULT_A]);
    expect(Object.isFrozen(sources)).toBe(true);
  });

  it('skips a market entry that is not an object', () => {
    const sources = collectPoolAddresses(null, reportWithMarkets([null, { pubkey: MARKET }]));

    expect(sources.map((s) => s.address)).toEqual([KNOWN.INCINERATOR, MARKET]);
  });

  it('records a gap even when the failure was not an Error object', async () => {
    const v = await checkHolders(
      MINT,
      makeCtx({
        getPair: async () => {
          throw 'aborted by signal';
        },
      }),
    );

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.evidenceGaps.join(' ')).toContain('aborted by signal');
  });

  it('never treats a mint as a holder and dedupes repeats, first source winning', () => {
    const sources = collectPoolAddresses(
      { pairAddress: VAULT_A },
      reportWithMarkets([{ mintA: MINT, mintB: pad('MNTB'), mintLP: pad('MNTLP'), pubkey: VAULT_A }]),
    );

    const addresses = sources.map((s) => s.address);
    expect(addresses).not.toContain(MINT);
    expect(addresses.filter((a) => a === VAULT_A)).toHaveLength(1);
    expect(sources.find((s) => s.address === VAULT_A).source).toBe('pair.pairAddress');
  });

  it('refuses a percentage that is not a usable number', () => {
    expect(assertUsablePct(0, 'x')).toBe(0);
    expect(assertUsablePct(100, 'x')).toBe(100);
    expect(() => assertUsablePct(Number.NaN, 'x')).toThrow(/not a finite percentage/);
    expect(() => assertUsablePct(null, 'x')).toThrow(/not a finite percentage/);
    expect(() => assertUsablePct(-1, 'x')).toThrow(/outside 0-100/);
  });
});
