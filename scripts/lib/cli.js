/**
 * Shared CLI plumbing. Presentation and process wiring ONLY.
 *
 * There is no business logic here and there must never be: no thresholds, no
 * decisions, no arithmetic that affects a verdict. Everything this module prints
 * was decided by src/safety or src/paper. If you find yourself wanting to
 * compute something here, it belongs in a module with tests.
 *
 * The one opinion this file does hold is about HONESTY IN OUTPUT: a skipped
 * layer is rendered as "not run", never blended into the passes, and a buyable
 * verdict always prints what it does not mean. A log that overstates what was
 * proven is the failure mode this whole project is built to avoid.
 */

import { OUTCOME } from '../../src/safety/verdict.js';

/** Process exit codes, shared by every script so shell pipelines compose. */
export const EXIT = Object.freeze({
  /** Ran, and the answer was affirmative (buyable / candidates found / report produced). */
  OK: 0,
  /** Ran fine, but the answer was negative (blocked, nothing found). NOT an error. */
  NEGATIVE: 1,
  /** We broke, or were misused. The answer is unknown. */
  ERROR: 2,
});

const SYMBOL = Object.freeze({
  [OUTCOME.PASS]: 'PASS ',
  [OUTCOME.REJECT]: 'REJECT',
  [OUTCOME.ERROR]: 'ERROR',
});

/**
 * Minimal flag parser: `--flag`, `--key=value`, `--key value`, plus positionals.
 * Deliberately tiny -- a script that needs more than this is doing too much.
 * @param {readonly string[]} argv typically process.argv.slice(2)
 * @returns {Readonly<{positional: readonly string[], flags: Readonly<Record<string, string|boolean>>}>}
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return Object.freeze({ positional: Object.freeze(positional), flags: Object.freeze(flags) });
}

/** @param {unknown} value @param {number} fallback */
export function intFlag(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const usd = (n) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '     n/a'
    : `$${n < 10 ? n.toFixed(4) : Math.round(n).toLocaleString('en-US')}`;

export const pct = (n) =>
  n === null || n === undefined || !Number.isFinite(n) ? '  n/a' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

export const line = (char = '-', width = 78) => char.repeat(width);

/**
 * Render a GateResult from src/safety/index.js.
 *
 * Skipped layers are printed in their own section, explicitly labelled, because
 * the design record's first invariant is that "skipped" is recorded distinctly
 * from "passed". Flattening them into one list would be a lie in the log and
 * would poison the recorded dataset the rug-filter backtest depends on.
 *
 * @param {object} gate GateResult
 * @param {(s: string) => void} [out]
 */
export function printGateReport(gate, out = console.log) {
  out(line('='));
  out(`SAFETY GATE  ${gate.mint}`);
  out(line('='));

  for (const v of gate.layers) {
    const symbol = SYMBOL[v.outcome] ?? v.outcome;
    out(`  ${symbol}  ${v.layer.padEnd(20)} ${String(v.ms ?? 0).padStart(5)}ms`);
    for (const reason of v.reasons) out(`          - ${reason}`);
  }

  if (gate.skipped.length > 0) {
    out('');
    out('  NOT RUN (the gate short-circuited). These are NOT passes -- nothing');
    out('  about them was checked or proven:');
    for (const name of gate.skipped) out(`     . ${name}`);
  }

  if (gate.residualRisks.length > 0) {
    out('');
    out('  RESIDUAL RISK -- what a pass here does NOT establish:');
    for (const risk of dedupe(gate.residualRisks)) out(`     ! ${risk}`);
  }

  out('');
  out(line('-'));
  if (gate.buyable) {
    out(`VERDICT: BUYABLE  (${gate.elapsedMs}ms, every layer ran and passed)`);
    out('');
    out('  This means the creator probably cannot burn, freeze, tax or block your');
    out('  tokens. It does NOT mean profitable. A perfectly clean token still goes');
    out('  to zero if nobody buys it, and a SOFT RUG -- a dev quietly selling into');
    out('  buyers -- breaks no rule and passes every check above.');
  } else {
    const why = gate.rejectedBy.length > 0 ? `rejected by ${gate.rejectedBy.join(', ')}` : '';
    const errs = gate.erroredIn.length > 0 ? `errored in ${gate.erroredIn.join(', ')}` : '';
    out(`VERDICT: BLOCKED  (${gate.elapsedMs}ms) ${[why, errs].filter(Boolean).join('; ')}`);
    if (!gate.complete) {
      out('  Incomplete: at least one layer could not answer. Under fail-closed');
      out('  rules an unanswered check blocks the buy -- it is never a pass.');
    }
  }
  out(line('-'));
}

const dedupe = (list) => [...new Set(list)];

/**
 * Wrap a script body: prints errors to stderr, sets the exit code, and makes
 * Ctrl+C a clean exit rather than an unhandled rejection.
 * @param {() => Promise<number>} body resolves to an EXIT code
 */
export async function runMain(body) {
  const onSignal = () => {
    process.stderr.write('\ninterrupted\n');
    process.exit(EXIT.OK);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    process.exitCode = await body();
  } catch (err) {
    process.stderr.write(`error: ${err?.message ?? String(err)}\n`);
    if (process.env.SOLSCALP_DEBUG) process.stderr.write(`${err?.stack ?? ''}\n`);
    process.exitCode = EXIT.ERROR;
  }
}

/**
 * True when this module's importer was run directly (`node scripts/x.js`) rather
 * than imported. Lets every script guard its main() so importing runs nothing.
 * @param {string} moduleUrl import.meta.url of the calling script
 */
export function isMain(moduleUrl) {
  const invoked = process.argv[1];
  if (typeof invoked !== 'string') return false;
  // Compare resolved paths, not raw strings: argv[1] is a path, moduleUrl a URL.
  try {
    return new URL(moduleUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1') ===
      invoked.replace(/\\/g, '/');
  } catch {
    return false;
  }
}

/**
 * Build the RpcClient every gate run shares.
 *
 * createRpcClient deliberately refuses to guess an endpoint, and loadEnv owns the
 * public-mainnet default -- so this is the ONE correct way to wire the two, and
 * scripts should not do it by hand.
 * @param {object} env loadEnv() result
 * @param {object} [deps]
 */
export async function buildRpc(env, deps = {}) {
  const { createRpcClient } = deps.connection ?? (await import('../../src/rpc/connection.js'));
  return createRpcClient({ url: env.rpcUrl, fallbackUrl: env.rpcFallbackUrl ?? undefined });
}
