/**
 * Layer 0 -- the mint account itself. ONE getAccountInfo, and it kills most scams
 * outright, deterministically, before a single quote is requested.
 *
 * WHAT THIS LAYER PROVES (read this before trusting a PASS)
 * --------------------------------------------------------
 * That at the slot the mint account was read, its bytes said:
 *   - no mint authority existed, so the supply cannot be inflated;
 *   - no freeze authority existed, so no single instruction can lock your account;
 *   - every Token-2022 extension present is on SAFETY.layer0.allowedExtensions --
 *     an ALLOWLIST of six metadata/grouping extensions, none of which can move,
 *     burn or block a holder's tokens;
 *   - both transfer-fee schedules, the current one AND the scheduled one, sit at or
 *     below SAFETY.layer0.maxTransferFeeBps;
 *   - new token accounts do not default to frozen.
 * These are on-chain facts, not predictions. This is the only layer in the gate
 * that is deterministic rather than an inference from someone else's data.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - NOTHING ABOUT LIQUIDITY. A mint with flawless flags can sit on an empty,
 *    already-drained or never-funded pool. That is layer 2.
 *  - NOTHING ABOUT HOLDERS. One wallet may hold the entire supply and dump it on
 *    the first bid. That is layer 3.
 *  - NOTHING ABOUT WHETHER A ROUTE OUT EXISTS. This layer never quotes and never
 *    simulates; a mint can be spotless and still have no sell route. That is layer 1.
 *  - NOTHING ABOUT THE FUTURE. This is one slot of bytes. An authority that is
 *    revoked now may have been used five minutes ago, and a mint whose authorities
 *    are live can add a fee, a hook or a pause after this read -- which is exactly
 *    why SAFETY.recheckOpenPositionsSeconds re-runs layers 0+1 on open positions.
 *  - NOTHING ABOUT A SOFT RUG. A legitimate-looking mint is the normal shape of a
 *    soft rug: the dev quietly sells into buyers, breaking no mint-level rule at
 *    all. 93% of Raydium pools show that pattern, and every one of them passes
 *    every hard check in this file.
 *  - NOTHING ABOUT OFF-MINT CONTROL. Pool authorities, launchpad programs and
 *    upgradeable programs holding the LP are invisible from the mint account.
 *
 * FAIL CLOSED. checkMint NEVER throws and NEVER returns PASS on incomplete
 * evidence: an unreadable, missing, mismatched or type-wrong MintFacts becomes
 * errored(), which the gate treats as a REJECT under SAFETY.failClosed. A missing
 * `mintAuthority` field is not a revoked authority, and unknown extensions are
 * `null`, never `[]`. The shape rules live in ./layer0-facts.js.
 *
 * Reasons are COLLECTED, not short-circuited: a token gets one verdict listing
 * every mechanism that condemned it, so the log explains the token fully instead
 * of naming whichever flag happened to be checked first.
 *
 * No network access of its own: the single account read arrives through
 * `ctx.getMintFacts()` (src/rpc/mint.js), memoized once per gate run. No keypair,
 * no signing, no simulation.
 */

import { SAFETY } from '../config.js';
import { describeValue, readMintFacts } from './layer0-facts.js';
import { describeExtensionRisk, disallowedExtensions } from './token2022.js';
import { errored, pass, reject } from './verdict.js';

export const LAYER = 'layer0-mint';

/**
 * Honest, machine-readable statement of this layer's epistemic limits, mirroring
 * layer 1's SIMULATION_LIMITATION. `residualRisk` travels on every verdict so a
 * PASS can never be logged as "this token is safe".
 */
export const MINT_INSPECTION_LIMITATION = Object.freeze({
  layer: LAYER,
  method: 'single-account-read-extension-allowlist',
  proven: Object.freeze([
    'at the slot that account was read, no mint authority existed: the supply cannot be inflated',
    'at that same slot, no freeze authority existed: no single instruction can lock your account',
    'every Token-2022 extension present is on the six-item metadata/grouping allowlist',
    'both transfer-fee schedules, current and scheduled, were within the configured limit',
    'new token accounts do not start life frozen',
  ]),
  notProven: Object.freeze([
    'nothing about liquidity: perfect mint flags are compatible with an empty or drained pool',
    'nothing about holders: one wallet may hold the entire supply',
    'nothing about whether a route out exists -- this layer never quotes and never simulates',
    'nothing about the future: authorities can be re-added and fees can activate after this read',
    'nothing about a SOFT RUG, which is the normal shape of a legitimate-looking mint: a dev ' +
      'selling into buyers breaks no mint-level rule and passes every check in this layer',
    'nothing about off-mint control: pool authorities, launchpad programs and the owner of the ' +
      'LP position are all invisible from the mint account',
  ]),
  residualRisk:
    'layer 0 proves the mint cannot be inflated, frozen or taxed by its own account flags; ' +
    'it proves nothing about liquidity, holders, an exit route or a soft rug -- a ' +
    'legitimate-looking mint can still be a soft rug and can still go to zero',
  /** What the later layers exist to establish, since layer 0 structurally cannot. */
  mitigatedBy: Object.freeze([
    'layer1-sellsim: a quote round trip showing an exit route exists',
    'layer2-liquidity: pool depth, LP burn/lock and liquidity-to-cap ratio',
    'layer3-holders: holder and insider-cluster concentration',
    'layer4-deployer: prior rug rate of the deployer address',
    'layer5-thirdparty: an independent scanner veto',
  ]),
  /** Detection is by allowlist, so an extension Solana ships tomorrow is still caught. */
  allowlist: SAFETY.layer0.allowedExtensions,
  recheck:
    'a held token can BECOME a honeypot, so this layer is re-run on open positions every ' +
    `${SAFETY.recheckOpenPositionsSeconds}s`,
});

/**
 * What layer 0 structurally cannot establish, in the same machine-readable
 * `facts.unverified` form layers 2 and 4 use, so a PASS is never mistaken for a
 * clean bill of health.
 */
const UNVERIFIED_BY_LAYER0 = Object.freeze([
  'liquidityDepth',
  'lpBurnedOrLocked',
  'holderConcentration',
  'exitRouteExists',
  'deployerReputation',
  'softRugBehaviour',
]);

/** Added when the account bytes themselves were never read: strictly less is known. */
const MINT_BYTES_UNREAD = 'mintAccountBytes';

/* -------------------------------------------------------------------------- */
/* the rules -- every reason names the MECHANISM, not the flag                 */
/* -------------------------------------------------------------------------- */

function authorityReasons(facts) {
  const reasons = [];
  if (SAFETY.layer0.requireMintAuthorityRevoked && facts.mintAuthority !== null) {
    reasons.push(
      `mint authority is still live (${facts.mintAuthority}): the creator can mint unlimited ` +
        'new supply at any moment and dilute your position to nothing, so the supply you ' +
        'priced is not the supply you own a share of',
    );
  }
  if (SAFETY.layer0.requireFreezeAuthorityRevoked && facts.freezeAuthority !== null) {
    reasons.push(
      `freeze authority is still live (${facts.freezeAuthority}): the creator can freeze your ` +
        'token account, after which you cannot sell at any price -- one instruction from them ' +
        'makes the position unexitable',
    );
  }
  return reasons;
}

/**
 * One reason per disallowed extension, each naming what its holder can do to you
 * rather than merely printing a flag name. `describeExtensionRisk` supplies the
 * mechanism, including a deliberately pessimistic sentence for an extension this
 * library has never heard of -- which is the whole point of an allowlist.
 */
function extensionReasons(disallowed) {
  return disallowed.map(
    (name) =>
      `Token-2022 extension ${name} is not on the layer 0 allowlist: ` +
      `${describeExtensionRisk(name)}`,
  );
}

/**
 * The scheduled-fee trap gets its own sentence: a mint taxing 0% today and 100% at
 * a future epoch reads as clean to anything that only inspects the fee in force
 * right now. `maxFeeBpsEver` is the max of BOTH schedules, which is how
 * SAFETY.layer0.inspectScheduledTransferFee is honoured.
 */
function transferFeeReasons(transferFee) {
  const limit = SAFETY.layer0.maxTransferFeeBps;
  if (!transferFee.present || transferFee.maxFeeBpsEver <= limit) return [];

  const peak = transferFee.maxFeeBpsEver;
  const tail =
    'a transfer fee is charged on the way in AND on the way out, so it compounds across the ' +
    'round trip, and it is taken out of your proceeds';

  if (transferFee.scheduledIncrease) {
    return [
      `SCHEDULED FEE INCREASE: the transfer fee rises from ${transferFee.olderFeeBps} bps at ` +
        `epoch ${transferFee.olderEpoch} to ${transferFee.newerFeeBps} bps at epoch ` +
        `${transferFee.newerEpoch}, so the ${peak} bps peak exceeds the ${limit} bps limit. ` +
        'The classic trap is 0% now and 100% at a future epoch: the fee in force today proves ' +
        `nothing, because the spike is already committed on chain. ${tail}`,
    ];
  }
  return [
    `transfer fee ${peak} bps exceeds the ${limit} bps limit (current schedule ` +
      `${transferFee.olderFeeBps} bps at epoch ${transferFee.olderEpoch}, newer schedule ` +
      `${transferFee.newerFeeBps} bps at epoch ${transferFee.newerEpoch}): ${tail}`,
  ];
}

function defaultAccountStateReasons(facts) {
  if (!SAFETY.layer0.rejectDefaultAccountStateFrozen) return [];
  if (!facts.defaultAccountState.frozen) return [];
  return [
    `new token accounts default to ${facts.defaultAccountState.state ?? 'frozen'}: the account ` +
      'that would hold this token starts FROZEN, so you can buy and then cannot sell until the ' +
      'creator chooses to thaw you -- a honeypot needing no further action from them',
  ];
}

function initialisationReasons(facts) {
  if (facts.isInitialized) return [];
  return [
    'mint account is not initialized: its authorities and extensions are not final, so ' +
      'nothing read from it can be trusted as the state a buyer would be exposed to',
  ];
}

/**
 * The whole layer-0 rule set as a PURE function of MintFacts: no clock, no
 * randomness, no network, so it is deterministic and separately testable.
 *
 * Collects EVERY applicable reason rather than returning the first, because a mint
 * with a live authority and three dangerous extensions is a different animal from
 * one with a single flag set, and the log should say so.
 *
 * @param {unknown} rawFacts MintFacts from src/rpc/mint.js `fetchMintFacts`
 * @param {string} [expectedMint] when supplied, facts for another mint throw
 * @returns {Readonly<{ facts: Readonly<object>, disallowed: readonly string[],
 *   transferFeeExceedsLimit: boolean, defaultsToFrozen: boolean,
 *   reasons: readonly string[] }>} empty `reasons` means nothing condemned the mint
 * @throws {TypeError|Error} on unreadable MintFacts -- fail closed, never a default
 */
export function evaluateMintFacts(rawFacts, expectedMint) {
  const facts = readMintFacts(rawFacts, expectedMint);
  const disallowed = disallowedExtensions(facts.extensions);
  const feeReasons = transferFeeReasons(facts.transferFee);

  return Object.freeze({
    facts,
    disallowed,
    transferFeeExceedsLimit: feeReasons.length > 0,
    defaultsToFrozen: facts.defaultAccountState.frozen === true,
    reasons: Object.freeze([
      ...authorityReasons(facts),
      ...extensionReasons(disallowed),
      ...feeReasons,
      ...defaultAccountStateReasons(facts),
      ...initialisationReasons(facts),
    ]),
  });
}

/* -------------------------------------------------------------------------- */
/* verdict                                                                    */
/* -------------------------------------------------------------------------- */

/** Facts for a verdict we could not form: every unknown is null, never 0, never []. */
function unknownFacts(mint) {
  return {
    mint: typeof mint === 'string' ? mint : String(mint),
    programId: null,
    isToken2022: null,
    isInitialized: null,
    decimals: null,
    supplyRaw: null,
    supplyUi: null,
    authorities: null,
    /** null, NOT [] -- an empty list would read as "inspected, no extensions found". */
    extensions: null,
    disallowed: null,
    allowedExtensions: SAFETY.layer0.allowedExtensions,
    transferFee: null,
    transferFeeExceedsLimit: null,
    maxTransferFeeBps: SAFETY.layer0.maxTransferFeeBps,
    defaultAccountState: null,
    defaultsToFrozen: null,
    transferHook: null,
    permanentDelegate: null,
    hadUninitializedEntries: null,
    inspectionMethod: MINT_INSPECTION_LIMITATION.method,
    residualRisk: MINT_INSPECTION_LIMITATION.residualRisk,
    unverified: Object.freeze([MINT_BYTES_UNREAD, ...UNVERIFIED_BY_LAYER0]),
  };
}

/** Facts for a verdict we did form, from a completed inspection. */
function inspectedFacts(assessment) {
  const f = assessment.facts;
  return {
    mint: f.mint,
    programId: f.programId,
    isToken2022: f.isToken2022,
    isInitialized: f.isInitialized,
    decimals: f.decimals,
    supplyRaw: f.supplyRaw,
    supplyUi: f.supplyUi,
    authorities: Object.freeze({
      mintAuthority: f.mintAuthority,
      freezeAuthority: f.freezeAuthority,
      mintAuthorityRevoked: f.mintAuthority === null,
      freezeAuthorityRevoked: f.freezeAuthority === null,
    }),
    extensions: f.extensions,
    disallowed: assessment.disallowed,
    allowedExtensions: SAFETY.layer0.allowedExtensions,
    transferFee: f.transferFee,
    transferFeeExceedsLimit: assessment.transferFeeExceedsLimit,
    maxTransferFeeBps: SAFETY.layer0.maxTransferFeeBps,
    defaultAccountState: f.defaultAccountState,
    defaultsToFrozen: assessment.defaultsToFrozen,
    transferHook: f.transferHook,
    permanentDelegate: f.permanentDelegate,
    /** TLV zero-padding was present and skipped; reported so it is never swallowed. */
    hadUninitializedEntries: f.hadUninitializedEntries,
    inspectionMethod: MINT_INSPECTION_LIMITATION.method,
    residualRisk: MINT_INSPECTION_LIMITATION.residualRisk,
    unverified: UNVERIFIED_BY_LAYER0,
  };
}

/**
 * Layer 0: inspect the mint account and return a verdict. NEVER throws.
 *
 * @param {string} mint base58 mint address
 * @param {Readonly<{ getMintFacts: () => Promise<object>, signal?: AbortSignal }>} ctx
 *   the gate context. Only `getMintFacts` (memoized once per gate run) and `signal`
 *   are read, because layer 0 costs exactly one account read.
 * @returns {Promise<Readonly<object>>} verdict for layer 'layer0-mint'
 */
export async function checkMint(mint, ctx) {
  // Wall time only, never a decision input -- mirrors layer1-sellsim.
  const startedAt = Date.now();
  const baseFacts = unknownFacts(mint);

  try {
    if (typeof mint !== 'string' || mint.length === 0) {
      throw new TypeError(`checkMint: mint must be a mint address, got ${describeValue(mint)}`);
    }
    if (typeof ctx?.getMintFacts !== 'function') {
      throw new TypeError('checkMint: ctx.getMintFacts must be a function');
    }
    if (ctx.signal?.aborted === true) {
      throw new Error(
        'layer 0 budget was already spent before the mint account was read: an unread ' +
          'account is not a clean account',
      );
    }

    const assessment = evaluateMintFacts(await ctx.getMintFacts(), mint);
    const facts = inspectedFacts(assessment);
    const ms = Date.now() - startedAt;

    return assessment.reasons.length > 0
      ? reject(LAYER, [...assessment.reasons], facts, ms)
      : pass(LAYER, facts, ms);
  } catch (err) {
    // FAIL CLOSED: a mint account we could not read is not a mint account we cleared.
    return errored(LAYER, err, baseFacts, Date.now() - startedAt);
  }
}
