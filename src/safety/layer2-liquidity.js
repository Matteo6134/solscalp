/**
 * Layer 2 - liquidity depth and LP ownership.
 *
 * WHAT IS CHECKED (all from data the caller already has, no network calls here):
 *   1. absolute depth        liquidityUsd >= SAFETY.layer2.minLiquidityUsd
 *   2. our own footprint     positionSizeUsd as a PERCENT of liquidityUsd
 *                            <= SAFETY.layer2.maxPositionPctOfLiquidity
 *                            (a position that is a meaningful slice of the pool
 *                             means we are our own slippage, both in and out)
 *   3. float vs cap          liquidityUsd / marketCap >= minLiquidityToMcapRatio
 *                            (thin float on an inflated cap == manipulated price)
 *   4. LP burned or locked   ONLY when the caller supplied LP evidence -- see below
 *
 * WHAT IS *NOT* CHECKED HERE, HONESTLY:
 *   Verifying LP burn from first principles needs the pool's LP mint, and finding
 *   that mint is DEX-specific (Raydium AMM v4 vs CPMM vs CLMM vs Meteora vs Orca
 *   all lay out pool state differently, and CLMM/DLMM positions are NFTs with no
 *   fungible LP mint to burn at all). A Dexscreener pair object carries none of
 *   that. So this layer NEVER derives LP burn itself. It evaluates LP burn only
 *   when the caller hands it evidence (rugcheck markets[].lp.lpLockedPct, or an
 *   explicit lp/lpBurnedPct/lpLockedPct field on the pair).
 *
 *   When no LP evidence exists the result is never a silent pass:
 *     - default (requireLpVerified: false): PASS with facts.lp.status === 'unverified',
 *       facts.unverified containing 'lpBurnedOrLocked', and facts.scoreDown === true.
 *       The orchestrator MUST surface that, exactly as it surfaces layer 4's
 *       deployerUnknown.
 *     - requireLpVerified: true: REJECT, for callers that refuse to trade on
 *       unverifiable LP ownership.
 *
 * Unknown liquidity or market cap is a REJECT, not a zero: fail closed.
 *
 * TWO ENTRY POINTS:
 *   checkLiquidity(pair, options)  the pure test over a snapshot the caller holds.
 *   runLayer2(mint, ctx)           the (mint, ctx) adapter the gate calls: it
 *                                  resolves the pair through ctx.getPair(), tries
 *                                  to enrich it with RugCheck LP evidence, then
 *                                  delegates. It adds no thresholds of its own.
 */

import { RISK, SAFETY } from '../config.js';
import { errored, pass, reject, verdict } from './verdict.js';

const LAYER = 'layer2-liquidity';
/** LP burned and LP locked are interchangeable for "creator cannot pull the pool". */
const LP_EVIDENCE_KINDS = Object.freeze(['burnedPct', 'lockedPct']);
const PCT_MAX = 100;

/** @returns {number|null} finite number or null. Unknown stays unknown. */
function finiteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round(value, digits = 4) {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Liquidity in USD from the shapes we actually receive:
 * Dexscreener (`liquidity.usd`), our normalised pair (`liquidityUsd`),
 * GeckoTerminal (`reserve_in_usd`), RugCheck (`totalMarketLiquidity`).
 */
function readLiquidityUsd(pair) {
  const nested = isPlainObject(pair.liquidity) ? pair.liquidity.usd : undefined;
  return finiteOrNull(
    pair.liquidityUsd ?? nested ?? pair.reserve_in_usd ?? pair.totalMarketLiquidity,
  );
}

/**
 * Market cap. FDV is the fallback and is the more conservative of the two for
 * this test: a larger cap lowers the liquidity/cap ratio.
 */
function readMarketCap(pair) {
  return finiteOrNull(pair.marketCap ?? pair.marketCapUsd ?? pair.fdv ?? pair.market_cap_usd);
}

/**
 * Collect whatever LP evidence the caller supplied. Returns a frozen record with
 * `pct === null` meaning "nobody told us", which is different from 0 ("nothing
 * burned"). Percentages outside 0-100 are a data-shape error and throw, so the
 * layer reports errored() rather than trusting a nonsense number.
 * @param {object} pair
 */
function readLpEvidence(pair) {
  const lp = isPlainObject(pair.lp) ? pair.lp : {};
  const markets = Array.isArray(pair.markets) ? pair.markets : [];
  const marketLpPcts = markets
    .filter(isPlainObject)
    .map((m) => (isPlainObject(m.lp) ? finiteOrNull(m.lp.lpLockedPct) : null))
    .filter((n) => n !== null);

  const candidates = [
    { kind: 'burnedPct', value: finiteOrNull(lp.burnedPct ?? pair.lpBurnedPct) },
    {
      kind: 'lockedPct',
      value: finiteOrNull(
        lp.lockedPct ?? lp.lpLockedPct ?? pair.lpLockedPct ?? pair.lpLockedPercentage,
      ),
    },
    ...marketLpPcts.map((value) => ({ kind: 'lockedPct', value })),
  ].filter((c) => c.value !== null);

  for (const c of candidates) {
    if (c.value < 0 || c.value > PCT_MAX) {
      throw new RangeError(
        `LP ${c.kind} must be a percentage in 0-${PCT_MAX}, got ${c.value}`,
      );
    }
  }

  const best = candidates.reduce(
    (acc, c) => (acc === null || c.value > acc.value ? c : acc),
    /** @type {{kind: string, value: number}|null} */ (null),
  );

  return Object.freeze({
    /** Highest of burned/locked: either one satisfies requireLpBurnedOrLocked. */
    pct: best === null ? null : best.value,
    kind: best === null ? null : best.kind,
    lpMint:
      typeof lp.lpMint === 'string'
        ? lp.lpMint
        : typeof pair.lpMint === 'string'
          ? pair.lpMint
          : null,
    source: typeof lp.source === 'string' ? lp.source : null,
    evidenceKinds: Object.freeze(LP_EVIDENCE_KINDS.filter((k) => candidates.some((c) => c.kind === k))),
    verified: best !== null,
    status: best === null ? 'unverified' : 'reported-by-caller',
  });
}

/**
 * @param {object} pair pool snapshot: { liquidityUsd|liquidity.usd, marketCap|fdv,
 *   pairAddress?, dexId?, lp?|lpBurnedPct?|lpLockedPct?|markets? }
 * @param {object} [options]
 * @param {number} [options.positionSizeUsd] defaults to RISK.positionSizeUsd
 * @param {boolean} [options.requireLpVerified] reject instead of passing with an
 *   'unverified' fact when no LP burn/lock evidence was supplied. Default false.
 * @returns {Promise<import('./verdict.js').default|object>} frozen verdict
 */
export async function checkLiquidity(pair, options = {}) {
  const startedAt = Date.now();
  const cfg = SAFETY.layer2;

  try {
    if (!isPlainObject(pair)) {
      throw new TypeError(`checkLiquidity requires a pair object, got ${typeof pair}`);
    }
    const positionSizeUsd = options.positionSizeUsd ?? RISK.positionSizeUsd;
    if (!Number.isFinite(positionSizeUsd) || positionSizeUsd <= 0) {
      throw new TypeError(
        `positionSizeUsd must be a positive finite number, got ${String(options.positionSizeUsd)}`,
      );
    }
    const requireLpVerified = options.requireLpVerified === true;

    const liquidityUsd = readLiquidityUsd(pair);
    const marketCap = readMarketCap(pair);
    const lp = readLpEvidence(pair);

    // Percent of the pool our single order represents. maxPositionPctOfLiquidity
    // is a PERCENT (0.5 == half a percent), matching every other *Pct in config;
    // ratios in config are named *Ratio / *Rate and are fractions.
    const positionPctOfLiquidity =
      liquidityUsd !== null && liquidityUsd > 0 ? (positionSizeUsd / liquidityUsd) * PCT_MAX : null;
    const liquidityToMcapRatio =
      liquidityUsd !== null && marketCap !== null && marketCap > 0 ? liquidityUsd / marketCap : null;

    const reasons = [];
    const unverified = [];

    // --- unknown inputs: reject, never treat as zero (fail closed) ---
    if (liquidityUsd === null) {
      reasons.push('liquidityUsd unknown: cannot size a position against unknown depth');
    } else if (liquidityUsd <= 0) {
      reasons.push(`liquidityUsd is ${liquidityUsd}: no tradeable pool`);
    }
    if (marketCap === null) {
      reasons.push('marketCap unknown: cannot evaluate liquidity-to-cap ratio');
    } else if (marketCap <= 0) {
      reasons.push(`marketCap is ${marketCap}: unusable for the liquidity-to-cap ratio`);
    }

    // --- 1. absolute depth ---
    if (liquidityUsd !== null && liquidityUsd > 0 && liquidityUsd < cfg.minLiquidityUsd) {
      reasons.push(
        `liquidity ${liquidityUsd} USD below minimum ${cfg.minLiquidityUsd} USD`,
      );
    }

    // --- 2. our own footprint ---
    if (positionPctOfLiquidity !== null && positionPctOfLiquidity > cfg.maxPositionPctOfLiquidity) {
      reasons.push(
        `position ${positionSizeUsd} USD is ${round(positionPctOfLiquidity, 3)}% of liquidity, ` +
          `above max ${cfg.maxPositionPctOfLiquidity}% (we would be our own slippage)`,
      );
    }

    // --- 3. float vs cap ---
    if (liquidityToMcapRatio !== null && liquidityToMcapRatio < cfg.minLiquidityToMcapRatio) {
      reasons.push(
        `liquidity/marketCap ${round(liquidityToMcapRatio)} below minimum ` +
          `${cfg.minLiquidityToMcapRatio} (thin float on an inflated cap)`,
      );
    }

    // --- 4. LP burned or locked ---
    if (cfg.requireLpBurnedOrLocked) {
      if (lp.pct !== null) {
        if (lp.pct < cfg.minLpBurnedPct) {
          reasons.push(
            `LP ${lp.kind} ${lp.pct}% below minimum ${cfg.minLpBurnedPct}%: ` +
              'the creator can still pull the pool',
          );
        }
      } else {
        // Not verifiable from what we were given. Surfaced, never silently passed.
        unverified.push('lpBurnedOrLocked');
        if (requireLpVerified) {
          reasons.push(
            'LP burn/lock could not be verified: no lpBurnedPct, lpLockedPct or ' +
              'markets[].lp.lpLockedPct supplied, and the LP mint is DEX-specific ' +
              '(requireLpVerified was set)',
          );
        }
      }
    }

    const facts = Object.freeze({
      pairAddress: typeof pair.pairAddress === 'string' ? pair.pairAddress : null,
      dexId: typeof pair.dexId === 'string' ? pair.dexId : null,
      liquidityUsd,
      marketCap,
      positionSizeUsd,
      positionPctOfLiquidity: round(positionPctOfLiquidity, 4),
      liquidityToMcapRatio: round(liquidityToMcapRatio),
      lp,
      unverified: Object.freeze([...unverified]),
      /** True when something the orchestrator should score down went unverified. */
      scoreDown: unverified.length > 0,
      thresholds: Object.freeze({ ...cfg }),
    });

    const ms = Date.now() - startedAt;
    return reasons.length > 0 ? reject(LAYER, reasons, facts, ms) : pass(LAYER, facts, ms);
  } catch (err) {
    // Fail closed: a thrown check is an ERROR verdict, which the gate blocks on.
    return errored(LAYER, err, {}, Date.now() - startedAt);
  }
}

/* -------------------------------------------------------------------------- */
/* runLayer2 -- the (mint, ctx) adapter the gate calls                        */
/* -------------------------------------------------------------------------- */

/** Marks the LP evidence this adapter could not obtain, in facts.unverified. */
const RUGCHECK_LP_EVIDENCE = 'rugcheckLpEvidence';

/**
 * LP evidence carried by a RugCheck token report, if one can be had.
 *
 * A FAILING rugcheck fetch is NOT layer 2's failure: layer 5 owns the
 * third-party veto, and turning a rugcheck outage into a layer 2 ERROR would
 * make an unrelated provider able to block every buy. So the failure is
 * recorded and the caller falls through to the existing `unverified` path.
 *
 * The normalised report already exposes `lpLockedPct` as the highest
 * `markets[].lp.lpLockedPct` (see src/data/rugcheck.js); `raw.markets` is read
 * as a fallback for a caller that hands over an un-normalised report.
 *
 * @param {object} ctx
 * @returns {Promise<Readonly<{available: boolean, lpLockedPct: number|null,
 *   lpMint: string|null, error: string|null, ignored: readonly string[]}>>}
 */
async function readReportLpEvidence(ctx) {
  const none = (error, ignored = []) =>
    Object.freeze({
      available: error === null,
      lpLockedPct: null,
      lpMint: null,
      error,
      ignored: Object.freeze([...ignored]),
    });

  if (typeof ctx.getTokenReport !== 'function') {
    return none('ctx.getTokenReport is not available');
  }

  let report;
  try {
    report = await ctx.getTokenReport();
  } catch (err) {
    // Deliberately swallowed: see the note above. Layer 5 reports this outage.
    return none(`rugcheck report unavailable: ${err?.message ?? String(err)}`);
  }
  if (!isPlainObject(report)) return none(`rugcheck report was ${typeof report}`);

  const raw = isPlainObject(report.raw) ? report.raw : {};
  const markets = Array.isArray(report.markets)
    ? report.markets
    : Array.isArray(raw.markets)
      ? raw.markets
      : [];
  const marketPcts = markets
    .filter(isPlainObject)
    .map((m) => (isPlainObject(m.lp) ? finiteOrNull(m.lp.lpLockedPct) : null))
    .filter((n) => n !== null);

  const reported = [finiteOrNull(report.lpLockedPct), ...marketPcts];
  const usable = reported.filter((n) => n !== null && n >= 0 && n <= PCT_MAX);
  const ignored = reported.filter((n) => n !== null && (n < 0 || n > PCT_MAX));

  return Object.freeze({
    available: true,
    // Highest reported lock, matching readLpEvidence's burned-OR-locked rule.
    lpLockedPct: usable.length > 0 ? Math.max(...usable) : null,
    lpMint: typeof report.lpMint === 'string' ? report.lpMint : null,
    error: null,
    /** Out-of-range percentages are dropped, never clamped and never trusted. */
    ignored: Object.freeze(
      ignored.map((n) => `rugcheck lpLockedPct ${n} outside 0-${PCT_MAX}, ignored`),
    ),
  });
}

/**
 * A NEW pair object carrying the report's LP evidence, in the shape
 * `readLpEvidence` already understands. The caller's own evidence is never
 * overwritten: the report is appended as one more market, so the existing
 * "highest of burned/locked wins" rule decides.
 * @param {object} pair
 * @param {Readonly<{lpLockedPct: number|null, lpMint: string|null}>} evidence
 */
function withReportEvidence(pair, evidence) {
  if (evidence.lpLockedPct === null && evidence.lpMint === null) return pair;
  const markets = Array.isArray(pair.markets) ? [...pair.markets] : [];
  if (evidence.lpLockedPct !== null) {
    markets.push(Object.freeze({ lp: Object.freeze({ lpLockedPct: evidence.lpLockedPct }) }));
  }
  return Object.freeze({
    ...pair,
    markets: Object.freeze(markets),
    // Informational only; never overwrite an lpMint the caller already had.
    lpMint: typeof pair.lpMint === 'string' ? pair.lpMint : (evidence.lpMint ?? undefined),
  });
}

/**
 * Re-create the verdict with the adapter's own evidence attached.
 * A new verdict, never a mutation: `checkLiquidity` returns a frozen value.
 * @param {object} v verdict from checkLiquidity
 * @param {string} mint
 * @param {Readonly<{available: boolean, lpLockedPct: number|null, error: string|null,
 *   ignored: readonly string[]}>} evidence
 */
function withAdapterFacts(v, mint, evidence) {
  const facts = isPlainObject(v.facts) ? v.facts : {};
  const lpVerified = isPlainObject(facts.lp) && facts.lp.verified === true;
  const unverified = [...(Array.isArray(facts.unverified) ? facts.unverified : [])];
  // Only when the missing report actually cost us the LP check: if the pair
  // carried its own LP evidence, the outage changed nothing.
  if (!lpVerified && !unverified.includes(RUGCHECK_LP_EVIDENCE) && evidence.lpLockedPct === null) {
    unverified.push(RUGCHECK_LP_EVIDENCE);
  }
  return verdict({
    layer: v.layer,
    outcome: v.outcome,
    reasons: v.reasons,
    facts: {
      ...facts,
      mint,
      lpEvidenceFromReport: Object.freeze({
        reportAvailable: evidence.available,
        lpLockedPct: evidence.lpLockedPct,
        error: evidence.error,
        ignored: evidence.ignored,
      }),
      unverified: Object.freeze(unverified),
      /** Kept in step with the merged list, so a scored-down pass stays visible. */
      scoreDown: unverified.length > 0,
    },
    ms: v.ms,
  });
}

/**
 * Layer 2 as the gate calls it.
 *
 * Resolves the pool snapshot through `ctx.getPair()` (memoised per gate run),
 * enriches it with RugCheck LP evidence when that is obtainable, and delegates
 * every threshold decision to `checkLiquidity`. Adds no thresholds of its own.
 *
 * @param {string} mint
 * @param {Readonly<{getPair: () => Promise<object|null>,
 *   getTokenReport?: () => Promise<object>}>} ctx the gate context
 * @returns {Promise<object>} frozen verdict for 'layer2-liquidity'; never throws
 */
export async function runLayer2(mint, ctx) {
  const startedAt = Date.now();
  try {
    if (!isPlainObject(ctx) || typeof ctx.getPair !== 'function') {
      throw new TypeError('runLayer2 requires a gate context exposing getPair()');
    }
    const pair = await ctx.getPair();

    if (pair === null || pair === undefined) {
      // A FACT, not an error: Dexscreener reports no acceptable pool for this
      // mint, so there is no depth to size against and no exit to price.
      return reject(
        LAYER,
        ['no pair: nothing to size against (no acceptable quote pool was reported for this mint)'],
        Object.freeze({
          mint,
          pairAddress: null,
          dexId: null,
          liquidityUsd: null,
          marketCap: null,
          pairFound: false,
          thresholds: Object.freeze({ ...SAFETY.layer2 }),
        }),
        Date.now() - startedAt,
      );
    }

    const evidence = await readReportLpEvidence(ctx);
    const enriched = isPlainObject(pair) ? withReportEvidence(pair, evidence) : pair;
    return withAdapterFacts(await checkLiquidity(enriched), mint, evidence);
  } catch (err) {
    // Fail closed: an unresolvable pair is not a proven pool.
    return errored(LAYER, err, Object.freeze({ mint, pairFound: null }), Date.now() - startedAt);
  }
}
