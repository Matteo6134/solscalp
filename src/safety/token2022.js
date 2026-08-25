/**
 * Token-2022 mint inspection -- PURE functions over an ALREADY-UNPACKED mint.
 *
 * WHAT THIS MODULE PROVES
 * -----------------------
 * Exactly what the mint account's TLV bytes say at the moment they were read:
 * which extensions are present (by name), BOTH transfer-fee schedules with their
 * epochs, the default account state, the transfer-hook program and the permanent
 * delegate. These are on-chain facts, not predictions -- this is the deterministic
 * part of the safety gate.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - Nothing about the FUTURE. A live mint/freeze authority can add a fee, a hook
 *    or a pause after this inspection. Layer 0 must check the authorities too, and
 *    the gate re-checks open positions for exactly this reason.
 *  - Nothing about the POOL. A mint with zero dangerous extensions can still be a
 *    soft rug, an empty pool, or a bundled launch posing as demand.
 *  - Nothing about a transfer actually SUCCEEDING. A transfer hook is arbitrary
 *    code; all this module can report is that the hook exists.
 *  - Nothing about extensions the TLV data does not mention: absence here is
 *    absence from this account, not a guarantee of good faith.
 *  - No network access. The caller (src/rpc/mint.js) fetches; everything here is a
 *    pure function of its argument, so the tests never open a socket.
 *
 * FAIL CLOSED: a malformed TLV blob, an unrecognised default-account-state code or
 * an extension that is present but whose struct will not decode THROWS. Layer 0
 * turns any throw into a reject. Nothing here ever substitutes a default.
 *
 * The byte-level rules (what counts as malformed, what counts as truncated) live in
 * ./token2022-tlv.js; this file is the list of named findings built on top of them.
 */

import {
  AccountState,
  DEFAULT_ACCOUNT_STATE_SIZE,
  ExtensionType,
  PERMANENT_DELEGATE_SIZE,
  TRANSFER_FEE_CONFIG_SIZE,
  TRANSFER_HOOK_SIZE,
  getDefaultAccountState,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
} from '@solana/spl-token';
import { SAFETY } from '../config.js';
import {
  addressOrNull,
  integerOrThrow,
  normaliseMint,
  readExtension,
  readExtensionCodes,
} from './token2022-tlv.js';

/** Unit conversion: 10_000 basis points == 100%. A fee above this cannot be real. */
const BPS_PER_WHOLE = 10_000;

/**
 * Numeric ExtensionType code -> camelCase name, built once by INVERTING the live
 * spl-token enum, so the names track the installed library rather than a hand-kept
 * list. camelCase is not cosmetic: these strings are compared against
 * SAFETY.layer0.allowedExtensions and looked up in
 * SAFETY.layer0.knownDangerousExtensions, both of which are camelCase.
 */
const EXTENSION_NAME_BY_CODE = new Map(
  Object.entries(ExtensionType)
    .filter(([key, value]) => typeof value === 'number' && !Number.isInteger(Number(key)))
    .map(([key, value]) => [value, key.charAt(0).toLowerCase() + key.slice(1)]),
);

/** AccountState code -> camelCase name, inverted from the live enum, same reason. */
const ACCOUNT_STATE_NAME_BY_CODE = new Map(
  Object.entries(AccountState)
    .filter(([key, value]) => typeof value === 'number' && !Number.isInteger(Number(key)))
    .map(([key, value]) => [value, key.charAt(0).toLowerCase() + key.slice(1)]),
);

/* -------------------------------------------------------------------------- */
/* names                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Invert spl-token's ExtensionType enum: 18 -> 'metadataPointer'.
 *
 * An unmapped code becomes `unknown(<n>)` -- and because layer 0 is an ALLOWLIST,
 * that string is automatically a reject. THAT IS THE WHOLE POINT: a blacklist would
 * lose to the next extension Solana ships, and it already had. PausableConfig (26),
 * ScaledUiAmountConfig (25) and PermissionedBurn (28) all post-date the well-known
 * PermanentDelegate scam, so a filter enumerating known-bad names would have waved
 * all three through. Here, an extension this library has never heard of is still
 * named, still reported, and still rejected.
 *
 * @param {number} code numeric ExtensionType member
 * @returns {string} camelCase name, or `unknown(<code>)`
 */
export function extensionName(code) {
  if (!Number.isInteger(code)) {
    throw new TypeError(
      `extensionName(code) expects an integer, got ${typeof code} (${String(code)})`,
    );
  }
  return EXTENSION_NAME_BY_CODE.get(code) ?? `unknown(${code})`;
}

/**
 * Every extension present on the mint, by name and by raw code.
 *
 * `names[i]` corresponds to `codes[i]`: both are in TLV storage order and both keep
 * duplicates, because "what the account actually says" is more useful for diagnosis
 * than a tidied set (`disallowedExtensions` deduplicates its own output). Type 0
 * (`uninitialized`) is TLV zero-padding rather than an extension, so it is filtered
 * out -- but `hadUninitializedEntries` reports that it was seen, so it is never
 * silently swallowed.
 *
 * @param {object} unpackedMint output of spl-token's unpackMint()
 * @returns {Readonly<{ names: readonly string[], codes: readonly number[],
 *   hadUninitializedEntries: boolean }>}
 * @throws {TypeError} missing or malformed TLV data
 */
export function enumerateExtensions(unpackedMint) {
  const mint = normaliseMint(unpackedMint, 'enumerateExtensions');
  const allCodes = readExtensionCodes(mint, 'enumerateExtensions');
  const codes = allCodes.filter((code) => code !== ExtensionType.Uninitialized);
  return Object.freeze({
    names: Object.freeze(codes.map(extensionName)),
    codes: Object.freeze(codes),
    hadUninitializedEntries: codes.length !== allCodes.length,
  });
}

/**
 * Names present that are NOT in the allowlist, deduplicated, first-seen order.
 *
 * Allowlist semantics: anything unrecognised is disallowed, including the
 * `unknown(<n>)` names produced by extensionName().
 *
 * @param {readonly string[]} names from enumerateExtensions().names
 * @param {readonly string[]} [allowlist] defaults to SAFETY.layer0.allowedExtensions
 * @returns {readonly string[]} frozen
 */
export function disallowedExtensions(names, allowlist = SAFETY.layer0.allowedExtensions) {
  if (!Array.isArray(names)) {
    throw new TypeError(`disallowedExtensions(names) expects an array, got ${typeof names}`);
  }
  if (!Array.isArray(allowlist)) {
    throw new TypeError(
      `disallowedExtensions(, allowlist) expects an array, got ${typeof allowlist}`,
    );
  }
  const allowed = new Set(allowlist);
  const seen = new Set();
  const disallowed = [];
  names.forEach((name, index) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`disallowedExtensions: names[${index}] is not a non-empty string`);
    }
    if (!allowed.has(name) && !seen.has(name)) {
      seen.add(name);
      disallowed.push(name);
    }
  });
  return Object.freeze(disallowed);
}

/**
 * The documented mechanism behind an extension name, so a reject reason can say
 * *what the creator can do to you* rather than merely naming a flag.
 *
 * @param {string} name camelCase extension name
 * @returns {string} risk sentence; a generic one for anything undocumented
 */
export function describeExtensionRisk(name) {
  const known = SAFETY.layer0.knownDangerousExtensions[name];
  if (typeof known === 'string' && known.length > 0) return known;
  return (
    'undocumented extension: its powers were never verified, so it is assumed ' +
    'capable of moving, burning or freezing your tokens'
  );
}

/* -------------------------------------------------------------------------- */
/* extension structs                                                          */
/* -------------------------------------------------------------------------- */

/** Absent transfer fee: every figure null, because "no extension" is not "0 bps known". */
const NO_TRANSFER_FEE = Object.freeze({
  present: false,
  olderEpoch: null,
  olderFeeBps: null,
  newerEpoch: null,
  newerFeeBps: null,
  maxFeeBpsEver: null,
  scheduledIncrease: false,
  withdrawWithheldAuthority: null,
  transferFeeConfigAuthority: null,
});

/** One of the two fee schedules, normalised and range-checked. */
function readFeeSchedule(schedule, label) {
  if (schedule === null || typeof schedule !== 'object') {
    throw new TypeError(`${label} is missing from the decoded TransferFeeConfig`);
  }
  const feeBps = integerOrThrow(schedule.transferFeeBasisPoints, `${label}.transferFeeBasisPoints`);
  if (feeBps < 0 || feeBps > BPS_PER_WHOLE) {
    throw new RangeError(`${label}.transferFeeBasisPoints is out of range (${feeBps} bps)`);
  }
  const epoch = integerOrThrow(schedule.epoch, `${label}.epoch`);
  if (epoch < 0) throw new RangeError(`${label}.epoch is negative (${epoch})`);
  return { epoch, feeBps };
}

/**
 * BOTH transfer-fee schedules, because the classic trap is 0% now and 100% at a
 * future epoch: reading only the fee in force today passes that mint.
 *
 * `maxFeeBpsEver` is the figure layer 0 compares against
 * SAFETY.layer0.maxTransferFeeBps; `scheduledIncrease` says the newer schedule is
 * worse than the older one, i.e. the spike is already queued on chain.
 *
 * @param {object} unpackedMint
 * @returns {Readonly<{ present: boolean, olderEpoch: number|null, olderFeeBps: number|null,
 *   newerEpoch: number|null, newerFeeBps: number|null, maxFeeBpsEver: number|null,
 *   scheduledIncrease: boolean, withdrawWithheldAuthority: string|null,
 *   transferFeeConfigAuthority: string|null }>}
 * @throws {TypeError|RangeError} present but undecodable
 */
export function inspectTransferFee(unpackedMint) {
  const label = 'inspectTransferFee';
  const mint = normaliseMint(unpackedMint, label);
  const config = readExtension(
    mint,
    ExtensionType.TransferFeeConfig,
    getTransferFeeConfig,
    TRANSFER_FEE_CONFIG_SIZE,
    label,
  );
  if (config === null) return NO_TRANSFER_FEE;

  const older = readFeeSchedule(config.olderTransferFee, `${label}: olderTransferFee`);
  const newer = readFeeSchedule(config.newerTransferFee, `${label}: newerTransferFee`);

  return Object.freeze({
    present: true,
    olderEpoch: older.epoch,
    olderFeeBps: older.feeBps,
    newerEpoch: newer.epoch,
    newerFeeBps: newer.feeBps,
    maxFeeBpsEver: Math.max(older.feeBps, newer.feeBps),
    scheduledIncrease: newer.feeBps > older.feeBps,
    withdrawWithheldAuthority: addressOrNull(config.withdrawWithheldAuthority),
    transferFeeConfigAuthority: addressOrNull(config.transferFeeConfigAuthority),
  });
}

/** Absent DefaultAccountState: no extension, so new accounts are not force-frozen. */
const NO_DEFAULT_ACCOUNT_STATE = Object.freeze({ present: false, state: null, frozen: false });

/**
 * DefaultAccountState: when this is `frozen`, every new token account starts frozen
 * and the holder cannot sell. An unrecognised state code throws rather than being
 * reported as not-frozen.
 *
 * @param {object} unpackedMint
 * @returns {Readonly<{ present: boolean, state: string|null, frozen: boolean }>}
 */
export function inspectDefaultAccountState(unpackedMint) {
  const label = 'inspectDefaultAccountState';
  const mint = normaliseMint(unpackedMint, label);
  const decoded = readExtension(
    mint,
    ExtensionType.DefaultAccountState,
    getDefaultAccountState,
    DEFAULT_ACCOUNT_STATE_SIZE,
    label,
  );
  if (decoded === null) return NO_DEFAULT_ACCOUNT_STATE;

  const code = integerOrThrow(decoded.state, `${label}: state`);
  const state = ACCOUNT_STATE_NAME_BY_CODE.get(code);
  if (state === undefined) {
    throw new TypeError(
      `${label}: unrecognised AccountState code ${code}; refusing to assume new ` +
        'accounts are unfrozen',
    );
  }
  return Object.freeze({ present: true, state, frozen: code === AccountState.Frozen });
}

/** Absent TransferHook: no third-party program runs on transfer. */
const NO_TRANSFER_HOOK = Object.freeze({ present: false, programId: null, authority: null });

/**
 * TransferHook: an arbitrary program invoked on every transfer, which can revert the
 * sell leg. Presence is the finding; the program's behaviour is unknowable here.
 *
 * @param {object} unpackedMint
 * @returns {Readonly<{ present: boolean, programId: string|null, authority: string|null }>}
 */
export function inspectTransferHook(unpackedMint) {
  const label = 'inspectTransferHook';
  const mint = normaliseMint(unpackedMint, label);
  const decoded = readExtension(
    mint,
    ExtensionType.TransferHook,
    getTransferHook,
    TRANSFER_HOOK_SIZE,
    label,
  );
  if (decoded === null) return NO_TRANSFER_HOOK;
  return Object.freeze({
    present: true,
    programId: addressOrNull(decoded.programId),
    authority: addressOrNull(decoded.authority),
  });
}

/** Absent PermanentDelegate: nobody holds a standing transfer/burn right. */
const NO_PERMANENT_DELEGATE = Object.freeze({ present: false, delegate: null });

/**
 * PermanentDelegate: an address that can transfer or burn tokens out of ANY holder's
 * account, forever. RugCheck flags this on >40% of new Solana tokens.
 *
 * A zero delegate address is reported as null, but `present` stays true: the
 * extension itself is not on the allowlist, so layer 0 rejects either way.
 *
 * @param {object} unpackedMint
 * @returns {Readonly<{ present: boolean, delegate: string|null }>}
 */
export function inspectPermanentDelegate(unpackedMint) {
  const label = 'inspectPermanentDelegate';
  const mint = normaliseMint(unpackedMint, label);
  const decoded = readExtension(
    mint,
    ExtensionType.PermanentDelegate,
    getPermanentDelegate,
    PERMANENT_DELEGATE_SIZE,
    label,
  );
  if (decoded === null) return NO_PERMANENT_DELEGATE;
  return Object.freeze({ present: true, delegate: addressOrNull(decoded.delegate) });
}
