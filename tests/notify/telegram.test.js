import { describe, expect, it, vi } from 'vitest';
import { NOTIFY } from '../../src/config.js';
import { SEND_RESULT, createNotifier, redactToken } from '../../src/notify/telegram.js';

const TOKEN = '123456789:AAFakeTokenValueForTestsOnly_xyz';
const CHAT = '-1001234567890';
const MS_PER_SECOND = 1_000;

/** A fake undici request that returns a Telegram-shaped body. */
const ok = (result = {}) =>
  vi.fn(async () => ({
    statusCode: 200,
    body: { text: async () => JSON.stringify({ ok: true, result }) },
  }));

const apiError = (description) =>
  vi.fn(async () => ({
    statusCode: 400,
    body: { text: async () => JSON.stringify({ ok: false, description }) },
  }));

const network = (message) =>
  vi.fn(async () => {
    throw new Error(message);
  });

/** A controllable clock, so cooldowns are testable without waiting. */
const clockAt = (start) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

const build = (over = {}, deps = {}) => {
  const clock = over.clock ?? clockAt(1_000_000);
  const logs = [];
  const notifier = createNotifier(
    {
      botToken: TOKEN,
      chatId: CHAT,
      enabled: true,
      log: (m) => logs.push(m),
      now: clock.now,
      ...over,
    },
    deps,
  );
  return { notifier, logs, clock };
};

describe('redactToken', () => {
  it('removes a bot token from any string', () => {
    const leaky = `failed GET https://api.telegram.org/bot${TOKEN}/sendMessage`;

    expect(redactToken(leaky)).not.toContain(TOKEN);
    expect(redactToken(leaky)).toContain('<bot-token>');
  });

  it('leaves ordinary text alone', () => {
    expect(redactToken('HTTP 429: Too Many Requests')).toBe('HTTP 429: Too Many Requests');
  });

  it('handles null and undefined', () => {
    expect(redactToken(null)).toBe('');
    expect(redactToken(undefined)).toBe('');
  });
});

describe('createNotifier -- disabled is not an error', () => {
  it('is inert when credentials are missing', async () => {
    const httpRequest = ok();
    const { notifier } = build({ botToken: null, enabled: false }, { httpRequest });

    expect(notifier.enabled).toBe(false);
    expect((await notifier.send('hi')).status).toBe(SEND_RESULT.DISABLED);
    expect(await notifier.whoAmI()).toBeNull();
    expect(await notifier.getUpdates(0)).toEqual([]);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('is inert when enabled is true but a half of the credential is absent', async () => {
    const { notifier } = build({ chatId: null }, { httpRequest: ok() });

    expect(notifier.enabled).toBe(false);
  });
});

describe('createNotifier -- FAIL SOFT (inverted from the rest of the repo)', () => {
  it('never throws when the network fails, and reports it instead', async () => {
    const { notifier, logs } = build({}, { httpRequest: network('ECONNRESET') });

    let res;
    await expect(
      (async () => {
        res = await notifier.send('hello');
      })(),
    ).resolves.not.toThrow();
    expect(res.status).toBe(SEND_RESULT.FAILED);
    expect(logs.join(' ')).toMatch(/send failed \(continuing anyway\)/);
  });

  it('never throws when Telegram returns ok:false', async () => {
    const { notifier } = build({}, { httpRequest: apiError('chat not found') });
    const res = await notifier.send('hello');

    expect(res.status).toBe(SEND_RESULT.FAILED);
    expect(res.detail).toMatch(/chat not found/);
  });

  it('never throws on an unparseable body', async () => {
    const httpRequest = vi.fn(async () => ({
      statusCode: 502,
      body: { text: async () => '<html>bad gateway</html>' },
    }));
    const { notifier } = build({}, { httpRequest });

    expect((await notifier.send('x')).status).toBe(SEND_RESULT.FAILED);
  });

  it('NEVER leaks the bot token into a failure detail or a log line', async () => {
    // the token lives in the URL path, so a naive error message would carry it
    const { notifier, logs } = build(
      {},
      { httpRequest: network(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`) },
    );
    const res = await notifier.send('x');

    expect(res.detail).not.toContain(TOKEN);
    expect(logs.join(' ')).not.toContain(TOKEN);
    expect(res.detail).toContain('<bot-token>');
  });

  it('returns [] from getUpdates on failure so a poll loop keeps running', async () => {
    const { notifier } = build({}, { httpRequest: network('timeout') });

    expect(await notifier.getUpdates(0)).toEqual([]);
  });
});

describe('createNotifier -- cooldowns', () => {
  it('sends the first message for a key', async () => {
    const { notifier } = build({}, { httpRequest: ok() });

    expect((await notifier.send('a', { key: 'mintA' })).status).toBe(SEND_RESULT.SENT);
  });

  it('suppresses a repeat for the same key inside the per-mint cooldown', async () => {
    const clock = clockAt(1_000_000);
    const { notifier } = build({ clock, now: clock.now }, { httpRequest: ok() });

    await notifier.send('a', { key: 'mintA' });
    clock.advance(NOTIFY.minSecondsBetweenAnyAlert * MS_PER_SECOND + 1);
    const second = await notifier.send('a again', { key: 'mintA' });

    expect(second.status).toBe(SEND_RESULT.THROTTLED);
    expect(second.detail).toMatch(/cooldown for mintA/);
  });

  it('allows the same key again once the per-mint cooldown has passed', async () => {
    const clock = clockAt(1_000_000);
    const { notifier } = build({ now: clock.now }, { httpRequest: ok() });

    await notifier.send('a', { key: 'mintA' });
    clock.advance(NOTIFY.minSecondsBetweenAlertsPerMint * MS_PER_SECOND + 1);

    expect((await notifier.send('a', { key: 'mintA' })).status).toBe(SEND_RESULT.SENT);
  });

  it('applies a global floor between any two alerts', async () => {
    const clock = clockAt(1_000_000);
    const { notifier } = build({ now: clock.now }, { httpRequest: ok() });

    await notifier.send('a', { key: 'mintA' });
    const immediate = await notifier.send('b', { key: 'mintB' });

    expect(immediate.status).toBe(SEND_RESULT.THROTTLED);
    expect(immediate.detail).toMatch(/global cooldown/);
  });

  it('force bypasses every cooldown, for command replies', async () => {
    const clock = clockAt(1_000_000);
    const { notifier } = build({ now: clock.now }, { httpRequest: ok() });

    await notifier.send('a', { key: 'mintA' });

    expect((await notifier.send('reply', { force: true })).status).toBe(SEND_RESULT.SENT);
    expect((await notifier.send('reply', { force: true })).status).toBe(SEND_RESULT.SENT);
  });

  it('does NOT advance the cooldown clock on a failed send', async () => {
    // otherwise one outage would silence the next alert for the whole cooldown
    const clock = clockAt(1_000_000);
    const httpRequest = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('down');
      })
      .mockImplementation(async () => ({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ ok: true, result: {} }) },
      }));
    const { notifier } = build({ now: clock.now }, { httpRequest });

    expect((await notifier.send('a', { key: 'k' })).status).toBe(SEND_RESULT.FAILED);
    expect((await notifier.send('a', { key: 'k' })).status).toBe(SEND_RESULT.SENT);
  });
});

describe('createNotifier -- payload and stats', () => {
  it('posts to sendMessage with the configured chat and HTML mode', async () => {
    const httpRequest = ok();
    const { notifier } = build({}, { httpRequest });
    await notifier.send('<b>hi</b>');

    const [url, options] = httpRequest.mock.calls[0];
    expect(url).toContain('/sendMessage');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.chat_id).toBe(CHAT);
    expect(body.parse_mode).toBe('HTML');
    expect(body.disable_web_page_preview).toBe(true);
  });

  it('clips a message to the configured maximum', async () => {
    const httpRequest = ok();
    const { notifier } = build({}, { httpRequest });
    await notifier.send('x'.repeat(NOTIFY.maxMessageChars + 500));

    const body = JSON.parse(httpRequest.mock.calls[0][1].body);
    expect(body.text.length).toBe(NOTIFY.maxMessageChars);
  });

  it('counts sent, failed and throttled', async () => {
    const clock = clockAt(1_000_000);
    const { notifier } = build({ now: clock.now }, { httpRequest: ok() });

    await notifier.send('a', { key: 'k1' });
    await notifier.send('b', { key: 'k2' });
    const stats = notifier.stats();

    expect(stats.sent).toBe(1);
    expect(stats.throttled).toBe(1);
    expect(Object.isFrozen(stats)).toBe(true);
  });

  it('reports the bot username from getMe', async () => {
    const { notifier } = build({}, { httpRequest: ok({ username: 'solscalp_bot' }) });

    expect(await notifier.whoAmI()).toBe('solscalp_bot');
  });

  it('registers the command menu', async () => {
    const httpRequest = ok(true);
    const { notifier } = build({}, { httpRequest });
    await notifier.setCommands([{ command: 'status', description: 'x' }]);

    expect(httpRequest.mock.calls[0][0]).toContain('/setMyCommands');
  });
});

describe('createNotifier -- another process owns the token', () => {
  /**
   * Telegram permits exactly ONE getUpdates consumer per bot token. Reusing a
   * token that another running bot already polls makes the two endlessly
   * terminate each other -- and, worse, breaks the OTHER bot. Retrying cannot
   * fix it, so the notifier flags it once and the caller falls back to
   * send-only. Outbound alerts are unaffected.
   */
  const conflict = () =>
    vi.fn(async () => ({
      statusCode: 409,
      body: {
        text: async () =>
          JSON.stringify({
            ok: false,
            description:
              'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
          }),
      },
    }));

  it('flags a 409 as commands-unavailable rather than a transient failure', async () => {
    const { notifier } = build({}, { httpRequest: conflict() });

    expect(notifier.commandsUnavailable()).toBe(false);
    await notifier.getUpdates(0);
    expect(notifier.commandsUnavailable()).toBe(true);
    expect(notifier.stats().updatesConflicted).toBe(true);
  });

  it('logs the explanation only ONCE, not on every poll', async () => {
    const { notifier, logs } = build({}, { httpRequest: conflict() });

    await notifier.getUpdates(0);
    await notifier.getUpdates(0);
    await notifier.getUpdates(0);

    const explained = logs.filter((l) => /already polling this bot token/.test(l));
    expect(explained).toHaveLength(1);
    expect(explained[0]).toMatch(/alerts still work/);
  });

  it('still returns an empty list so a caller loop never breaks', async () => {
    const { notifier } = build({}, { httpRequest: conflict() });

    expect(await notifier.getUpdates(0)).toEqual([]);
  });

  it('a 409 does NOT disable sending -- alerts do not conflict', async () => {
    const httpRequest = vi
      .fn()
      .mockImplementationOnce(async () => ({
        statusCode: 409,
        body: { text: async () => JSON.stringify({ ok: false, description: 'Conflict' }) },
      }))
      .mockImplementation(async () => ({
        statusCode: 200,
        body: { text: async () => JSON.stringify({ ok: true, result: {} }) },
      }));
    const { notifier } = build({}, { httpRequest });

    await notifier.getUpdates(0);
    expect(notifier.commandsUnavailable()).toBe(true);
    expect((await notifier.send('alert still works', { force: true })).status).toBe(SEND_RESULT.SENT);
  });
});
