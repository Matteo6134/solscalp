/**
 * The single JSON-over-HTTP boundary for every free-tier data client.
 *
 * FAIL CLOSED. A non-2xx status, an unparseable body, a socket error or a
 * timeout all THROW. Nothing here ever returns a partial or default-shaped
 * payload, because a caller that reads `{}` as "no risk found" is exactly the
 * failure mode this project is built to avoid.
 *
 * NO RETRIES, deliberately. The per-minute limits we live under are hard
 * (LIMITS in src/config.js) and a blind retry is the classic way to turn one
 * failure into a bot-wide throttle. Callers that want a retry must schedule it
 * through the same rate limiter as the first attempt.
 *
 * READ ONLY: GET requests only, https only, no request bodies, no credentials.
 * Nothing in this project signs anything.
 */

import { request } from 'undici';
import { SAFETY } from '../config.js';
import { describeValue } from './coerce.js';

/**
 * Identifies us to the free APIs. Several of them drop requests with no
 * user-agent, which would look like a network failure.
 */
const USER_AGENT = 'solscalp/0.1 (read-only paper trading)';

/** Why a request failed. Callers branch on this, never on message text. */
export const HTTP_ERROR = Object.freeze({
  /** Bad url/arguments handed to this module. A bug, not a network event. */
  USAGE: 'usage',
  /** Socket error, DNS failure, or our own timeout fired. */
  TRANSPORT: 'transport',
  /** A response arrived with a non-2xx status. `status` is set. */
  STATUS: 'status',
  /** A 2xx response whose body was not parseable JSON. */
  BODY: 'body',
});

/**
 * Build the error every failure path here throws.
 * A factory rather than a subclass: callers read `.kind` / `.status`.
 * @returns {Error & {kind: string, label: string, url: string, status: number|null}}
 */
function httpError(kind, label, url, message, { status = null, cause } = {}) {
  const err = new Error(`${label}: ${message} [GET ${url}]`);
  err.kind = kind;
  err.label = label;
  err.url = url;
  err.status = status;
  if (cause !== undefined) err.cause = cause;
  return err;
}

/** True when the remote told us to back off. Callers should widen their interval. */
export const isRateLimited = (err) => err?.kind === HTTP_ERROR.STATUS && err.status === 429;

/**
 * Release a non-2xx body so undici can reuse the socket. A failure to drain is
 * irrelevant to the caller -- the request already failed and that error is the
 * one being thrown -- so it is deliberately not propagated.
 */
async function drain(body) {
  try {
    if (typeof body?.dump === 'function') await body.dump();
    else if (typeof body?.text === 'function') await body.text();
  } catch {
    /* the status error is the real error; draining is best-effort cleanup */
  }
}

/**
 * GET `url` and return the parsed JSON. Throws on anything else.
 *
 * @param {string} url absolute https url, query string already built
 * @param {object} [opts]
 * @param {string} [opts.label] data source name, prefixes every error
 * @param {number} [opts.timeoutMs] defaults to SAFETY.perLayerTimeoutMs: a data
 *   call made inside a safety layer must not outlive that layer's budget
 * @param {Record<string,string>} [opts.headers]
 * @returns {Promise<unknown>} untrusted: the caller must validate its shape
 */
export async function getJson(
  url,
  { label = 'http', timeoutMs = SAFETY.perLayerTimeoutMs, headers = {} } = {},
) {
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw httpError(HTTP_ERROR.USAGE, label, String(url), 'refusing to fetch a non-https url');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw httpError(HTTP_ERROR.USAGE, label, url, `invalid timeoutMs ${String(timeoutMs)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    let res;
    try {
      res = await request(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
        signal: controller.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (cause) {
      throw httpError(
        HTTP_ERROR.TRANSPORT,
        label,
        url,
        `request failed within ${timeoutMs}ms: ${cause?.message ?? String(cause)}`,
        { cause },
      );
    }

    const status = typeof res?.statusCode === 'number' ? res.statusCode : null;
    if (status === null) {
      throw httpError(
        HTTP_ERROR.TRANSPORT,
        label,
        url,
        `client returned no statusCode (${describeValue(res)})`,
      );
    }
    if (status < 200 || status >= 300) {
      await drain(res.body);
      throw httpError(HTTP_ERROR.STATUS, label, url, `HTTP ${status}`, { status });
    }
    if (typeof res.body?.json !== 'function') {
      throw httpError(HTTP_ERROR.BODY, label, url, 'response had no readable body', { status });
    }

    let payload;
    try {
      payload = await res.body.json();
    } catch (cause) {
      throw httpError(
        HTTP_ERROR.BODY,
        label,
        url,
        `body was not valid JSON: ${cause?.message ?? String(cause)}`,
        { status, cause },
      );
    }
    if (payload === null || payload === undefined) {
      throw httpError(HTTP_ERROR.BODY, label, url, 'body parsed to null', { status });
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build `base + path + ?query`, dropping params whose value is null/undefined.
 * Keeps query building out of the clients and out of error-prone concatenation.
 * @param {string} base
 * @param {string} path must start with '/'
 * @param {Record<string, string|number|null|undefined>} [params]
 * @returns {string}
 */
export function buildUrl(base, path, params = {}) {
  if (typeof base !== 'string' || base === '') throw new TypeError('buildUrl: base required');
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(`buildUrl: path must start with "/", got ${describeValue(path)}`);
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    query.set(key, String(value));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return `${base.replace(/\/+$/, '')}${path}${suffix}`;
}
