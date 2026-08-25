/**
 * Deployer history for layer 4. Part of the src/rpc/mint.js contract, kept in its
 * own file so neither module outgrows the size limit; mint.js re-exports it.
 *
 * WHAT THIS MODULE PROVES
 * -----------------------
 * A LOWER BOUND on how many mints a wallet paid to create inside
 * SAFETY.layer4.deployerHistoryLookbackDays, derived from its own signature history:
 * transactions where this address is the fee payer AND an initializeMint /
 * initializeMint2 instruction (outer or CPI) appears. Plus, when RugCheck answers,
 * that third party's own rug/mint counters.
 *
 * WHAT IT DOES NOT PROVE -- read this before touching layer 4
 * ----------------------------------------------------------
 *  - **`priorRugRate === null` means UNKNOWN, and layer 4 MUST NOT read null as 0.**
 *    Zero would say "this deployer has never rugged", which is the single most
 *    dangerous sentence in this repo. Config decides what unknown means:
 *    SAFETY.layer4.rejectUnknownDeployer.
 *  - A rug rate is NOT derivable from chain data here, and none is fabricated. "Did
 *    this mint rug" is an outcome label requiring later price/liquidity history that
 *    the free tiers cannot serve retroactively; see the design record. The only rate
 *    reported is RugCheck's own, computed from RugCheck's own numerator and
 *    denominator -- never our on-chain mint count divided by someone else's rug
 *    count, which would be two incompatible windows posing as a ratio.
 *  - `mintCount` is a floor, not a census: public RPC prunes history, the walk is
 *    page-capped and the parsed-transaction inspection is capped, so
 *    `mintCountIsLowerBound` is usually true. A wallet can also fund a mint without
 *    paying its creation fee, and a serial rugger simply uses a fresh wallet each
 *    time -- which is why layer 4 is a scoring signal and not a veto.
 *  - `ruggedCount === null` is likewise unknown, not zero.
 *
 * FAIL CLOSED, honestly: unavailable evidence becomes null plus an entry in
 * `unverified`. It never becomes a number, and a third party being down never
 * becomes the gate's error.
 */

import { SAFETY } from '../config.js';
import {
  DEFAULT_MAX_SIGNATURE_PAGES,
  SIGNATURE_PAGE_LIMIT,
  feePayerOf,
  initialisedMintsIn,
  walkSignatures,
} from './history.js';
import { resolveRpc } from './rpc-deps.js';
import { describeError } from './rpc-errors.js';
import { requireAddress } from './rpc-validate.js';

/** Unit conversion: days -> milliseconds. */
const MS_PER_DAY = 86_400_000;

/**
 * How many parsed transactions we will read to look for initializeMint. One RPC call
 * each, against LIMITS.rpc.requestsPerSecond and a per-layer budget of
 * SAFETY.perLayerTimeoutMs, so this is deliberately small. Exceeding it does not
 * invent data: it sets mintCountIsLowerBound.
 */
export const DEFAULT_MAX_TX_INSPECTIONS = 25;

const SILENT = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/**
 * Scan the wallet's recent signatures for mint creations it paid for.
 * Never throws: a failed scan is reported as `available: false`, because "we could
 * not look" and "we looked and found none" are different facts.
 */
async function scanCreatedMints({ rpc, deployer, sinceMs, deps, logger }) {
  const maxInspections = deps.maxTransactionInspections ?? DEFAULT_MAX_TX_INSPECTIONS;
  let walk;
  try {
    walk = await walkSignatures({
      rpc,
      address: deployer,
      sinceMs,
      pageLimit: deps.signaturePageLimit ?? SIGNATURE_PAGE_LIMIT,
      maxPages: deps.maxSignaturePages ?? DEFAULT_MAX_SIGNATURE_PAGES,
      signal: deps.signal,
    });
  } catch (err) {
    logger.debug?.(`deployer history: signature walk failed for ${deployer}`, describeError(err));
    return Object.freeze({ available: false, mints: Object.freeze([]), truncated: true, scanned: 0 });
  }

  const candidates = walk.entries.slice(0, maxInspections);
  let truncated = walk.truncated || candidates.length < walk.entries.length;
  const mints = new Set();
  let scanned = 0;

  for (const entry of candidates) {
    if (deps.signal?.aborted === true) {
      truncated = true;
      break;
    }
    let parsedTx;
    try {
      parsedTx = await rpc.getParsedTransaction(entry.signature);
    } catch (err) {
      logger.debug?.(`deployer history: ${entry.signature} unreadable`, describeError(err));
      truncated = true;
      continue;
    }
    scanned += 1;
    // Only mints this wallet PAID to create count as its own. Merely appearing in
    // the transaction is not authorship.
    if (feePayerOf(parsedTx) !== deployer) continue;
    for (const mint of initialisedMintsIn(parsedTx)) mints.add(mint);
  }

  return Object.freeze({
    // A walk that never completed a single page looked at nothing at all, which is
    // different from "looked and found none".
    available: walk.pages > 0,
    mints: Object.freeze([...mints]),
    truncated,
    scanned,
  });
}

/** RugCheck wallet risk, or null. A third party being down is not our failure. */
async function readWalletRisk(deployer, deps, logger) {
  if (deps.getWalletRisk === null) return null; // explicitly disabled by the caller
  try {
    const getWalletRisk =
      deps.getWalletRisk ?? (await import('../data/rugcheck.js')).getWalletRisk;
    const risk = await getWalletRisk(deployer);
    return risk !== null && typeof risk === 'object' ? risk : null;
  } catch (err) {
    logger.debug?.(`deployer history: rugcheck wallet risk unavailable`, describeError(err));
    return null;
  }
}

const finiteOrNull = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * On-chain and third-party evidence about a deployer wallet.
 *
 * @param {string} address deployer wallet
 * `deps.getWalletRisk` defaults to the real RugCheck client (lazily imported, so a
 * test that injects one never loads it); pass `null` to run with on-chain evidence
 * only. Its failure is logged and becomes nulls, never a throw.
 *
 * @param {{ rpc?: object, getWalletRisk?: ((a: string) => Promise<object>)|null,
 *   nowMs?: number, signal?: AbortSignal, logger?: object,
 *   maxSignaturePages?: number, signaturePageLimit?: number,
 *   maxTransactionInspections?: number }} [deps]
 * @returns {Promise<Readonly<{ address: string, mintCount: number|null,
 *   ruggedCount: number|null, priorRugRate: number|null, knownMints: readonly string[],
 *   lookbackDays: number, source: string, mintCountIsLowerBound: boolean,
 *   scannedTransactions: number, unverified: readonly string[] }>>}
 * @throws rpcError(INVALID_ADDRESS) for a non-address argument
 */
export async function fetchDeployerHistory(address, deps = {}) {
  const deployer = requireAddress(address, 'fetchDeployerHistory(address)');
  const logger = deps.logger ?? SILENT;
  const lookbackDays = SAFETY.layer4.deployerHistoryLookbackDays;
  // Time arrives as a dep so the lookback window is deterministic under test.
  const nowMs = deps.nowMs ?? Date.now();
  const sinceMs = nowMs - lookbackDays * MS_PER_DAY;
  const rpc = await resolveRpc(deps);

  const scan = await scanCreatedMints({ rpc, deployer, sinceMs, deps, logger });
  const walletRisk = await readWalletRisk(deployer, deps, logger);

  // An on-chain count is only reported when it establishes something. A walk that was
  // cut short before it found any mint established nothing, and reporting 0 there
  // would read as "brand new deployer, nothing in its past".
  const onchainCount =
    !scan.available || (scan.truncated && scan.mints.length === 0) ? null : scan.mints.length;
  const mintCount = onchainCount ?? finiteOrNull(walletRisk?.mintCount);
  const ruggedCount = finiteOrNull(walletRisk?.rugCount);
  // RugCheck's rate only: its own numerator over its own denominator.
  const priorRugRate = finiteOrNull(walletRisk?.priorRugRate);

  const sources = [];
  if (scan.available) sources.push('onchain:initializeMint-scan');
  if (walletRisk !== null) sources.push('rugcheck:wallet-risk');

  const unverified = [];
  if (!scan.available) {
    unverified.push('mint count: the deployer signature history could not be read');
  } else if (onchainCount === null) {
    unverified.push(
      'mint count: the history walk was cut short before it found any mint, so nothing ' +
        'was established',
    );
  } else if (scan.truncated) {
    unverified.push(
      `mint count is a floor: the ${lookbackDays}-day history was truncated at the ` +
        'page / inspection cap',
    );
  }
  if (ruggedCount === null) {
    unverified.push('rugged count: no outcome labels exist for this wallet');
  }
  if (priorRugRate === null) {
    unverified.push(
      'prior rug rate is UNKNOWN (null), which must not be read as 0: no rate is ' +
        'derivable from chain history alone',
    );
  }

  return Object.freeze({
    address: deployer,
    mintCount,
    ruggedCount,
    priorRugRate,
    knownMints: scan.mints,
    lookbackDays,
    source: sources.length > 0 ? sources.join('+') : 'none',
    /** True whenever mintCount could be higher than what we managed to read. */
    mintCountIsLowerBound: !scan.available || scan.truncated,
    scannedTransactions: scan.scanned,
    /** Human-readable list of what this result did NOT establish. */
    unverified: Object.freeze(unverified),
  });
}
