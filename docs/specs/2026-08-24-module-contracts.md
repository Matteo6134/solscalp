# Module contracts — the interfaces every module MUST implement

**Status: authoritative.** These signatures are frozen. Implementations are written in
parallel against this document, so a module that invents its own shape breaks its callers.
If a contract here is wrong, fix it *here first* and say so — do not silently diverge.

Read [2026-08-24-solscalp-design.md](2026-08-24-solscalp-design.md) for *why*. This file is
only *what*.

## Universal rules (apply to every module below)

1. **Fail closed.** Missing, unparseable or timed-out data THROWS in `src/data` and `src/rpc`,
   and becomes `errored()` in `src/safety`. Never a default, never a zero.
2. **Unknown is `null`, never `0`.** `toNumberOrNull` semantics from `src/data/coerce.js`.
   A missing liquidity figure must not reach a safety layer as `0` ("no liquidity") or as
   `undefined` (which becomes `NaN` in arithmetic).
3. **Immutable.** Every value returned to a caller is `Object.freeze`d. Nothing mutates an
   argument. New objects, never in-place edits.
4. **Every threshold comes from `src/config.js`.** No numeric literal in module code except
   unit conversions (`1e9`, `100`, `60_000`) which must be named constants with a comment.
5. **No keypair, no signing, no `sendTransaction`, no `Keypair`, no private key, ever.**
   `simulateTransaction` is permitted only where explicitly stated (it is currently nowhere).
6. **Injectable dependencies.** Every network call arrives through a parameter with a real
   default, so tests never open a socket. Shape: `fn(args, deps = {})` with
   `const x = deps.x ?? realDefault`.
7. **JSDoc on every export**, and a file-header comment stating what the module proves and
   what it does *not* prove.
8. Tests live at `tests/<mirrored path>.test.js`, use `vitest`, and must pass
   `npm test`. Target 80%+ lines. Test the failure paths — for safety code the failure
   paths *are* the feature.

---

## `src/rpc/connection.js`

Wraps `@solana/web3.js` `Connection` with rate limiting (`LIMITS.rpc.requestsPerSecond`),
bounded retry for transient errors only, and fallback to `SOLANA_RPC_URL_FALLBACK`.
Uses `src/rpc/rpc-errors.js` for classification — do not re-implement it.

```js
/** @returns {RpcClient} frozen */
export function createRpcClient({ url, fallbackUrl, maxAttempts = 3, clock, connectionFactory } = {})

// RpcClient:
//   endpoint: string            (redacted via redactRpcUrl)
//   call<T>(name: string, fn: (connection: Connection) => Promise<T>): Promise<T>
//   getAccountInfo(address: string): Promise<AccountInfo|null>   // null = does not exist
//   getTokenSupply(address: string): Promise<{ amount: string, decimals: number, uiAmount: number|null }>
//   getTokenLargestAccounts(address: string): Promise<readonly {address,amount,decimals,uiAmount}[]>
//   getSignaturesForAddress(address: string, opts?): Promise<readonly object[]>
//   getParsedTransaction(signature: string): Promise<object|null>
//   stats(): object             // for logging only, never control flow
```

- Retry only when `isTransientRpcError(err)`; exponential backoff `2**attempt * 250ms`,
  deterministic (no jitter, no `Math.random` — `clock.sleep` is the seam).
- After `maxAttempts` on the primary, try `fallbackUrl` once (if distinct), then throw
  `rpcError(..., { code: RPC_ERROR.EXHAUSTED })`.
- Errors must never leak the API key: every message uses `redactRpcUrl`.
- `getAccountInfo` returning `null` is a *value*, not an error (the caller decides).

## `src/safety/token2022.js`

PURE functions over an already-unpacked mint. No network, no `Connection` import.

```js
/** Invert spl-token's ExtensionType enum: 18 -> 'metadataPointer'. Unknown -> 'unknown(41)'. */
export function extensionName(code)                      // (number) => string
/** @returns {{ names: readonly string[], codes: readonly number[], hadUninitializedEntries: boolean }} */
export function enumerateExtensions(unpackedMint)        // uses getExtensionTypes(mint.tlvData)
/** @returns {readonly string[]} names present that are NOT in the allowlist */
export function disallowedExtensions(names, allowlist = SAFETY.layer0.allowedExtensions)
/** Documented risk sentence for a name, or a generic "unknown extension" sentence. */
export function describeExtensionRisk(name)              // from SAFETY.layer0.knownDangerousExtensions
/**
 * BOTH fee schedules, because the classic trap is 0% now / 100% at a future epoch.
 * @returns {Readonly<{ present: boolean, olderEpoch: number|null, olderFeeBps: number|null,
 *   newerEpoch: number|null, newerFeeBps: number|null, maxFeeBpsEver: number|null,
 *   scheduledIncrease: boolean, withdrawWithheldAuthority: string|null,
 *   transferFeeConfigAuthority: string|null }>}
 */
export function inspectTransferFee(unpackedMint)
/** @returns {Readonly<{ present: boolean, state: string|null, frozen: boolean }>} */
export function inspectDefaultAccountState(unpackedMint)
/** @returns {Readonly<{ present: boolean, programId: string|null, authority: string|null }>} */
export function inspectTransferHook(unpackedMint)
/** @returns {Readonly<{ present: boolean, delegate: string|null }>} */
export function inspectPermanentDelegate(unpackedMint)
```

- `enumerateExtensions` filters out `uninitialized` (TLV zero-padding) but reports
  `hadUninitializedEntries` so it is never silently swallowed.
- Names are **camelCase**, matching `SAFETY.layer0.allowedExtensions` exactly.
- `maxFeeBpsEver = max(older, newer)` — that is the number layer 0 compares against
  `SAFETY.layer0.maxTransferFeeBps`. `scheduledIncrease = newerFeeBps > olderFeeBps`.
- A missing/parse-failing extension struct THROWS. Layer 0 turns that into a reject.

## `src/rpc/mint.js`

```js
/**
 * @returns {Promise<MintFacts>} frozen
 * @throws rpcError(ACCOUNT_NOT_FOUND | NOT_A_MINT | INVALID_ADDRESS | UNPARSEABLE)
 */
export async function fetchMintFacts(mint, deps = {})       // deps.rpc = RpcClient
// MintFacts:
//   mint, programId, isToken2022: boolean,
//   decimals, supplyRaw: string, supplyUi: number|null,
//   mintAuthority: string|null, freezeAuthority: string|null, isInitialized: boolean,
//   extensions: readonly string[], extensionCodes: readonly number[],
//   hadUninitializedEntries: boolean,
//   transferFee, defaultAccountState, transferHook, permanentDelegate,   // token2022.js shapes
//   raw: Readonly<{ owner, lamports, dataLength }>

/** @returns {Promise<{ holders: readonly object[], amountField: string, supply: number }>} */
export async function fetchHolders(mint, deps = {})
//   Shape MUST be consumable by normaliseHolders() in src/safety/holderConcentration.js:
//   entries { address, owner: string|null, amount: number, isLpVault: boolean, insider: boolean }
//   `amount` and `supply` MUST be in the SAME unit (raw base units).

/** @returns {Promise<Readonly<{creator, createdAtMs, signature}>|null>} null = unknowable */
export async function fetchCreator(mint, deps = {})
//   Oldest signature for the mint address; fee payer of that tx is the creator.
//   Public RPC often refuses deep history -> return null (unknown), never a guess.

/** @returns {Promise<Readonly<{ address, mintCount, ruggedCount, priorRugRate: number|null,
 *   knownMints: readonly string[], lookbackDays: number, source: string }>>} */
export async function fetchDeployerHistory(address, deps = {})
//   priorRugRate === null means UNKNOWN. Layer 4 must not read null as 0.
```

## `src/data/dexscreener.js`

Live snapshots only — Dexscreener has **no** history endpoint. Rate limited to
`LIMITS.dexscreener.requestsPerMinute` via `createRateLimiter`, batched at
`LIMITS.dexscreener.maxMintsPerCall` (30). Uses `getJson`/`buildUrl` from `httpJson.js`
and the coercers from `coerce.js`.

```js
/** @returns {Promise<readonly Pair[]>} every pair for the mint, deepest liquidity first */
export async function getPairsForMint(mint, deps = {})
/** @returns {Promise<Pair|null>} deepest-liquidity pair whose quote is in STRATEGY.universe.quoteMints */
export async function getBestPair(mint, deps = {})
/** @returns {Promise<Map<string, Pair|null>>} batches 30 mints per request */
export async function getBestPairs(mints, deps = {})

// Pair (frozen):
//   mint, pairAddress, dexId, chainId, url,
//   baseToken:{address,name,symbol}, quoteToken:{address,name,symbol},
//   priceUsd: number|null, priceNative: number|null,
//   liquidityUsd: number|null, fdv: number|null, marketCap: number|null,
//   volumeUsd: {m5,h1,h6,h24} (each number|null),
//   priceChangePct: {m5,h1,h6,h24} (each number|null),
//   txns: {m5:{buys,sells}, h1:{...}, h6:{...}, h24:{...}} (each number|null),
//   pairCreatedAtMs: number|null, ageMinutes: number|null,
//   fetchedAtMs: number, raw
```

- `marketCap` falls back to `fdv` (conservative: a larger cap lowers liquidity/cap).
- A mint with no pairs yields `[]` / `null` — that is a *fact*, not an error.
- `getBestPairs` MUST include every requested mint as a key (value `null` if absent), so a
  caller can never mistake "not returned" for "not requested".

## `src/data/geckoterminal.js`

The scarcest resource: 30 req/min. **Cache and never re-fetch the same window.**

```js
/** @returns {Promise<readonly Candle[]>} ascending by ts; Candle = {ts,open,high,low,close,volumeUsd} */
export async function getOhlcv({ poolAddress, timeframe = 'minute', aggregate = 1, limit = 100, beforeTimestamp }, deps = {})
/** @returns {Promise<readonly Pool[]>} live-only feed; there is no history endpoint */
export async function getNewPools({ page = 1 } = {}, deps = {})
/** @returns {Promise<readonly Pool[]>} pools trading a given mint */
export async function getPoolsForToken(mint, deps = {})

// Pool (frozen): poolAddress, dexId, name, baseMint, quoteMint,
//   priceUsd|null, liquidityUsd|null, fdv|null, volumeUsd24h|null,
//   createdAtMs|null, ageMinutes|null, fetchedAtMs, raw
```

- Candles use `requireFiniteNumber` — a candle without a close price is not a candle.
- `timeframe` must be one of `'minute'|'hour'|'day'`; anything else throws.
- Include a documented note that this feed is **live-only** and therefore cannot be used to
  enumerate a historical universe (see the design record's rejection of candle backtesting).

## The gate context (`ctx`) — passed to every layer

Built once per gate run by `src/safety/index.js`. Every fetcher is **memoized per run**
(including rejections: a retry inside one run would only burn rate-limit budget).

```js
ctx = Object.freeze({
  mint,                  // string
  signal,                // AbortSignal for THIS layer's budget
  remainingMs,           // () => number, whole-gate budget left
  getMintFacts,          // () => Promise<MintFacts>
  getHolders,            // () => Promise<{holders, amountField, supply}>
  getCreator,            // () => Promise<{creator,...}|null>
  getDeployerHistory,    // (address) => Promise<DeployerHistory>
  getRoundTrip,          // ({mint, probeLamports, slippageBps}) => Promise<RoundTrip>
  getPair,               // () => Promise<Pair|null>
  getTokenReport,        // () => Promise<RugcheckTokenReport>
  getInsiderGraph,       // () => Promise<InsiderGraph>
  logger,                // {debug,info,warn,error}
})
```

**Layer signature is uniformly `(mint, ctx) => Promise<Verdict>`** and every layer returns
`pass()` / `reject()` / `errored()` from `src/safety/verdict.js` — never throws.

## `src/safety/layer0-mint.js`

```js
export const LAYER = 'layer0-mint';
export async function checkMint(mint, ctx)     // (mint, ctx) => Promise<Verdict>
```
Rejects on: mint authority present (`requireMintAuthorityRevoked`), freeze authority present,
any extension not in the allowlist, `transferFee.maxFeeBpsEver > maxTransferFeeBps`,
`defaultAccountState.frozen`. Facts must include `extensions`, `disallowed`,
`transferFee`, and a `residualRisk` string. Every reject reason must name the mechanism
(use `describeExtensionRisk`), not just the flag.

## `src/safety/layer2-liquidity.js` — ADD, do not rewrite

`checkLiquidity(pair, options)` already exists and is tested. **Add** an adapter:
```js
export async function runLayer2(mint, ctx)
```
It resolves the pair via `ctx.getPair()`, merges LP evidence from `ctx.getTokenReport()`
(`markets[].lp.lpLockedPct`) when the report is already available *without* forcing a fetch
failure to become layer 2's failure, and delegates to `checkLiquidity`. A `null` pair is a
REJECT ("no pair: nothing to size against"). Do not change `checkLiquidity`'s existing
behaviour or signature.

## `src/safety/layer3-holders.js`

```js
export const LAYER = 'layer3-holders';
export async function checkHolders(mint, ctx)
```
Uses `src/safety/holderConcentration.js` (`buildExclusionSet`, `normaliseHolders`,
`readSupply`, `computeConcentration`, `resolveInsiderClusterPct`) — do **not** re-derive the
maths. Pool/vault addresses for the exclusion set come from `ctx.getPair()` (`pairAddress`)
and the rugcheck report's markets. Thresholds: `maxTop10HolderPct`, `maxSingleHolderPct`,
`maxInsiderClusterPct`. An unavailable insider graph is an ERROR (`resolveInsiderClusterPct`
throws by design) — never a zero.

## `src/safety/layer4-deployer.js`

```js
export const LAYER = 'layer4-deployer';
export async function checkDeployer(mint, ctx)
```
- `priorRugRate > maxDeployerPriorRugRate` → REJECT.
- Unknown deployer or unknown rug rate → **PASS with `facts.scoreDown === true` and
  `facts.unverified` listing what was not established**, unless
  `SAFETY.layer4.rejectUnknownDeployer` is true (then REJECT). Mirrors layer 2's
  `unverified` convention exactly.

## `src/safety/layer5-thirdparty.js`

```js
export const LAYER = 'layer5-thirdparty';
export async function checkThirdParty(mint, ctx)
```
**VETO ONLY.** Rejects when `scoreNormalised > SAFETY.layer5.maxRugcheckScoreNormalised`
(HIGHER = RISKIER — see the header of `src/data/rugcheck.js`) or `rugged === true`.
A pass must state in facts that third-party silence is *not* evidence of safety.
`scoreOutOfDocumentedRange` → REJECT (the API changed scale; fail closed).

## `src/safety/index.js` — the orchestrator

```js
export async function runGate(mint, deps = {}) // => GateResult
export async function recheckGate(mint, deps = {}) // layers 0+1 only, for open positions
export const RECHECK_LAYERS = Object.freeze(['layer0', 'layer1']);

// GateResult (frozen) = combine(verdicts, SAFETY.failClosed) plus:
//   mint, buyable, complete,
//   skipped: readonly string[],       // layers never run (short-circuit) -- NOT passed
//   residualRisks: readonly string[], // what a PASS did not prove, per layer
//   startedAtMs, finishedAtMs, totalMs
```

Behaviour, exactly:
- Validate the mint (base58, 32–44 chars) before any network call; invalid → a single
  `errored('gate', ...)` verdict and `buyable: false`.
- Iterate `normaliseOrder(deps.order ?? LAYER_ORDER)`; resolve each layer via
  `lazyLayer(LAYER_SPECS[id], deps.importer)` unless `deps.layers[id]` overrides it.
- Each layer runs inside `withTimeout(..., { timeoutMs: min(SAFETY.perLayerTimeoutMs,
  remainingGateMs), parentSignal: deps.signal, label: spec.name })`. Timeout or throw →
  `errored(spec.name, err)`.
- **Short-circuit on the first REJECT, and on the first ERROR when `SAFETY.failClosed`.**
  Layers that never ran go in `skipped`, and their `spec.unproven` text goes in
  `residualRisks`. `skipped` must never be conflated with a pass — that is invariant 1.
- If the whole-gate budget (`SAFETY.totalGateTimeoutMs`) is exhausted with no reject yet,
  remaining layers are `errored()` with a timeout reason — **not** `skipped`, because the
  gate result is then incomplete rather than decided.
- `residualRisks` also collects `facts.residualRisk` from every layer that did run.
- `deps` seams: `{ layers, order, importer, signal, now, logger, rpc, ...fetchers }`.

## `src/paper/engine.js` — pure decision functions, no network

```js
/** @returns {Readonly<{enter:boolean, reasons:readonly string[], signals:object}>} */
export function decideEntry({ pair, portfolio, gateResult, costBreakdown, now })
/** @returns {Readonly<{exit:boolean, reason:string|null, reasons:readonly string[]}>} */
export function decideExit({ position, pair, now, gateRecheck })
/** @returns {Readonly<{portfolio, actions: readonly object[], killSwitch: object}>} */
export function stepEngine(state, tick)
```
- Entry requires **all** of: gate `buyable`, universe filters (`STRATEGY.universe`),
  momentum conditions (`STRATEGY.entry`), a free position slot, and
  `clearsCosts(costBreakdown, STRATEGY.entry.expectedGrossMovePct).clears === true`.
- Exit order of precedence: gate-recheck failure → stop loss → trailing stop → take
  profit → time stop. First match wins and is reported as `reason`.
- `stepEngine` is a pure reducer over the frozen `portfolio` from `src/paper/portfolio.js`.
  It must call `openPosition`/`closePosition`/`markPositions`/`shouldKillSwitch` — never
  reimplement their accounting. It NEVER opens a position when the kill switch is tripped.
- No `Date.now()` inside these functions: time arrives as `now`/`tick.ts`.

## `src/baseline/monkey.js`

```js
/** Deterministic PRNG (mulberry32/xorshift). No Math.random anywhere in this repo. */
export function createRng(seed = BASELINE.seed)   // => { next(): number in [0,1), state() }
/** Random ENTRY, identical exits: the only permitted difference from the strategy. */
export function decideEntryRandom({ pair, portfolio, gateResult, costBreakdown, now, rng })
```
The monkey still respects the safety gate, position limits and the cost model — otherwise it
is not a baseline for *this* strategy, it is a different experiment. It ignores only the
`STRATEGY.entry` momentum signals, entering with probability
`BASELINE.entryProbabilityPerTick`. Exits MUST call the same `decideExit` as the strategy.

## `src/env.js`

```js
/** @returns {Readonly<{rpcUrl, rpcFallbackUrl, mode, telegram, isLive: false}>} */
export function loadEnv(source = process.env)
```
Loads `dotenv` at most once. `MODE=live` without `SOLSCALP_ALLOW_LIVE=I_UNDERSTAND` throws.
`MODE=live` *with* it **also throws** — there is no signing code in this repo, so live mode
is a tripwire, not a capability. The error must say so explicitly.

## `scripts/*` — thin wiring only, no business logic

All scripts: `#!/usr/bin/env node`, ESM, `main()` guarded so importing them runs nothing,
exit codes `0` = ok / `1` = blocked-or-negative-result / `2` = internal error, and they print
human-readable output to stdout with errors on stderr.

| Script | Job |
|---|---|
| `check-token.js <MINT>` | one full `runGate`; print every layer verdict, reasons, residual risks, and what was skipped. Exit 0 buyable / 1 blocked / 2 error. |
| `scan.js` | GeckoTerminal new pools + Dexscreener snapshots → `STRATEGY.universe` filter → gate the survivors → print a ranked candidate table. Respect every rate limit. |
| `record.js` | append JSONL snapshots (`RECORDER`) of the candidate universe + gate verdicts to `data/recordings/YYYY-MM-DD.jsonl`. Append-only, one line per snapshot, `schemaVersion`. This is the forward-test dataset — it must never be rewritten. |
| `paper.js` | run `stepEngine` on live snapshots with the monkey baseline **alongside**, printing both equity curves. Paper only; assert `MODES.PAPER`. |
| `backtest-rug-filter.js` | the one honest backtest: replay recorded gate decisions, join later outcome labels, and report *of the tokens the filter approved, what fraction rugged* against the 98.6% base rate. State sample size and refuse to report a rate on a sample too small to mean anything. |

---

# Addendum — resolutions from the implemented foundations

The `src/rpc` and `src/data` modules above are now **built and tested**. Where this document
was underspecified, the implementations resolved it as follows. These resolutions are now
part of the contract; downstream layers must code against them, not against the sketch above.

## New helper modules — reuse, never duplicate

The 400-line file rule forced several extractions. Import from these rather than
re-implementing their logic:

| Module | Provides |
|---|---|
| `src/rpc/rpc-validate.js` | `requireAddress`, `toPublicKey`, `requireHttpUrl`, `isBase58`, `unparseable`, `safeDetail`, `redactUrlsIn`, envelope/shape asserts. **The one definition of address validation in `src/rpc`.** |
| `src/rpc/rpc-values.js` | `isPlainObject`, `addressOrNull`, `amountOrNull`, `asBuffer`, `unparseable` |
| `src/rpc/rpc-deps.js` | `resolveRpc` — the lazy default-client seam. Use it to get an `RpcClient` without importing `connection.js` eagerly. |
| `src/rpc/history.js` | `walkSignatures`, `blockTimeMs`, `feePayerOf`, `initialisedMintsIn`, paging budgets |
| `src/rpc/holders.js` | `fetchHolders` (re-exported from `mint.js`) |
| `src/rpc/deployer-history.js` | `fetchDeployerHistory` (re-exported from `mint.js`), `DEFAULT_MAX_TX_INSPECTIONS` |
| `src/safety/token2022-tlv.js` | TLV byte rules: `normaliseMint`, `readExtensionCodes`, `readExtension`, struct length checks |
| `src/data/payload.js` | `MS_PER_SECOND`, `MS_PER_MINUTE`, `isPlainObject`, `stringOrNull`, `deepFreeze`, `frozenClone`, `assertBase58Address`, `assertPositiveInteger`, `readNowMs`, `minutesSince` |
| `src/data/responseCache.js` | `createResponseCache({maxEntries})` |
| `tests/fixtures/token2022-fixtures.js` | real TLV bytes + mint-account data, so the installed spl-token decoders actually run |

All four fetchers remain importable from `src/rpc/mint.js` exactly as specified.

## Resolutions that change how a caller must behave

1. **`createRpcClient()` refuses to guess an endpoint.** There is no built-in public-node
   default: it reads `url`/`fallbackUrl` from the parameter, else `SOLANA_RPC_URL` /
   `SOLANA_RPC_URL_FALLBACK`, else **throws**. The public-mainnet default lives in
   `src/env.js` instead. So the wiring is always
   `createRpcClient({ url: loadEnv().rpcUrl, fallbackUrl: loadEnv().rpcFallbackUrl })` —
   a script must call `loadEnv()` before building a client.
2. **`getOhlcv({ beforeTimestamp })` is in unix SECONDS**, matching the API's own
   `before_timestamp` and the parameter's lack of an `Ms` suffix. Every *other* timestamp in
   this project is epoch **milliseconds**. This is the one exception; do not "fix" it.
3. **`fetchDeployerHistory` may return `null` for `mintCount` and `ruggedCount`, not just for
   `priorRugRate`.** A truncated history walk that found no mint reports `null`, because `0`
   would read as "brand-new deployer". It also returns `mintCountIsLowerBound` (boolean),
   `scannedTransactions` (number) and `unverified` (readonly string[], already shaped for
   layer 2's `facts.unverified` convention). **Layer 4 must treat all three nullable fields as
   UNKNOWN.** `priorRugRate` is only ever RugCheck's own rate — our on-chain mint count is
   never used as a denominator for someone else's rug count.
4. **`fetchHolders` leaves `holder.owner === null` unless `deps.resolveOwners` is injected.**
   `getTokenLargestAccounts` returns token accounts, not owners, and resolving them costs an
   extra `getMultipleAccounts` per 100 entries. Consequence for layer 3: the exclusion set can
   miss an LP vault that is only matchable *by owner*, which yields a **false REJECT, never a
   false PASS** — acceptable under fail-closed, but layer 3 must record it in
   `facts.unverified` so the reject is not mistaken for real concentration.
5. **`fetchCreator` may return a non-null object whose `createdAtMs` is `null`** (block time
   pruned but the creator known). The whole object is `null` only when the creator itself is
   unknowable.
6. **`MintFacts.supplyUi` is derived** from `supplyRaw` and `decimals`, not a second RPC call
   (layer 0 stays at one `getAccountInfo`). `supplyRaw` is authoritative; `supplyUi` is `null`
   when the division is not representable.
7. **`getBestPairs` returns `Object.freeze(map)`.** `Object.freeze` cannot seal a `Map`'s
   entries, so `.set` still works. Treat it as read-only by contract; the `Pair` values inside
   *are* deeply frozen.
8. **A truncated TLV extension struct throws.** spl-token 0.4.15 silently decodes a short or
   empty buffer into the all-zero PublicKey, so a `TransferHook` declaring 64 bytes and
   storing none would otherwise read as "present, no authority". `token2022-tlv.js`
   length-checks every struct. Any other code decoding TLV must do the same.
9. **GeckoTerminal caching has two regimes:** a closed window (`beforeTimestamp` supplied) is
   cached with no expiry; every live request (latest candles, `new_pools`, token pools) is
   cached for one `STRATEGY.tickSeconds`. Failures are **never** cached. Call `clearCache()`
   for fresher data.
10. **Layer 4 must pass `deps.signal`.** `fetchDeployerHistory` can cost 1 signature page plus
    25 `getParsedTransaction` calls; at `LIMITS.rpc.requestsPerSecond = 8` that can exceed
    `SAFETY.perLayerTimeoutMs`. Both the walk and the inspection loop honour the signal and
    mark the result truncated.

## Known open items (not blockers)

- RPC rate limiting converts `LIMITS.rpc.requestsPerSecond * 60` into the per-minute limiter,
  which permits a burst inside one second. Documented in `connection.js`; the fix if a
  provider ever enforces a true per-second cap is a second limiter with `windowMs: 1000`.
- `describeError(err)` walks the `cause` chain, whose upstream messages are **not** redacted.
  Our own messages, `endpoint` and `stats().lastError` always are. Log `err.message`, never
  the raw chain.
- Paging budgets (`SIGNATURE_PAGE_LIMIT`, `DEFAULT_MAX_SIGNATURE_PAGES`,
  `DEFAULT_MAX_TX_INSPECTIONS`) and `responseCache`'s `DEFAULT_MAX_ENTRIES` are exported named
  constants rather than config keys, because `src/config.js` was off-limits to the
  implementers. If they should be centralised they belong in `LIMITS.rpc`.
