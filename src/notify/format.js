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
  return [
    '📊 <b>SOLSCALP STATUS</b>',
    '',
    `<b>cycle</b> ${cycle}   <b>feed</b> ${escapeHtml(feed)}   <b>profile</b> ${escapeHtml(profile)}`,
    `<b>up</b> ${Math.round(uptimeMs / 60_000)}m   <b>rpc</b> ${escapeHtml(rpcLabel)}`,
    '',
    '<b>last funnel</b>',
    `pools ${funnel.pools} → pairs ${funnel.pairs} → screened ${funnel.screened}`,
    `→ gated ${funnel.gated} → safe ${funnel.safe} → <b>would enter ${funnel.wouldEnter}</b>`,
    '',
    '<b>paper book</b>',
    `equity ${usd(equityUsd)}   realised ${usd(book.realisedPnlUsd)}`,
    `open ${Object.keys(book.positions).length}   closed ${book.closedCount}` +
      `   wins ${book.wins}/${book.closedCount}`,
    '',
    '<i>paper only — no keypair exists in this repo</i>',
  ].join('\n');
}

/** Reply to /positions. */
export function formatPositions({ book, now }) {
  const entries = Object.entries(book.positions);
  if (entries.length === 0) return '<b>no open paper positions</b>';
  return [
    `<b>OPEN PAPER POSITIONS</b> (${entries.length})`,
    '',
    ...entries.map(([mint, p]) => {
      const pnl = ((p.lastPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;
      return (
        `${pnl >= 0 ? '🟢' : '🔴'} <code>${escapeHtml(mint.slice(0, 12))}</code> ` +
        `${pct(pnl)}  ${usd(p.sizeUsd)}  held ${Math.round((now - p.openedTs) / 60_000)}m`
      );
    }),
  ].join('\n');
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
  Object.freeze({ command: 'status', description: 'funnel, paper book, uptime' }),
  Object.freeze({ command: 'candidates', description: 'what passed the screen right now' }),
  Object.freeze({ command: 'positions', description: 'open paper positions' }),
  Object.freeze({ command: 'check', description: 'run the safety gate on a mint: /check <mint>' }),
  Object.freeze({ command: 'pause', description: 'stop sending alerts' }),
  Object.freeze({ command: 'resume', description: 'start sending alerts again' }),
  Object.freeze({ command: 'help', description: 'this list' }),
]);

export function formatHelp() {
  return [
    '<b>SOLSCALP</b> — paper-trading safety gate',
    '',
    ...COMMANDS.map((c) => `/${c.command} — ${escapeHtml(c.description)}`),
    '',
    '<i>This bot reports and queries. It cannot trade: there is no keypair in',
    'the repo and no code that can sign a transaction.</i>',
  ].join('\n');
}

/** Reply to /candidates. */
export function formatCandidates({ candidates }) {
  if (candidates.length === 0) {
    return [
      '<b>no candidates right now</b>',
      '',
      '<i>98.6% of these tokens are rugs or under $1k liquidity, so an empty',
      'list is usually the filter working rather than the filter broken.</i>',
    ].join('\n');
  }
  return [
    `<b>CANDIDATES</b> (${candidates.length})`,
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
