/**
 * Single source of truth for every threshold in the system.
 * No magic numbers anywhere else in the codebase.
 * All objects frozen: config is read-only at runtime.
 */

/** Wallet-draining / unsellable-token vectors. A token must pass ALL layers. */
export const SAFETY = Object.freeze({
  /** Layer 0 - mint account inspection. One getAccountInfo. Deterministic. */
  layer0: Object.freeze({
    requireMintAuthorityRevoked: true,
    requireFreezeAuthorityRevoked: true,
    /**
     * ALLOWLIST, not blacklist. getExtensionTypes() enumerates every extension
     * present on the mint; anything not listed here is an instant reject.
     * A blacklist loses to each new extension Solana ships -- and it already had:
     * PausableConfig (creator can freeze ALL transfers), PermissionedBurn and
     * ScaledUiAmountConfig all post-date the well-known PermanentDelegate scam.
     * These six are metadata/grouping only and cannot move or block a holder's tokens.
     */
    allowedExtensions: Object.freeze([
      'metadataPointer',
      'tokenMetadata',
      'groupPointer',
      'tokenGroup',
      'groupMemberPointer',
      'tokenGroupMember',
    ]),
    /**
     * Documented reject reasons, for logging clarity. Detection is via the
     * allowlist above, so an unlisted future extension is still caught.
     */
    knownDangerousExtensions: Object.freeze({
      permanentDelegate: 'creator can burn or transfer tokens out of your wallet',
      permissionedBurn: 'creator can burn your tokens',
      transferHook: 'arbitrary program runs on every transfer; can revert your sell',
      pausableConfig: 'creator can pause all transfers; you cannot sell',
      nonTransferable: 'token cannot be transferred at all',
      defaultAccountState: 'new accounts can default to frozen; you cannot sell',
      transferFeeConfig: 'fee on transfer, possibly scheduled to spike later',
      mintCloseAuthority: 'mint can be closed',
      confidentialTransferMint: 'balances opaque; cannot verify supply or holders',
      interestBearingConfig: 'balance rebases; displayed amount is not real',
      scaledUiAmountConfig: 'displayed amount is scaled; deceptive',
    }),
    /** Reject if DefaultAccountState is Frozen (new accounts frozen == cannot sell). */
    rejectDefaultAccountStateFrozen: true,
    /** Any nonzero transfer fee is rejected by default: it compounds on round trip. */
    maxTransferFeeBps: 0,
    /**
     * TransferFeeConfig carries olderTransferFee AND newerTransferFee with epochs.
     * The classic trap is 0% now, 100% at a future epoch. Both must be inspected.
     */
    inspectScheduledTransferFee: true,
  }),

  /** Layer 1 - sell simulation. The definitive honeypot test: prove the exit exists. */
  layer1: Object.freeze({
    probeSizeSol: 0.05,
    /** Buy quote -> sell quote round trip. Above this implied loss, reject. */
    maxRoundTripLossPct: 8,
    /** simulateTransaction on the sell leg must succeed. Never skip. */
    requireSellSimulationSuccess: true,
    quoteSlippageBps: 300,
  }),

  /** Layer 2 - liquidity depth and LP ownership. */
  layer2: Object.freeze({
    minLiquidityUsd: 30_000,
    /** Our own order must not be a meaningful fraction of the pool. */
    maxPositionPctOfLiquidity: 0.5,
    /** Thin float on a large cap == manipulated price. */
    minLiquidityToMcapRatio: 0.03,
    requireLpBurnedOrLocked: true,
    minLpBurnedPct: 90,
  }),

  /** Layer 3 - holder and insider concentration. */
  layer3: Object.freeze({
    /** Excludes LP vaults and known locker programs. */
    maxTop10HolderPct: 25,
    maxSingleHolderPct: 8,
    /** Wallets funded from a common source == bundled launch posing as demand. */
    maxInsiderClusterPct: 15,
  }),

  /** Layer 4 - deployer reputation from on-chain history. */
  layer4: Object.freeze({
    maxDeployerPriorRugRate: 0.25,
    /** A brand-new deployer is allowed but scored down, not auto-rejected. */
    rejectUnknownDeployer: false,
    deployerHistoryLookbackDays: 180,
  }),

  /** Layer 5 - third-party veto. Cross-check only, never primary evidence. */
  layer5: Object.freeze({
    maxRugcheckScoreNormalised: 20,
  }),

  /**
   * FAIL CLOSED. Any check that throws, times out, or returns unparseable data
   * is a REJECT, not a pass. Inverted from normal error handling, deliberately.
   */
  failClosed: true,
  perLayerTimeoutMs: 4_000,
  totalGateTimeoutMs: 15_000,

  /** A held token can BECOME a honeypot. Re-run layers 0+1 on open positions. */
  recheckOpenPositionsSeconds: 30,
});

/** Position sizing and loss limits. Book is ~200-500 EUR. */
export const RISK = Object.freeze({
  bookSizeUsd: 450,
  positionSizeUsd: 100,
  maxConcurrentPositions: 4,
  maxDailyLossPct: 15,
  killSwitchConsecutiveLosses: 6,
  /** Hard ceiling on total SOL the bot may ever spend, regardless of logic. */
  absoluteSpendCapUsd: 500,
});

/**
 * Round-trip cost model. At a 40 USD position these are 2-4% -- the minimum
 * edge any strategy must clear before it makes a cent.
 */
export const COSTS = Object.freeze({
  solBaseFeeLamports: 5_000,
  priorityFeeLamports: 200_000,
  /** Associated token account rent. Refundable on close, but capital is tied up. */
  ataRentLamports: 2_039_280,
  routerFeeBps: 100,
  /** Slippage is never assumed: it is read from the live Jupiter quote. */
  useLiveQuoteForSlippage: true,
});

/** Free-tier rate limits. Exceeding these gets us throttled, so they are enforced. */
export const LIMITS = Object.freeze({
  dexscreener: Object.freeze({
    requestsPerMinute: 60,
    /** /tokens/v1/solana/{a,b,c...} accepts 30 mints per call. */
    maxMintsPerCall: 30,
  }),
  geckoterminal: Object.freeze({ requestsPerMinute: 30 }),
  jupiter: Object.freeze({ requestsPerMinute: 60 }),
  rugcheck: Object.freeze({ requestsPerMinute: 30 }),
  rpc: Object.freeze({ requestsPerSecond: 8 }),
});

export const ENDPOINTS = Object.freeze({
  dexscreener: 'https://api.dexscreener.com',
  geckoterminal: 'https://api.geckoterminal.com/api/v2',
  /**
   * Jupiter's High-Throughput Public tier.
   * `https://public.jupiterapi.com` provides reliable quotes without the 429 throttling
   * seen on the deprecated lite endpoint.
   */
  jupiterQuote: 'https://public.jupiterapi.com',
  rugcheck: 'https://api.rugcheck.xyz/v1',
});

/** Well-known mints/programs excluded from holder concentration maths. */
export const KNOWN = Object.freeze({
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  INCINERATOR: '1nc1nerator11111111111111111111111111111111',
});

/* ==========================================================================
 * Strategy, baseline and recorder.
 *
 * Everything below is a HYPOTHESIS, not a belief. The design record
 * (docs/specs/2026-08-24-solscalp-design.md) rejects historical candle
 * backtesting, so these numbers cannot have been fitted -- they are starting
 * points to be measured by forward paper trading against the monkey baseline.
 * Treat every value here as "the thing under test", never as "the thing known".
 * ========================================================================== */

/** Momentum scalping on already-surviving pairs. */
export const STRATEGY = Object.freeze({
  name: 'momentum-scalp-v0',

  /**
   * Which pairs are even eligible. Deliberately EXCLUDES fresh launches: the
   * design record shows the 100x entry window is the first minutes after launch,
   * which is a latency arms race this project does not enter.
   */
  universe: Object.freeze({
    minPairAgeMinutes: 60,
    maxPairAgeHours: 720,
    minVolumeH1Usd: 25_000,
    minTxnsH1: 40,
    /**
     * MARKET CAP WINDOW. A big cap cannot multiply: a 10x on a 50M token needs
     * 500M of new buying. The ceiling is what makes upside arithmetically possible
     * at all, and it is the single most important filter for "small now, big later".
     * The floor is not squeamishness -- below it there is no float to sell into, so
     * the position is unexitable at size regardless of what the price prints.
     */
    maxMarketCapUsd: 5_000_000,
    minMarketCapUsd: 50_000,
    /** Only SOL- and USDC-quoted pairs; an exotic quote hides its own rug risk. */
    quoteMints: Object.freeze([
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    ]),
  }),

  /** Entry conditions. ALL must hold, and the move must clear its own costs. */
  entry: Object.freeze({
    minPriceChangeM5Pct: 1.5,
    /** Allow entering explosive runners while avoiding extreme multi-candle blowoffs. */
    maxPriceChangeM5Pct: 150,
    minPriceChangeH1Pct: 5,
    /** Buys/sells in the last 5m. Below 1.0 the move is being sold into. */
    minBuySellRatioM5: 1.1,
    /** vol(m5) * 12 / vol(h1): is the move accelerating or just ongoing? */
    minVolumeAccelerationRatio: 1.5,
    /**
     * Gross move the entry is betting on.
     * Raised to 25% to align with the new profit targets.
     */
    expectedGrossMovePct: 25,
  }),

  /** Exits. The monkey baseline uses these IDENTICALLY; only entry differs. */
  exit: Object.freeze({
    // Set to Infinity so we NEVER hard-cap our winners. We let the trailing stop do the work.
    takeProfitPct: Infinity,
    stopLossPct: 15,
    trailingStopPct: 8,
    /** Trailing stop only arms once the position is this far up. */
    trailingArmsAtPct: 15,
    timeStopMinutes: 60,
    /** Let positions run using trailing stop and stop loss without panic-exiting on network hiccups. */
    exitOnGateRecheckFail: false,
  }),

  tickSeconds: 15,
});

/**
 * Universe profiles -- how early and how small we are willing to go.
 *
 * `standard` is STRATEGY.universe: already-surviving pairs. `early` hunts smaller
 * and younger, which is the only place a large multiple is arithmetically available.
 *
 * READ THIS BEFORE SWITCHING TO `early`. Three couplings make it a risk decision
 * rather than a tuning knob:
 *
 * 1. THE SAFETY GATE STILL BINDS, AND IT BINDS FIRST.
 *    SAFETY.layer2.minLiquidityUsd is 30_000. A 400k-cap token typically carries
 *    15-40k of liquidity, so the gate rejects most of this profile's targets no
 *    matter what is set here. Trading them means lowering that floor too -- a
 *    deliberate, separate edit, made with open eyes.
 *
 * 2. THERE IS A MECHANICAL FLOOR BELOW WHICH NO SETTING HELPS.
 *    Our own order must stay under SAFETY.layer2.maxPositionPctOfLiquidity (0.5%)
 *    of the pool, so the minimum workable depth is
 *        RISK.positionSizeUsd / (maxPositionPctOfLiquidity / 100)
 *      = 40 / 0.005 = 8_000 USD.
 *    Below that we are our own slippage in both directions. Shrink the position
 *    before shrinking the pool.
 *
 * 3. THIN POOLS RAISE THE BAR THEY ARE SUPPOSED TO LOWER.
 *    Round-trip cost is dominated by slippage, not fees. Measured with
 *    src/paper/costModel.js at a 40 USD position and SOL at 150:
 *        0.5%/leg slippage (deep pool) -> break-even needs a  +3.2% move
 *        5.0%/leg slippage (thin pool) -> break-even needs a +13.3% move
 *    So a small cap must move ~4x further before the first cent of profit. The
 *    upside is real and so is the toll; `early` buys the first by paying the second.
 */
export const UNIVERSE_PROFILES = Object.freeze({
  /** The default. Survivors only: the honestly testable variant. */
  standard: Object.freeze({
    minPairAgeMinutes: 60,
    maxPairAgeHours: 720,
    minVolumeH1Usd: 25_000,
    minTxnsH1: 40,
    maxMarketCapUsd: 5_000_000,
    minMarketCapUsd: 50_000,
  }),
  /**
   * Small and young. Still NOT a sniper: minPairAgeMinutes stays above zero on
   * purpose, because the first minutes after launch are a latency race this
   * project does not enter (see the design record) and are where the 98.6%
   * failure base rate is concentrated.
   */
  early: Object.freeze({
    minPairAgeMinutes: 0,
    maxPairAgeHours: Infinity,
    minVolumeH1Usd: 500,
    minTxnsH1: 5,
    maxMarketCapUsd: 750_000,
    minMarketCapUsd: 10_000,
    /**
     * The matching safety floor this profile needs, stated here so the coupling in
     * note 1 is impossible to miss. It is NOT applied automatically -- the gate
     * reads SAFETY.layer2, never this. Wiring it in is an explicit, separate act.
     */
    requiresSafetyOverride: Object.freeze({ 'SAFETY.layer2.minLiquidityUsd': 10_000 }),
  }),
});

/**
 * Random-entry baseline. If the strategy cannot beat this, that is worth
 * knowing for free -- so the ONLY difference permitted between them is entry
 * selection. Exits, sizing, costs and the safety gate are shared.
 *
 * Off by default: it is diagnostic scaffolding, not a feature. Scripts expose it
 * behind a --baseline flag so a normal run never mentions it.
 */
export const BASELINE = Object.freeze({
  name: 'monkey-v0',
  entryProbabilityPerTick: 0.02,
  /** Deterministic PRNG seed: a baseline that cannot be replayed is not a baseline. */
  seed: 20_260_824,
});

/** Forward recording. This is the only honest evidence source we can grow. */
/**
 * Where the paper bot publishes its book.
 *
 * Separate from the recording on purpose. The recording is what the MARKET did
 * and is never revised; this is what the BOT did. One file holding both would be
 * two datasets with different meanings and different lifetimes.
 *
 * Named JOURNAL rather than PAPER because MODES.PAPER already means something
 * else -- the trading mode, not a location.
 */
export const JOURNAL = Object.freeze({
  dir: 'data/paper',
  schemaVersion: 1,
});

export const RECORDER = Object.freeze({
  dir: 'data/recordings',
  snapshotIntervalSeconds: 5,
  /** Append-only JSONL, one file per UTC day. Never rewritten in place. */
  fileFormat: 'jsonl',
  schemaVersion: 1,
});

/**
 * Execution mode. There is no signing code in this repo, so 'live' is not a
 * capability -- it is a tripwire that must stay unreachable.
 */
export const MODES = Object.freeze({ PAPER: 'paper', LIVE: 'live' });

/**
 * Telegram notifications and the phone-side command menu.
 *
 * FAIL SOFT -- AND THIS IS THE ONE PLACE IN THE REPO THAT DOES.
 * Everything else here fails CLOSED: an error becomes a REJECT, because an
 * unanswered safety question must never read as permission. Notifications invert
 * that on purpose. A Telegram outage is not a safety signal, and letting it
 * block a gate check, abort a tick, or crash a recorder would turn a cosmetic
 * dependency into an operational one. So every send is best-effort: it retries
 * nothing, throws nothing, and is logged rather than raised.
 *
 * A missed alert is a missed alert. A blocked trading loop is a bug.
 */
export const NOTIFY = Object.freeze({
  /**
   * Per-mint quiet period. One token flickering in and out of signal would
   * otherwise empty the phone battery and train you to ignore the alerts.
   */
  minSecondsBetweenAlertsPerMint: 300,
  /** Global floor between any two messages, to stay inside Telegram's limits. */
  minSecondsBetweenAnyAlert: 3,
  /** Telegram hard-caps a message at 4096 chars; leave room for formatting. */
  maxMessageChars: 3_500,
  /** Which events are worth a buzz. Everything else stays in the terminal. */
  events: Object.freeze({
    /** Gate passed AND the entry rules fired -- the only genuine "look now". */
    wouldEnter: true,
    positionOpened: true,
    positionClosed: true,
    /** A held token started failing its recheck: it may have BECOME a honeypot. */
    gateRecheckFailed: true,
    killSwitch: true,
    /** Data-source outages, so silence is never mistaken for "nothing found". */
    dataSourceDown: true,
  }),
  /** Long-poll timeout for the command menu. Telegram allows up to 50s. */
  pollSeconds: 30,
});

/**
 * Outcome labelling -- what turns a recording into evidence.
 *
 * scripts/record.js writes every candidate with `outcome: null`. Without a
 * labelling pass the dataset can never be scored, and the one number this whole
 * project exists to produce -- of the tokens the filter approved, what fraction
 * rugged -- has no input. These thresholds define "rugged" OPERATIONALLY.
 *
 * THE DEFINITION HAS TO BE MECHANICAL, NOT INTERPRETIVE.
 *   "The dev rugged" is a story. "Liquidity fell by 80% or below $1k" is a
 *   measurement, and two people running it get the same answer. So the label is
 *   derived from liquidity and price only, and the RAW FIGURES ARE STORED
 *   ALONGSIDE IT -- if these thresholds turn out wrong, the dataset can be
 *   relabelled from the recorded evidence without re-collecting anything. That
 *   is the whole reason the numbers live here instead of inside the labeller.
 *
 * The $1k floor is not arbitrary: it is the figure Solidus Labs used when they
 * found 98.6% of 7M+ pump.fun tokens fell below it, so labelling against the
 * same line makes our rate directly comparable to that base rate.
 */
export const LABELS = Object.freeze({
  /**
   * Do not judge a token before this much time has passed. Label too early and
   * every survivor looks alive; the failure mode is a flattering dataset.
   */
  minAgeHoursBeforeLabelling: 24,
  /** Liquidity at or below this is a dead pool, whatever it started at. */
  ruggedBelowLiquidityUsd: 1_000,
  /** Or a collapse this large from what was recorded, even if still above the floor. */
  ruggedLiquidityDropPct: 80,
  /** A price collapse this deep counts too: the pool can persist while the token dies. */
  ruggedPriceDropPct: 90,
  /**
   * Re-label a mint at most this often. Labels are appended, never overwritten
   * (the recording is append-only), so without this the file would grow a new
   * label line on every run.
   */
  relabelAfterHours: 24,
  /**
   * How often the RECORDER runs a labelling pass. Not a command anyone has to
   * remember: 136 snapshots accumulated with zero labels before the gap was
   * noticed, which made the whole dataset unscoreable while looking healthy.
   * The recorder owns data/recordings and already talks to Dexscreener, so it is
   * the right owner -- a separate labelling process would compete for the same
   * per-IP rate limit.
   */
  autoLabelEveryMinutes: 30,
  /** Line type used for appended label records, so readers can tell them apart. */
  recordType: 'labels',
});
