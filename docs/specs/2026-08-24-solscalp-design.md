# SOLSCALP — design record

**Date:** 2026-08-24
**Status:** safety core under construction

## Origin

The brief was "autotrade on a DEX scanner, flip $1 into a lot of money", citing CYBERLEEK:
200 EUR a few days ago would supposedly now be 20k+.

### What the CYBERLEEK numbers actually say

Mint `ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg`. Rode the GTA 6 leak narrative:
+14x in 24h, ATH **$0.03371 on 2026-08-23** (~$25M mcap, $36M volume), then -35% off ATH
within a day. ~730M circulating of 1B supply.

200 EUR -> 20k EUR is **100x**. Working back from the ATH, that requires an entry near
**$0.00034/token ≈ $250k market cap**. Launchpad graduation is at $69k. So the entry window
was the **first minutes after launch**, not "a few days ago" — and at that moment the token
was indistinguishable from every other fresh mint.

### Base rates that shape the design

- Solidus Labs: **98.6%** of 7M+ pump.fun tokens fell below $1k liquidity or were rugs /
  manipulative schemes. Only ~97k of 7M ever held >$1k liquidity.
- 93% of 388k Raydium pools showed **soft-rug** characteristics.
- Flip Research: up to **93% of Solana trading activity is non-organic**. Bots are 60-80%
  of volume. Bitquery documented one wallet seeding 200 bots with 0.5 SOL each to fake
  $500k of volume in 12 hours — setup took 52 seconds.
- One project spent **4 SOL** to reach #7 trending on Dexscreener off $400k fake volume.
- Token-2022 extension abuse: **$50M+ losses in Q1 2026**. RugCheck flags **>40% of new
  Solana tokens** as carrying the Permanent Delegate extension.

Consequence: a blind-sniper portfolio needs its ~1.4% survivors to average **>71x net of
costs** merely to break even.

### Correction (2026-08-25): the $1 arithmetic

This section originally claimed "$1 is mechanically impossible — $1 in becomes ~$0.30 out".
**That overstated it, and the error is worth recording.** It counted the $0.306 ATA rent as a
loss, but that rent is *refundable* when the token account closes —
[src/paper/costModel.js](../../src/paper/costModel.js) argues explicitly that including it in
`totalUsd` double-counts, and treats it as tied-up capital instead.

Measured with the real cost model (SOL at $150):

| Position | Deep pool (0.5%/leg) | Thin new pool (5%/leg) | Capital tied up |
|---|---|---|---|
| $1 | break-even at **+9.4%** | **+20.1%** | $1.37 |
| $10 | +3.7% | +13.9% | $10.37 |
| $40 | +3.2% | +13.3% | $40.37 |

So a $1 trade is not impossible; it needs a 9–20% move, and small tokens move that much
routinely. **The compounding is the real obstacle.** At ~15% drag per round trip, turning $1
into $1,000 requires ~28 consecutive winning trades with zero losses — against the 98.6% base
rate above. The fixed cost is ~$0.062 per round trip regardless of size, which is 6.2% of a $1
position and 0.15% of a $40 one; below roughly $5–10 it dominates everything else.

The conclusion the design rests on is unchanged. The reasoning is now correct rather than
merely directionally right.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Strategy | Momentum scalping on **already-surviving** pairs | Only variant that is honestly testable; avoids the MEV latency arms race |
| Book size | ~200-500 EUR, $40 positions, max 8 concurrent | Sets the ~2-4% round-trip cost floor any edge must clear |
| Hold horizon | **Determined empirically**, not assumed | Makes the evidence engine the centre of the project |
| Data | Free keyless tiers only | Dexscreener + GeckoTerminal + Jupiter + RugCheck = 0 EUR/mo |
| Execution | **Paper only.** No keypair in the repo | A bot bug is a bigger threat to 400 EUR than a bad trade |
| Core value | The **safety gate** | The one component that is deterministic rather than predictive |

### Rejected: historical candle backtesting

Dropped deliberately. Two independent reasons:

1. **The features are fabricated.** ~93% of volume is non-organic. A "volume breakout"
   strategy fitted to that data learns *someone's advertising budget* and buys precisely
   when they want exit liquidity.
2. **No repeated observation.** Each token has one life. There is no stationary process to
   estimate, and parameters fitted to the January meta describe a market structure that no
   longer exists. Moves are exogenous narrative shocks — no candle contains "GTA 6 leak".

Also fatal for pool-level history: **the universe is not retroactively enumerable.**
Dexscreener has no history endpoint, and GeckoTerminal's new-pools feed is live-only. You
cannot reconstruct "which pools existed on 1 March with $50k liquidity". Selecting today's
survivors and backtesting their candles conditions on the 1.4% — every dip recovered by
construction.

### Accepted: what *is* honestly testable

**The rug filter is properly backtestable**, and this is the key asymmetry:

1. Features are **on-chain facts** (mint flags, LP state, deployer history), not fakeable volume.
2. The label is **objective** — did it rug, yes or no.
3. The universe **is** retroactively enumerable here: every mint created by a launchpad
   program in any date window is recoverable from on-chain program history, *including the
   dead ones*. Complete population, zero survivorship bias.

So one honest, reproducible number can be measured: **of the tokens the filter approved,
what fraction rugged, against the 98.6% base rate?**

**Forward paper trading** is the other valid evidence source — immune to survivorship and
lookahead bias by construction, because there is no history to cheat on. Slow, but real.
A **monkey baseline** (random entry, identical exits) runs alongside; if the strategy cannot
beat random, that is worth knowing for free.

## Architecture — the safety gate

Six layers, cheapest-and-most-decisive first, short-circuiting on first reject. A token must
**affirmatively pass all of them**.

| Layer | Check | Cost |
|---|---|---|
| 0 | Mint account: authorities revoked + Token-2022 extension **allowlist** | 1 RPC call, ~50ms |
| 1 | **Sell simulation** — prove an exit exists before committing SOL | 2 Jupiter quotes |
| 2 | Liquidity depth, LP burned/locked, liquidity:mcap ratio | free |
| 3 | Holder + insider-cluster concentration (LP vaults excluded) | RPC + RugCheck |
| 4 | Deployer reputation from prior mints | on-chain history |
| 5 | RugCheck `score_normalised` — **veto only, never primary evidence** | free |

### Layer 0 is an allowlist, not a blacklist

`getExtensionTypes()` enumerates every extension on a mint, so anything not on a six-item
metadata/grouping allowlist is rejected. This was originally designed as a blacklist;
inverting it was not cosmetic — verifying the live `@solana/spl-token` enum revealed three
vectors the blacklist would have missed: **PausableConfig** (creator freezes all transfers =
honeypot), **PermissionedBurn**, and **ScaledUiAmountConfig**. A blacklist loses to every
extension Solana ships next.

### Three invariants

- **Fail closed.** Any error, timeout, or unparseable response is a REJECT. Inverted from
  normal error handling, deliberately. "Skipped" is recorded distinctly from "passed".
- **Keep checking after buying.** A held token can *become* a honeypot — a scheduled fee
  activates, a hook appears. Layers 0+1 re-run every 30s on open positions; any change fires
  an immediate exit.
- **Never overstate what was proven.** A quote round trip proves a *route* exists, not that
  the sell *transaction* would land. The gate returns `residualRisks` naming what is unproven.

## Honest limits

- Passing the gate means **"probably not stolen from you"**, not "profitable". A clean token
  still goes to zero if nobody buys. This removes theft risk, not market risk.
- **Soft rugs pass every hard check.** A dev quietly selling into buyers breaks no rules, and
  93% of Raydium pools show that pattern. Only holder-flow monitoring catches it.
- The full gate costs 200-800ms/token. Fine for momentum scalping; fatal for sniping.

## Sources

- Solidus Labs — Solana rug pulls & pump-and-dumps
- Flip Research, "SOL: The Emperor's New Clothes" — 93% non-organic
- Bitquery — Solana's volume numbers are a lie
- Neodyme — SPL Token-2022: don't shoot yourself in the foot with extensions
- RugCheck API — api.rugcheck.xyz/swagger/index.html
- Dexscreener API (60 req/min, 30 mints/call, no history) / GeckoTerminal API (30 req/min, 6mo OHLCV)

## Field notes (2026-08-25) — what running it actually revealed

Wiring the scripts against live data surfaced three things no unit test would have caught.

### 1. Layer 1 was dead, and fail-closed hid it perfectly

`ENDPOINTS.jupiterQuote` pointed at `quote-api.jup.ag/v6`, which **no longer resolves at all**
(DNS `ENOTFOUND`). Layer 1 — the sell simulation, the check this document calls the definitive
honeypot test — therefore errored on every single token, which under fail-closed became a
REJECT on every single token.

Nothing looked broken. The gate answered promptly and confidently, and it rejected 100% of
what it saw. Fail-closed did its job (no false passes, ever) and in doing so made a total
outage indistinguishable from a run of bad tokens. Fixed to `lite-api.jup.ag/swap/v1`, the
keyless tier.

**The lesson is about monitoring, not about Jupiter.** A fail-closed gate needs a liveness
signal separate from its verdicts, or "everything is a rug" and "the check is broken" look the
same from outside. A pass *rate* of exactly zero should be treated as an alarm.

### 2. `new_pools` is the wrong feed for finding entries

The GeckoTerminal new-pools feed returns pools *minutes* old with sub-$20k caps. Screened
against even `UNIVERSE_PROFILES.early` (15 minutes, $20k floor), **zero of 20 survived**, every
time, on every sample. That is structural: the feed's population and the strategy's population
barely intersect.

`trending_pools` and `/pools?sort=h24_volume_usd_desc` were added for this reason, and against
the trending feed candidates do reach the gate. Both remain gameable — this document already
notes a project that bought #7 trending for 4 SOL — so a high placement means "someone is
spending to be seen", which is information but never demand and never safety.

### 3. The public RPC cannot support layer 3

`api.mainnet-beta.solana.com` returns 429 on `getTokenLargestAccounts` under any real load, so
layer 3 errors and the token is rejected. The env warning says this, and it is not
conservatism: on the public endpoint the gate's answer is dominated by rate limiting rather
than by the tokens. Any pass rate measured without a dedicated endpoint is measuring the RPC,
not the filter.

### A market-cap window was missing entirely

The universe filter had no cap ceiling, so it would have sized a position in a $50M token
identically to a $400k one. A ceiling is what makes a large multiple arithmetically possible at
all — a 10x on $50M needs $500M of new buying — and a floor is needed because below it there is
no float to exit into. Both now live in `STRATEGY.universe`, with an `early` profile in
`UNIVERSE_PROFILES` for smaller and younger pairs.
