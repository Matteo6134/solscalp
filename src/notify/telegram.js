/**
 * Telegram Bot API client -- the ONLY outbound write in this repo.
 *
 * WHAT THIS IS
 *   Alerts to a phone, and a small command menu so the bot can be queried from
 *   the phone. Nothing here touches a wallet, signs anything, or influences a
 *   trading decision. It is a one-way mirror onto decisions already made
 *   elsewhere, plus read-only queries.
 *
 * FAIL SOFT, DELIBERATELY INVERTED FROM THE REST OF THE REPO
 *   Every other module fails CLOSED: an error becomes a REJECT, because an
 *   unanswered safety question must never read as permission. This one fails
 *   OPEN. A Telegram outage is not a safety signal, and if a failed send could
 *   throw into a gate check, abort a paper tick, or kill a recorder, then a
 *   cosmetic dependency would have become an operational one -- the notifier
 *   would be able to stop the thing it is supposed to be watching.
 *
 *   So: `send` NEVER throws and NEVER retries. It returns a result object saying
 *   what happened. A missed alert is a missed alert; a blocked trading loop is a
 *   bug. `NOTIFY` in src/config.js says the same thing at more length.
 *
 * SECRETS
 *   The bot token is a credential that lives in a URL path. It is never logged,
 *   never included in an error message, and never echoed back in a result --
 *   `redactToken` is applied to everything that leaves this module.
 */

import { request } from 'undici';
import { NOTIFY } from '../config.js';
import { createRateLimiter } from '../data/rateLimiter.js';

const API_ROOT = 'https://api.telegram.org';
const USER_AGENT = 'solscalp/0.1 (paper trading notifier)';
/** Telegram tolerates bursts but throttles a chat at ~20 messages/minute. */
const MESSAGES_PER_MINUTE = 20;
const MS_PER_SECOND = 1_000;
/** Upper bound on foreign text echoed into a result. */
const MAX_DETAIL_CHARS = 200;

/** Outcomes a caller may branch on. Never exceptions. */
export const SEND_RESULT = Object.freeze({
  SENT: 'sent',
  /** Credentials absent: notifications are simply switched off. Not an error. */
  DISABLED: 'disabled',
  /** Suppressed by a cooldown in src/config.js NOTIFY. */
  THROTTLED: 'throttled',
  /** Telegram answered with a failure, or the network did. Logged, not thrown. */
  FAILED: 'failed',
});

/**
 * Strip a bot token from any string. Tokens look like `123456789:AA...` and
 * appear in the URL path, so a naive error message would leak the credential
 * into a log file.
 * @param {unknown} text
 * @returns {string}
 */
export function redactToken(text) {
  // NO leading \b, deliberately. A token always appears in the URL as
  // ".../bot123456789:AA...", and \b requires a boundary between a non-word and a
  // word character -- "t" and "1" are both word characters, so \b never matches
  // there and the real leak path would have gone straight through. A test pins
  // this. Over-redacting is the safe direction: a mangled log line costs nothing,
  // a leaked bearer credential costs the bot.
  return String(text ?? '').replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '<bot-token>');
}

const clip = (text) => {
  const s = redactToken(text);
  return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}...` : s;
};

/** One limiter per process, shared by every send. */
const limiter = createRateLimiter({
  requestsPerMinute: MESSAGES_PER_MINUTE,
  label: 'telegram',
});

/**
 * POST a Bot API method. The single place in this repo that writes to a network.
 * Resolves to `{ ok, result?, detail? }` and never throws.
 * @param {string} token
 * @param {string} method
 * @param {object} body
 * @param {object} [deps]
 */
async function call(token, method, body, deps = {}) {
  const httpRequest = deps.httpRequest ?? request;
  const timeoutMs = deps.timeoutMs ?? (NOTIFY.pollSeconds + 10) * MS_PER_SECOND;
  const url = `${API_ROOT}/bot${token}/${method}`;
  try {
    const res = await httpRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const text = await res.body.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, detail: `HTTP ${res.statusCode}: unparseable body ${clip(text)}` };
    }
    if (payload?.ok !== true) {
      return {
        ok: false,
        detail: `HTTP ${res.statusCode}: ${clip(payload?.description ?? text)}`,
      };
    }
    return { ok: true, result: payload.result };
  } catch (err) {
    // Fail soft: the caller gets a result, never an exception.
    return { ok: false, detail: clip(err?.message ?? err) };
  }
}

/**
 * Build a notifier bound to one chat.
 *
 * @param {object} p
 * @param {string|null} p.botToken
 * @param {string|null} p.chatId
 * @param {boolean} [p.enabled] pass loadEnv().telegram.enabled
 * @param {(msg: string) => void} [p.log] where soft failures are reported
 * @param {() => number} [p.now]
 * @param {object} [deps] `httpRequest` seam for tests
 * @returns {Readonly<object>} frozen notifier
 */
export function createNotifier({ botToken, chatId, enabled, log = () => {}, now = Date.now }, deps = {}) {
  const active = enabled === true && typeof botToken === 'string' && typeof chatId === 'string';

  /** mint (or event key) -> last sent at. Keeps one token from flooding a phone. */
  let lastPerKey = Object.freeze({});
  let lastAnyAt = 0;
  let sent = 0;
  let failed = 0;
  let throttled = 0;

  /**
   * Send a message. NEVER throws.
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.key] cooldown bucket, usually a mint
   * @param {boolean} [opts.force] bypass the cooldowns (use for /commands replies)
   * @returns {Promise<Readonly<{status: string, detail?: string}>>}
   */
  async function send(text, { key, force = false } = {}) {
    if (!active) return Object.freeze({ status: SEND_RESULT.DISABLED });

    const at = now();
    if (!force) {
      if (at - lastAnyAt < NOTIFY.minSecondsBetweenAnyAlert * MS_PER_SECOND) {
        throttled += 1;
        return Object.freeze({ status: SEND_RESULT.THROTTLED, detail: 'global cooldown' });
      }
      if (key !== undefined) {
        const last = lastPerKey[key] ?? 0;
        if (at - last < NOTIFY.minSecondsBetweenAlertsPerMint * MS_PER_SECOND) {
          throttled += 1;
          return Object.freeze({ status: SEND_RESULT.THROTTLED, detail: `cooldown for ${key}` });
        }
      }
    }

    const body = {
      chat_id: chatId,
      text: text.slice(0, NOTIFY.maxMessageChars),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    const res = await limiter.schedule(() => call(botToken, 'sendMessage', body, deps));

    if (!res.ok) {
      failed += 1;
      // Logged, never raised: see the fail-soft note in this file's header.
      log(`telegram: send failed (continuing anyway): ${res.detail}`);
      return Object.freeze({ status: SEND_RESULT.FAILED, detail: res.detail });
    }
    sent += 1;
    lastAnyAt = at;
    if (key !== undefined) lastPerKey = Object.freeze({ ...lastPerKey, [key]: at });
    return Object.freeze({ status: SEND_RESULT.SENT });
  }

  /**
   * Register the command menu, so the commands appear in Telegram's own UI
   * (the "/" button) instead of having to be remembered.
   * @param {readonly {command: string, description: string}[]} commands
   */
  async function setCommands(commands) {
    if (!active) return Object.freeze({ status: SEND_RESULT.DISABLED });
    const res = await call(botToken, 'setMyCommands', { commands }, deps);
    if (!res.ok) {
      log(`telegram: setMyCommands failed: ${res.detail}`);
      return Object.freeze({ status: SEND_RESULT.FAILED, detail: res.detail });
    }
    return Object.freeze({ status: SEND_RESULT.SENT });
  }

  /**
   * Long-poll for incoming messages. Returns `[]` on any failure, so a caller's
   * loop keeps running through an outage.
   * @param {number} offset last processed update_id + 1
   * @returns {Promise<readonly object[]>}
   */
  async function getUpdates(offset) {
    if (!active) return Object.freeze([]);
    const res = await call(
      botToken,
      'getUpdates',
      { offset, timeout: NOTIFY.pollSeconds, allowed_updates: ['message'] },
      deps,
    );
    if (!res.ok) {
      log(`telegram: getUpdates failed: ${res.detail}`);
      return Object.freeze([]);
    }
    return Object.freeze(Array.isArray(res.result) ? res.result : []);
  }

  /** Confirm the credentials work. Returns the bot's own username, or null. */
  async function whoAmI() {
    if (!active) return null;
    const res = await call(botToken, 'getMe', {}, deps);
    return res.ok ? (res.result?.username ?? null) : null;
  }

  return Object.freeze({
    enabled: active,
    send,
    setCommands,
    getUpdates,
    whoAmI,
    stats: () => Object.freeze({ enabled: active, sent, failed, throttled }),
  });
}
