import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  escapeHtml,
  formatCandidates,
  formatClosed,
  formatGate,
  formatHelp,
  formatOpened,
  formatPositions,
  formatRecheckFailed,
  formatSignal,
  formatStatus,
} from '../../src/notify/format.js';

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const signals = (over = {}) => ({
  marketCapUsd: 350_000,
  liquidityUsd: 50_000,
  priceUsd: 0.00035,
  ageMinutes: 42,
  priceChangeM5Pct: 6.2,
  priceChangeH1Pct: 18.4,
  buySellRatioM5: 2.1,
  volumeAccelerationRatio: 1.9,
  ...over,
});

describe('escapeHtml', () => {
  it('escapes the characters Telegram HTML mode treats as markup', () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
  });

  it('handles null and undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('formatSignal', () => {
  it('leads with market cap, not unit price', () => {
    // unit price is the most misleading number in this market: a $40 position is
    // $40 of exposure whatever the price, and the multiple depends on the cap
    const text = formatSignal({ mint: MINT, symbol: 'TKN', signals: signals() });
    const mcapAt = text.indexOf('mcap');
    const priceAt = text.indexOf('priceUsd');

    expect(mcapAt).toBeGreaterThan(-1);
    expect(priceAt).toBe(-1);
  });

  it('always states what a gate pass does NOT mean, in the same message', () => {
    const text = formatSignal({ mint: MINT, symbol: 'TKN', signals: signals() });

    expect(text).toMatch(/does NOT/);
    expect(text).toMatch(/soft rug/i);
    expect(text).toMatch(/[Pp]aper only/);
  });

  it('ESCAPES a hostile token symbol instead of injecting markup', () => {
    // a token symbol is attacker-controlled text
    const text = formatSignal({
      mint: MINT,
      symbol: '<b>PUMP</b><a href="http://evil">',
      signals: signals(),
    });

    expect(text).not.toContain('<b>PUMP</b>');
    expect(text).toContain('&lt;b&gt;PUMP');
    expect(text).not.toContain('href="http://evil"');
  });

  it('renders unknown figures as n/a rather than 0', () => {
    const text = formatSignal({
      mint: MINT,
      symbol: 'X',
      signals: signals({ marketCapUsd: null, buySellRatioM5: null }),
    });

    expect(text).toMatch(/mcap<\/b> n\/a/);
    expect(text).toMatch(/buy\/sell<\/b> n\/a/);
  });

  it('includes the break-even figure when costs are known', () => {
    const text = formatSignal({
      mint: MINT,
      symbol: 'X',
      signals: signals(),
      costs: { breakEvenPct: 3.21, clears: true, edgePct: 4.79 },
    });

    expect(text).toMatch(/break-even.*3\.21%/);
  });
});

describe('formatClosed', () => {
  it('shows net pnl AFTER costs and names the exit reason', () => {
    const text = formatClosed({
      symbol: 'TKN',
      trade: {
        netPnlUsd: 3.4,
        netPnlPct: 8.5,
        totalCostUsd: 1.26,
        holdMs: 12 * 60_000,
        reason: 'takeProfit',
        win: true,
      },
    });

    expect(text).toMatch(/takeProfit/);
    expect(text).toMatch(/after \$1 costs|after \$1\.26|costs/);
    expect(text).toMatch(/held 12m/);
    expect(text).toMatch(/paper only/);
  });

  it('marks a loss differently from a win', () => {
    const loss = formatClosed({
      symbol: 'T',
      trade: { netPnlUsd: -2, netPnlPct: -5, totalCostUsd: 1, holdMs: 60_000, reason: 'stopLoss' },
    });

    expect(loss).toContain('🔻');
  });
});

describe('formatRecheckFailed', () => {
  it('explains that a held token can BECOME a honeypot', () => {
    const text = formatRecheckFailed({
      mint: MINT,
      symbol: 'TKN',
      reasons: ['transferHook appeared'],
    });

    expect(text).toMatch(/BECOME a honeypot/);
    expect(text).toMatch(/transferHook appeared/);
    expect(text).toMatch(/exited immediately/);
  });
});

describe('formatGate', () => {
  const gate = (over = {}) => ({
    buyable: false,
    layers: [
      { layer: 'layer0-mint', outcome: 'PASS', reasons: [] },
      { layer: 'layer1-sellsim', outcome: 'REJECT', reasons: ['HONEYPOT: no sell route exists'] },
    ],
    skipped: ['layer2-liquidity', 'layer3-holders'],
    rejectedBy: ['layer1-sellsim'],
    erroredIn: [],
    ...over,
  });

  it('keeps NOT-RUN layers visibly separate from passes', () => {
    const text = formatGate({ mint: MINT, gate: gate() });

    expect(text).toMatch(/not run.*NOT passes/is);
    expect(text).toMatch(/layer2-liquidity/);
  });

  it('shows the reject reason', () => {
    expect(formatGate({ mint: MINT, gate: gate() })).toMatch(/HONEYPOT/);
  });

  it('still states the caveat on a pass', () => {
    const text = formatGate({ mint: MINT, gate: gate({ buyable: true, skipped: [] }) });

    expect(text).toMatch(/PASSED/);
    expect(text).toMatch(/not that it is a good trade/);
  });
});

describe('formatCandidates', () => {
  it('explains an empty list rather than looking broken', () => {
    const text = formatCandidates({ candidates: [] });

    expect(text).toMatch(/98\.6%/);
    expect(text).toMatch(/filter working/);
  });

  it('distinguishes safe from would-enter', () => {
    const text = formatCandidates({
      candidates: [
        { symbol: 'A', signals: signals(), gate: { buyable: true }, entry: { enter: true } },
        { symbol: 'B', signals: signals(), gate: { buyable: true }, entry: { enter: false } },
        { symbol: 'C', signals: signals(), gate: { buyable: false }, entry: { enter: false } },
      ],
    });

    expect(text).toMatch(/ENTER/);
    expect(text).toMatch(/different questions/i);
    expect(text).toContain('⛔');
  });
});

describe('formatStatus and formatPositions', () => {
  const book = {
    positions: {},
    realisedPnlUsd: 0,
    closedCount: 0,
    wins: 0,
  };

  it('reports the funnel and says paper only', () => {
    const text = formatStatus({
      cycle: 7,
      funnel: { pools: 20, pairs: 16, screened: 4, gated: 4, safe: 1, wouldEnter: 0 },
      book,
      equityUsd: 450,
      feed: 'trending',
      profile: 'early',
      rpcLabel: 'https://x/<redacted>',
      uptimeMs: 600_000,
    });

    expect(text).toMatch(/would enter 0/);
    expect(text).toMatch(/paper only/);
    expect(text).toMatch(/no keypair/);
  });

  it('says so plainly when there are no positions', () => {
    expect(formatPositions({ book, now: 1 })).toMatch(/no open paper positions/);
  });

  it('renders an open position with its pnl', () => {
    const text = formatPositions({
      book: {
        positions: {
          [MINT]: { entryPriceUsd: 1, lastPriceUsd: 1.1, sizeUsd: 40, openedTs: 0 },
        },
      },
      now: 300_000,
    });

    expect(text).toMatch(/\+10\.0%/);
    expect(text).toMatch(/held 5m/);
  });
});

describe('COMMANDS / formatHelp', () => {
  it('is frozen and covers the documented menu', () => {
    expect(Object.isFrozen(COMMANDS)).toBe(true);
    const names = COMMANDS.map((c) => c.command);
    for (const expected of ['status', 'candidates', 'positions', 'check', 'pause', 'resume', 'help']) {
      expect(names).toContain(expected);
    }
  });

  it('states that the bot cannot trade', () => {
    expect(formatHelp()).toMatch(/cannot trade/);
    expect(formatHelp()).toMatch(/no keypair/);
  });

  it('lists every command with a description', () => {
    const help = formatHelp();
    for (const c of COMMANDS) expect(help).toContain(`/${c.command}`);
  });
});

describe('money and price formatting in alerts', () => {
  /**
   * `usd` branches on `n < 1`, which EVERY negative number satisfies -- so a
   * realised loss of -9.2 went through the six-decimal price branch and was sent
   * to Telegram as "$-9.200000", with the minus inside the currency and four
   * digits of invented precision.
   */
  it('a loss reads as -$9.20, not $-9.200000', () => {
    const out = formatClosed({
      symbol: 'X',
      trade: {
        mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        netPnlUsd: -9.2,
        netPnlPct: -23,
        totalCostUsd: 1.28,
        holdMs: 2_700_000,
        entryPriceUsd: 0.00032418,
        exitPriceUsd: 0.00030473,
        reason: 'stopLoss',
      },
    });

    expect(out).toContain('-$9.20');
    expect(out).not.toContain('$-9');
    expect(out).not.toContain('9.200000');
  });

  /**
   * Fixed decimals cannot serve a range from $12 to $0.0000004. At four decimal
   * places a token at $0.00032 and the same token 15% later both render as
   * "$0.0003", which is why the open position's in/now columns looked identical
   * while the price was moving.
   */
  it('small prices keep enough significant digits to show a move', () => {
    const at = (p) =>
      formatOpened({ mint: 'M', symbol: 'X', sizeUsd: 40, entryPriceUsd: p });

    expect(at(0.00032418)).toContain('$0.0003242');
    // The distinguishing property: two prices 15% apart must not print the same.
    const a = at(0.00032418);
    const bb = at(0.00032418 * 1.15);
    expect(a).not.toEqual(bb);
  });

  it('opens and closes both carry a tappable chart and holder link', () => {
    const mint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const opened = formatOpened({ mint, symbol: 'X', sizeUsd: 40, entryPriceUsd: 0.001 });
    const closed = formatClosed({
      symbol: 'X',
      trade: { mint, netPnlUsd: 1, netPnlPct: 2, totalCostUsd: 1, holdMs: 60_000, entryPriceUsd: 0.001, exitPriceUsd: 0.0011, reason: 'takeProfit' },
    });

    for (const msg of [opened, closed]) {
      expect(msg).toContain(`dexscreener.com/solana/${mint}`);
      expect(msg).toContain(`solscan.io/token/${mint}`);
      expect(msg).toContain('<a href=');
    }
  });
});
