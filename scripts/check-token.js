#!/usr/bin/env node
/**
 * Run the full safety gate against one mint and report honestly.
 *
 * Exit codes are chosen so this composes into shell pipelines:
 *   0  buyable        -- every layer ran and passed
 *   1  blocked        -- a layer rejected, or (fail-closed) a layer could not answer
 *   2  internal error -- including usage errors; the answer is UNKNOWN, not "safe"
 *
 * Thin wiring only: every decision belongs to src/safety/index.js.
 */

import { loadEnv } from '../src/env.js';
import { runGate } from '../src/safety/index.js';
import { EXIT, buildRpc, isMain, parseArgs, printGateReport, runMain } from './lib/cli.js';

const USAGE = `usage: npm run check <MINT>

Runs the six-layer safety gate against one Solana mint.

  0 = buyable    1 = blocked    2 = internal error / bad usage

flags:
  --json     emit the raw GateResult as JSON instead of a report
`;

/**
 * @param {readonly string[]} argv
 * @param {object} [deps] test seam
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const { positional, flags } = parseArgs(argv);
  const out = deps.out ?? console.log;
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));

  const mint = positional[0];
  if (mint === undefined || flags.help === true) {
    err(USAGE);
    // A missing argument is a usage error, not a "not buyable" answer. Exiting 1
    // here would let `check-token && buy` read a typo as a considered rejection.
    return EXIT.ERROR;
  }

  const env = (deps.loadEnv ?? loadEnv)();
  const rpc = deps.rpc ?? (await buildRpc(env));
  const gate = await (deps.runGate ?? runGate)(mint, { rpc });

  if (flags.json === true) {
    out(JSON.stringify(gate, null, 2));
  } else {
    printGateReport(gate, out);
  }
  return gate.buyable ? EXIT.OK : EXIT.NEGATIVE;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
