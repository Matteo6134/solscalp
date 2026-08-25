/**
 * Environment loading: the ONE place this process reads configuration from
 * outside itself.
 *
 * What this module PROVES:
 *  - the endpoint it returns parsed as an `https://` URL, or as `http://` on a
 *    loopback host (a local test validator), so a plaintext endpoint cannot be
 *    configured by accident;
 *  - `mode` is one of `MODES`, and is NEVER `live` -- see the tripwire note below;
 *  - `telegram.enabled` is true only when BOTH halves of the credential are
 *    present, so a half-configured notifier can never be mistaken for a working one;
 *  - nothing it throws or logs carries a credential: every RPC URL goes through
 *    `redactRpcUrl`, and the Telegram values are never interpolated into a
 *    message at all.
 *
 * What it does NOT prove:
 *  - that the endpoint answers, is synced, or is the cluster you think it is. A
 *    well-formed URL is a shape, not a node (`src/rpc/connection.js` owns that);
 *  - that a present Telegram credential is valid, or that the chat exists;
 *  - that a `.env` file exists. Configuration may arrive entirely from the real
 *    environment (CI, a systemd unit), so a missing file is not an error here.
 *
 * WHY AN ENV VAR CAN NEVER BE THE THING THAT ENABLES LIVE TRADING
 * ---------------------------------------------------------------
 * `MODE=live` throws -- with the `SOLSCALP_ALLOW_LIVE=I_UNDERSTAND`
 * acknowledgement just as much as without it. That is not caution, it is
 * arithmetic: this repository contains no signing code whatsoever -- no
 * `Keypair`, no private key, no `sendTransaction` -- so there is no capability
 * for a variable to switch on. A flag claiming to "enable live trading" can
 * therefore only lie, and a lie in the direction of spending real money is the
 * most expensive bug this project could ship. So live mode is a TRIPWIRE, not a
 * capability: if this throw ever fires, someone has started wiring execution,
 * and the way past it is a deliberate diff that a human reviews -- deleting this
 * refusal alongside the code that earns it -- never `export MODE=live`.
 */

// Static import of the library is side-effect free: `.env` is read only when
// `config()` is called, which `loadDotenvOnce` gates. A dynamic import is not an
// option here -- `loadEnv` is synchronous by contract.
import { config as dotenvConfig } from 'dotenv';
import { MODES } from './config.js';
import { isPlainObject, stringOrNull } from './data/payload.js';
import { redactRpcUrl } from './rpc/rpc-errors.js';
import { describeValue, requireHttpUrl } from './rpc/rpc-validate.js';

/** Every environment variable this project reads, named exactly once. */
export const ENV_VARS = Object.freeze({
  rpcUrl: 'SOLANA_RPC_URL',
  rpcFallbackUrl: 'SOLANA_RPC_URL_FALLBACK',
  mode: 'MODE',
  allowLive: 'SOLSCALP_ALLOW_LIVE',
  telegramBotToken: 'TELEGRAM_BOT_TOKEN',
  telegramChatId: 'TELEGRAM_CHAT_ID',
});

/**
 * The default endpoint from `.env.example`. It lives here rather than in
 * `createRpcClient`, which refuses to guess an endpoint: a library that invents
 * a default hides a misconfiguration, whereas this module is the declared owner
 * of "what the operator meant" and warns loudly when it substitutes one.
 */
export const PUBLIC_MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';

/** The exact acknowledgement string documented in `.env.example`. */
export const LIVE_ACKNOWLEDGEMENT = 'I_UNDERSTAND';

/** Stable `err.code` values, so a caller branches on a code, not on a message. */
export const ENV_ERROR = Object.freeze({
  BAD_SOURCE: 'ENV_BAD_SOURCE',
  BAD_VALUE: 'ENV_BAD_VALUE',
  BAD_RPC_URL: 'ENV_BAD_RPC_URL',
  BAD_MODE: 'ENV_BAD_MODE',
  /** `MODE=live`, acknowledgement absent. */
  LIVE_MODE_UNACKNOWLEDGED: 'ENV_LIVE_MODE_UNACKNOWLEDGED',
  /** `MODE=live`, acknowledgement present. Still refused. */
  LIVE_MODE_UNIMPLEMENTED: 'ENV_LIVE_MODE_UNIMPLEMENTED',
});

/** Derived from config, never re-typed: `['paper', 'live']`. */
const ALLOWED_MODES = Object.freeze(Object.values(MODES));

/**
 * Hosts on which plaintext `http://` is accepted, because the traffic never
 * leaves the machine. Deliberately exact: the private ranges (10/8, 192.168/16)
 * are NOT included, since "somewhere on the LAN" is a place where a plaintext
 * RPC response can be rewritten by something other than the node.
 */
const LOOPBACK_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Set once `dotenv.config()` has been attempted in this module instance. */
let dotenvAttempted = false;

/**
 * Attach a stable code to a configuration error. Errors are deliberately not
 * frozen (V8 fills in `stack` lazily); nothing here mutates a caller's object.
 * @param {Error} err
 * @param {string} code one of {@link ENV_ERROR}
 * @returns {Error} the same error, now carrying `code`
 */
function coded(err, code) {
  err.code = code;
  return err;
}

/**
 * Default warning sink: stderr, so a warning never contaminates the stdout that
 * a script's caller is parsing.
 * @param {string} message
 */
const defaultWarn = (message) => {
  console.warn(`[solscalp:env] ${message}`);
};

/**
 * The one place `dotenv` actually runs. `quiet` suppresses its own banner so a
 * script's output stays machine-readable; `override` stays off (the default) so
 * a real environment variable always beats the file.
 * @returns {{error?: object, parsed?: object}}
 */
function defaultLoadDotenv() {
  return dotenvConfig({ quiet: true });
}

/**
 * Load `.env` into `process.env` at most once per module instance.
 *
 * A missing file is NOT reported: env vars legitimately come from the real
 * environment. Any other failure IS warned about, because a `.env` that exists
 * and could not be read means the process is running on configuration the
 * operator did not intend. The attempt is marked *before* it runs, so repeated
 * `loadEnv()` calls cannot turn one unreadable file into an I/O loop.
 *
 * @param {{loadDotenv?: () => unknown, warn?: (message: string) => void}} deps
 */
function loadDotenvOnce(deps) {
  if (dotenvAttempted) return;
  dotenvAttempted = true;
  const warn = deps.warn ?? defaultWarn;
  const load = deps.loadDotenv ?? defaultLoadDotenv;
  const result = load();
  const error = isPlainObject(result) ? /** @type {any} */ (result).error : null;
  if (error != null && error.code !== 'ENOENT') {
    warn(
      `.env exists but could not be read (${String(error.code ?? error.name ?? 'unknown')}); ` +
        'continuing with the ambient environment only.',
    );
  }
}

/**
 * Read an optional variable. Absent, blank and whitespace-only all mean the same
 * thing -- UNKNOWN, which is `null`, never `''`, which would read downstream as a
 * real (empty) credential.
 * @param {Record<string, unknown>} env
 * @param {string} varName
 * @returns {string|null} trimmed value, or null when unknown
 * @throws {TypeError} the value is present but not a string. The value itself is
 *   never echoed: some of these variables are secrets.
 */
function readOptional(env, varName) {
  const value = env[varName];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw coded(
      new TypeError(`${varName} must be a string, got ${typeof value}`),
      ENV_ERROR.BAD_VALUE,
    );
  }
  return stringOrNull(value.trim());
}

/**
 * @param {string} hostname as parsed by `URL`, so an IPv6 literal keeps its brackets
 * @returns {boolean}
 */
const isLoopback = (hostname) => LOOPBACK_HOSTNAMES.includes(hostname.toLowerCase());

/**
 * Validate a configured endpoint. The URL is never echoed raw: provider keys
 * live in the query string (Helius) or in a path segment (QuickNode, Alchemy),
 * and a URL malformed enough to be rejected here can still contain a live one.
 * @param {string} value
 * @param {string} varName the env var, so the message says what to go and fix
 * @returns {string} `value` unchanged, once known to be a usable endpoint
 * @throws {TypeError} code {@link ENV_ERROR.BAD_RPC_URL}
 */
function requireEndpoint(value, varName) {
  let url;
  try {
    url = requireHttpUrl(value, varName);
  } catch (err) {
    throw coded(/** @type {Error} */ (err), ENV_ERROR.BAD_RPC_URL);
  }
  const parsed = new URL(url); // cannot throw: requireHttpUrl already parsed it
  if (parsed.protocol === 'https:' || isLoopback(parsed.hostname)) return url;
  throw coded(
    new TypeError(
      `${varName} must be an https:// URL (http:// is accepted only for a local ` +
        `validator on ${LOOPBACK_HOSTNAMES.join(', ')}), got ${redactRpcUrl(url)}`,
    ),
    ENV_ERROR.BAD_RPC_URL,
  );
}

/**
 * @param {Record<string, unknown>} env
 * @param {(message: string) => void} warn
 * @returns {string} a validated primary endpoint
 */
function readRpcUrl(env, warn) {
  const raw = readOptional(env, ENV_VARS.rpcUrl);
  if (raw !== null) return requireEndpoint(raw, ENV_VARS.rpcUrl);
  warn(
    `${ENV_VARS.rpcUrl} is unset -- falling back to ${redactRpcUrl(PUBLIC_MAINNET_RPC_URL)}, ` +
      'which is rate-limited and flaky: it throttles under load and refuses deep signature ' +
      'history, so gate layers will error (and therefore REJECT) more often than they ' +
      'should. Configure a dedicated endpoint before reading anything into a pass rate.',
  );
  return PUBLIC_MAINNET_RPC_URL;
}

/**
 * The fallback is `null` when unset. It is deliberately NOT defaulted to the
 * public endpoint: silently sending traffic to a node the operator never
 * configured is exactly the invented default this project forbids. `null` is
 * also what `createRpcClient` treats as "no second endpoint".
 * @param {Record<string, unknown>} env
 * @returns {string|null}
 */
function readRpcFallbackUrl(env) {
  const raw = readOptional(env, ENV_VARS.rpcFallbackUrl);
  return raw === null ? null : requireEndpoint(raw, ENV_VARS.rpcFallbackUrl);
}

/**
 * Build the (always thrown) refusal for `MODE=live`. Two distinct messages,
 * because the two situations need different things from the reader: one is a
 * missing acknowledgement, the other is a missing capability.
 * @param {boolean} acknowledged whether `SOLSCALP_ALLOW_LIVE` matched exactly
 * @returns {Error} never returned to a caller -- always thrown
 */
function liveModeRefused(acknowledged) {
  const tripwire =
    'live mode is a TRIPWIRE, not a capability: this repository contains no signing code ' +
    '-- no Keypair, no private key, no sendTransaction -- so no environment variable can ' +
    'enable live trading, and one that claimed to would be lying about spending real money';
  if (!acknowledged) {
    return coded(
      new Error(
        `${ENV_VARS.mode}=${MODES.LIVE} is refused: ${ENV_VARS.allowLive} is not set to ` +
          `${LIVE_ACKNOWLEDGEMENT}. Setting it would NOT help -- ${tripwire}. Use ` +
          `${ENV_VARS.mode}=${MODES.PAPER}.`,
      ),
      ENV_ERROR.LIVE_MODE_UNACKNOWLEDGED,
    );
  }
  return coded(
    new Error(
      `${ENV_VARS.mode}=${MODES.LIVE} is refused even with ` +
        `${ENV_VARS.allowLive}=${LIVE_ACKNOWLEDGEMENT}: ${tripwire}. The acknowledgement was ` +
        'read and then deliberately ignored, because there is nothing here yet to acknowledge.',
    ),
    ENV_ERROR.LIVE_MODE_UNIMPLEMENTED,
  );
}

/**
 * @param {Record<string, unknown>} env
 * @returns {string} `MODES.PAPER` -- the only value this function can ever return
 * @throws {Error} for `live`, always; a {@link TypeError} for any unknown mode
 */
function readMode(env) {
  const raw = readOptional(env, ENV_VARS.mode);
  if (raw === null) return MODES.PAPER;
  // Case-insensitive on purpose: `MODE=LIVE` must hit the tripwire and show its
  // explanation, not bounce off an "unknown mode" message that hides the reason.
  const mode = raw.toLowerCase();
  if (mode === MODES.LIVE) {
    throw liveModeRefused(readOptional(env, ENV_VARS.allowLive) === LIVE_ACKNOWLEDGEMENT);
  }
  if (mode !== MODES.PAPER) {
    throw coded(
      new TypeError(
        `${ENV_VARS.mode} must be one of ${ALLOWED_MODES.join(' | ')}, got ${describeValue(raw)}`,
      ),
      ENV_ERROR.BAD_MODE,
    );
  }
  return mode;
}

/**
 * A half-configured notifier is DISABLED, and says so: a bot that believes it
 * can alert you and cannot is worse than one that never claimed it could.
 * @param {Record<string, unknown>} env
 * @param {(message: string) => void} warn
 * @returns {Readonly<{botToken: string|null, chatId: string|null, enabled: boolean}>}
 */
function readTelegram(env, warn) {
  const botToken = readOptional(env, ENV_VARS.telegramBotToken);
  const chatId = readOptional(env, ENV_VARS.telegramChatId);
  const enabled = botToken !== null && chatId !== null;
  if (!enabled && (botToken !== null || chatId !== null)) {
    const missing = botToken === null ? ENV_VARS.telegramBotToken : ENV_VARS.telegramChatId;
    const present = botToken === null ? ENV_VARS.telegramChatId : ENV_VARS.telegramBotToken;
    warn(
      `Telegram notifications are DISABLED: ${missing} is empty, and both it and ` +
        `${present} are required. (Neither value is ever logged.)`,
    );
  }
  return Object.freeze({ botToken, chatId, enabled });
}

/**
 * @typedef {Readonly<{
 *   rpcUrl: string,
 *   rpcFallbackUrl: string|null,
 *   mode: string,
 *   telegram: Readonly<{botToken: string|null, chatId: string|null, enabled: boolean}>,
 *   isLive: false,
 * }>} SolscalpEnv
 */

/**
 * Read, validate and freeze the environment.
 *
 * `mode` is resolved FIRST: a `MODE=live` process must be stopped by the
 * tripwire, not by whichever unrelated variable happens to be malformed too.
 *
 * @param {Record<string, unknown>} [source] the environment to read. Omit it in
 *   production (`process.env`). Supplying one explicitly ALSO suppresses
 *   `dotenv`, so a test can neither read nor write the real environment.
 * @param {{loadDotenv?: () => unknown, warn?: (message: string) => void}} [deps]
 *   test seams with real defaults: `dotenv.config({quiet:true})` and `console.warn`.
 * @returns {SolscalpEnv} frozen
 * @throws {TypeError} on a malformed endpoint, a non-string value, a non-object
 *   `source`, or an unknown `MODE`; {@link Error} on `MODE=live`, with or without
 *   the acknowledgement. No thrown message contains a secret, and no endpoint
 *   ever appears in one unredacted.
 */
export function loadEnv(source, deps = {}) {
  if (source !== undefined && !isPlainObject(source)) {
    throw coded(
      new TypeError(
        'loadEnv(source): source must be an object of environment variables, got ' +
          describeValue(source),
      ),
      ENV_ERROR.BAD_SOURCE,
    );
  }
  if (source === undefined) loadDotenvOnce(deps);
  const env = /** @type {Record<string, unknown>} */ (source ?? process.env);
  const warn = deps.warn ?? defaultWarn;

  const mode = readMode(env);
  const rpcUrl = readRpcUrl(env, warn);
  const rpcFallbackUrl = readRpcFallbackUrl(env);
  const telegram = readTelegram(env, warn);

  return Object.freeze({
    rpcUrl,
    rpcFallbackUrl,
    mode,
    telegram,
    // Structurally `false`, not computed: `readMode` throws on `live`, so there
    // is no execution path in which this could be true. Callers may assert on it
    // as a cheap, permanent invariant.
    isLive: false,
  });
}
