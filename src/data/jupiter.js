/**
 * Jupiter quote client -- READ ONLY.
 *
 * This module only ever performs GET /quote. It never builds, serialises,
 * signs or sends a transaction, and it never touches a keypair. The only thing
 * it can prove is that a ROUTE exists and what that route would return.
 *
 * Fail closed: every non-quote outcome (HTTP failure, unparseable body,
 * unexpected shape) throws with a descriptive message. Callers -- notably the
 * safety layers -- must translate a throw into a REJECT, never into a PASS.
 *
 * Rate limited to LIMITS.jupiter.requestsPerMinute over a sliding 60s window,
 * shared by every caller of this module: the quota is per IP, not per call site.
 */

import { request } from 'undici';
import { ENDPOINTS, KNOWN, LIMITS, SAFETY } from '../config.js';

/** Error code marking "Jupiter has no route for this pair/amount". */
export const NO_ROUTE = 'JUPITER_NO_ROUTE';

const WINDOW_MS = 60_000;
/** Per-request ceiling. The gate enforces the overall budget on top of this. */
const HTTP_TIMEOUT_MS = SAFETY.perLayerTimeoutMs;
/** Upper bound on foreign text echoed into an error message. */
const MAX_BODY_SNIPPET_CHARS = 240;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sliding-window rate limiter. Genuinely stateful, so it keeps its state in a
 * closure and exposes only acquire(); no caller can reach in and mutate it.
 * @param {number} requestsPerMinute
 */
function createRateLimiter(requestsPerMinute) {
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
    throw new TypeError(`rate limit must be a positive number, got ${requestsPerMinute}`);
  }
  /** @type {readonly number[]} timestamps of slots granted in the current window */
  let granted = [];
  /** Serialises slot handout so two concurrent callers cannot claim one slot. */
  let queue = Promise.resolve();

  const acquire = () => {
    const next = queue.then(async () => {
      for (;;) {
        const now = Date.now();
        granted = granted.filter((at) => now - at < WINDOW_MS);
        if (granted.length < requestsPerMinute) {
          granted = [...granted, now];
          return;
        }
        const waitMs = WINDOW_MS - (now - granted[0]);
        await delay(waitMs > 0 ? waitMs : 1);
      }
    });
    // Keep the chain alive even if a waiter above is rejected.
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return Object.freeze({ acquire });
}

const limiter = createRateLimiter(LIMITS.jupiter.requestsPerMinute);

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isDigitString = (v) => typeof v === 'string' && /^[0-9]+$/.test(v);

const describe = (v) => {
  if (typeof v === 'string') return JSON.stringify(v.slice(0, 64));
  if (typeof v === 'object' && v !== null) return Array.isArray(v) ? 'array' : 'object';
  return String(v);
};

const snippet = (text) =>
  typeof text === 'string' && text.length > MAX_BODY_SNIPPET_CHARS
    ? `${text.slice(0, MAX_BODY_SNIPPET_CHARS)}...`
    : String(text ?? '');

/** @param {string} message */
function noRouteError(message) {
  return Object.assign(new Error(message), { code: NO_ROUTE });
}

/** True when a failure means "no route", not "the check itself broke". */
export const isNoRouteError = (err) =>
  Boolean(err) && typeof err === 'object' && /** @type {any} */ (err).code === NO_ROUTE;

/** Jupiter signals a missing route with an error body, not an empty result. */
function looksLikeNoRoute(body) {
  const code = typeof body?.errorCode === 'string' ? body.errorCode : '';
  const message = typeof body?.error === 'string' ? body.error : '';
  return (
    /route/i.test(code) ||
    /no route|not find any route|could not find route|routes? (?:not )?found/i.test(message)
  );
}

/** Structural deep freeze for parsed JSON (finite and acyclic by construction). */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Normalise a smallest-unit amount into the digit string Jupiter expects.
 * Floats, negatives and zero are rejected: the amount IS the question being
 * asked, and a silently coerced one produces a meaningless answer.
 * @param {string|number|bigint} amount
 * @param {string} label
 * @returns {string}
 */
function toSmallestUnitString(amount, label) {
  if (typeof amount === 'bigint') {
    if (amount <= 0n) throw new TypeError(`${label} must be > 0, got ${amount}`);
    return amount.toString();
  }
  if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new TypeError(`${label} must be a positive safe integer, got ${amount}`);
    }
    return String(amount);
  }
  if (isDigitString(amount)) {
    const trimmed = amount.replace(/^0+(?=\d)/, '');
    if (trimmed === '0') throw new TypeError(`${label} must be > 0, got "${amount}"`);
    return trimmed;
  }
  throw new TypeError(
    `${label} must be a positive integer in the smallest unit of the input token ` +
      `(digit string, safe integer or bigint); got ${describe(amount)}`,
  );
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function toFiniteNumber(value, label) {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`jupiter quote: ${label} is not a finite number (got ${describe(value)})`);
  }
  return n;
}

/**
 * Validate an untrusted /quote body and project it onto our own shape.
 * @param {any} body
 * @param {{ inputMint: string, outputMint: string }} expected
 */
function normaliseQuote(body, expected) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`jupiter quote: expected a JSON object, got ${describe(body)}`);
  }
  for (const field of ['inAmount', 'outAmount', 'otherAmountThreshold']) {
    if (!isDigitString(body[field])) {
      throw new Error(
        `jupiter quote: ${field} must be an integer string, got ${describe(body[field])}`,
      );
    }
  }
  if (!Array.isArray(body.routePlan)) {
    throw new Error(`jupiter quote: routePlan must be an array, got ${describe(body.routePlan)}`);
  }
  if (body.routePlan.length === 0) {
    throw noRouteError(
      `jupiter returned an empty routePlan for ${expected.inputMint} -> ${expected.outputMint}`,
    );
  }
  // The mints are echoed back; a mismatch means we are reading the wrong quote.
  for (const field of ['inputMint', 'outputMint']) {
    if (isNonEmptyString(body[field]) && body[field] !== expected[field]) {
      throw new Error(
        `jupiter quote: ${field} mismatch, asked ${expected[field]} got ${describe(body[field])}`,
      );
    }
  }

  return Object.freeze({
    inputMint: expected.inputMint,
    outputMint: expected.outputMint,
    inAmount: body.inAmount,
    outAmount: body.outAmount,
    otherAmountThreshold: body.otherAmountThreshold,
    priceImpactPct: toFiniteNumber(body.priceImpactPct, 'priceImpactPct'),
    routePlan: deepFreeze(structuredClone(body.routePlan)),
    raw: deepFreeze(structuredClone(body)),
  });
}

/**
 * GET /quote. Quoting only -- no transaction is ever built or signed.
 *
 * @param {object} p
 * @param {string} p.inputMint
 * @param {string} p.outputMint
 * @param {string|number|bigint} p.amount amount of inputMint in its smallest unit
 * @param {number} p.slippageBps
 * @param {{ httpRequest?: typeof request }} [deps] injection seam for tests
 * @returns {Promise<Readonly<{ inputMint: string, outputMint: string, inAmount: string,
 *   outAmount: string, otherAmountThreshold: string, priceImpactPct: number,
 *   routePlan: readonly object[], raw: object }>>}
 * @throws on no route (err.code === NO_ROUTE), HTTP failure, or unexpected shape
 */
export async function getQuote({ inputMint, outputMint, amount, slippageBps }, deps = {}) {
  const httpRequest = deps.httpRequest ?? request;
  if (!isNonEmptyString(inputMint)) {
    throw new TypeError(`getQuote: inputMint must be a mint address, got ${describe(inputMint)}`);
  }
  if (!isNonEmptyString(outputMint)) {
    throw new TypeError(`getQuote: outputMint must be a mint address, got ${describe(outputMint)}`);
  }
  if (inputMint === outputMint) {
    throw new TypeError(`getQuote: inputMint and outputMint are identical (${inputMint})`);
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new TypeError(`getQuote: slippageBps must be a non-negative integer, got ${slippageBps}`);
  }
  const amountStr = toSmallestUnitString(amount, 'getQuote: amount');

  const query = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountStr,
    slippageBps: String(slippageBps),
  });
  const url = `${ENDPOINTS.jupiterQuote}/quote?${query.toString()}`;
  const pair = `${inputMint} -> ${outputMint}`;

  await limiter.acquire();

  let statusCode;
  let text;
  try {
    const res = await httpRequest(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      headersTimeout: HTTP_TIMEOUT_MS,
      bodyTimeout: HTTP_TIMEOUT_MS,
    });
    statusCode = res?.statusCode;
    // Always drain the body: an undrained undici response leaks its socket.
    text = await res?.body?.text();
  } catch (err) {
    throw new Error(`jupiter quote request failed for ${pair}: ${err?.message ?? String(err)}`, {
      cause: err,
    });
  }

  if (typeof text !== 'string') {
    throw new Error(`jupiter quote returned no readable body for ${pair} (status ${statusCode})`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `jupiter quote returned unparseable JSON for ${pair} (status ${statusCode}): ${snippet(text)}`,
      { cause: err },
    );
  }

  if (body !== null && typeof body === 'object' && 'error' in body) {
    const detail = typeof body.error === 'string' ? body.error : describe(body.error);
    if (looksLikeNoRoute(body)) {
      throw noRouteError(`jupiter has no route for ${pair}: ${detail}`);
    }
    throw new Error(`jupiter quote error for ${pair} (status ${statusCode}): ${detail}`);
  }

  if (statusCode !== 200) {
    throw new Error(`jupiter quote HTTP ${statusCode} for ${pair}: ${snippet(text)}`);
  }

  return normaliseQuote(body, { inputMint, outputMint });
}

/**
 * Quote WSOL -> mint, then quote the ENTIRE proceeds back mint -> WSOL.
 * This is the honeypot probe: can the position be exited at all, and at what cost.
 *
 * A missing sell route is a FINDING, not a failure -- it is the single most
 * important thing this project detects -- so it is reported as
 * sellRouteExists:false / roundTripLossPct:100 instead of being thrown.
 * Everything else (missing buy route, HTTP failure, bad shape) throws: fail closed.
 *
 * @param {object} p
 * @param {string} p.mint token being probed
 * @param {number|bigint|string} p.probeLamports size of the buy leg, in lamports
 * @param {number} p.slippageBps
 * @param {{ quote?: typeof getQuote }} [deps] injection seam for tests
 * @returns {Promise<Readonly<{ buyQuote: object, sellQuote: object|null,
 *   returnedLamports: number, roundTripLossPct: number, sellRouteExists: boolean }>>}
 */
export async function getRoundTrip({ mint, probeLamports, slippageBps }, deps = {}) {
  const quote = deps.quote ?? getQuote;
  if (!isNonEmptyString(mint)) {
    throw new TypeError(`getRoundTrip: mint must be a mint address, got ${describe(mint)}`);
  }
  if (mint === KNOWN.WSOL) {
    throw new TypeError('getRoundTrip: cannot round trip WSOL against itself');
  }
  const probeStr = toSmallestUnitString(probeLamports, 'getRoundTrip: probeLamports');
  const probe = Number(probeStr);
  if (!Number.isSafeInteger(probe)) {
    throw new RangeError(`getRoundTrip: probeLamports out of safe integer range (${probeStr})`);
  }

  const buyQuote = await quote({
    inputMint: KNOWN.WSOL,
    outputMint: mint,
    amount: probeStr,
    slippageBps,
  });

  let sellQuote;
  try {
    sellQuote = await quote({
      inputMint: mint,
      outputMint: KNOWN.WSOL,
      // The whole output of leg 1: a partial exit can hide a size-dependent trap.
      amount: buyQuote.outAmount,
      slippageBps,
    });
  } catch (err) {
    if (!isNoRouteError(err)) throw err;
    return Object.freeze({
      buyQuote,
      sellQuote: null,
      returnedLamports: 0,
      roundTripLossPct: 100,
      sellRouteExists: false,
    });
  }

  const returnedLamports = Number(sellQuote.outAmount);
  if (!Number.isSafeInteger(returnedLamports)) {
    throw new RangeError(
      `getRoundTrip: sell leg outAmount out of safe integer range (${sellQuote.outAmount})`,
    );
  }

  return Object.freeze({
    buyQuote,
    sellQuote,
    returnedLamports,
    roundTripLossPct: (1 - returnedLamports / probe) * 100,
    sellRouteExists: true,
  });
}
