#!/usr/bin/env node
/**
 * The stateful view: every token ever recorded, and what became of it.
 *
 * WHY THIS EXISTS
 *   A stream of alerts cannot answer "what happened to the things you showed me".
 *   Each message is a moment; there is no state, so the same token appearing and
 *   vanishing reads as the tool being inconsistent when it is actually the market
 *   being exactly as lethal as the base rate says. This puts every token on one
 *   page with its outcome, so the pattern is legible instead of anecdotal.
 *
 * IT RE-FETCHES. IT DOES NOT TRUST THE RECORDING'S TAIL.
 *   This is the subtle part. scripts/record.js only observes a token WHILE IT
 *   PASSES THE SCREEN. The moment liquidity collapses the token drops out of the
 *   candidate set and stops being recorded -- so the last recorded value is the
 *   last HEALTHY reading, never the outcome. Measured on real data: one mint's
 *   final recorded liquidity was $61,861 while its actual live pool held $2,623.
 *
 *   Any report built from "last recorded liquidity" would therefore be
 *   systematically flattering, and would show a portfolio of survivors that do
 *   not exist. So the reference point comes from the recording (the FIRST
 *   observation, which is the decision the filter would have traded on) and the
 *   current value is always fetched live.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LABELS, RECORDER } from '../src/config.js';
import { getBestPairs } from '../src/data/dexscreener.js';
import { LABEL, decideOutcome } from '../src/evidence/outcome.js';
import { EXIT, isMain, line, parseArgs, pct, runMain, usd } from './lib/cli.js';

const MS_PER_HOUR = 3_600_000;

const USAGE = `usage: npm run watchlist -- [--dir PATH] [--html FILE] [--json] [--all]

Every token the recorder has ever seen, with its CURRENT state fetched live.

  --dir PATH   recordings directory (default ${RECORDER.dir})
  --html FILE  also write a standalone HTML report (for a phone)
  --json       machine-readable output
  --all        include tokens the gate BLOCKED (default: approved only)
`;

/**
 * Fold the recording into one row per mint: the FIRST observation (the decision
 * the filter would have acted on) plus how many times it was seen.
 * @param {readonly string[]} lines
 */
export function buildWatchlist(lines) {
  const rows = new Map();
  const labels = new Map();

  for (const raw of lines) {
    const text = raw.trim();
    if (text === '') continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    if (record?.schemaVersion !== RECORDER.schemaVersion) continue;

    if (record.type === LABELS.recordType) {
      for (const entry of record.labels ?? []) {
        if (typeof entry?.mint === 'string') labels.set(entry.mint, entry);
      }
      continue;
    }

    for (const c of record.candidates ?? []) {
      if (typeof c?.mint !== 'string') continue;
      const existing = rows.get(c.mint);
      if (existing === undefined) {
        rows.set(c.mint, {
          mint: c.mint,
          symbol: c.symbol ?? null,
          firstTs: record.ts,
          lastSeenTs: record.ts,
          seen: 1,
          entryLiquidityUsd: c.liquidityUsd ?? null,
          entryPriceUsd: c.priceUsd ?? null,
          entryMarketCapUsd: c.marketCapUsd ?? null,
          gateBuyable: c.gate?.buyable ?? null,
          gateBlockedBy: [...(c.gate?.rejectedBy ?? []), ...(c.gate?.erroredIn ?? [])],
        });
      } else {
        existing.seen += 1;
        existing.lastSeenTs = record.ts;
      }
    }
  }

  for (const [mint, entry] of labels) {
    const row = rows.get(mint);
    if (row !== undefined) row.storedLabel = entry.outcome;
  }
  return [...rows.values()];
}

/** Escape for the HTML report. */
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A mortality register, not a trading screen.
 *
 * The design follows the subject: what this data says is that almost everything
 * dies, so the page is built as a forensic record -- clinical neutrals, an
 * instrument typeface, a severity stripe per row, magnitude encoded as a bar so
 * the shape of the attrition reads before any number does. Deliberately not
 * styled as a gains dashboard: green-on-black would misrepresent the finding.
 */
function htmlReport(rows, generatedAt) {
  const rugged = rows.filter((r) => r.outcome === LABEL.RUGGED).length;
  const survived = rows.filter((r) => r.outcome === LABEL.SURVIVED).length;
  const conclusive = rugged + survived;

  // Banded by what actually happened to the pool. With most tokens still too
  // young for a verdict, the change distribution is the honest headline: it shows
  // the attrition shape now, without claiming a rate the sample cannot support.
  const BANDS = [
    { label: 'gone', hint: 'down 90%+', test: (c) => c !== null && c <= -90, tone: 'crit' },
    { label: 'bleeding', hint: 'down 50–90%', test: (c) => c !== null && c <= -50 && c > -90, tone: 'warn' },
    { label: 'sagging', hint: 'down 0–50%', test: (c) => c !== null && c < 0 && c > -50, tone: 'mild' },
    { label: 'holding', hint: 'flat or up', test: (c) => c !== null && c >= 0, tone: 'ok' },
    { label: 'unreadable', hint: 'no figure', test: (c) => c === null, tone: 'none' },
  ].map((b) => {
    const n = rows.filter((r) => b.test(r.changePct)).length;
    return { ...b, n, pct: rows.length === 0 ? 0 : (n / rows.length) * 100 };
  });

  const bars = BANDS.filter((b) => b.n > 0)
    .map(
      (b) =>
        `<div class="seg ${b.tone}" style="flex:${b.pct}" title="${esc(b.label)}: ${b.n}"></div>`,
    )
    .join('');

  const legend = BANDS.filter((b) => b.n > 0)
    .map(
      (b) => `<li><i class="dot ${b.tone}"></i><b>${b.n}</b>
<span>${esc(b.label)}</span><em>${esc(b.hint)}</em></li>`,
    )
    .join('\n');

  const register = rows
    .map((r) => {
      const c = r.changePct;
      const tone =
        c === null ? 'none' : c <= -90 ? 'crit' : c <= -50 ? 'warn' : c < 0 ? 'mild' : 'ok';
      // Magnitude as form, clamped: a -100% and a -400% should not differ visually.
      const width = c === null ? 0 : Math.min(100, Math.abs(c));
      const dir = c !== null && c >= 0 ? 'up' : 'down';
      const change = c === null ? '—' : `${c > 0 ? '+' : ''}${c.toFixed(0)}%`;
      return `<tr class="${tone}">
<th scope="row"><span class="stripe"></span><span class="sym">${esc(r.symbol ?? 'unnamed')}</span>
<span class="mint">${esc(r.mint.slice(0, 6))}…${esc(r.mint.slice(-4))}</span></th>
<td class="n">${esc(usd(r.entryLiquidityUsd).trim())}</td>
<td class="n">${esc(usd(r.currentLiquidityUsd).trim())}</td>
<td class="n chg">${esc(change)}</td>
<td class="barcell"><span class="bar ${dir}" style="width:${width}%"></span></td>
<td class="n age">${r.ageHours === null ? '—' : `${r.ageHours.toFixed(0)}h`}</td>
<td class="n age">${r.seen}</td>
<td class="gate">${r.gateBuyable ? 'passed' : 'blocked'}</td>
</tr>`;
    })
    .join('\n');

  return `<title>Token Mortality Register</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
  :root{
    --paper:#f7f8fa; --raised:#ffffff; --ink:#14181f; --ink-2:#3d4653;
    --dim:#6e7681; --rule:#dfe3e8; --rule-soft:#eaedf1;
    --crit:#a8332a; --warn:#b3722a; --mild:#7d7f88; --ok:#2f6b4f; --none:#a9afb8;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --paper:#0e1116; --raised:#151a21; --ink:#e6e9ed; --ink-2:#b3bac4;
      --dim:#8b939e; --rule:#232a33; --rule-soft:#1b212a;
      --crit:#e8837a; --warn:#d8a05e; --mild:#8d949e; --ok:#64b98a; --none:#5d646d;
    }
  }
  :root[data-theme="dark"]{
    --paper:#0e1116; --raised:#151a21; --ink:#e6e9ed; --ink-2:#b3bac4;
    --dim:#8b939e; --rule:#232a33; --rule-soft:#1b212a;
    --crit:#e8837a; --warn:#d8a05e; --mild:#8d949e; --ok:#64b98a; --none:#5d646d;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:34px 18px 64px;background:var(--paper);color:var(--ink);
    font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
  .sheet{max-width:1020px;margin:0 auto}
  .eyebrow{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11px;
    letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 0 8px}
  h1{font-size:clamp(25px,5vw,34px);line-height:1.1;font-weight:600;margin:0 0 10px;
    letter-spacing:-.02em;text-wrap:balance}
  .standfirst{color:var(--ink-2);font-size:15.5px;max-width:63ch;margin:0 0 30px}
  .standfirst b{color:var(--ink);font-weight:600}

  .attrition{margin-bottom:8px}
  .track{display:flex;height:13px;gap:2px;border-radius:2px;overflow:hidden}
  .seg{min-width:3px;border-radius:1px}
  .seg.crit{background:var(--crit)} .seg.warn{background:var(--warn)}
  .seg.mild{background:var(--mild)} .seg.ok{background:var(--ok)}
  .seg.none{background:var(--none)}
  ul.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 22px;
    margin:14px 0 34px;padding:0}
  ul.legend li{display:flex;align-items:baseline;gap:7px;font-size:13px}
  ul.legend b{font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:600;
    font-variant-numeric:tabular-nums}
  ul.legend span{color:var(--ink-2)}
  ul.legend em{color:var(--dim);font-style:normal;font-size:12px}
  .dot{width:8px;height:8px;border-radius:50%;flex:none;transform:translateY(-1px)}
  .dot.crit{background:var(--crit)} .dot.warn{background:var(--warn)}
  .dot.mild{background:var(--mild)} .dot.ok{background:var(--ok)}
  .dot.none{background:var(--none)}

  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;
    border:1px solid var(--rule);border-radius:4px;background:var(--raised)}
  table{border-collapse:collapse;width:100%;min-width:660px}
  caption{text-align:left;padding:13px 16px;font-size:11px;letter-spacing:.12em;
    text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--rule);
    font-family:"IBM Plex Mono",ui-monospace,monospace}
  thead th{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;
    color:var(--dim);font-weight:600;text-align:left;padding:10px 12px;
    border-bottom:1px solid var(--rule);white-space:nowrap;background:var(--raised)}
  thead th.n{text-align:right}
  tbody th{font-weight:400;text-align:left;padding:0 12px 0 0;position:relative}
  tbody td,tbody th{border-bottom:1px solid var(--rule-soft);white-space:nowrap;
    padding-top:9px;padding-bottom:9px}
  tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}
  .stripe{position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--none)}
  tr.crit .stripe{background:var(--crit)} tr.warn .stripe{background:var(--warn)}
  tr.mild .stripe{background:var(--mild)} tr.ok .stripe{background:var(--ok)}
  .sym{display:inline-block;margin-left:15px;font-weight:600;font-size:14px;
    max-width:15ch;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
  .mint{display:block;margin-left:15px;font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:10.5px;color:var(--dim)}
  td.n{text-align:right;font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:13px;font-variant-numeric:tabular-nums;padding-left:12px;padding-right:12px}
  td.age{color:var(--dim);font-size:12px}
  .chg{font-weight:600}
  tr.crit .chg{color:var(--crit)} tr.warn .chg{color:var(--warn)}
  tr.ok .chg{color:var(--ok)} tr.none .chg{color:var(--dim)}
  .barcell{width:96px;padding:0 12px}
  .bar{display:block;height:5px;border-radius:1px;background:var(--mild);min-width:2px}
  tr.crit .bar{background:var(--crit)} tr.warn .bar{background:var(--warn)}
  tr.ok .bar{background:var(--ok)} tr.none .bar{background:transparent}
  .gate{font-size:11.5px;color:var(--dim);font-family:"IBM Plex Mono",ui-monospace,monospace}

  .footnotes{margin-top:30px;display:grid;gap:16px;
    grid-template-columns:repeat(auto-fit,minmax(258px,1fr))}
  .fn{border-top:2px solid var(--rule);padding-top:13px}
  .fn h2{font-size:11px;letter-spacing:.11em;text-transform:uppercase;color:var(--dim);
    margin:0 0 7px;font-weight:600;font-family:"IBM Plex Mono",ui-monospace,monospace}
  .fn p{margin:0;font-size:13px;color:var(--ink-2);line-height:1.55}
  .fn p b{color:var(--ink);font-weight:600}
  a{color:inherit}
  a:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--ok);outline-offset:2px}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
<div class="sheet">
  <p class="eyebrow">Solscalp · forward record · ${esc(generatedAt)} UTC</p>
  <h1>Token Mortality Register</h1>
  <p class="standfirst">Every token the scanner has recorded, and what became of its pool.
  Entry figures come from the first sighting — the moment the filter would have acted.
  <b>Current figures are fetched live, not read back from the recording</b>, because the
  recorder only watches a token while it still passes the screen: its last stored reading
  is the last healthy one, never the outcome.</p>

  <div class="attrition"><div class="track">${bars}</div></div>
  <ul class="legend">${legend}</ul>

  <div class="scroll">
    <table>
      <caption>${rows.length} tokens · sorted worst first</caption>
      <thead><tr>
        <th scope="col">Token</th>
        <th scope="col" class="n">Liquidity at entry</th>
        <th scope="col" class="n">Liquidity now</th>
        <th scope="col" class="n">Change</th>
        <th scope="col"><span class="sr">Magnitude</span></th>
        <th scope="col" class="n">Age</th>
        <th scope="col" class="n">Sightings</th>
        <th scope="col">Gate</th>
      </tr></thead>
      <tbody>
${register}
      </tbody>
    </table>
  </div>

  <div class="footnotes">
    <div class="fn"><h2>What the gate settles</h2>
    <p><b>Passed</b> means the creator probably cannot burn, freeze, tax or block your
    tokens. It says nothing about whether the price holds — and a soft rug, a dev quietly
    selling into buyers, breaks no rule and passes every check here.</p></div>

    <div class="fn"><h2>Why so many collapse</h2>
    <p>Solidus Labs found <b>98.6%</b> of 7M+ pump.fun tokens fell below $1k liquidity or
    were outright rugs. A register this brutal is the base rate showing up, not a fault in
    the filter.</p></div>

    <div class="fn"><h2>Sample size</h2>
    <p>${conclusive === 0
      ? 'No token has yet aged past the 24-hour mark needed for a verdict, so no rate is quoted. The change column is what happened so far, not a conclusion.'
      : `<b>${conclusive}</b> conclusive outcome${conclusive === 1 ? '' : 's'} so far. Nothing below 30 supports a rate — a handful of results is noise.`}</p></div>
  </div>
</div>`;
}

/**
 * @param {readonly string[]} argv
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const { flags } = parseArgs(argv);
  const out = deps.out ?? console.log;
  if (flags.help === true) {
    out(USAGE);
    return EXIT.OK;
  }

  const dir = typeof flags.dir === 'string' ? flags.dir : RECORDER.dir;
  const now = (deps.now ?? Date.now)();

  let files;
  try {
    files = (await (deps.readdir ?? readdir)(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    out(`no recordings at ${dir}. Run "npm run record" first.`);
    return EXIT.NEGATIVE;
  }
  if (files.length === 0) {
    out(`no .jsonl recordings in ${dir}.`);
    return EXIT.NEGATIVE;
  }

  const lines = [];
  for (const file of files) {
    lines.push(...(await (deps.readFile ?? readFile)(join(dir, file), 'utf8')).split('\n'));
  }

  let rows = buildWatchlist(lines);
  if (flags.all !== true) rows = rows.filter((r) => r.gateBuyable === true);
  if (rows.length === 0) {
    out('nothing recorded yet that matches. Try --all to include blocked tokens.');
    return EXIT.NEGATIVE;
  }

  // Current state is always fetched live -- never read off the recording's tail.
  const current = await (deps.getBestPairs ?? getBestPairs)(rows.map((r) => r.mint));
  const answered = [...current.values()].filter((p) => p !== null).length;
  const apiHealthy = answered > 0;

  const enriched = rows
    .map((r) => {
      const pair = current.get(r.mint) ?? null;
      const verdict = decideOutcome({
        recordedTs: r.firstTs,
        recordedLiquidityUsd: r.entryLiquidityUsd,
        recordedPriceUsd: r.entryPriceUsd,
        current: pair,
        now,
        apiHealthy,
      });
      return {
        ...r,
        currentLiquidityUsd: pair?.liquidityUsd ?? null,
        currentPriceUsd: pair?.priceUsd ?? null,
        changePct: verdict.evidence.liquidityDropPct === null ? null : -verdict.evidence.liquidityDropPct,
        ageHours: (now - r.firstTs) / MS_PER_HOUR,
        outcome: verdict.label,
        outcomeReason: verdict.reasons[0] ?? '',
      };
    })
    .sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));

  if (flags.json === true) {
    out(JSON.stringify({ generatedAt: new Date(now).toISOString(), rows: enriched }, null, 2));
    return EXIT.OK;
  }

  const rugged = enriched.filter((r) => r.outcome === LABEL.RUGGED).length;
  const survived = enriched.filter((r) => r.outcome === LABEL.SURVIVED).length;

  out(line('='));
  out(`WATCHLIST -- ${enriched.length} tokens, current values fetched live`);
  out(line('='));
  out(
    `${'TOKEN'.padEnd(12)}${'LIQ@ENTRY'.padStart(11)}${'LIQ NOW'.padStart(11)}` +
      `${'CHANGE'.padStart(9)}${'AGE'.padStart(6)}${'SEEN'.padStart(6)}  OUTCOME`,
  );
  out(line('-'));
  for (const r of enriched) {
    out(
      (r.symbol ?? '?').slice(0, 11).padEnd(12) +
        usd(r.entryLiquidityUsd).padStart(11) +
        usd(r.currentLiquidityUsd).padStart(11) +
        (r.changePct === null ? 'n/a' : pct(r.changePct)).padStart(9) +
        `${r.ageHours.toFixed(0)}h`.padStart(6) +
        String(r.seen).padStart(6) +
        '  ' +
        r.outcome,
    );
  }
  out(line('-'));
  out(`  collapsed ${rugged}   still trading ${survived}   too early ${enriched.length - rugged - survived}`);
  if (rugged + survived < 30) {
    out(`  ${rugged + survived} conclusive so far -- 30 needed before any rate means anything.`);
  }

  if (typeof flags.html === 'string') {
    const html = htmlReport(enriched, new Date(now).toISOString().replace('T', ' ').slice(0, 16));
    await (deps.writeFile ?? writeFile)(flags.html, html, 'utf8');
    out('');
    out(`  HTML report written to ${flags.html}`);
  }
  out(line('-'));
  return EXIT.OK;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
