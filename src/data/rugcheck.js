/**
 * RugCheck v1 read-only client. Keyless endpoints only: no API key, no auth header,
 * no wallet, no signing. Every response is untrusted input and is validated before
 * any nested field is read.
 *
 * SCORE DIRECTION -- read this before touching layer 5:
 *   `score_normalised` is 0-100 where **HIGHER = RISKIER**.
 *   0   == RugCheck found nothing suspicious.
 *   100 == maximally dangerous.
 *   Layer 5 therefore rejects when scoreNormalised > SAFETY.layer5.maxRugcheckScoreNormalised.
 *   Inverting this comparison would turn the veto into an "only buy scams" filter,
 *   which is why the direction is asserted here, on the typedef, and in layer 5.
 *
 *   We deliberately do NOT fall back to the legacy unbounded `score` field when
 *   `score_normalised` is absent: the two live on different scales, so substituting
 *   one for the other would silently move the threshold. Absent => throw =>
 *   layer 5 returns errored() => the gate rejects. Fail closed.
 */

import { request } from 'undici';
import { ENDPOINTS, LIMITS, SAFETY } from '../config.js';
import { createRateLimiter } from './rateLimiter.js';

const USER_AGENT = 'solscalp/0.1 (read-only safety gate)';
/** base58, 32-44 chars: covers both mints and wallet addresses. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Error bodies are quoted back for diagnosis, truncated so logs stay readable. */
const MAX_ERROR_BODY_CHARS = 240;

/**
 * @typedef {object} RugcheckTokenReport
 * @property {string} mint
 * @property {number} scoreNormalised 0-100, HIGHER = RISKIER
 * @property {number|null} scoreRaw legacy unbounded score, HIGHER = RISKIER
 * @property {boolean} rugged
 * @property {readonly object[]} risks
 * @property {readonly object[]} topHolders
 * @property {number|null} liquidityUsd
 * @property {number|null} lpLockedPct highest lpLockedPct across reported markets
 * @property {string|null} lpMint
 * @property {string|null} creator
 * @property {object} token mint-level facts (supply / decimals / authorities)
 * @property {object} raw parsed response, kept for logs and backtests
 */

/* -------------------------------------------------------------------------- */
/* primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** @returns {number|null} finite number or null. Never NaN, never coerced from ''. */
function finiteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** @returns {string|null} non-empty string or null. */
function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAddress(value, label) {
  if (typeof value !== 'string' || !BASE58_ADDRESS.test(value)) {
    throw new TypeError(`${label} must be a base58 address (32-44 chars), got: ${String(value)}`);
  }
  return value;
}

function truncate(text) {
  const s = String(text ?? '');
  return s.length > MAX_ERROR_BODY_CHARS ? `${s.slice(0, MAX_ERROR_BODY_CHARS)}...` : s;
}

/* -------------------------------------------------------------------------- */
/* transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The shared limiter is built lazily so a shape mismatch with rateLimiter.js
 * surfaces as a descriptive error on first use instead of at import time.
 * Accepts either a callable limiter or an object exposing schedule() / run().
 * @type {((fn: () => Promise<any>) => Promise<any>)|null}
 */
let scheduler = null;

function getScheduler() {
  if (scheduler) return scheduler;
  const limiter = createRateLimiter({ requestsPerMinute: LIMITS.rugcheck.requestsPerMinute });
  if (typeof limiter === 'function') scheduler = limiter;
  else if (limiter && typeof limiter.schedule === 'function') scheduler = (fn) => limiter.schedule(fn);
  else if (limiter && typeof limiter.run === 'function') scheduler = (fn) => limiter.run(fn);
  else {
    throw new TypeError(
      'createRateLimiter must return a callable limiter or an object with schedule()/run()',
    );
  }
  return scheduler;
}

/**
 * Rate-limited GET returning parsed JSON. Throws with endpoint, status and a
 * truncated body on any transport, status or parse failure -- callers turn that
 * into errored(), which the gate treats as a reject.
 * @param {string} path path under ENDPOINTS.rugcheck, already encoded
 * @param {string} label human label used in error messages
 */
async function getJson(path, label) {
  const url = `${ENDPOINTS.rugcheck}${path}`;
  return getScheduler()(async () => {
    let response;
    try {
      response = await request(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        headersTimeout: SAFETY.perLayerTimeoutMs,
        bodyTimeout: SAFETY.perLayerTimeoutMs,
        signal: AbortSignal.timeout(SAFETY.perLayerTimeoutMs),
        maxRedirections: 0,
      });
    } catch (err) {
      throw new Error(`rugcheck ${label} request failed (${url}): ${err?.message ?? err}`, {
        cause: err,
      });
    }

    // Always drain the body, even on a bad status, or the socket is never released.
    const text = await response.body.text();

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`rugcheck ${label} HTTP ${response.statusCode} (${url}): ${truncate(text)}`);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`rugcheck ${label} returned unparseable JSON (${url}): ${truncate(text)}`, {
        cause: err,
      });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* normalisation                                                              */
/* -------------------------------------------------------------------------- */

function normaliseRisks(raw) {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw.filter(isPlainObject).map((r) =>
      Object.freeze({
        name: stringOrNull(r.name) ?? 'unnamed-risk',
        level: stringOrNull(r.level),
        score: finiteOrNull(r.score),
        value: stringOrNull(r.value),
        description: stringOrNull(r.description),
      }),
    ),
  );
}

function normaliseTopHolders(raw) {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw.filter(isPlainObject).map((h) =>
      Object.freeze({
        address: stringOrNull(h.address),
        owner: stringOrNull(h.owner),
        /** Raw base units as reported by RugCheck. */
        amount: finiteOrNull(h.amount),
        pct: finiteOrNull(h.pct),
        insider: h.insider === true,
      }),
    ),
  );
}

/** Highest lpLockedPct across reported markets: "burned or locked" is per-pool. */
function normaliseMarkets(raw) {
  if (!Array.isArray(raw)) return { lpLockedPct: null, lpMint: null, marketCount: 0 };
  const lps = raw.filter(isPlainObject).map((m) => (isPlainObject(m.lp) ? m.lp : {}));
  const pcts = lps.map((lp) => finiteOrNull(lp.lpLockedPct)).filter((n) => n !== null);
  const lpMint = lps.map((lp) => stringOrNull(lp.lpMint)).find((v) => v != null) ?? null;
  return {
    lpLockedPct: pcts.length > 0 ? Math.max(...pcts) : null,
    lpMint,
    marketCount: raw.length,
  };
}

/**
 * @param {unknown} raw
 * @param {string} mint
 * @returns {RugcheckTokenReport}
 */
function normaliseTokenReport(raw, mint) {
  if (!isPlainObject(raw)) {
    throw new TypeError(`rugcheck report for ${mint} is not an object (got ${typeof raw})`);
  }

  // HIGHER = RISKIER. Accept the documented snake_case field and a camelCase
  // variant in case the API renames it; never substitute the legacy `score`.
  const scoreNormalised = finiteOrNull(raw.score_normalised ?? raw.scoreNormalised);
  if (scoreNormalised === null) {
    throw new TypeError(
      `rugcheck report for ${mint} has no usable score_normalised field ` +
        `(keys: ${Object.keys(raw).join(',') || 'none'})`,
    );
  }
  if (scoreNormalised < 0) {
    throw new RangeError(
      `rugcheck score_normalised for ${mint} is negative (${scoreNormalised}); ` +
        'expected 0-100 where higher is riskier',
    );
  }

  const token = isPlainObject(raw.token) ? raw.token : {};
  const markets = normaliseMarkets(raw.markets);

  return Object.freeze({
    mint,
    /** 0-100, HIGHER = RISKIER. */
    scoreNormalised,
    /** Legacy unbounded score, HIGHER = RISKIER. Informational only. */
    scoreRaw: finiteOrNull(raw.score),
    /** Above 100 means the API changed scale: surfaced, never silently clamped. */
    scoreOutOfDocumentedRange: scoreNormalised > 100,
    rugged: raw.rugged === true,
    risks: normaliseRisks(raw.risks),
    topHolders: normaliseTopHolders(raw.topHolders),
    totalHolders: finiteOrNull(raw.totalHolders),
    liquidityUsd: finiteOrNull(raw.totalMarketLiquidity),
    lpLockedPct: markets.lpLockedPct,
    lpMint: markets.lpMint,
    marketCount: markets.marketCount,
    creator: stringOrNull(raw.creator),
    graphInsidersDetected: finiteOrNull(raw.graphInsidersDetected),
    token: Object.freeze({
      supply: finiteOrNull(token.supply),
      decimals: finiteOrNull(token.decimals),
      mintAuthority: stringOrNull(token.mintAuthority),
      freezeAuthority: stringOrNull(token.freezeAuthority),
    }),
    raw: Object.freeze(raw),
  });
}

/** Pull the network list out of whichever envelope the API used. */
function pickNetworks(raw, mint) {
  if (Array.isArray(raw)) return raw;
  if (isPlainObject(raw)) {
    const candidate = raw.networks ?? raw.insiderNetworks ?? raw.graph ?? raw.data ?? raw.nodes;
    if (Array.isArray(candidate)) return candidate;
  }
  throw new TypeError(
    `rugcheck insider graph for ${mint} has no recognisable network array ` +
      `(top-level type: ${Array.isArray(raw) ? 'array' : typeof raw})`,
  );
}

function nodeAddress(node) {
  if (typeof node === 'string') return stringOrNull(node);
  if (!isPlainObject(node)) return null;
  return (
    stringOrNull(node.address) ??
    stringOrNull(node.owner) ??
    stringOrNull(node.account) ??
    stringOrNull(node.participant) ??
    stringOrNull(node.wallet) ??
    stringOrNull(node.id)
  );
}

function normaliseNetwork(group, index) {
  const source = isPlainObject(group) ? group : {};
  const rawNodes =
    [source.nodes, source.network, source.accounts, source.wallets, source.participants].find(
      Array.isArray,
    ) ?? [];
  const addresses = Object.freeze([
    ...new Set(rawNodes.map(nodeAddress).filter((a) => a !== null)),
  ]);
  const declaredPct = finiteOrNull(source.pct ?? source.percentage ?? source.tokenPct);
  const nodePcts = rawNodes
    .map((n) => (isPlainObject(n) ? finiteOrNull(n.pct ?? n.percentage) : null))
    .filter((n) => n !== null);

  return Object.freeze({
    id: stringOrNull(source.id) ?? `network-${index}`,
    type: stringOrNull(source.type),
    addresses,
    size: finiteOrNull(source.size) ?? addresses.length,
    tokenAmount: finiteOrNull(source.tokenAmount ?? source.amount),
    /** Percentage of supply held by this cluster, or null when not reported. */
    pct: declaredPct ?? (nodePcts.length > 0 ? nodePcts.reduce((a, b) => a + b, 0) : null),
  });
}

/**
 * Normalised insider graph. `largestClusterPct` is null when at least one cluster
 * reported no percentage: unknown is never flattened to zero, because zero reads
 * as "clean" to layer 3.
 * @param {unknown} raw
 * @param {string} mint
 */
function normaliseInsiderGraph(raw, mint) {
  const networks = Object.freeze(pickNetworks(raw, mint).map(normaliseNetwork));
  const pcts = networks.map((n) => n.pct).filter((p) => p !== null);
  const allPctsKnown = pcts.length === networks.length;

  return Object.freeze({
    mint,
    networks,
    largestClusterPct: networks.length === 0 ? 0 : allPctsKnown ? Math.max(...pcts) : null,
    totalInsiderPct: allPctsKnown ? pcts.reduce((a, b) => a + b, 0) : null,
    raw: Object.freeze(raw),
  });
}

/**
 * Wallet risk is under-documented and best-effort: layer 4 has no score threshold
 * of its own, it only reuses prior-rug counts. So we do not demand a score here,
 * but we do demand that at least one recognisable field was present.
 */
function normaliseWalletRisk(raw, address) {
  if (!isPlainObject(raw)) {
    throw new TypeError(`rugcheck wallet risk for ${address} is not an object (got ${typeof raw})`);
  }
  const riskScore = finiteOrNull(
    raw.score_normalised ?? raw.scoreNormalised ?? raw.score ?? raw.risk_score,
  );
  const riskLevel = stringOrNull(raw.level ?? raw.riskLevel ?? raw.risk);
  const rugCount = finiteOrNull(raw.rugCount ?? raw.rugged_count ?? raw.ruggedTokens ?? raw.rugs);
  const mintCount = finiteOrNull(
    raw.mintCount ?? raw.tokens_created ?? raw.createdTokens ?? raw.mints,
  );

  if (riskScore === null && riskLevel === null && rugCount === null && mintCount === null) {
    throw new TypeError(
      `rugcheck wallet risk for ${address} had no recognisable fields ` +
        `(keys: ${Object.keys(raw).join(',') || 'none'})`,
    );
  }

  return Object.freeze({
    address,
    /** HIGHER = RISKIER, same direction as the token report. */
    riskScore,
    riskLevel,
    rugCount,
    mintCount,
    priorRugRate:
      rugCount !== null && mintCount !== null && mintCount > 0 ? rugCount / mintCount : null,
    rugged: raw.rugged === true,
    raw: Object.freeze(raw),
  });
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /tokens/{mint}/report
 * @param {string} mint
 * @returns {Promise<RugcheckTokenReport>} frozen; scoreNormalised 0-100, HIGHER = RISKIER
 */
export async function getTokenReport(mint) {
  assertAddress(mint, 'getTokenReport(mint)');
  const raw = await getJson(`/tokens/${encodeURIComponent(mint)}/report`, 'token report');
  return normaliseTokenReport(raw, mint);
}

/**
 * GET /tokens/{mint}/insiders/graph
 * Clusters of wallets funded from a common source (bundled launch posing as demand).
 * @param {string} mint
 */
export async function getInsiderGraph(mint) {
  assertAddress(mint, 'getInsiderGraph(mint)');
  const raw = await getJson(`/tokens/${encodeURIComponent(mint)}/insiders/graph`, 'insider graph');
  return normaliseInsiderGraph(raw, mint);
}

/**
 * GET /wallet/{address}/risk
 * @param {string} address
 */
export async function getWalletRisk(address) {
  assertAddress(address, 'getWalletRisk(address)');
  const raw = await getJson(`/wallet/${encodeURIComponent(address)}/risk`, 'wallet risk');
  return normaliseWalletRisk(raw, address);
}
