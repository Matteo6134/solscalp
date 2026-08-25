import { describe, expect, it } from 'vitest';
import { AccountState, ExtensionType } from '@solana/spl-token';
import { SAFETY } from '../../src/config.js';
import {
  describeExtensionRisk,
  disallowedExtensions,
  enumerateExtensions,
  extensionName,
  inspectDefaultAccountState,
  inspectPermanentDelegate,
  inspectTransferFee,
  inspectTransferHook,
} from '../../src/safety/token2022.js';
import {
  ADDRESSES,
  defaultAccountStateEntry,
  opaqueExtension,
  permanentDelegateEntry,
  transferFeeEntry,
  transferHookEntry,
  truncatedEntry,
  uninitialisedEntry,
  unpackedMint,
} from '../fixtures/token2022-fixtures.js';

/** An extension code this build of spl-token has never heard of. */
const UNKNOWN_CODE = 41;

describe('extensionName', () => {
  it('round-trips every one of the six allowlisted names', () => {
    const codes = [
      ExtensionType.MetadataPointer,
      ExtensionType.TokenMetadata,
      ExtensionType.GroupPointer,
      ExtensionType.TokenGroup,
      ExtensionType.GroupMemberPointer,
      ExtensionType.TokenGroupMember,
    ];
    const names = codes.map(extensionName);

    expect(names).toEqual([
      'metadataPointer',
      'tokenMetadata',
      'groupPointer',
      'tokenGroup',
      'groupMemberPointer',
      'tokenGroupMember',
    ]);
    // The allowlist is matched by string, so any camelCase drift is a silent reject.
    expect([...SAFETY.layer0.allowedExtensions].sort()).toEqual([...names].sort());
    expect(disallowedExtensions(names)).toEqual([]);
  });

  it('names an unmapped code as unknown(41), which the allowlist then rejects', () => {
    expect(extensionName(UNKNOWN_CODE)).toBe(`unknown(${UNKNOWN_CODE})`);
    expect(disallowedExtensions([`unknown(${UNKNOWN_CODE})`])).toEqual([
      `unknown(${UNKNOWN_CODE})`,
    ]);
  });

  it('detects the three post-PermanentDelegate vectors a blacklist would have missed', () => {
    const names = [
      extensionName(ExtensionType.PausableConfig),
      extensionName(ExtensionType.ScaledUiAmountConfig),
      extensionName(ExtensionType.PermissionedBurn),
    ];
    expect(names).toEqual(['pausableConfig', 'scaledUiAmountConfig', 'permissionedBurn']);
    expect(disallowedExtensions(names)).toEqual(names);
  });

  it('names the classic wallet-draining extensions', () => {
    expect(extensionName(ExtensionType.PermanentDelegate)).toBe('permanentDelegate');
    expect(extensionName(ExtensionType.TransferHook)).toBe('transferHook');
    expect(extensionName(ExtensionType.NonTransferable)).toBe('nonTransferable');
    expect(extensionName(ExtensionType.Uninitialized)).toBe('uninitialized');
  });

  it('throws on a non-integer code rather than inventing a name', () => {
    expect(() => extensionName('18')).toThrow(TypeError);
    expect(() => extensionName(18.5)).toThrow(TypeError);
    expect(() => extensionName(undefined)).toThrow(TypeError);
    expect(() => extensionName(Number.NaN)).toThrow(TypeError);
  });
});

describe('enumerateExtensions', () => {
  it('reports nothing for a legacy mint with empty TLV data', () => {
    const result = enumerateExtensions(unpackedMint());
    expect(result).toEqual({ names: [], codes: [], hadUninitializedEntries: false });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.names)).toBe(true);
  });

  it('filters uninitialized padding but reports that it was there', () => {
    const result = enumerateExtensions(
      unpackedMint({
        tlv: [
          uninitialisedEntry(),
          opaqueExtension(ExtensionType.MetadataPointer),
          uninitialisedEntry(),
        ],
      }),
    );
    expect(result.names).toEqual(['metadataPointer']);
    expect(result.codes).toEqual([ExtensionType.MetadataPointer]);
    expect(result.hadUninitializedEntries).toBe(true);
  });

  it('keeps names parallel to codes, in TLV order, duplicates included', () => {
    const result = enumerateExtensions(
      unpackedMint({
        tlv: [
          opaqueExtension(ExtensionType.PausableConfig),
          opaqueExtension(UNKNOWN_CODE),
          opaqueExtension(ExtensionType.PausableConfig),
        ],
      }),
    );
    expect(result.codes).toEqual([
      ExtensionType.PausableConfig,
      UNKNOWN_CODE,
      ExtensionType.PausableConfig,
    ]);
    expect(result.names).toEqual([
      'pausableConfig',
      `unknown(${UNKNOWN_CODE})`,
      'pausableConfig',
    ]);
    expect(result.hadUninitializedEntries).toBe(false);
  });

  it('accepts a plain Uint8Array view of the TLV bytes', () => {
    const mint = unpackedMint({ tlv: [opaqueExtension(ExtensionType.TokenMetadata)] });
    const asView = { ...mint, tlvData: new Uint8Array(mint.tlvData) };
    expect(enumerateExtensions(asView).names).toEqual(['tokenMetadata']);
  });

  it('throws when tlvData is missing: absent bytes are not "no extensions"', () => {
    expect(() => enumerateExtensions({ decimals: 6 })).toThrow(/tlvData/);
    expect(() => enumerateExtensions({ decimals: 6, tlvData: null })).toThrow(/tlvData/);
    expect(() => enumerateExtensions({ decimals: 6, tlvData: 'AAAA' })).toThrow(/tlvData/);
  });

  it('throws on a non-object argument', () => {
    expect(() => enumerateExtensions(null)).toThrow(/got null/);
    expect(() => enumerateExtensions([])).toThrow(/got an array/);
    expect(() => enumerateExtensions(undefined)).toThrow(TypeError);
  });

  it('throws on a truncated TLV header instead of reporting a short list', () => {
    const mint = unpackedMint();
    const truncated = { ...mint, tlvData: Buffer.from([1, 0, 4]) };
    expect(() => enumerateExtensions(truncated)).toThrow(/malformed/);
  });

  it('does not mutate the mint it was handed', () => {
    const mint = unpackedMint({ tlv: [opaqueExtension(ExtensionType.TokenGroup)] });
    const before = Buffer.from(mint.tlvData);
    const keys = Object.keys(mint).sort();
    enumerateExtensions(mint);
    expect(Buffer.compare(mint.tlvData, before)).toBe(0);
    expect(Object.keys(mint).sort()).toEqual(keys);
  });
});

describe('disallowedExtensions', () => {
  it('deduplicates, preserving first-seen order', () => {
    expect(
      disallowedExtensions(['permanentDelegate', 'metadataPointer', 'permanentDelegate', 'x']),
    ).toEqual(['permanentDelegate', 'x']);
  });

  it('rejects everything when handed an empty allowlist', () => {
    expect(disallowedExtensions(['metadataPointer'], [])).toEqual(['metadataPointer']);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(disallowedExtensions(['transferHook']))).toBe(true);
  });

  it('throws on a non-array or a non-string entry rather than skipping it', () => {
    expect(() => disallowedExtensions('permanentDelegate')).toThrow(TypeError);
    expect(() => disallowedExtensions(null)).toThrow(TypeError);
    expect(() => disallowedExtensions(['a'], 'metadataPointer')).toThrow(TypeError);
    expect(() => disallowedExtensions([null])).toThrow(/names\[0\]/);
    expect(() => disallowedExtensions([''])).toThrow(/names\[0\]/);
    expect(() => disallowedExtensions([12])).toThrow(/names\[0\]/);
  });
});

describe('describeExtensionRisk', () => {
  it('returns the documented mechanism for every known dangerous extension', () => {
    for (const [name, sentence] of Object.entries(SAFETY.layer0.knownDangerousExtensions)) {
      expect(describeExtensionRisk(name)).toBe(sentence);
    }
    expect(describeExtensionRisk('permanentDelegate')).toMatch(/out of your wallet/);
    expect(describeExtensionRisk('pausableConfig')).toMatch(/cannot sell/);
  });

  it('falls back to a generic sentence for an undocumented or unknown name', () => {
    expect(describeExtensionRisk(`unknown(${UNKNOWN_CODE})`)).toMatch(/undocumented extension/);
    expect(describeExtensionRisk('metadataPointer')).toMatch(/undocumented extension/);
    expect(describeExtensionRisk(undefined)).toMatch(/undocumented extension/);
  });
});

describe('inspectTransferFee', () => {
  it('reports all-null and no scheduled increase when the extension is absent', () => {
    const fee = inspectTransferFee(unpackedMint());
    expect(fee).toEqual({
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
    // Unknown is null, so layer 0's comparison cannot accidentally reject a clean mint.
    expect(fee.maxFeeBpsEver > SAFETY.layer0.maxTransferFeeBps).toBe(false);
    expect(Object.isFrozen(fee)).toBe(true);
  });

  it('catches 0% now / 100% at a future epoch through maxFeeBpsEver', () => {
    const fee = inspectTransferFee(
      unpackedMint({
        tlv: [
          transferFeeEntry({
            olderFeeBps: 0,
            olderEpoch: 500,
            newerFeeBps: 10_000,
            newerEpoch: 999,
          }),
        ],
      }),
    );
    expect(fee.present).toBe(true);
    expect(fee.olderFeeBps).toBe(0);
    expect(fee.olderEpoch).toBe(500);
    expect(fee.newerFeeBps).toBe(10_000);
    expect(fee.newerEpoch).toBe(999);
    expect(fee.maxFeeBpsEver).toBe(10_000);
    expect(fee.scheduledIncrease).toBe(true);
    // The whole point: the fee in force TODAY is 0, and layer 0 still rejects.
    expect(fee.maxFeeBpsEver > SAFETY.layer0.maxTransferFeeBps).toBe(true);
  });

  it('reads the older schedule as the maximum when the fee is being reduced', () => {
    const fee = inspectTransferFee(
      unpackedMint({ tlv: [transferFeeEntry({ olderFeeBps: 750, newerFeeBps: 25 })] }),
    );
    expect(fee.maxFeeBpsEver).toBe(750);
    expect(fee.scheduledIncrease).toBe(false);
  });

  it('sits exactly at the threshold for a genuine 0 bps fee config', () => {
    const fee = inspectTransferFee(
      unpackedMint({ tlv: [transferFeeEntry({ olderFeeBps: 0, newerFeeBps: 0 })] }),
    );
    expect(fee.present).toBe(true);
    expect(fee.maxFeeBpsEver).toBe(SAFETY.layer0.maxTransferFeeBps);
    expect(fee.maxFeeBpsEver > SAFETY.layer0.maxTransferFeeBps).toBe(false);
  });

  it('rejects one basis point above the threshold', () => {
    const fee = inspectTransferFee(
      unpackedMint({ tlv: [transferFeeEntry({ olderFeeBps: 0, newerFeeBps: 1 })] }),
    );
    expect(fee.maxFeeBpsEver > SAFETY.layer0.maxTransferFeeBps).toBe(true);
    expect(fee.scheduledIncrease).toBe(true);
  });

  it('reports the fee authorities, mapping the all-zero pubkey to null', () => {
    const withAuthorities = inspectTransferFee(
      unpackedMint({
        tlv: [
          transferFeeEntry({
            configAuthority: ADDRESSES.authority,
            withdrawAuthority: ADDRESSES.delegate,
          }),
        ],
      }),
    );
    expect(withAuthorities.transferFeeConfigAuthority).toBe(ADDRESSES.authority);
    expect(withAuthorities.withdrawWithheldAuthority).toBe(ADDRESSES.delegate);

    const renounced = inspectTransferFee(
      unpackedMint({
        tlv: [
          transferFeeEntry({ configAuthority: ADDRESSES.none, withdrawAuthority: ADDRESSES.none }),
        ],
      }),
    );
    expect(renounced.transferFeeConfigAuthority).toBeNull();
    expect(renounced.withdrawWithheldAuthority).toBeNull();
  });

  it('throws when the extension is present but its struct does not decode', () => {
    const mint = unpackedMint({ tlv: [truncatedEntry(ExtensionType.TransferFeeConfig)] });
    expect(() => inspectTransferFee(mint)).toThrow(/present in the TLV data but only \d+ of \d+ bytes/);
  });

  it('throws on a malformed TLV blob instead of reporting no fee', () => {
    const mint = { ...unpackedMint(), tlvData: Buffer.from([1, 0, 4]) };
    expect(() => inspectTransferFee(mint)).toThrow(/malformed/);
  });
});

describe('inspectDefaultAccountState', () => {
  it('reports absent as not frozen', () => {
    const state = inspectDefaultAccountState(unpackedMint());
    expect(state).toEqual({ present: false, state: null, frozen: false });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('detects a frozen default state, which makes the token unsellable', () => {
    const state = inspectDefaultAccountState(
      unpackedMint({ tlv: [defaultAccountStateEntry(AccountState.Frozen)] }),
    );
    expect(state).toEqual({ present: true, state: 'frozen', frozen: true });
    expect(SAFETY.layer0.rejectDefaultAccountStateFrozen).toBe(true);
  });

  it('detects an initialized default state as present but not frozen', () => {
    const state = inspectDefaultAccountState(
      unpackedMint({ tlv: [defaultAccountStateEntry(AccountState.Initialized)] }),
    );
    expect(state).toEqual({ present: true, state: 'initialized', frozen: false });
  });

  it('throws on an unrecognised state code rather than assuming unfrozen', () => {
    expect(() =>
      inspectDefaultAccountState(unpackedMint({ tlv: [defaultAccountStateEntry(7)] })),
    ).toThrow(/unrecognised AccountState code 7/);
  });

  it('throws when the state byte is missing', () => {
    expect(() =>
      inspectDefaultAccountState(
        unpackedMint({ tlv: [truncatedEntry(ExtensionType.DefaultAccountState, 1)] }),
      ),
    ).toThrow(/present in the TLV data but only \d+ of \d+ bytes/);
  });
});

describe('inspectTransferHook', () => {
  it('reports absent', () => {
    expect(inspectTransferHook(unpackedMint())).toEqual({
      present: false,
      programId: null,
      authority: null,
    });
  });

  it('reports the hook program and authority', () => {
    const hook = inspectTransferHook(unpackedMint({ tlv: [transferHookEntry()] }));
    expect(hook).toEqual({
      present: true,
      programId: ADDRESSES.hookProgram,
      authority: ADDRESSES.authority,
    });
    expect(Object.isFrozen(hook)).toBe(true);
  });

  it('reports a renounced hook authority as null while staying present', () => {
    const hook = inspectTransferHook(
      unpackedMint({ tlv: [transferHookEntry({ authority: ADDRESSES.none })] }),
    );
    expect(hook.present).toBe(true);
    expect(hook.authority).toBeNull();
    expect(hook.programId).toBe(ADDRESSES.hookProgram);
  });

  it('throws when the hook struct is truncated', () => {
    expect(() =>
      inspectTransferHook(unpackedMint({ tlv: [truncatedEntry(ExtensionType.TransferHook, 64)] })),
    ).toThrow(/present in the TLV data but only \d+ of \d+ bytes/);
  });
});

describe('inspectPermanentDelegate', () => {
  it('reports absent', () => {
    expect(inspectPermanentDelegate(unpackedMint())).toEqual({ present: false, delegate: null });
  });

  it('reports the delegate that can drain any holder', () => {
    const delegate = inspectPermanentDelegate(unpackedMint({ tlv: [permanentDelegateEntry()] }));
    expect(delegate).toEqual({ present: true, delegate: ADDRESSES.delegate });
  });

  it('stays present when the delegate is the all-zero pubkey', () => {
    const delegate = inspectPermanentDelegate(
      unpackedMint({ tlv: [permanentDelegateEntry(ADDRESSES.none)] }),
    );
    expect(delegate).toEqual({ present: true, delegate: null });
    // Presence alone is the reject: the extension is not on the allowlist.
    expect(disallowedExtensions(['permanentDelegate'])).toEqual(['permanentDelegate']);
  });

  it('throws when the delegate struct is truncated', () => {
    expect(() =>
      inspectPermanentDelegate(
        unpackedMint({ tlv: [truncatedEntry(ExtensionType.PermanentDelegate, 32)] }),
      ),
    ).toThrow(/present in the TLV data but only \d+ of \d+ bytes/);
  });
});

describe('a fully loaded malicious mint', () => {
  it('is enumerated completely, and every mechanism is named', () => {
    const mint = unpackedMint({
      tlv: [
        opaqueExtension(ExtensionType.MetadataPointer),
        permanentDelegateEntry(),
        transferHookEntry(),
        transferFeeEntry({ olderFeeBps: 0, newerFeeBps: 10_000 }),
        defaultAccountStateEntry(AccountState.Frozen),
        opaqueExtension(ExtensionType.PausableConfig),
        opaqueExtension(UNKNOWN_CODE),
        uninitialisedEntry(),
      ],
    });

    const { names, hadUninitializedEntries } = enumerateExtensions(mint);
    expect(names).toEqual([
      'metadataPointer',
      'permanentDelegate',
      'transferHook',
      'transferFeeConfig',
      'defaultAccountState',
      'pausableConfig',
      `unknown(${UNKNOWN_CODE})`,
    ]);
    expect(hadUninitializedEntries).toBe(true);

    const disallowed = disallowedExtensions(names);
    expect(disallowed).toEqual([
      'permanentDelegate',
      'transferHook',
      'transferFeeConfig',
      'defaultAccountState',
      'pausableConfig',
      `unknown(${UNKNOWN_CODE})`,
    ]);
    for (const name of disallowed) {
      expect(describeExtensionRisk(name).length).toBeGreaterThan(0);
    }

    expect(inspectPermanentDelegate(mint).present).toBe(true);
    expect(inspectTransferHook(mint).programId).toBe(ADDRESSES.hookProgram);
    expect(inspectTransferFee(mint).maxFeeBpsEver).toBe(10_000);
    expect(inspectDefaultAccountState(mint).frozen).toBe(true);
  });
});
