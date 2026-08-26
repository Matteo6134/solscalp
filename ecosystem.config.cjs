/**
 * pm2 process definitions.
 *
 * WHY pm2 AND NOT `nohup ... &`
 *   A backgrounded job is a child of the shell that launched it. When that shell
 *   goes away -- a closed terminal, a recycled session -- the job goes with it.
 *   That happened repeatedly here: the recorder ran for 5.7 hours and then
 *   vanished with no error and no one having killed it, which is the worst kind
 *   of failure for a process whose entire job is to not miss anything.
 *
 *   The recording cannot be reconstructed after the fact (there is no history
 *   endpoint; see the design record), so every minute the recorder is silently
 *   down is a minute of evidence that can never be recovered. That makes
 *   durability a correctness property here, not an operational nicety. pm2
 *   detaches properly, restarts on crash, and can be inspected later.
 *
 * CommonJS (.cjs) on purpose: package.json sets "type": "module", and pm2 reads
 * its config with require().
 *
 * ONE FETCHER PER SOURCE, ROUGHLY. GeckoTerminal allows 30 req/min per IP and
 * the rate limiters are per-process, so two processes cannot see each other's
 * budget. The intervals below keep the pair comfortably inside it: the recorder
 * at 60s and the bot at 60s is ~2 req/min against a 30 req/min ceiling. Adding
 * more processes, or shortening these, is how the 429 storm happened before.
 */
module.exports = {
  apps: [
    {
      name: 'solscalp-record',
      script: 'scripts/record.js',
      args: '--early',
      cwd: __dirname,
      // The evidence collector. Never let it stay down.
      autorestart: true,
      // A crash loop must not spin: back off instead of hammering the APIs.
      restart_delay: 10_000,
      max_restarts: 50,
      env: { SOLSCALP_LOG_FILE: 'data/record.log' },
      out_file: 'data/pm2-record.log',
      error_file: 'data/pm2-record.err',
      time: true,
    },
    {
      name: 'solscalp-bot',
      script: 'scripts/bot.js',
      args: '--early --paper --interval 60',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 15_000,
      max_restarts: 50,
      env: { SOLSCALP_LOG_FILE: 'data/bot.log' },
      out_file: 'data/pm2-bot.log',
      error_file: 'data/pm2-bot.err',
      time: true,
    },
  ],
};
