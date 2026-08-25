import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODES } from '../src/config.js';
import {
  ENV_ERROR,
  ENV_VARS,
  LIVE_ACKNOWLEDGEMENT,
  PUBLIC_MAINNET_RPC_URL,
  loadEnv,
} from '../src/env.js';

/**
 * A URL shaped like a real provider endpoint: the credential is in BOTH a path
 * segment (QuickNode style) and the query string (Helius style), so one assertion
 * covers both leak routes.
 */
const SECRET_PATH = 'v2-super-secret-token-abc123';
const SECRET_QUERY = 'api-key=sk-live-do-not-log';
const CREDENTIALED_URL = `https://mainnet.example.com/${SECRET_PATH}?${SECRET_QUERY}`;

/** Warnings are captured, never printed: a test suite is not a log sink. */
const captureWarn = () => {
  /** @type {string[]} */
  const messages = [];
  return { messages, warn: (m) => messages.push(m) };
};

/** dotenv must NEVER run for real in a test: the repo may hold a live .env. */
const stubDotenv = () => vi.fn(() => ({ parsed: {} }));

/** Load a pristine copy of the module, so the "at most once" guard is unspent. */
async function freshEnv() {
  vi.resetModules();
  return import('../src/env.js');
}

/** @param {Record<string, string>} patch */
function patchProcessEnv(patch) {
  /** @type {Record<string, string|undefined>} */
  const previous = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * A minimally valid ambient environment for the tests that deliberately read
 * `process.env`. `MODE` is pinned explicitly because the test runner itself sets
 * `process.env.MODE = 'test'` -- which is exactly the collision `readMode`
 * refuses, and refusing is the safe direction (an unrecognised mode never
 * becomes `live`).
 */
const AMBIENT_OK = Object.freeze({
  [ENV_VARS.rpcUrl]: PUBLIC_MAINNET_RPC_URL,
  [ENV_VARS.mode]: MODES.PAPER,
});

/** @type {Array<() => void>} */
let restorers = [];
beforeEach(() => {
  restorers = [];
});
afterEach(() => {
  for (const restore of restorers.reverse()) restore();
  vi.restoreAllMocks();
});

describe('loadEnv defaults', () => {
  it('returns the documented shape from an empty environment', () => {
    const { warn, messages } = captureWarn();
    const env = loadEnv({}, { warn });
    expect(env).toEqual({
      rpcUrl: PUBLIC_MAINNET_RPC_URL,
      rpcFallbackUrl: null,
      mode: MODES.PAPER,
      telegram: { botToken: null, chatId: null, enabled: false },
      isLive: false,
    });
    expect(messages).toHaveLength(1);
  });

  it('warns that the substituted public endpoint is rate-limited and flaky', () => {
    const { warn, messages } = captureWarn();
    loadEnv({}, { warn });
    expect(messages[0]).toContain(ENV_VARS.rpcUrl);
    expect(messages[0]).toMatch(/rate-limited/i);
    expect(messages[0]).toMatch(/flaky/i);
  });

  it('treats a blank and a whitespace-only rpc url as unset, never as an endpoint', () => {
    for (const blank of ['', '   ', '\t\n']) {
      const { warn, messages } = captureWarn();
      expect(loadEnv({ [ENV_VARS.rpcUrl]: blank }, { warn }).rpcUrl).toBe(PUBLIC_MAINNET_RPC_URL);
      expect(messages).toHaveLength(1);
    }
  });

  it('defaults mode to paper and can never report isLive', () => {
    const env = loadEnv({}, { warn: () => {} });
    expect(env.mode).toBe(MODES.PAPER);
    expect(env.isLive).toBe(false);
  });

  it('freezes the result and the nested telegram object', () => {
    const env = loadEnv({}, { warn: () => {} });
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.telegram)).toBe(true);
    expect(() => {
      // @ts-expect-error deliberate write to a frozen field
      env.mode = MODES.LIVE;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error deliberate write to a frozen field
      env.telegram.enabled = true;
    }).toThrow(TypeError);
    expect(env.mode).toBe(MODES.PAPER);
  });

  it('does not mutate or freeze the source object it was handed', () => {
    const source = { [ENV_VARS.mode]: MODES.PAPER };
    loadEnv(source, { warn: () => {} });
    expect(Object.isFrozen(source)).toBe(false);
    expect(source).toEqual({ [ENV_VARS.mode]: MODES.PAPER });
  });
});

describe('loadEnv source validation', () => {
  it.each([
    ['null', null],
    ['a string', 'MODE=paper'],
    ['an array', []],
    ['a number', 7],
  ])('refuses %s as a source', (_label, bad) => {
    // @ts-expect-error deliberately wrong type
    expect(() => loadEnv(bad, { warn: () => {} })).toThrow(TypeError);
    try {
      // @ts-expect-error deliberately wrong type
      loadEnv(bad, { warn: () => {} });
    } catch (err) {
      expect(err.code).toBe(ENV_ERROR.BAD_SOURCE);
    }
  });
});

describe('rpc url validation', () => {
  it('accepts an https endpoint and returns it byte-for-byte', () => {
    const env = loadEnv({ [ENV_VARS.rpcUrl]: CREDENTIALED_URL }, { warn: () => {} });
    expect(env.rpcUrl).toBe(CREDENTIALED_URL);
  });

  it('trims surrounding whitespace rather than rejecting it', () => {
    const env = loadEnv({ [ENV_VARS.rpcUrl]: `  ${CREDENTIALED_URL}  ` }, { warn: () => {} });
    expect(env.rpcUrl).toBe(CREDENTIALED_URL);
  });

  it.each(['http://localhost:8899', 'http://127.0.0.1:8899', 'http://[::1]:8899'])(
    'accepts plaintext %s for a local validator',
    (url) => {
      expect(loadEnv({ [ENV_VARS.rpcUrl]: url }, { warn: () => {} }).rpcUrl).toBe(url);
    },
  );

  it('rejects plaintext http on a non-loopback host', () => {
    expect(() =>
      loadEnv({ [ENV_VARS.rpcUrl]: 'http://mainnet.example.com' }, { warn: () => {} }),
    ).toThrow(TypeError);
  });

  it('rejects a LAN address: private is not loopback', () => {
    expect(() =>
      loadEnv({ [ENV_VARS.rpcUrl]: 'http://192.168.1.10:8899' }, { warn: () => {} }),
    ).toThrow(/https:\/\//);
  });

  it.each([
    ['unparseable text', 'not-a-url-at-all'],
    ['a bare host', 'mainnet.example.com'],
    ['a non-http scheme', 'ws://mainnet.example.com'],
    ['a file url', 'file:///etc/passwd'],
  ])('rejects %s', (_label, url) => {
    expect(() => loadEnv({ [ENV_VARS.rpcUrl]: url }, { warn: () => {} })).toThrow(TypeError);
  });

  it('names the env var and the error code, but never leaks the credential', () => {
    const bogus = `ftp://mainnet.example.com/${SECRET_PATH}?${SECRET_QUERY}`;
    try {
      loadEnv({ [ENV_VARS.rpcUrl]: bogus }, { warn: () => {} });
      expect.unreachable('a bogus rpc url must throw');
    } catch (err) {
      expect(err.code).toBe(ENV_ERROR.BAD_RPC_URL);
      expect(err.message).toContain(ENV_VARS.rpcUrl);
      expect(err.message).not.toContain(SECRET_PATH);
      expect(err.message).not.toContain(SECRET_QUERY);
      expect(err.message).not.toContain(bogus);
      expect(err.message).toContain('<redacted>');
    }
  });

  it('does not leak the credential when the url is rejected for plaintext http', () => {
    const plaintext = `http://mainnet.example.com/${SECRET_PATH}?${SECRET_QUERY}`;
    try {
      loadEnv({ [ENV_VARS.rpcUrl]: plaintext }, { warn: () => {} });
      expect.unreachable('plaintext http off-loopback must throw');
    } catch (err) {
      expect(err.message).not.toContain(SECRET_PATH);
      expect(err.message).not.toContain(SECRET_QUERY);
      expect(err.message).toContain(ENV_VARS.rpcUrl);
    }
  });

  it('rejects a non-string rpc url without echoing the value', () => {
    try {
      loadEnv({ [ENV_VARS.rpcUrl]: { href: CREDENTIALED_URL } }, { warn: () => {} });
      expect.unreachable('a non-string endpoint must throw');
    } catch (err) {
      expect(err.code).toBe(ENV_ERROR.BAD_VALUE);
      expect(err.message).toContain(ENV_VARS.rpcUrl);
      expect(err.message).toContain('object');
      expect(err.message).not.toContain(SECRET_PATH);
    }
  });
});

describe('rpc fallback url', () => {
  it('is null when unset -- never a silently invented second endpoint', () => {
    const env = loadEnv({ [ENV_VARS.rpcUrl]: CREDENTIALED_URL }, { warn: () => {} });
    expect(env.rpcFallbackUrl).toBeNull();
  });

  it('is null when blank', () => {
    const env = loadEnv(
      { [ENV_VARS.rpcUrl]: CREDENTIALED_URL, [ENV_VARS.rpcFallbackUrl]: '  ' },
      { warn: () => {} },
    );
    expect(env.rpcFallbackUrl).toBeNull();
  });

  it('is returned when valid', () => {
    const env = loadEnv(
      {
        [ENV_VARS.rpcUrl]: CREDENTIALED_URL,
        [ENV_VARS.rpcFallbackUrl]: PUBLIC_MAINNET_RPC_URL,
      },
      { warn: () => {} },
    );
    expect(env.rpcFallbackUrl).toBe(PUBLIC_MAINNET_RPC_URL);
  });

  it('is validated exactly as strictly as the primary, and names its own var', () => {
    try {
      loadEnv(
        {
          [ENV_VARS.rpcUrl]: CREDENTIALED_URL,
          [ENV_VARS.rpcFallbackUrl]: `http://mainnet.example.com/${SECRET_PATH}`,
        },
        { warn: () => {} },
      );
      expect.unreachable('a bogus fallback must throw');
    } catch (err) {
      expect(err.code).toBe(ENV_ERROR.BAD_RPC_URL);
      expect(err.message).toContain(ENV_VARS.rpcFallbackUrl);
      expect(err.message).not.toContain(SECRET_PATH);
    }
  });
});

describe('mode is a tripwire, not a switch', () => {
  const live = (extra = {}) => ({ [ENV_VARS.mode]: MODES.LIVE, ...extra });

  it('throws for MODE=live without the acknowledgement', () => {
    try {
      loadEnv(live(), { warn: () => {} });
      expect.unreachable('MODE=live must throw');
    } catch (err) {
      expect(err.code).toBe(ENV_ERROR.LIVE_MODE_UNACKNOWLEDGED);
      expect(err.message).toContain(ENV_VARS.allowLive);
      expect(err.message).toContain(LIVE_ACKNOWLEDGEMENT);
      expect(err.message).toMatch(/TRIPWIRE, not a capability/);
      expect(err.message).toMatch(/no signing code/);
    }
  });

  it('ALSO throws for MODE=live WITH the acknowledgement', () => {
    try {
      loadEnv(live({ [ENV_VARS.allowLive]: LIVE_ACKNOWLEDGEMENT }), { warn: () => {} });
      expect.unreachable('the acknowledgement must not enable live mode');
    } catch (err) {
      expect(err.code).toBe(ENV_ERROR.LIVE_MODE_UNIMPLEMENTED);
      expect(err.message).toMatch(/TRIPWIRE, not a capability/);
      expect(err.message).toMatch(/no signing code/);
      expect(err.message).toMatch(/sendTransaction/);
    }
  });

  it('gives the two refusals distinct messages and distinct codes', () => {
    const grab = (source) => {
      try {
        loadEnv(source, { warn: () => {} });
        return null;
      } catch (err) {
        return err;
      }
    };
    const without = grab(live());
    const with_ = grab(live({ [ENV_VARS.allowLive]: LIVE_ACKNOWLEDGEMENT }));
    expect(without).not.toBeNull();
    expect(with_).not.toBeNull();
    expect(without.message).not.toBe(with_.message);
    expect(without.code).not.toBe(with_.code);
    expect(ENV_ERROR.LIVE_MODE_UNACKNOWLEDGED).not.toBe(ENV_ERROR.LIVE_MODE_UNIMPLEMENTED);
  });

  it.each(['I_understand', 'i_understand', 'yes', 'true', '', '   '])(
    'treats %o as NOT the acknowledgement (exact match only)',
    (value) => {
      try {
        loadEnv(live({ [ENV_VARS.allowLive]: value }), { warn: () => {} });
        expect.unreachable('MODE=live must throw regardless');
      } catch (err) {
        expect(err.code).toBe(ENV_ERROR.LIVE_MODE_UNACKNOWLEDGED);
      }
    },
  );

  it('hits the tripwire for MODE=LIVE and MODE= live (case and padding)', () => {
    for (const value of ['LIVE', ' Live ', 'live ']) {
      try {
        loadEnv({ [ENV_VARS.mode]: value }, { warn: () => {} });
        expect.unreachable(`${value} must throw`);
      } catch (err) {
        expect(err.code).toBe(ENV_ERROR.LIVE_MODE_UNACKNOWLEDGED);
      }
    }
  });

  it('resolves mode BEFORE the rpc url, so live is refused even on broken config', () => {
    try {
      loadEnv(
        { [ENV_VARS.mode]: MODES.LIVE, [ENV_VARS.rpcUrl]: 'not-a-url' },
        { warn: () => {} },
      );
      expect.unreachable('MODE=live must throw');
    } catch (err) {
      expect(err.code).toBe(ENV_ERROR.LIVE_MODE_UNACKNOWLEDGED);
    }
  });

  it.each(['nonsense', 'PAPERR', 'dry-run', 'paper trading', '0'])(
    'rejects the unknown mode %o and lists the allowed values',
    (value) => {
      try {
        loadEnv({ [ENV_VARS.mode]: value }, { warn: () => {} });
        expect.unreachable('an unknown mode must throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TypeError);
        expect(err.code).toBe(ENV_ERROR.BAD_MODE);
        expect(err.message).toContain(ENV_VARS.mode);
        expect(err.message).toContain(MODES.PAPER);
        expect(err.message).toContain(MODES.LIVE);
      }
    },
  );

  it.each(['paper', 'PAPER', ' Paper '])('accepts %o as paper', (value) => {
    expect(loadEnv({ [ENV_VARS.mode]: value }, { warn: () => {} }).mode).toBe(MODES.PAPER);
  });

  it('rejects a non-string MODE', () => {
    try {
      loadEnv({ [ENV_VARS.mode]: 1 }, { warn: () => {} });
      expect.unreachable('a non-string MODE must throw');
    } catch (err) {
      expect(err.code).toBe(ENV_ERROR.BAD_VALUE);
      expect(err.message).toContain(ENV_VARS.mode);
    }
  });
});

describe('telegram', () => {
  const BOT_TOKEN = '1234567890:AA-secret-bot-token';
  const CHAT_ID = '-1001234567890';

  it('is enabled only when both halves are present', () => {
    const env = loadEnv(
      { [ENV_VARS.telegramBotToken]: BOT_TOKEN, [ENV_VARS.telegramChatId]: CHAT_ID },
      { warn: () => {} },
    );
    expect(env.telegram).toEqual({ botToken: BOT_TOKEN, chatId: CHAT_ID, enabled: true });
  });

  it('trims both values', () => {
    const env = loadEnv(
      {
        [ENV_VARS.telegramBotToken]: `  ${BOT_TOKEN}\n`,
        [ENV_VARS.telegramChatId]: ` ${CHAT_ID} `,
      },
      { warn: () => {} },
    );
    expect(env.telegram.botToken).toBe(BOT_TOKEN);
    expect(env.telegram.chatId).toBe(CHAT_ID);
  });

  it('is disabled, and says so, when only the bot token is set', () => {
    const { warn, messages } = captureWarn();
    const env = loadEnv({ [ENV_VARS.telegramBotToken]: BOT_TOKEN }, { warn });
    expect(env.telegram.enabled).toBe(false);
    expect(env.telegram.chatId).toBeNull();
    const message = messages.join('\n');
    expect(message).toContain(ENV_VARS.telegramChatId);
    expect(message).toMatch(/DISABLED/);
  });

  it('is disabled, and says so, when only the chat id is set', () => {
    const { warn, messages } = captureWarn();
    const env = loadEnv({ [ENV_VARS.telegramChatId]: CHAT_ID }, { warn });
    expect(env.telegram.enabled).toBe(false);
    expect(env.telegram.botToken).toBeNull();
    expect(messages.join('\n')).toContain(ENV_VARS.telegramBotToken);
  });

  it('never puts the bot token or chat id in a warning', () => {
    const { warn, messages } = captureWarn();
    loadEnv({ [ENV_VARS.telegramBotToken]: BOT_TOKEN }, { warn });
    loadEnv({ [ENV_VARS.telegramChatId]: CHAT_ID }, { warn });
    const message = messages.join('\n');
    expect(message).not.toContain(BOT_TOKEN);
    expect(message).not.toContain(CHAT_ID);
  });

  it('treats a blank half as unknown: both null, disabled, and no half-config warning', () => {
    const { warn, messages } = captureWarn();
    const env = loadEnv(
      {
        [ENV_VARS.rpcUrl]: CREDENTIALED_URL,
        [ENV_VARS.telegramBotToken]: '   ',
        [ENV_VARS.telegramChatId]: '',
      },
      { warn },
    );
    expect(env.telegram).toEqual({ botToken: null, chatId: null, enabled: false });
    expect(messages).toHaveLength(0);
  });

  it('rejects a non-string bot token without echoing it', () => {
    try {
      loadEnv({ [ENV_VARS.telegramBotToken]: { token: BOT_TOKEN } }, { warn: () => {} });
      expect.unreachable('a non-string token must throw');
    } catch (err) {
      expect(err.code).toBe(ENV_ERROR.BAD_VALUE);
      expect(err.message).toContain(ENV_VARS.telegramBotToken);
      expect(err.message).not.toContain(BOT_TOKEN);
    }
  });

  it('keeps every secret out of an unrelated failure message', () => {
    try {
      loadEnv(
        {
          [ENV_VARS.mode]: 'nonsense',
          [ENV_VARS.rpcUrl]: CREDENTIALED_URL,
          [ENV_VARS.telegramBotToken]: BOT_TOKEN,
          [ENV_VARS.telegramChatId]: CHAT_ID,
        },
        { warn: () => {} },
      );
      expect.unreachable('an unknown mode must throw');
    } catch (err) {
      expect(err.message).not.toContain(BOT_TOKEN);
      expect(err.message).not.toContain(SECRET_PATH);
      expect(err.message).not.toContain(SECRET_QUERY);
    }
  });
});

describe('dotenv and process.env are only touched when no source is supplied', () => {
  it('never calls dotenv when a source is supplied', async () => {
    const { loadEnv: fresh } = await freshEnv();
    const loadDotenv = stubDotenv();
    fresh({}, { loadDotenv, warn: () => {} });
    fresh({ [ENV_VARS.rpcUrl]: PUBLIC_MAINNET_RPC_URL }, { loadDotenv, warn: () => {} });
    expect(loadDotenv).not.toHaveBeenCalled();
  });

  it('never reads process.env when a source is supplied', () => {
    // A live-mode tripwire and a bogus endpoint in the ambient environment: if
    // loadEnv read process.env at all, this call could not return.
    restorers.push(
      patchProcessEnv({
        [ENV_VARS.mode]: MODES.LIVE,
        [ENV_VARS.allowLive]: LIVE_ACKNOWLEDGEMENT,
        [ENV_VARS.rpcUrl]: 'not-a-url',
        [ENV_VARS.telegramBotToken]: 'ambient-token',
        [ENV_VARS.telegramChatId]: 'ambient-chat',
      }),
    );
    const env = loadEnv({ [ENV_VARS.mode]: MODES.PAPER }, { warn: () => {} });
    expect(env.mode).toBe(MODES.PAPER);
    expect(env.rpcUrl).toBe(PUBLIC_MAINNET_RPC_URL);
    expect(env.telegram).toEqual({ botToken: null, chatId: null, enabled: false });
  });

  it('never writes to process.env when a source is supplied', () => {
    const before = JSON.stringify({ ...process.env });
    loadEnv({ [ENV_VARS.rpcUrl]: CREDENTIALED_URL, MADE_UP_KEY: 'x' }, { warn: () => {} });
    expect(JSON.stringify({ ...process.env })).toBe(before);
    expect(process.env.MADE_UP_KEY).toBeUndefined();
  });

  it('reads process.env when no source is supplied', async () => {
    const { loadEnv: fresh } = await freshEnv();
    restorers.push(
      patchProcessEnv({
        [ENV_VARS.rpcUrl]: 'https://ambient.example.com',
        [ENV_VARS.mode]: MODES.PAPER,
      }),
    );
    const env = fresh(undefined, { loadDotenv: stubDotenv(), warn: () => {} });
    expect(env.rpcUrl).toBe('https://ambient.example.com');
  });

  it('loads dotenv at most once across many loadEnv() calls', async () => {
    const { loadEnv: fresh } = await freshEnv();
    const loadDotenv = stubDotenv();
    restorers.push(patchProcessEnv(AMBIENT_OK));
    fresh(undefined, { loadDotenv, warn: () => {} });
    fresh(undefined, { loadDotenv, warn: () => {} });
    fresh(undefined, { loadDotenv, warn: () => {} });
    expect(loadDotenv).toHaveBeenCalledTimes(1);
  });

  it('does not retry dotenv after it failed, and is silent about a missing .env', async () => {
    const { loadEnv: fresh } = await freshEnv();
    const loadDotenv = vi.fn(() => ({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }));
    const { warn, messages } = captureWarn();
    restorers.push(patchProcessEnv(AMBIENT_OK));
    fresh(undefined, { loadDotenv, warn });
    fresh(undefined, { loadDotenv, warn });
    expect(loadDotenv).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(0);
  });

  it('warns when a .env exists but could not be read', async () => {
    const { loadEnv: fresh } = await freshEnv();
    const loadDotenv = vi.fn(() => ({ error: Object.assign(new Error('denied'), { code: 'EACCES' }) }));
    const { warn, messages } = captureWarn();
    restorers.push(patchProcessEnv(AMBIENT_OK));
    fresh(undefined, { loadDotenv, warn });
    expect(messages.join('\n')).toContain('EACCES');
  });

  it('survives a dotenv shim that returns nothing at all', async () => {
    const { loadEnv: fresh } = await freshEnv();
    const { warn, messages } = captureWarn();
    restorers.push(patchProcessEnv(AMBIENT_OK));
    expect(fresh(undefined, { loadDotenv: vi.fn(() => undefined), warn }).mode).toBe(MODES.PAPER);
    expect(messages).toHaveLength(0);
  });

  it('falls back to console.warn when no warn seam is injected', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadEnv({});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain(ENV_VARS.rpcUrl);
  });
});
