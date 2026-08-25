/**
 * The per-run gate context: the only door a safety layer has to the network.
 *
 * WHAT THIS MODULE PROVES
 *   Every fetcher a layer can reach is MEMOISED for the whole gate run --
 *   rejections included -- so two layers asking the same question cost exactly
 *   one network call, and a failing call is not retried inside one run (a retry
 *   there would only burn rate-limit budget against a question already answered).
 *   Every real default is imported LAZILY, so importing the gate constructs no
 *   Connection, no rate limiter and no socket, and a test that injects fetchers
 *   never reaches src/rpc or src/data at all.
 *
 * WHAT IT DOES NOT PROVE
 *   Nothing about the data. A memoised value can still be stale (it was fetched
 *   once, at the start of this run) and a memoised REJECTION is handed to every
 *   later layer unchanged -- which is deliberate: under fail-closed, one
 *   unanswerable question must not read as answered on the second attempt.
 *   It also does not bound anything: the budget and the AbortSignal come from
 *   the orchestrator, and `signal` belongs to the layer that is running now.
 *
 * The fetcher that runs first supplies the signal the network call sees. If that
 * layer's budget expires mid-flight the memoised rejection is what every later
 * layer gets, i.e. an ERROR verdict, i.e. a reject. Fail closed, never a default.
 */

/** A logger that swallows everything. Explicit, so "no logger" is not a crash. */
const SILENT_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

/**
 * Fill in whatever a caller's logger is missing, so a layer can always call
 * `ctx.logger.warn` without probing for it first.
 * @param {object} [logger]
 * @returns {Readonly<{debug: Function, info: Function, warn: Function, error: Function}>}
 */
export function normaliseLogger(logger) {
  if (logger === undefined || logger === null) return SILENT_LOGGER;
  const merged = {};
  for (const level of LOG_LEVELS) {
    merged[level] = typeof logger[level] === 'function' ? logger[level].bind(logger) : () => {};
  }
  return Object.freeze(merged);
}

/**
 * The real fetchers, each behind a lazy dynamic import.
 *
 * The import specifiers are literal on purpose: a bundler or a reader can still
 * see every module the gate can reach.
 */
const DEFAULT_FETCHERS = Object.freeze({
  fetchMintFacts: (mint, deps) => import('../rpc/mint.js').then((m) => m.fetchMintFacts(mint, deps)),
  fetchHolders: (mint, deps) => import('../rpc/mint.js').then((m) => m.fetchHolders(mint, deps)),
  fetchCreator: (mint, deps) => import('../rpc/mint.js').then((m) => m.fetchCreator(mint, deps)),
  fetchDeployerHistory: (address, deps) =>
    import('../rpc/mint.js').then((m) => m.fetchDeployerHistory(address, deps)),
  getRoundTrip: (params, deps) =>
    import('../data/jupiter.js').then((m) => m.getRoundTrip(params, deps)),
  getBestPair: (mint, deps) =>
    import('../data/dexscreener.js').then((m) => m.getBestPair(mint, deps)),
  getTokenReport: (mint) => import('../data/rugcheck.js').then((m) => m.getTokenReport(mint)),
  getInsiderGraph: (mint) => import('../data/rugcheck.js').then((m) => m.getInsiderGraph(mint)),
});

/** Names a caller may override, and the `ctx` accessor each one feeds. */
const FETCHER_ALIASES = Object.freeze({
  fetchMintFacts: 'getMintFacts',
  fetchHolders: 'getHolders',
  fetchCreator: 'getCreator',
  fetchDeployerHistory: 'getDeployerHistory',
  getRoundTrip: 'getRoundTrip',
  getBestPair: 'getPair',
  getTokenReport: 'getTokenReport',
  getInsiderGraph: 'getInsiderGraph',
});

/**
 * Resolve the fetcher set: the module export name wins, the `ctx` accessor name
 * is accepted as an alias (callers think in `ctx.getPair`, the module is called
 * `getBestPair`), and anything not overridden falls back to the real default.
 * @param {object} deps
 * @returns {Readonly<Record<string, Function>>}
 */
export function resolveFetchers(deps = {}) {
  const resolved = {};
  for (const [name, alias] of Object.entries(FETCHER_ALIASES)) {
    const override = deps[name] ?? deps[alias];
    if (override !== undefined && typeof override !== 'function') {
      throw new TypeError(
        `deps.${name} must be a function, got ${override === null ? 'null' : typeof override}`,
      );
    }
    resolved[name] = override ?? DEFAULT_FETCHERS[name];
  }
  return Object.freeze(resolved);
}

/**
 * A single memo slot. The promise is stored before it settles, so concurrent
 * callers share one in-flight call, and a rejection is remembered exactly like a
 * value: one question, one answer, per run.
 */
function memoCell() {
  /** @type {Promise<any>|null} */
  let promise = null;
  return {
    /** @param {() => any} produce */
    get(produce) {
      if (promise === null) {
        // Wrapped so a synchronous throw inside `produce` is memoised too,
        // instead of escaping as a thrown error on the first call only.
        promise = Promise.resolve().then(produce);
      }
      return promise;
    },
    called: () => promise !== null,
  };
}

/** Memo slots keyed by a string argument (deployer address, round-trip probe). */
function keyedMemo() {
  const cells = new Map();
  return {
    /**
     * @param {string} key
     * @param {() => any} produce
     */
    get(key, produce) {
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = memoCell();
        cells.set(key, cell);
      }
      return cell.get(produce);
    },
    size: () => cells.size,
  };
}

/** Stable key for the round-trip probe parameters. Unknown fields are ignored. */
function roundTripKey(params) {
  const p = params === null || typeof params !== 'object' ? {} : params;
  return `${String(p.mint)}|${String(p.probeLamports)}|${String(p.slippageBps)}`;
}

/**
 * Build the context for ONE gate run.
 *
 * Returns a factory rather than the context itself, because `ctx.signal` is the
 * signal of the layer that is running *now* while the memoised fetchers are
 * shared by the whole run. `forSignal()` therefore hands out a frozen view per
 * layer over one set of memo cells.
 *
 * @param {object} p
 * @param {string} p.mint
 * @param {() => number} p.remainingMs whole-gate budget left, in ms
 * @param {object} [p.deps] fetcher overrides + `rpc`; see `resolveFetchers`
 * @param {object} [p.logger] already normalised, or anything logger-shaped
 * @returns {Readonly<{ forSignal: (signal?: AbortSignal) => object,
 *   stats: () => Readonly<Record<string, boolean|number>> }>}
 */
export function createGateContext({ mint, remainingMs, deps = {}, logger } = {}) {
  if (typeof mint !== 'string' || mint.length === 0) {
    throw new TypeError('createGateContext requires a mint string');
  }
  if (typeof remainingMs !== 'function') {
    throw new TypeError('createGateContext requires remainingMs()');
  }
  const fetchers = resolveFetchers(deps);
  const log = normaliseLogger(logger);

  const cells = Object.freeze({
    mintFacts: memoCell(),
    holders: memoCell(),
    creator: memoCell(),
    pair: memoCell(),
    tokenReport: memoCell(),
    insiderGraph: memoCell(),
  });
  const keyed = Object.freeze({ deployerHistory: keyedMemo(), roundTrip: keyedMemo() });

  /** Deps handed to a real fetcher: the shared RpcClient plus THIS layer's signal. */
  const fetchDeps = (signal) => Object.freeze({ rpc: deps.rpc, signal, logger: log });

  const forSignal = (signal) =>
    Object.freeze({
      mint,
      /** AbortSignal of the layer currently running. Pass it to every fetcher. */
      signal,
      remainingMs,
      logger: log,
      getMintFacts: () => cells.mintFacts.get(() => fetchers.fetchMintFacts(mint, fetchDeps(signal))),
      getHolders: () => cells.holders.get(() => fetchers.fetchHolders(mint, fetchDeps(signal))),
      getCreator: () => cells.creator.get(() => fetchers.fetchCreator(mint, fetchDeps(signal))),
      getDeployerHistory: (address) =>
        keyed.deployerHistory.get(String(address), () =>
          fetchers.fetchDeployerHistory(address, fetchDeps(signal)),
        ),
      getRoundTrip: (params) =>
        keyed.roundTrip.get(roundTripKey(params), () =>
          fetchers.getRoundTrip(params, fetchDeps(signal)),
        ),
      getPair: () => cells.pair.get(() => fetchers.getBestPair(mint, fetchDeps(signal))),
      getTokenReport: () => cells.tokenReport.get(() => fetchers.getTokenReport(mint)),
      getInsiderGraph: () => cells.insiderGraph.get(() => fetchers.getInsiderGraph(mint)),
    });

  /** Which questions this run actually asked. Logging and tests only. */
  const stats = () =>
    Object.freeze({
      mintFacts: cells.mintFacts.called(),
      holders: cells.holders.called(),
      creator: cells.creator.called(),
      pair: cells.pair.called(),
      tokenReport: cells.tokenReport.called(),
      insiderGraph: cells.insiderGraph.called(),
      deployerHistories: keyed.deployerHistory.size(),
      roundTrips: keyed.roundTrip.size(),
    });

  return Object.freeze({ forSignal, stats });
}
