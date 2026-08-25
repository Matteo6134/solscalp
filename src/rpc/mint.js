/**
 * The NETWORK half of mint inspection: fetch, validate, hand pure facts onward.
 *
 * WHAT THIS MODULE PROVES
 * -----------------------
 * That at the moment of the call, the chain said: this account exists, it is owned by
 * the SPL Token or Token-2022 program, and its bytes decode to these authorities,
 * this supply and these extensions (via src/safety/token2022.js, which does all the
 * parsing and none of the fetching). Plus who paid for the mint's first transaction.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - Nothing about the future. Authorities that are still live can change all of this
 *    a slot later; that is why the gate re-checks open positions.
 *  - Nothing about the pool, the price, or anybody's intentions.
 *  - A creator of `null` means UNKNOWN, never innocent. Public RPC prunes and
 *    refuses deep history constantly.
 *
 * FAIL CLOSED. Missing account, wrong owner, undecodable data and unreadable
 * responses all THROW `rpcError` with a distinguishing `code`, so the safety layer
 * above turns them into errored() and the gate rejects. The documented exceptions are
 * `fetchCreator` returning null and `fetchDeployerHistory` reporting nulls: those are
 * *contractual unknowns* that layer 4 is required to handle, not swallowed errors,
 * and they are logged when they happen.
 *
 * No keypair, no signing, no sendTransaction, no simulateTransaction: read-only.
 *
 * `fetchHolders` and `fetchDeployerHistory` are part of this module's contract and are
 * re-exported below; they live in sibling files only to keep each file readable.
 */

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInvalidAccountSizeError,
  TokenInvalidMintError,
  unpackMint,
} from '@solana/spl-token';
import {
  enumerateExtensions,
  inspectDefaultAccountState,
  inspectPermanentDelegate,
  inspectTransferFee,
  inspectTransferHook,
} from '../safety/token2022.js';
import {
  DEFAULT_MAX_SIGNATURE_PAGES,
  SIGNATURE_PAGE_LIMIT,
  blockTimeMs,
  feePayerOf,
  walkSignatures,
} from './history.js';
import { resolveRpc } from './rpc-deps.js';
import { RPC_ERROR, describeError, rpcError } from './rpc-errors.js';
import { requireAddress, toPublicKey } from './rpc-validate.js';
import {
  addressOrNull,
  amountOrNull,
  asBuffer,
  isPlainObject,
  unparseable,
} from './rpc-values.js';

export { fetchHolders } from './holders.js';
export { fetchDeployerHistory } from './deployer-history.js';

const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();

/** Unit conversion: raw base units -> UI amount is a division by 10**decimals. */
const DECIMAL_BASE = 10;

const SILENT = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/* -------------------------------------------------------------------------- */
/* mint facts                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate the account envelope before spl-token ever sees it, so that a stub, a
 * proxy or a future web3.js shape change becomes a named error instead of a
 * TypeError from inside a decoder.
 */
function readAccountEnvelope(info, address) {
  if (info === null || info === undefined) {
    throw rpcError(`mint account ${address} does not exist on chain`, {
      code: RPC_ERROR.ACCOUNT_NOT_FOUND,
      address,
    });
  }
  if (!isPlainObject(info)) {
    throw unparseable(`getAccountInfo(${address}) returned ${typeof info}, not an account`, {
      address,
    });
  }
  const owner = addressOrNull(info.owner);
  if (owner === null) {
    throw unparseable(`getAccountInfo(${address}) returned an account with no owner`, { address });
  }
  const data = asBuffer(info.data);
  if (data === null) {
    throw unparseable(
      `getAccountInfo(${address}) returned account data that is not bytes ` +
        `(got ${info.data === undefined ? 'undefined' : typeof info.data})`,
      { address },
    );
  }
  return { owner, data, lamports: amountOrNull(info.lamports) };
}

/** Wrong size / account type is NOT_A_MINT; anything else under a token program is UNPARSEABLE. */
function classifyUnpackError(err, address) {
  const notAMint =
    err instanceof TokenInvalidAccountSizeError || err instanceof TokenInvalidMintError;
  return rpcError(
    `${address} is owned by a token program but its data is not a readable mint ` +
      `(${describeError(err)})`,
    { code: notAMint ? RPC_ERROR.NOT_A_MINT : RPC_ERROR.UNPARSEABLE, cause: err, address },
  );
}

/** UI supply, or null when the division is not representable. Never a silent 0. */
function toSupplyUi(supplyRaw, decimals) {
  const raw = amountOrNull(supplyRaw);
  if (raw === null) return null;
  const ui = raw / DECIMAL_BASE ** decimals;
  return Number.isFinite(ui) ? ui : null;
}

/** The five pure inspections, wrapped so an unreadable extension fails closed. */
function inspectExtensions(unpacked, address) {
  try {
    return {
      extensions: enumerateExtensions(unpacked),
      transferFee: inspectTransferFee(unpacked),
      defaultAccountState: inspectDefaultAccountState(unpacked),
      transferHook: inspectTransferHook(unpacked),
      permanentDelegate: inspectPermanentDelegate(unpacked),
    };
  } catch (err) {
    // An extension we cannot read is the dangerous case: reporting "no extensions"
    // would pass the mint. Fail closed instead.
    throw unparseable(`${address} extension data could not be inspected: ${describeError(err)}`, {
      cause: err,
      address,
    });
  }
}

/**
 * Every mint-level fact layer 0 needs, from ONE getAccountInfo call.
 *
 * @param {string} mint base58 mint address
 * @param {{ rpc?: object }} [deps] `deps.rpc` is an RpcClient from ./connection.js
 * @returns {Promise<Readonly<object>>} frozen MintFacts
 * @throws rpcError(INVALID_ADDRESS | ACCOUNT_NOT_FOUND | NOT_A_MINT | UNPARSEABLE)
 */
export async function fetchMintFacts(mint, deps = {}) {
  const address = requireAddress(mint, 'fetchMintFacts(mint)');
  const rpc = await resolveRpc(deps);
  const info = await rpc.getAccountInfo(address);
  const { owner, data, lamports } = readAccountEnvelope(info, address);

  const isToken2022 = owner === TOKEN_2022_PROGRAM;
  if (!isToken2022 && owner !== TOKEN_PROGRAM) {
    throw rpcError(
      `${address} is not a mint: owned by ${owner}, not the SPL Token or Token-2022 program`,
      { code: RPC_ERROR.NOT_A_MINT, address, owner },
    );
  }
  const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mintKey = await toPublicKey(address, 'fetchMintFacts(mint)');

  let unpacked;
  try {
    // A fresh envelope: spl-token needs PublicKey/Buffer instances, and the caller's
    // object is never mutated.
    unpacked = unpackMint(mintKey, { ...info, owner: programId, data }, programId);
  } catch (err) {
    throw classifyUnpackError(err, address);
  }

  const decimals = unpacked.decimals;
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw unparseable(`${address} decoded with a non-integer decimals (${String(decimals)})`, {
      address,
    });
  }
  if (amountOrNull(unpacked.supply) === null) {
    throw unparseable(`${address} decoded with an unreadable supply (${String(unpacked.supply)})`, {
      address,
    });
  }

  const { extensions, transferFee, defaultAccountState, transferHook, permanentDelegate } =
    inspectExtensions(unpacked, address);

  return Object.freeze({
    mint: address,
    programId: owner,
    isToken2022,
    decimals,
    supplyRaw: String(unpacked.supply),
    supplyUi: toSupplyUi(unpacked.supply, decimals),
    mintAuthority: addressOrNull(unpacked.mintAuthority),
    freezeAuthority: addressOrNull(unpacked.freezeAuthority),
    isInitialized: unpacked.isInitialized === true,
    extensions: extensions.names,
    extensionCodes: extensions.codes,
    hadUninitializedEntries: extensions.hadUninitializedEntries,
    transferFee,
    defaultAccountState,
    transferHook,
    permanentDelegate,
    raw: Object.freeze({ owner, lamports, dataLength: data.length }),
  });
}

/* -------------------------------------------------------------------------- */
/* creator                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Who created the mint: the fee payer of the OLDEST transaction touching it.
 *
 * Returns null for UNKNOWN, which is a documented outcome rather than an error:
 * public RPC prunes history and refuses deep queries (-32011) routinely, and the walk
 * is page-capped, so "we could not see the beginning" is the normal case. Null must
 * never be read as "no creator" -- layer 4 handles unknown deliberately.
 *
 * @param {string} mint
 * @param {{ rpc?: object, logger?: object, signal?: AbortSignal,
 *   maxSignaturePages?: number, signaturePageLimit?: number }} [deps]
 * @returns {Promise<Readonly<{ creator: string, createdAtMs: number|null,
 *   signature: string }>|null>}
 * @throws rpcError(INVALID_ADDRESS) only
 */
export async function fetchCreator(mint, deps = {}) {
  const address = requireAddress(mint, 'fetchCreator(mint)');
  const logger = deps.logger ?? SILENT;
  const rpc = await resolveRpc(deps);

  let walk;
  try {
    walk = await walkSignatures({
      rpc,
      address,
      sinceMs: null,
      pageLimit: deps.signaturePageLimit ?? SIGNATURE_PAGE_LIMIT,
      maxPages: deps.maxSignaturePages ?? DEFAULT_MAX_SIGNATURE_PAGES,
      signal: deps.signal,
    });
  } catch (err) {
    logger.debug?.(`fetchCreator(${address}): signature history unavailable`, describeError(err));
    return null;
  }
  if (!walk.reachedEnd || walk.oldest === null) {
    logger.debug?.(
      `fetchCreator(${address}): history deeper than ${walk.pages} page(s); creator unknown`,
    );
    return null;
  }

  const { signature } = walk.oldest;
  let parsedTx;
  try {
    parsedTx = await rpc.getParsedTransaction(signature);
  } catch (err) {
    logger.debug?.(`fetchCreator(${address}): ${signature} unreadable`, describeError(err));
    return null;
  }
  const creator = feePayerOf(parsedTx);
  if (creator === null) {
    logger.debug?.(`fetchCreator(${address}): ${signature} has no readable fee payer`);
    return null;
  }

  return Object.freeze({
    creator,
    /** Null when the node pruned blockTime: an unknown age, never a fabricated one. */
    createdAtMs: blockTimeMs(parsedTx) ?? walk.oldest.blockTimeMs,
    signature,
  });
}
