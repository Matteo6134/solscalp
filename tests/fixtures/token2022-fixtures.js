/**
 * Deterministic, socket-free fixtures for Token-2022 inspection tests.
 *
 * These build REAL TLV bytes and REAL mint-account data and let the installed
 * @solana/spl-token decoders run over them. Stubbing the decoders instead would test
 * our stubs; this way a library upgrade that changes a layout breaks the tests, which
 * is the entire point of a safety gate.
 *
 * Not a .test.js file, so vitest does not collect it as a suite.
 */

import { Buffer } from 'node:buffer';
import {
  ACCOUNT_SIZE,
  AccountType,
  DefaultAccountStateLayout,
  ExtensionType,
  LENGTH_SIZE,
  MINT_SIZE,
  MintLayout,
  PermanentDelegateLayout,
  TRANSFER_FEE_CONFIG_SIZE,
  TRANSFER_HOOK_SIZE,
  TYPE_SIZE,
  TransferFeeConfigLayout,
  TransferHookLayout,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

/** Stable addresses, so no test needs a random or time-dependent value. */
export const ADDRESSES = Object.freeze({
  mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  authority: 'So11111111111111111111111111111111111111112',
  hookProgram: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  delegate: '1nc1nerator11111111111111111111111111111111',
  deployer: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  /** The all-zero pubkey: Token-2022's encoding for "no authority". */
  none: '11111111111111111111111111111111',
});

const key = (value) => new PublicKey(value);

/** One TLV entry: u16 type, u16 length, then the struct bytes. */
export function tlvEntry(code, data) {
  const header = Buffer.alloc(TYPE_SIZE + LENGTH_SIZE);
  header.writeUInt16LE(code, 0);
  header.writeUInt16LE(data.length, TYPE_SIZE);
  return Buffer.concat([header, data]);
}

/** An extension whose bytes we never decode: only its presence matters. */
export const opaqueExtension = (code, byteLength = TYPE_SIZE) =>
  tlvEntry(code, Buffer.alloc(byteLength));

/** TLV zero-padding: type 0, which enumerateExtensions must report but not list. */
export const uninitialisedEntry = () => opaqueExtension(ExtensionType.Uninitialized, 0);

/** A TransferFeeConfig with both schedules under our control. */
export function transferFeeEntry({
  olderFeeBps = 0,
  olderEpoch = 100,
  newerFeeBps = 0,
  newerEpoch = 200,
  configAuthority = ADDRESSES.authority,
  withdrawAuthority = ADDRESSES.authority,
  maximumFee = 0n,
} = {}) {
  const data = Buffer.alloc(TRANSFER_FEE_CONFIG_SIZE);
  TransferFeeConfigLayout.encode(
    {
      transferFeeConfigAuthority: key(configAuthority),
      withdrawWithheldAuthority: key(withdrawAuthority),
      withheldAmount: 0n,
      olderTransferFee: {
        epoch: BigInt(olderEpoch),
        maximumFee,
        transferFeeBasisPoints: olderFeeBps,
      },
      newerTransferFee: {
        epoch: BigInt(newerEpoch),
        maximumFee,
        transferFeeBasisPoints: newerFeeBps,
      },
    },
    data,
  );
  return tlvEntry(ExtensionType.TransferFeeConfig, data);
}

/** DefaultAccountState. `state` is an AccountState code (2 == Frozen). */
export function defaultAccountStateEntry(state) {
  const data = Buffer.alloc(DefaultAccountStateLayout.span);
  DefaultAccountStateLayout.encode({ state }, data);
  return tlvEntry(ExtensionType.DefaultAccountState, data);
}

export function transferHookEntry({
  authority = ADDRESSES.authority,
  programId = ADDRESSES.hookProgram,
} = {}) {
  const data = Buffer.alloc(TRANSFER_HOOK_SIZE);
  TransferHookLayout.encode({ authority: key(authority), programId: key(programId) }, data);
  return tlvEntry(ExtensionType.TransferHook, data);
}

export function permanentDelegateEntry(delegate = ADDRESSES.delegate) {
  const data = Buffer.alloc(PermanentDelegateLayout.span);
  PermanentDelegateLayout.encode({ delegate: key(delegate) }, data);
  return tlvEntry(ExtensionType.PermanentDelegate, data);
}

/**
 * An extension header claiming more bytes than follow it: the "present but
 * unparseable" case that must throw rather than be reported as absent.
 */
export function truncatedEntry(code, declaredLength = TRANSFER_FEE_CONFIG_SIZE) {
  const header = Buffer.alloc(TYPE_SIZE + LENGTH_SIZE);
  header.writeUInt16LE(code, 0);
  header.writeUInt16LE(declaredLength, TYPE_SIZE);
  return header; // header only: the declared struct bytes are missing
}

/** An unpacked mint exactly as spl-token's unpackMint() would return it. */
export function unpackedMint({
  tlv = [],
  address = ADDRESSES.mint,
  mintAuthority = null,
  freezeAuthority = null,
  supply = 1_000_000_000n,
  decimals = 6,
  isInitialized = true,
} = {}) {
  return {
    address: key(address),
    mintAuthority: mintAuthority === null ? null : key(mintAuthority),
    supply,
    decimals,
    isInitialized,
    freezeAuthority: freezeAuthority === null ? null : key(freezeAuthority),
    tlvData: tlv.length === 0 ? Buffer.alloc(0) : Buffer.concat(tlv),
  };
}

/**
 * Real mint-account bytes. With no TLV entries this is a legacy 82-byte SPL mint;
 * with entries it is a Token-2022 account (padded past ACCOUNT_SIZE, AccountType
 * marker byte, then the TLV blob) exactly as unpackMint() expects.
 */
export function mintAccountData({
  tlv = [],
  mintAuthority = null,
  freezeAuthority = null,
  supply = 1_000_000_000n,
  decimals = 6,
  isInitialized = true,
  token2022 = tlv.length > 0,
} = {}) {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: mintAuthority === null ? 0 : 1,
      mintAuthority: key(mintAuthority ?? ADDRESSES.none),
      supply,
      decimals,
      isInitialized,
      freezeAuthorityOption: freezeAuthority === null ? 0 : 1,
      freezeAuthority: key(freezeAuthority ?? ADDRESSES.none),
    },
    base,
  );
  if (!token2022) return base;

  const padded = Buffer.alloc(ACCOUNT_SIZE);
  base.copy(padded);
  return Buffer.concat([padded, Buffer.from([AccountType.Mint]), ...tlv]);
}

/** A web3.js-shaped AccountInfo. `owner` is a base58 string for readability. */
export function accountInfo({ owner, data, lamports = 1_461_600 }) {
  return { owner: key(owner), data, lamports, executable: false, rentEpoch: 0 };
}
