/**
 * Message bodies for the Telegram notifier. PURE -- no network, no clock.
 *
 * These are the sentences that will be read on a phone, at a glance, possibly at
 * 3am. Two rules follow from that:
 *
 *   1. NEVER imply more than was proven. An alert saying a token is "SAFE" would
 *      be read as "buy this". Every alert that mentions the gate also says what
 *      the gate does not cover, in the same message, because nobody scrolls back
 *      to the README on their phone.
 *   2. The number that matters goes first. Market cap, not unit price -- unit
 *      price is the single most misleading figure in this market, since a $40
 *      position is $40 of exposure whatever the price per token, and the multiple
 *      depends entirely on the cap.
 *
 * Telegram HTML mode: only <b>, <i>, <code>, <a> are used, and any interpolated
 * external string (a token symbol!) is escaped, because a symbol containing "<"
 * would otherwise break the message or inject markup.
 */

import { STRATEGY } from '../config.js';

const PCT_DIGITS = 1;

/** Escape the four characters Telegram HTML mode treats as markup. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const usd = (n) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? 'n/a'
    : n < 1
      ? `$${n.toFixed(6)}`
      : `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * A token price, at enough precision to see it move.
 *
 * Fixed decimal places cannot do this job. These tokens trade from $12 down to
 * $0.0000004, and any single number of decimals either drowns the big ones in
 * zeroes or rounds the small ones to nothing -- a memecoin at $0.00032 rendered
 * as "$0.0003", which is the same string it shows after a 15% move. Four
 * SIGNIFICANT digits scales with the number instead.
 */
const price = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  if (n === 0) return '$0';
  const a = Math.abs(n);
  if (a >= 1) return `$${n.toFixed(2)}`;
  const digits = Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(a))));
  return `$${n.toFixed(digits)}`;
};

/**
 * A signed dollar amount.
 *
 * `usd` above branches on `n < 1`, which every negative number satisfies -- so a
 * realised loss of -9.2 was formatted through the six-decimal price branch and
 * sent to Telegram as "$-9.200000". Money that can be negative needs its own
 * formatter, with the sign outside the currency.
 */
const money = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  const body = a < 1_000 ? a.toFixed(2) : Math.round(a).toLocaleString('en-US');
  return `${n < 0 ? '-' : ''}$${body}`;
};

const pct = (n) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? 'n/a'
    : `${n >= 0 ? '+' : ''}${n.toFixed(PCT_DIGITS)}%`;

const num = (n, digits = 1) =>
  n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : n.toFixed(digits);

/** Dexscreener link, so the alert is one tap from a chart. */
const chartLink = (mint) => `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;

/**
 * Both links as tappable markup: the chart, and the holder list.
 *
 * A bare mint address in a message is not something you can act on from a phone.
 * Copying 44 characters out of a chat is the friction that stops anyone
 * checking, which defeats the point of the alert. The signal alert already
 * linked the chart; the OPEN and CLOSE messages did not, so a position you were
 * told about could not be followed by hand.
 */
const links = (mint) =>
  typeof mint === 'string' && mint !== ''
    ? `<a href="${chartLink(mint)}">chart</a> · ` +
      `<a href="https://solscan.io/token/${encodeURIComponent(mint)}">holders</a>`
    : '';

/**
 * The only alert that means "look now": gate passed AND the entry rules fired.
 * @param {object} p
 * @param {string} p.mint
 * @param {string|null} p.symbol
 * @param {object} p.signals readSignals() output
 * @param {object} [p.costs] clearsCosts() output from decideEntry
 */
export function formatSignal({ mint, symbol, signals, costs }) {
  return [
    `🎯 <b>SIGNAL</b> ${escapeHtml(symbol ?? '?')}`,
    '',
    `<b>mcap</b> ${usd(signals.marketCapUsd)}   <b>liq</b> ${usd(signals.liquidityUsd)}`,
    `<b>5m</b> ${pct(signals.priceChangeM5Pct)}   <b>1h</b> ${pct(signals.priceChangeH1Pct)}`,
    `<b>buy/sell</b> ${num(signals.buySellRatioM5, 2)}   <b>accel</b> ${num(signals.volumeAccelerationRatio, 2)}`,
    `<b>age</b> ${signals.ageMinutes === null ? 'n/a' : `${Math.round(signals.ageMinutes)}m`}`,
    costs?.breakEvenPct === undefined
      ? ''
      : `<b>break-even</b> needs ${num(costs.breakEvenPct, 2)}% ` +
        `(betting on ${STRATEGY.entry.expectedGrossMovePct}%)`,
    '',
    `<code>${escapeHtml(mint)}</code>`,
    links(mint),
    '',
    '<i>Gate passed = the creator probably cannot steal your tokens. It does NOT',
    'mean profitable, and a soft rug — a dev quietly selling into buyers —',
    'passes every check. Paper only; nothing was bought.</i>',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** A paper position was opened. */
export function formatOpened({ mint, symbol, sizeUsd, entryPriceUsd, signals }) {
  return [
    `📈 <b>PAPER OPEN</b> ${escapeHtml(symbol ?? '?')}`,
    `size ${money(sizeUsd)} @ ${price(entryPriceUsd)}`,
    signals ? `mcap ${usd(signals.marketCapUsd)}   liq ${usd(signals.liquidityUsd)}` : '',
    `<code>${escapeHtml(mint)}</code>`,
    links(mint),
    '<i>paper only — no order was placed</i>',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** A paper position was closed. `trade` is a portfolio closedTrades entry. */
export function formatClosed({ symbol, trade }) {
  const win = trade.netPnlUsd > 0;
  return [
    `${win ? '✅' : '🔻'} <b>PAPER CLOSE</b> ${escapeHtml(symbol ?? '?')} — ${escapeHtml(trade.reason)}`,
    `net <b>${money(trade.netPnlUsd)}</b> (${pct(trade.netPnlPct)}) after ${money(trade.totalCostUsd)} costs`,
    `${price(trade.entryPriceUsd)} → ${price(trade.exitPriceUsd)} · held ${Math.round(trade.holdMs / 60_000)}m`,
    links(trade.mint),
    '<i>paper only</i>',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** A held token started failing its recheck. This is the urgent one. */
export function formatRecheckFailed({ mint, symbol, reasons }) {
  return [
    `⚠️ <b>HELD TOKEN NOW FAILS THE GATE</b> ${escapeHtml(symbol ?? '?')}`,
    '',
    ...reasons.slice(0, 5).map((r) => `• ${escapeHtml(r)}`),
    '',
    `<code>${escapeHtml(mint)}</code>`,
    '<i>A token can BECOME a honeypot after you hold it — a scheduled fee',
    'activates, a hook appears. The paper engine exited immediately.</i>',
  ].join('\n');
}

/** The kill switch tripped. */
export function formatKillSwitch({ reasons, dailyPnlPct }) {
  return [
    '🛑 <b>KILL SWITCH TRIPPED</b>',
    '',
    ...reasons.map((r) => `• ${escapeHtml(r)}`),
    '',
    `day ${pct(dailyPnlPct)}`,
    '<i>No new positions will be opened. Exits still run.</i>',
  ].join('\n');
}

/** A data source went down, so silence is not mistaken for "nothing found". */
export function formatDataSourceDown({ detail }) {
  return [
    '🔌 <b>DATA SOURCE PROBLEM</b>',
    '',
    escapeHtml(detail),
    '',
    '<i>Alerts may be silent while this lasts. Under fail-closed rules an',
    'unanswered check REJECTS, so an outage looks exactly like “everything is',
    'a rug” — this message exists so the two are distinguishable.</i>',
  ].join('\n');
}

/** Reply to /status. */
export function formatStatus({ cycle, funnel, book, equityUsd, feed, profile, rpcLabel, uptimeMs }) {
  const positions = Array.isArray(book?.positions) ? book.positions : Object.values(book?.positions ?? {});
  const pnl = (book?.realisedPnlUsd ?? 0) + (book?.unrealisedPnlUsd ?? 0);
  const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';

  return [
    '📊 <b>SOLSCALP SYSTEM STATUS</b>',
    '',
    `<b>Book Equity:</b> ${usd(equityUsd)}  (${usd(book?.cashUsd ?? equityUsd)} cash)`,
    `<b>Total P&L:</b> ${pnlEmoji} <b>${money(pnl)}</b> (${book?.wins ?? 0}W / ${book?.losses ?? 0}L)`,
    `<b>Open Positions:</b> ${positions.length} active`,
    `<b>Uptime:</b> ${Math.round(uptimeMs / 60_000)}m   <b>Profile:</b> ${escapeHtml(profile)}`,
    '',
    '<b>🔍 Live Scanner Funnel:</b>',
    `Pools: ${funnel.pools} → Pairs: ${funnel.pairs} → Screened: ${funnel.screened}`,
    `→ Gated: ${funnel.gated} → Safe: ${funnel.safe} → <b>Signals: ${funnel.wouldEnter}</b>`,
    '',
    '<i>Available commands: /live, /positions, /history, /reentry, /status</i>',
  ].join('\n');
}

/** Reply to /positions (Tab 2). */
export function formatPositions({ book, now }) {
  const positions = Array.isArray(book?.positions)
    ? book.positions
    : Object.values(book?.positions ?? {});

  if (positions.length === 0) {
    return `📊 <b>OPEN POSITIONS (0)</b>\n\n<b>No open paper positions right now.</b>\n<i>Cash: ${usd(book?.cashUsd ?? book?.equityUsd ?? 450)}</i>`;
  }

  const lines = [
    `📊 <b>OPEN POSITIONS (${positions.length})</b>`,
    `Equity: <b>${usd(book?.equityUsd ?? 450)}</b>   Cash: <b>${usd(book?.cashUsd ?? 409)}</b>`,
    '',
  ];

  for (const p of positions) {
    const pnlUsd = typeof p.unrealisedPnlUsd === 'number'
      ? p.unrealisedPnlUsd
      : p.entryPriceUsd && p.lastPriceUsd
        ? ((p.lastPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * (p.sizeUsd ?? 40)
        : 0;
    const pnlPct = p.entryPriceUsd && p.lastPriceUsd
      ? ((p.lastPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100
      : 0;
    const emoji = pnlPct >= 0 ? '🟢' : '🔴';
    const heldMin = p.openedTs ? Math.max(0, Math.round((now - p.openedTs) / 60_000)) : 0;

    lines.push(
      `${emoji} <b>${escapeHtml(p.symbol ?? p.mint?.slice(0, 8) ?? '?')}</b> — <b>${pct(pnlPct)}</b> (${money(pnlUsd)})`,
      `• <b>Price:</b> ${price(p.entryPriceUsd)} ➔ ${price(p.lastPriceUsd)}`,
      `• <b>Size:</b> ${usd(p.sizeUsd)}   • <b>Held:</b> ${heldMin}m / 60m`,
      `• <b>Stop Loss:</b> -15%   • <b>Trailing:</b> 8% (arms +15%)`,
      links(p.mint),
      '',
    );
  }

  return lines.filter(Boolean).join('\n');
}

/** Reply to /reentry (Tab 5). */
export function formatReentry({ reentry }) {
  const list = reentry ?? [];
  if (list.length === 0) {
    return '🎯 <b>DIP-BUYING & RE-ENTRY TRACKING</b>\n\n<b>No closed trades to track yet.</b>';
  }

  const ready = list.filter((r) => r.status === 'READY').length;
  const dips = list.filter((r) => r.status === 'DIP').length;

  const lines = [
    `🎯 <b>DIP-BUYING & RE-ENTRY TRACKING</b>`,
    `<b>${ready} READY</b> · <b>${dips} DIPS</b> · ${list.length} monitored`,
    '',
  ];

  for (const r of list.slice(0, 10)) {
    const icon =
      r.status === 'READY' ? '🚀' :
      r.status === 'DIP' ? '🟡' :
      r.status === 'HOLDING' ? '💎' :
      r.status === 'BLOCKED' ? '🚫' : '👀';
    const dip = r.dipPct !== null ? `${r.dipPct >= 0 ? '+' : ''}${r.dipPct.toFixed(1)}%` : '—';

    lines.push(
      `${icon} <b>${escapeHtml(r.symbol ?? r.mint?.slice(0, 8) ?? '?')}</b> [${r.status}]`,
      `• Exit: ${price(r.exitPriceUsd)} ➔ Now: ${price(r.livePriceUsd)} (<b>${dip}</b>)`,
      `• 5m: ${pct(r.m5Change)} | B/S: ${r.buySellRatio !== null ? r.buySellRatio.toFixed(1) : '—'} | Reason: ${escapeHtml(r.exitReason ?? '—')}`,
      links(r.mint),
      '',
    );
  }

  return lines.join('\n');
}

/** Reply to /history (Tab 3). */
export function formatHistory({ closedTrades }) {
  const trades = closedTrades ?? [];
  if (trades.length === 0) {
    return '📜 <b>TRADE HISTORY (0)</b>\n\n<b>No closed trades recorded yet today.</b>';
  }

  const lines = [
    `📜 <b>TRADE HISTORY (${trades.length})</b>`,
    '',
  ];

  for (const t of trades.slice(-8).reverse()) {
    const win = (t.netPnlUsd ?? 0) > 0;
    const icon = win ? '✅' : '🔻';
    const holdSecs = Number.isFinite(t.holdMs) ? Math.round(t.holdMs / 1000) : 0;
    const holdStr = holdSecs >= 60 ? `${Math.round(holdSecs / 60)}m` : `${holdSecs}s`;

    lines.push(
      `${icon} <b>${escapeHtml(t.symbol ?? t.mint?.slice(0, 8) ?? '?')}</b> — <b>${money(t.netPnlUsd)}</b> (${pct(t.netPnlPct)})`,
      `• In: ${price(t.entryPriceUsd)} ➔ Out: ${price(t.exitPriceUsd)} (${holdStr})`,
      `• Reason: ${escapeHtml(t.reason ?? 'closed')}`,
      links(t.mint),
      '',
    );
  }

  return lines.join('\n');
}

/** Reply to /evidence (Tab 4). */
export function formatEvidence({ evidence, ml }) {
  const tally = evidence?.tally ?? {};
  const report = evidence?.report ?? {};
  const lines = [
    '🧪 <b>EVIDENCE & SCAM WEIGHTS</b>',
    '',
    `<b>Snaps:</b> ${tally.snapshots ?? 0}   <b>Pools:</b> ${tally.poolsSeen ?? 0}`,
    `<b>Pass Rate:</b> ${report.passRatePct ? report.passRatePct.toFixed(1) : 0}%`,
    '',
  ];

  if (ml?.weights) {
    lines.push('<b>🤖 AI Scam Classifier Weights:</b>');
    const sorted = Object.entries(ml.weights).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    for (const [k, v] of sorted.slice(0, 6)) {
      lines.push(`• <code>${escapeHtml(k)}</code>: ${v > 0 ? '+' : ''}${v.toFixed(3)}`);
    }
    lines.push('');
  }

  lines.push('<i>Trained continuously from forward on-chain outcomes.</i>');
  return lines.join('\n');
}

/**
 * Reply to /check <mint>. Renders a GateResult, keeping skipped layers visibly
 * separate from passes -- the same invariant the terminal report honours.
 */
export function formatGate({ mint, gate }) {
  const lines = [
    `${gate.buyable ? '✅' : '⛔'} <b>GATE</b> ${gate.buyable ? 'PASSED' : 'BLOCKED'}`,
    `<code>${escapeHtml(mint)}</code>`,
    '',
  ];
  for (const layer of gate.layers) {
    const mark = layer.outcome === 'PASS' ? '✓' : layer.outcome === 'REJECT' ? '✗' : '!';
    lines.push(`${mark} ${escapeHtml(layer.layer)}`);
    for (const reason of layer.reasons.slice(0, 2)) {
      lines.push(`   <i>${escapeHtml(reason.slice(0, 160))}</i>`);
    }
  }
  if (gate.skipped.length > 0) {
    lines.push('', `<b>not run</b> (NOT passes): ${escapeHtml(gate.skipped.join(', '))}`);
  }
  lines.push('', '<i>Passing means theft risk was checked, not that it is a good trade.</i>');
  return lines.join('\n');
}

/** Reply to /help — also what the Telegram "/" menu describes. */
export const COMMANDS = Object.freeze([
  Object.freeze({ command: 'status', description: 'System overview, equity, and P&L' }),
  Object.freeze({ command: 'live', description: 'Tab 1: Live candidate scanner' }),
  Object.freeze({ command: 'positions', description: 'Tab 2: Open trades, stop loss & trailing' }),
  Object.freeze({ command: 'history', description: 'Tab 3: Closed trades and today results' }),
  Object.freeze({ command: 'evidence', description: 'Tab 4: AI scam model weights' }),
  Object.freeze({ command: 'reentry', description: 'Tab 5: Dip-buying & re-entry tracking' }),
  Object.freeze({ command: 'check', description: 'Run safety gate on mint: /check <mint>' }),
  Object.freeze({ command: 'pause', description: 'Mute trade alerts' }),
  Object.freeze({ command: 'resume', description: 'Unmute trade alerts' }),
  Object.freeze({ command: 'help', description: 'Show all commands' }),
]);

export function formatHelp() {
  return [
    '<b>SOLSCALP DASHBOARD ON TELEGRAM</b>',
    '',
    '<b>📱 Dashboard Sections:</b>',
    '• /live — <b>Tab 1: LIVE</b> candidates',
    '• /positions — <b>Tab 2: POSITIONS</b> (with stop loss & charts)',
    '• /history — <b>Tab 3: HISTORY</b> (closed trades today)',
    '• /evidence — <b>Tab 4: EVIDENCE</b> (AI scam weights)',
    '• /reentry — <b>Tab 5: RE-ENTRY</b> (dip-buying tracking)',
    '',
    '<b>⚙️ Bot Control:</b>',
    '• /status — Equity, cash, P&L, uptime',
    '• /check &lt;mint&gt; — Run safety gate on any token',
    '• /pause & /resume — Mute/unmute alerts',
  ].join('\n');
}

/** Reply to /candidates or /live. */
export function formatCandidates({ candidates }) {
  if (!candidates || candidates.length === 0) {
    return [
      '<b>no candidates right now</b>',
      '',
      '<i>98.6% of these tokens are rugs or under $1k liquidity, so an empty',
      'list is usually the filter working rather than the filter broken.</i>',
    ].join('\n');
  }
  return [
    `<b>LIVE CANDIDATES (${candidates.length})</b>`,
    '',
    ...candidates.slice(0, 10).map((c) => {
      const safe = c.gate.buyable ? '✅' : '⛔';
      const enter = c.gate.buyable && c.entry.enter ? ' 🎯<b>ENTER</b>' : '';
      return (
        `${safe} <b>${escapeHtml(c.symbol ?? '?')}</b> ${usd(c.signals.marketCapUsd)} ` +
        `5m ${pct(c.signals.priceChangeM5Pct)} accel ${num(c.signals.volumeAccelerationRatio, 1)}${enter}`
      );
    }),
    '',
    '<i>✅ = safe to buy. 🎯 = the rules also fired. They are different questions.</i>',
  ].join('\n');
}
