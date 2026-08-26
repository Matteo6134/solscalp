#!/usr/bin/env node
/**
 * Stop SOLSCALP's long-running processes, and PROVE it stopped them.
 *
 * WHY THIS EXISTS
 *   `pkill -f "scripts/bot.js"` reports success on Windows and kills nothing:
 *   the POSIX tools in Git Bash cannot see a Windows process's command line, so
 *   the pattern never matches. Four stale bots accumulated that way, each one
 *   still holding the Telegram token that was in .env when IT started -- so they
 *   kept alerting through a bot the operator had already moved away from, and
 *   each ran its own in-memory paper portfolio, reporting different pnl for the
 *   same token.
 *
 *   The lesson is not "use taskkill". It is that a stop command which cannot
 *   verify what it stopped is worse than none, because it produces confident
 *   false reports. So this lists what it found, kills it, waits, lists again,
 *   and exits non-zero if anything survived.
 *
 * A process holds its credentials from startup. Editing .env does not reach it.
 * Restarting is the only way to change which bot a running process talks to.
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { EXIT, isMain, line, parseArgs, runMain } from './lib/cli.js';

const run = promisify(execFile);

/** The long-running scripts. Anything else node is doing is none of our business. */
const OURS = Object.freeze(['scripts/record.js', 'scripts/bot.js', 'scripts/dash.js']);

const USAGE = `usage: npm run stop -- [--only NAME] [--dry-run]

Stops SOLSCALP's long-running processes and verifies they are gone.

  --only NAME   just one: record | bot | dash
  --dry-run     list what would be killed, kill nothing

Exits 0 when nothing of ours is left running, 2 if something survived.
`;

/**
 * Every running SOLSCALP process. Windows needs PowerShell because the POSIX
 * tools cannot read a Windows command line -- the exact reason this file exists.
 * @returns {Promise<readonly {pid: number, cmd: string}[]>}
 */
export async function findProcesses(deps = {}) {
  const exec = deps.run ?? run;
  const os = deps.platform ?? platform();
  const patterns = deps.patterns ?? OURS;

  if (os === 'win32') {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', script], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return Object.freeze(
      stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const tab = l.indexOf('\t');
          return { pid: Number(l.slice(0, tab)), cmd: l.slice(tab + 1) };
        })
        .filter((p) => Number.isInteger(p.pid) && patterns.some((n) => p.cmd.includes(n))),
    );
  }

  const { stdout } = await exec('ps', ['-eo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 });
  return Object.freeze(
    stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const space = l.indexOf(' ');
        return { pid: Number(l.slice(0, space)), cmd: l.slice(space + 1) };
      })
      .filter((p) => Number.isInteger(p.pid) && patterns.some((n) => p.cmd.includes(n))),
  );
}

/** Short label for a process, e.g. "bot --early --paper". */
const label = (cmd) => {
  const at = OURS.map((n) => cmd.indexOf(n)).find((i) => i >= 0) ?? 0;
  return cmd.slice(at).replace('scripts/', '').replace('.js', '').slice(0, 56);
};

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

  const only = typeof flags.only === 'string' ? `scripts/${flags.only}.js` : null;
  const patterns = only === null ? OURS : [only];
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const found = (await findProcesses({ ...deps, patterns })).filter(
    (p) => p.pid !== process.pid,
  );

  out(line('='));
  out(`SOLSCALP processes running: ${found.length}`);
  out(line('='));
  for (const p of found) out(`  ${String(p.pid).padStart(7)}  ${label(p.cmd)}`);

  if (found.length === 0) {
    out('  (nothing to stop)');
    out(line('-'));
    return EXIT.OK;
  }
  if (flags['dry-run'] === true) {
    out('');
    out('--dry-run: nothing killed.');
    out(line('-'));
    return EXIT.OK;
  }

  out('');
  for (const p of found) {
    try {
      process.kill(p.pid, 'SIGTERM');
      out(`  signalled ${p.pid}`);
    } catch (err) {
      out(`  could not signal ${p.pid}: ${err?.message ?? err}`);
    }
  }

  // Verify. A stop command that cannot prove it worked is the whole problem.
  await sleep(deps.graceMs ?? 3_000);
  const survivors = (await findProcesses({ ...deps, patterns })).filter(
    (p) => p.pid !== process.pid,
  );

  out('');
  if (survivors.length === 0) {
    out('  all stopped, verified.');
    out(line('-'));
    return EXIT.OK;
  }

  out(`  ${survivors.length} SURVIVED SIGTERM -- forcing:`);
  for (const p of survivors) {
    try {
      process.kill(p.pid, 'SIGKILL');
      out(`  killed ${p.pid}`);
    } catch (err) {
      out(`  could not kill ${p.pid}: ${err?.message ?? err}`);
    }
  }
  await sleep(deps.graceMs ?? 3_000);
  const stubborn = (await findProcesses({ ...deps, patterns })).filter(
    (p) => p.pid !== process.pid,
  );
  out('');
  if (stubborn.length === 0) {
    out('  all stopped, verified.');
    out(line('-'));
    return EXIT.OK;
  }
  out(`  STILL RUNNING: ${stubborn.map((p) => p.pid).join(', ')}`);
  out('  Kill these by hand before starting anything new -- a stale process keeps');
  out('  the credentials it loaded at startup and will keep sending alerts.');
  out(line('-'));
  return EXIT.ERROR;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
