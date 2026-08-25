/**
 * Error classification and safe formatting for the RPC layer.
 *
 * Split out of connection.js so the retry policy stays readable and so the
 * classifier can be unit-tested without opening a socket.
 *
 * FAIL CLOSED: nothing here ever converts an error into a success value. The
 * only judgement made is "is this worth retrying", which is a transport
 * decision, never a safety decision.
 */

/**
 * Distinguishable failure codes. Callers (and safety layers) branch on
 * `err.code` instead of matching message strings.
 * @typedef {'RPC_TRANSPORT'|'RPC_ATTEMPTS_EXHAUSTED'|'RPC_INVALID_ADDRESS'
 *          |'RPC_ACCOUNT_NOT_FOUND'|'RPC_NOT_A_MINT'|'RPC_UNPARSEABLE'} RpcErrorCode
 */
export const RPC_ERROR = Object.freeze({
  /** A single request failed for a non-retryable reason. */
  TRANSPORT: 'RPC_TRANSPORT',
  /** Every attempt (and the fallback endpoint, if configured) failed. */
  EXHAUSTED: 'RPC_ATTEMPTS_EXHAUSTED',
  /** The caller supplied something that is not a base58 32-byte address. */
  INVALID_ADDRESS: 'RPC_INVALID_ADDRESS',
  /** getAccountInfo returned null: the account does not exist. */
  ACCOUNT_NOT_FOUND: 'RPC_ACCOUNT_NOT_FOUND',
  /** The account exists but is not an SPL / Token-2022 mint. */
  NOT_A_MINT: 'RPC_NOT_A_MINT',
  /** The node answered, but with a shape we refuse to guess at. */
  UNPARSEABLE: 'RPC_UNPARSEABLE',
});

/** Cycle-safe upper bound when walking `error.cause` chains. */
const MAX_CAUSE_DEPTH = 8;

/** HTTP statuses that mean "ask again later", not "your request was wrong". */
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

/** Node / undici transport codes worth another attempt. */
const TRANSIENT_SYSCALL_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * JSON-RPC codes describing a node momentarily unable to answer.
 * Deliberately narrow: -32011 (transaction history not available) and the
 * invalid-params family are permanent for this request, so retrying them
 * would only burn rate-limit budget.
 */
const TRANSIENT_JSONRPC_CODES = new Set([
  -32004, // BLOCK_NOT_AVAILABLE
  -32005, // NODE_UNHEALTHY / node is behind
  -32014, // BLOCK_STATUS_NOT_AVAILABLE_YET
  -32016, // MIN_CONTEXT_SLOT_NOT_REACHED
]);

/**
 * Lowercased message fragments. Kept phrase-shaped on purpose: a bare "429"
 * would also match a base58 address embedded in a web3.js error message.
 */
const TRANSIENT_MESSAGE_FRAGMENTS = [
  'socket hang up',
  'too many requests',
  'rate limit',
  'ratelimit',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'gateway time-out',
  'connection reset',
  'connection terminated',
  'connection closed',
  'other side closed',
  'fetch failed',
  'network error',
  'timed out',
  'timeout',
  'temporarily unavailable',
  'try again',
  'operation was aborted',
  'server error',
];

/**
 * Walk `err.cause` into a flat array (the error itself first).
 * @param {unknown} err
 * @returns {readonly unknown[]}
 */
export function causeChain(err) {
  const chain = [];
  const seen = new Set();
  let current = err;
  while (current != null && chain.length < MAX_CAUSE_DEPTH) {
    if (typeof current === 'object') {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(current);
    current = typeof current === 'object' && 'cause' in current ? current.cause : null;
  }
  return Object.freeze(chain);
}

/**
 * Best-effort HTTP status from the several shapes fetch/undici/web3.js use.
 * @param {any} err
 * @returns {number|undefined}
 */
function statusOf(err) {
  if (err == null || typeof err !== 'object') return undefined;
  for (const candidate of [err.status, err.statusCode, err.response?.status]) {
    if (Number.isInteger(candidate)) return candidate;
  }
  return undefined;
}

/**
 * web3.js formats HTTP failures as "<status> <statusText>: <body>", so a
 * leading three-digit group is a reliable status signal.
 * @param {string} message
 * @returns {number|undefined}
 */
function leadingHttpStatus(message) {
  const match = /^\s*(\d{3})\b/.exec(message);
  return match ? Number(match[1]) : undefined;
}

/**
 * True when another attempt could plausibly succeed.
 * Everything else must surface immediately: a malformed request does not get
 * better by being repeated against a rate-limited endpoint.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientRpcError(err) {
  for (const link of causeChain(err)) {
    const isObject = typeof link === 'object' && link !== null;
    const message = typeof link === 'string' ? link : String((isObject && link.message) || '');
    const lower = message.toLowerCase();

    const status = statusOf(link) ?? leadingHttpStatus(message);
    if (status !== undefined && TRANSIENT_HTTP_STATUS.has(status)) return true;

    const code = isObject ? link.code : undefined;
    if (typeof code === 'string' && TRANSIENT_SYSCALL_CODES.has(code)) return true;
    if (typeof code === 'number' && TRANSIENT_JSONRPC_CODES.has(code)) return true;

    const name = isObject ? String(link.name || '') : '';
    if (name === 'TimeoutError' || name === 'AbortError') return true;

    if (lower.length > 0 && TRANSIENT_MESSAGE_FRAGMENTS.some((f) => lower.includes(f))) {
      return true;
    }
  }
  return false;
}

/**
 * Build an Error carrying a stable `code`, the original `cause`, and any extra
 * context worth logging. Errors are intentionally not frozen (V8 fills in
 * `stack` lazily), but nothing here mutates the error it was handed.
 * @param {string} message
 * @param {{code?: string, cause?: unknown} & Record<string, unknown>} [details]
 * @returns {Error}
 */
export function rpcError(message, details = {}) {
  const { code = RPC_ERROR.TRANSPORT, cause, ...rest } = details;
  const err = cause === undefined ? new Error(message) : new Error(message, { cause });
  err.name = 'RpcError';
  err.code = code;
  return Object.assign(err, rest);
}

/**
 * Replace every http(s) URL in `text` with its redacted form.
 *
 * Lives here rather than in rpc-validate.js so that describeError can use it
 * without a circular import -- rpc-validate imports from this module.
 * @param {unknown} text
 * @returns {string}
 */
export function redactUrlsIn(text) {
  return String(text).replace(/https?:\/\/[^\s"'`<>,;)\]}]+/gi, (match) => redactRpcUrl(match));
}

/**
 * One-line description of an unknown throwable, safe to embed in a message.
 *
 * REDACTS EVERY URL IT TOUCHES, INCLUDING THOSE IN THE CAUSE CHAIN.
 *   This used to redact nothing. Our own messages were built with
 *   redactRpcUrl(), but describeError walks `err.cause`, and an upstream
 *   undici/web3.js error embeds the full request URL -- api-key and all. An
 *   audit traced a live path: src/rpc/mint.js interpolates describeError(err)
 *   into a THROWN message, which becomes a layer-0 `errored()` reason, which
 *   flows into the gate result, which scripts/record.js appends to the JSONL
 *   dataset and scripts/bot.js sends to Telegram. A provider key could therefore
 *   end up in durable storage and in an outbound message.
 *
 *   Redaction now happens HERE, so it is automatic rather than something each of
 *   eleven call sites has to remember. Only one of them was doing it.
 *
 * @param {unknown} err
 * @returns {string} safe to log, store, or send
 */
export function describeError(err) {
  return redactUrlsIn(describeErrorRaw(err)).slice(0, 500);
}

/**
 * The unredacted walk. Private: nothing outside this module should use it.
 *
 * DEPTH- AND CYCLE-BOUNDED. This recursed freely on `err.cause` until an audit
 * pointed a self-referential cause at it and blew the stack. That matters more
 * than it sounds: this function runs inside catch blocks in the safety layers,
 * so a RangeError here escapes the very handler meant to turn a failure into an
 * `errored()` verdict -- converting a handled error into an unhandled crash, in
 * exactly the code path that exists to keep the gate fail-closed.
 *
 * `causeChain` above already had both guards; they simply were not applied here.
 * @param {unknown} err
 * @param {number} depth
 * @param {Set<object>} seen
 */
function describeErrorRaw(err, depth = 0, seen = new Set()) {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (depth >= MAX_CAUSE_DEPTH) return '<cause chain too deep>';
  if (typeof err === 'object') {
    if (seen.has(err)) return '<circular cause>';
    seen.add(err);
  }
  const name = String(err.name || 'Error');
  const message = String(err.message || err);
  const head = message.length > 0 && message !== name ? name + ': ' + message : name;
  const inner =
    err.cause != null ? ' (cause: ' + describeErrorRaw(err.cause, depth + 1, seen) + ')' : '';
  return head + inner;
}

/**
 * Strip credentials from an RPC URL before it reaches a log or an error.
 * Provider keys live in the query string (Helius) or in a path segment
 * (QuickNode, Alchemy), so only the origin survives.
 * @param {string|undefined|null} url
 * @returns {string}
 */
export function redactRpcUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return '<unset>';
  try {
    const parsed = new URL(url);
    const trimmedPath = parsed.pathname.replace(/\/+$/, '');
    const secretish = parsed.search.length > 0 || trimmedPath.length > 0;
    return parsed.protocol + '//' + parsed.host + (secretish ? '/<redacted>' : '');
  } catch {
    return '<invalid-rpc-url>';
  }
}
