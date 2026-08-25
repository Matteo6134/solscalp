# SOLSCALP

Solana DEX safety gate + paper-trading engine.

**Status: paper only. There is no private key in this repo and no code that can sign a
transaction.** Live execution gets wired only after the strategy beats a random-entry
baseline on forward-recorded data.

## What this actually is

The valuable, honest core of this project is the **safety gate**: a six-layer, fail-closed
check that a Solana token is not a theft vector before any SOL is committed. Unlike price
prediction, that is a deterministic on-chain question with a verifiable answer.

Why that framing — and why historical candle backtesting was deliberately rejected — is
recorded in [docs/specs/2026-08-24-solscalp-design.md](docs/specs/2026-08-24-solscalp-design.md).
Read it before changing strategy code.

## Quick start

```bash
npm install
cp .env.example .env
npm test                  # 840 tests, no network needed
```

**Then set `SOLANA_RPC_URL` in `.env` to a real endpoint.** This is not optional. On the
public RPC, `getTokenLargestAccounts` returns 429 under any load, so layer 3 errors and —
under fail-closed rules — every token gets rejected. You would be measuring the rate limiter,
not the tokens. The Helius free tier is enough:

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR-KEY
```

Now, in order:

```bash
# 1. prove the gate works. USDC SHOULD be blocked -- it has both authorities live
npm run check EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# 2. one live screen: funnel, candidates, paper book, events
npm run dash -- --early --paper

# 3. long-running: alerts to your phone + a command menu
npm run bot -- --early --paper

# 4. the slow, honest one: build the dataset. Leave it running for days.
npm run record
npm run backtest:rug      # refuses to report a rate under 30 labelled approvals
```

`npm run check` exits 0 if the token is buyable, 1 if blocked, 2 on internal error — so it
composes into shell pipelines.

### One process, not four terminals

The rate limiters in `src/data` are **per process**. Every `node scripts/...` starts with a
fresh window and cannot see the others, while GeckoTerminal's 30 req/min is **per IP**. Four
terminals running `scan` + `record` + `paper` + `dash` will 429 each other even though each
one is individually well-behaved. Use `npm run dash` (one process, four panes) or
`npm run bot`. Run `record` alongside only if you raise the intervals.

## SAFE? and ENTER? are different questions

The scan and dashboard print two verdict columns, and conflating them is the most expensive
mistake available here:

- **SAFE?** — the safety gate passed. The creator probably cannot burn, freeze, tax or block
  your tokens. Says *nothing* about whether the trade is good.
- **ENTER?** — the momentum rules fired. This is the trade signal.

Most tokens are one without the other. A token can be perfectly safe and a terrible buy, and
the ones that move most violently are the likeliest to be traps.

## Telegram alerts and the phone menu

```bash
# in .env, from @BotFather and @userinfobot respectively:
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=987654321

npm run bot -- --test     # confirms credentials, sends one message, exits
npm run bot -- --early --paper
```

Both variables or nothing — one alone is a misconfiguration and `loadEnv` says so. With
neither, alerts are simply off, which is not an error.

Commands (they appear in Telegram's own "/" menu, registered via `setMyCommands`):

| Command | Does |
|---|---|
| `/status` | funnel, paper book, uptime |
| `/candidates` | what passed the screen right now |
| `/positions` | open paper positions |
| `/check <mint>` | run the full gate on any mint from your phone |
| `/pause` `/resume` | stop and start alerts |
| `/help` | the list |

Alerts fire on: a genuine signal (gate passed **and** rules fired), paper open/close, a held
token that starts **failing its recheck** (it may have become a honeypot), the kill switch,
and a data-source outage — that last one so silence is never mistaken for "nothing found".

Two design notes that matter:

- **The notifier fails soft, and it is the only thing in this repo that does.** Everything
  else fails closed, because an unanswered safety question must never read as permission. A
  Telegram outage is not a safety signal, so a failed send is logged and the loop continues.
  A missed alert is a missed alert; a blocked trading loop would be a bug.
- **Only the configured chat is answered.** A bot token is a bearer credential, so anyone who
  learns the bot's @name can message it. Every update is checked against `TELEGRAM_CHAT_ID`
  and silently ignored otherwise.

The bot reports and answers questions. It cannot trade — there is no keypair in the repo and
no code that can sign, so no message from the phone can move money.

## The gate

| Layer | Check |
|---|---|
| 0 | Mint authorities revoked; Token-2022 extensions against an **allowlist** |
| 1 | **Sell simulation** — prove an exit route exists before buying |
| 2 | Liquidity depth, LP burned/locked, liquidity:mcap ratio |
| 3 | Holder + insider-cluster concentration (LP vaults excluded) |
| 4 | Deployer reputation from their prior mints |
| 5 | RugCheck score — cross-check veto only |

Layers run cheapest-first and short-circuit on the first reject.

## Three invariants — do not break these

1. **Fail closed.** Any error, timeout or unparseable response is a REJECT, never a pass.
   This is inverted from normal error handling on purpose. `skipped` is recorded separately
   from `passed`; conflating them would be a lie in the logs and poison the backtest dataset.
2. **Allowlist, never blacklist.** Layer 0 enumerates what is present and permits only a
   known-benign set. A blacklist loses to the next extension Solana ships — it already had:
   `PausableConfig`, `PermissionedBurn` and `ScaledUiAmountConfig` all post-date the
   well-known `PermanentDelegate` scam.
3. **Never overstate what was proven.** A quote round trip proves a *route* exists, not that
   a sell *transaction* would land on-chain. The gate returns `residualRisks` listing exactly
   what remains unverified.

## What passing the gate does and does not mean

**Does:** the creator probably cannot burn, freeze, tax or block your tokens.

**Does not:** mean profitable. A perfectly clean token still goes to zero if nobody buys it.
And **soft rugs pass every hard check** — a dev quietly selling into buyers breaks no rules,
and 93% of Raydium pools show that pattern. This gate removes theft risk, not market risk.

## Data sources (all free, no API key)

| Source | Use | Limit |
|---|---|---|
| Dexscreener | live pair snapshots | 60 req/min, **30 mints per call** (~1800 snapshots/min) |
| GeckoTerminal | OHLCV, ~6 months back | 30 req/min — the scarcest resource; cache and never re-fetch |
| Jupiter | quotes, round-trip sellability | quotes only, never builds a transaction |
| RugCheck | third-party risk veto | read endpoints keyless |

Dexscreener has **no** historical/candle endpoint. That is why GeckoTerminal is here.

## Config

Every threshold lives in [src/config.js](src/config.js) and nowhere else. No magic numbers in
module code. All config objects are frozen at load.

## Layout

```
src/
  config.js          frozen thresholds — the single source of truth
  env.js             env validation; MODE=live is a tripwire, not a capability
  safety/
    verdict.js       immutable value type every layer returns
    index.js         gate orchestrator: ordering, timeouts, fail-closed combine
    gate-context.js  the per-run ctx; every fetcher memoised, including rejections
    gate-layers.js   the layer registry; gate-result.js, gate-timeout.js
    token2022.js     extension enumeration + transfer-fee epoch inspection
    token2022-tlv.js TLV byte rules — length-checks every extension struct
    layer0-mint.js  layer1-sellsim.js  layer2-liquidity.js
    layer3-holders.js  layer4-deployer.js  layer5-thirdparty.js
    holderConcentration.js, holderInputs.js, layer0-facts.js
  data/              dexscreener, geckoterminal, jupiter, rugcheck,
                     httpJson (the only HTTP path), coerce, rateLimiter,
                     responseCache, payload
  rpc/               connection (retry + rate limit), mint (facts, holders,
                     creator, deployer history), history, rpc-errors,
                     rpc-validate, rpc-values, rpc-deps
  paper/             costModel, portfolio (immutable), engine, guards
  baseline/          monkey — the random-entry control group (opt-in)
scripts/
  check-token.js     one full gate run, exit 0/1/2
  scan.js            enumerate → screen → gate → ranked candidates
  record.js          append-only JSONL forward recorder
  paper.js           paper trading on live snapshots
  backtest-rug-filter.js   the one honest backtest
  lib/cli.js         shared presentation only — no business logic
```

## Finding small caps

The market-cap **window** is what makes a large multiple arithmetically possible: a 10x on a
$50M token needs $500M of new buying, so `STRATEGY.universe.maxMarketCapUsd` is the most
important filter for "small now, bigger later". The floor matters too — below it there is no
float to sell into, so the position is unexitable whatever the price prints.

```bash
npm run scan                      # trending feed, standard profile
npm run scan -- --early           # smaller caps, younger pairs
npm run scan -- --feed top        # broadest enumeration, by 24h volume
npm run scan -- --feed new        # freshly created pools (see the caveat below)
```

`--feed new` returns pools *minutes* old with sub-$20k caps. They fail the universe screen
almost every time, and that is structural rather than a tuning problem — use it to watch
launches, not to find entries. `--feed trending` is the population the momentum rules were
actually written against.

Two couplings to understand before turning `--early` on, both spelled out in
[src/config.js](src/config.js):

1. **The gate still binds, and binds first.** `SAFETY.layer2.minLiquidityUsd` is $30k, so most
   small caps are rejected regardless of the profile. Trading them means lowering that floor —
   a separate, deliberate edit.
2. **Thin pools raise the bar they were supposed to lower.** Round-trip cost is dominated by
   slippage, not fees. At a $40 position: a deep pool needs a **+3.2%** move to break even, a
   thin one **+13.3%**. Small caps offer more upside per dollar *and* charge more per trade.

### On position size

Fixed costs are ~$0.062 per round trip regardless of size, so they dominate a small position:

| Position | Deep pool | Thin new pool |
|---|---|---|
| $1 | needs **+9.4%** to break even | **+20.1%** |
| $10 | +3.7% | +13.9% |
| $40 | +3.2% | +13.3% |

A single $1 trade is not impossible — it needs a 9–20% move. The compounding is what kills
it: turning $1 into $1,000 at ~15% drag per round trip needs roughly **28 consecutive winning
trades with zero losses**, against a base rate where 98.6% of these tokens die. Below about
$5–10 the fixed costs dominate everything else.

## Evidence, not opinion

```bash
npm run record                    # append-only JSONL; the ONLY dataset this can ever have
npm run paper                     # paper trading on live snapshots
npm run paper -- --baseline       # ...with the random-entry control group alongside
npm run backtest:rug              # of the tokens approved, what fraction rugged
```

`record.js` matters more than it looks. Dexscreener has no history endpoint and the pool feeds
are live-only, so a window nobody sampled while it was live is gone forever — the dataset
cannot be reconstructed after the fact. `backtest:rug` refuses to report a rate on fewer than
30 labelled approvals, because "1 rug in 10 approvals" is not 10%, it is *no idea*.

The **baseline** (`--baseline`) is a control group: it buys at random, through the same gate,
with identical exits, so it answers one question — is the strategy better than luck? It is off
by default and costs nothing to run.
