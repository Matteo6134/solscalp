/**
 * Layer 0 tests. The failure paths ARE the feature, so most of this file is about
 * what must never be reported as a PASS.
 *
 * Wherever possible the MintFacts under test are REAL: built from real TLV bytes by
 * the fixtures, decoded by the installed @solana/spl-token, and assembled by the
 * real fetchMintFacts over a stub `getAccountInfo`. No socket is ever opened, and a
 * library upgrade that changes a layout breaks these tests -- which is the point.
 */

import { describe, expect, it, vi } from 'vitest';
import { AccountState, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { SAFETY } from '../../src/config.js';
import { fetchMintFacts } from '../../src/rpc/mint.js';
import { LAYER_SPECS, loadLayerFn } from '../../src/safety/gate-layers.js';
import {
  LAYER,
  MINT_INSPECTION_LIMITATION,
  checkMint,
  evaluateMintFacts,
} from '../../src/safety/layer0-mint.js';
import { OUTCOME } from '../../src/safety/verdict.js';
import {
  ADDRESSES,
  accountInfo,
  defaultAccountStateEntry,
  mintAccountData,
  opaqueExtension,
  permanentDelegateEntry,
  transferFeeEntry,
  transferHookEntry,
  uninitialisedEntry,
} from '../fixtures/token2022-fixtures.js';

const MINT = ADDRESSES.mint;
const OTHER_MINT = ADDRESSES.hookProgram;
const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();
const FEE_LIMIT_BPS = SAFETY.layer0.maxTransferFeeBps;
/** 100% in basis points: the "0% now, 100% later" trap, from the fixture side. */
const ALL_OF_IT_BPS = 10_000;

/** The six allowlisted metadata/grouping extensions, straight from config. */
const ALLOWED_CODES = Object.freeze([
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.GroupPointer,
  ExtensionType.TokenGroup,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember,
]);

/**
 * A TLV type code this spl-token release has never heard of, found rather than
 * hardcoded so a library upgrade that adds codes cannot silently invalidate the
 * allowlist test.
 */
const UNMAPPED_EXTENSION_CODE = (() => {
  const known = new Set(Object.values(ExtensionType).filter((v) => typeof v === 'number'));
  let code = 41;
  while (known.has(code)) code += 1;
  return code;
})();

/** REAL MintFacts: real bytes, real decoders, one stubbed getAccountInfo. */
async function mintFactsFor(options = {}) {
  const token2022 = options.token2022 ?? (options.tlv ?? []).length > 0;
  const info = accountInfo({
    owner: token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    data: mintAccountData({ ...options, token2022 }),
  });
  return fetchMintFacts(MINT, { rpc: { getAccountInfo: async () => info } });
}

const tripwire = (name) =>
  vi.fn(async () => {
    throw new Error(`layer 0 must not call ctx.${name}: it costs exactly one account read`);
  });

/**
 * A gate context exposing getMintFacts and booby-trapping every other fetcher, so
 * a layer that quietly grew a second network call fails the suite.
 */
function ctxFor(factsOrThrower, extra = {}) {
  const getMintFacts =
    typeof factsOrThrower === 'function'
      ? vi.fn(factsOrThrower)
      : vi.fn(async () => factsOrThrower);
  return {
    mint: MINT,
    getMintFacts,
    getHolders: tripwire('getHolders'),
    getCreator: tripwire('getCreator'),
    getDeployerHistory: tripwire('getDeployerHistory'),
    getRoundTrip: tripwire('getRoundTrip'),
    getPair: tripwire('getPair'),
    getTokenReport: tripwire('getTokenReport'),
    getInsiderGraph: tripwire('getInsiderGraph'),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...extra,
  };
}

/** checkMint over real fixture bytes. */
const verdictFor = async (options) => checkMint(MINT, ctxFor(await mintFactsFor(options)));

const reasonsText = (v) => v.reasons.join(' | ');

/**
 * A hand-built MintFacts, used ONLY where real bytes cannot isolate one rule.
 * Every field is present and correctly typed: these tests are about the rules, not
 * about the shape check (which has its own describe block).
 */
const syntheticFacts = (overrides = {}) =>
  Object.freeze({
    mint: MINT,
    programId: TOKEN_2022_PROGRAM,
    isToken2022: true,
    isInitialized: true,
    decimals: 6,
    supplyRaw: '1000000000',
    supplyUi: 1_000,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: Object.freeze([]),
    extensionCodes: Object.freeze([]),
    hadUninitializedEntries: false,
    transferFee: Object.freeze({
      present: false,
      olderEpoch: null,
      olderFeeBps: null,
      newerEpoch: null,
      newerFeeBps: null,
      maxFeeBpsEver: null,
      scheduledIncrease: false,
      withdrawWithheldAuthority: null,
      transferFeeConfigAuthority: null,
    }),
    defaultAccountState: Object.freeze({ present: false, state: null, frozen: false }),
    transferHook: Object.freeze({ present: false, programId: null, authority: null }),
    permanentDelegate: Object.freeze({ present: false, delegate: null }),
    ...overrides,
  });

/** A fee schedule at a chosen peak, with no other extension in play. */
const factsWithFeePeak = (peakBps) =>
  syntheticFacts({
    transferFee: Object.freeze({
      present: true,
      olderEpoch: 100,
      olderFeeBps: peakBps,
      newerEpoch: 200,
      newerFeeBps: peakBps,
      maxFeeBpsEver: peakBps,
      scheduledIncrease: false,
      withdrawWithheldAuthority: null,
      transferFeeConfigAuthority: null,
    }),
  });

/* ========================================================================== */
/* the clean case                                                             */
/* ========================================================================== */

describe('checkMint: a clean mint', () => {
  it('passes a legacy SPL mint with both authorities revoked and no extensions', async () => {
    const v = await verdictFor({ token2022: false });

    expect(v.layer).toBe(LAYER);
    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.reasons).toEqual([]);
    expect(v.facts.mint).toBe(MINT);
    expect(v.facts.programId).toBe(TOKEN_PROGRAM);
    expect(v.facts.isToken2022).toBe(false);
    expect(v.facts.authorities).toEqual({
      mintAuthority: null,
      freezeAuthority: null,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
    });
    expect(v.facts.extensions).toEqual([]);
    expect(v.facts.disallowed).toEqual([]);
    expect(v.facts.transferFee.present).toBe(false);
    expect(v.facts.defaultAccountState.frozen).toBe(false);
    expect(v.facts.hadUninitializedEntries).toBe(false);
    expect(v.ms).toBeGreaterThanOrEqual(0);
  });

  it('passes all six allowlisted metadata/grouping extensions together', async () => {
    const v = await verdictFor({ tlv: ALLOWED_CODES.map((code) => opaqueExtension(code, 4)) });

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.isToken2022).toBe(true);
    expect(v.facts.extensions).toEqual([...SAFETY.layer0.allowedExtensions]);
    expect(v.facts.disallowed).toEqual([]);
  });

  it.each([...SAFETY.layer0.allowedExtensions].map((name, i) => [name, ALLOWED_CODES[i]]))(
    'passes %s on its own',
    async (name, code) => {
      const v = await verdictFor({ tlv: [opaqueExtension(code, 4)] });

      expect(v.outcome).toBe(OUTCOME.PASS);
      expect(v.facts.extensions).toEqual([name]);
    },
  );

  it('reports TLV zero-padding without rejecting for it', async () => {
    const v = await verdictFor({
      tlv: [uninitialisedEntry(), opaqueExtension(ExtensionType.MetadataPointer, 4)],
    });

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.hadUninitializedEntries).toBe(true);
    expect(v.facts.extensions).toEqual(['metadataPointer']);
  });

  it('states on a PASS what it did not prove', async () => {
    const v = await verdictFor({ token2022: false });

    expect(v.facts.residualRisk).toMatch(/liquidity/i);
    expect(v.facts.residualRisk).toMatch(/soft rug/i);
    expect(v.facts.unverified).toContain('liquidityDepth');
    expect(v.facts.unverified).toContain('holderConcentration');
    expect(v.facts.unverified).toContain('exitRouteExists');
  });

  it('costs exactly one mint-facts read and touches no other fetcher', async () => {
    const ctx = ctxFor(await mintFactsFor({ token2022: false }));

    const v = await checkMint(MINT, ctx);

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(ctx.getMintFacts).toHaveBeenCalledTimes(1);
    expect(ctx.getPair).not.toHaveBeenCalled();
    expect(ctx.getHolders).not.toHaveBeenCalled();
    expect(ctx.getRoundTrip).not.toHaveBeenCalled();
    expect(ctx.getTokenReport).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* authorities                                                                */
/* ========================================================================== */

describe('checkMint: authorities', () => {
  it('rejects a live mint authority, naming dilution as the mechanism', async () => {
    const v = await verdictFor({ token2022: false, mintAuthority: ADDRESSES.authority });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons).toHaveLength(1);
    expect(reasonsText(v)).toMatch(/mint authority is still live/i);
    expect(reasonsText(v)).toMatch(/mint unlimited new supply/i);
    expect(reasonsText(v)).toContain(ADDRESSES.authority);
    expect(v.facts.authorities.mintAuthorityRevoked).toBe(false);
    expect(v.facts.authorities.freezeAuthorityRevoked).toBe(true);
  });

  it('rejects a live freeze authority, naming the unsellable account', async () => {
    const v = await verdictFor({ token2022: false, freezeAuthority: ADDRESSES.deployer });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons).toHaveLength(1);
    expect(reasonsText(v)).toMatch(/freeze authority is still live/i);
    expect(reasonsText(v)).toMatch(/cannot sell at any price/i);
    expect(v.facts.authorities.freezeAuthority).toBe(ADDRESSES.deployer);
  });

  it('collects BOTH authority reasons instead of stopping at the first', async () => {
    const v = await verdictFor({
      token2022: false,
      mintAuthority: ADDRESSES.authority,
      freezeAuthority: ADDRESSES.deployer,
    });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons).toHaveLength(2);
    expect(reasonsText(v)).toMatch(/mint authority/i);
    expect(reasonsText(v)).toMatch(/freeze authority/i);
  });

  it('rejects an uninitialized mint account', async () => {
    const v = await verdictFor({ token2022: false, isInitialized: false });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(reasonsText(v)).toMatch(/not initialized/i);
    expect(v.facts.isInitialized).toBe(false);
  });
});

/* ========================================================================== */
/* the extension allowlist                                                    */
/* ========================================================================== */

describe('checkMint: the extension allowlist', () => {
  const MECHANISM_CASES = [
    ['permanentDelegate', [permanentDelegateEntry()], /burn or transfer tokens out of your wallet/i],
    ['transferHook', [transferHookEntry()], /arbitrary program runs on every transfer/i],
    [
      'pausableConfig',
      [opaqueExtension(ExtensionType.PausableConfig, 2)],
      /pause all transfers; you cannot sell/i,
    ],
    [
      'scaledUiAmountConfig',
      [opaqueExtension(ExtensionType.ScaledUiAmountConfig, 2)],
      /displayed amount is scaled/i,
    ],
    [
      'permissionedBurn',
      [opaqueExtension(ExtensionType.PermissionedBurn, 2)],
      /creator can burn your tokens/i,
    ],
    [
      'nonTransferable',
      [opaqueExtension(ExtensionType.NonTransferable, 0)],
      /cannot be transferred at all/i,
    ],
  ];

  it.each(MECHANISM_CASES)('rejects %s and names the mechanism', async (name, tlv, mechanism) => {
    const v = await verdictFor({ tlv });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.extensions).toContain(name);
    expect(v.facts.disallowed).toEqual([name]);
    expect(reasonsText(v)).toContain(name);
    expect(reasonsText(v)).toMatch(mechanism);
    // The reason must explain the power, not merely print the flag name.
    expect(reasonsText(v)).toMatch(/not on the layer 0 allowlist/i);
  });

  it('rejects an extension this library has never heard of (the allowlist works)', async () => {
    const v = await verdictFor({ tlv: [opaqueExtension(UNMAPPED_EXTENSION_CODE, 8)] });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.extensions).toEqual([`unknown(${UNMAPPED_EXTENSION_CODE})`]);
    expect(v.facts.disallowed).toEqual([`unknown(${UNMAPPED_EXTENSION_CODE})`]);
    expect(reasonsText(v)).toMatch(/undocumented extension/i);
    expect(reasonsText(v)).toMatch(/moving, burning or freezing your tokens/i);
  });

  it('collects one reason per disallowed extension, alongside authority reasons', async () => {
    const v = await verdictFor({
      tlv: [
        permanentDelegateEntry(),
        transferHookEntry(),
        opaqueExtension(ExtensionType.PausableConfig, 2),
        opaqueExtension(ExtensionType.MetadataPointer, 4),
      ],
      mintAuthority: ADDRESSES.authority,
    });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.disallowed).toEqual(['permanentDelegate', 'transferHook', 'pausableConfig']);
    // one live authority + three disallowed extensions, all reported
    expect(v.reasons).toHaveLength(4);
    expect(v.facts.transferHook.present).toBe(true);
    expect(v.facts.permanentDelegate.present).toBe(true);
  });
});

/* ========================================================================== */
/* transfer fees                                                              */
/* ========================================================================== */

describe('checkMint: transfer fees', () => {
  it('rejects the 0%-now / 100%-later scheduled trap, naming both epochs', async () => {
    const v = await verdictFor({
      tlv: [transferFeeEntry({ olderFeeBps: 0, olderEpoch: 100, newerFeeBps: ALL_OF_IT_BPS, newerEpoch: 200 })],
    });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.transferFee.scheduledIncrease).toBe(true);
    expect(v.facts.transferFee.maxFeeBpsEver).toBe(ALL_OF_IT_BPS);
    expect(v.facts.transferFeeExceedsLimit).toBe(true);
    expect(reasonsText(v)).toMatch(/SCHEDULED FEE INCREASE/);
    expect(reasonsText(v)).toMatch(/epoch 100/);
    expect(reasonsText(v)).toMatch(/epoch 200/);
    expect(reasonsText(v)).toMatch(/0% now and 100% at a future epoch/i);
    // The extension itself is also off-allowlist: both reasons are reported.
    expect(v.facts.disallowed).toEqual(['transferFeeConfig']);
    expect(v.reasons).toHaveLength(2);
  });

  it('does not raise a fee reason at exactly the configured limit', async () => {
    // A real mint carrying transferFeeConfig is rejected by the ALLOWLIST regardless
    // (maxTransferFeeBps is 0, so "at the limit" means a 0 bps fee). What is asserted
    // here is that the fee RULE did not fire: only the allowlist did.
    const v = await verdictFor({ tlv: [transferFeeEntry({ olderFeeBps: FEE_LIMIT_BPS, newerFeeBps: FEE_LIMIT_BPS })] });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.transferFee.maxFeeBpsEver).toBe(FEE_LIMIT_BPS);
    expect(v.facts.transferFeeExceedsLimit).toBe(false);
    expect(v.facts.disallowed).toEqual(['transferFeeConfig']);
    expect(v.reasons).toHaveLength(1);
    expect(reasonsText(v)).not.toMatch(/exceeds the/i);
  });

  it('raises a fee reason one basis point above the limit', async () => {
    const v = await verdictFor({
      tlv: [transferFeeEntry({ olderFeeBps: FEE_LIMIT_BPS + 1, newerFeeBps: FEE_LIMIT_BPS + 1 })],
    });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.transferFeeExceedsLimit).toBe(true);
    expect(v.reasons).toHaveLength(2);
    expect(reasonsText(v)).toMatch(
      new RegExp(`transfer fee ${FEE_LIMIT_BPS + 1} bps exceeds the ${FEE_LIMIT_BPS} bps limit`),
    );
    expect(reasonsText(v)).toMatch(/compounds across the round trip/i);
  });

  it('passes a fee exactly at the limit when nothing else condemns the mint', async () => {
    // Synthetic on purpose: it isolates the threshold from the allowlist, so the
    // boundary itself is proven rather than masked by the extension rule.
    const v = await checkMint(MINT, ctxFor(factsWithFeePeak(FEE_LIMIT_BPS)));

    expect(v.outcome).toBe(OUTCOME.PASS);
    expect(v.facts.transferFeeExceedsLimit).toBe(false);
    expect(v.facts.transferFee.maxFeeBpsEver).toBe(FEE_LIMIT_BPS);
  });

  it('rejects one basis point above the limit on the same isolated facts', async () => {
    const v = await checkMint(MINT, ctxFor(factsWithFeePeak(FEE_LIMIT_BPS + 1)));

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.reasons).toHaveLength(1);
    expect(v.facts.transferFeeExceedsLimit).toBe(true);
  });

  it('rejects a fee whose peak sits in the OLDER schedule too', async () => {
    const v = await checkMint(
      MINT,
      ctxFor(
        syntheticFacts({
          transferFee: Object.freeze({
            present: true,
            olderEpoch: 10,
            olderFeeBps: ALL_OF_IT_BPS,
            newerEpoch: 20,
            newerFeeBps: 0,
            maxFeeBpsEver: ALL_OF_IT_BPS,
            scheduledIncrease: false,
            withdrawWithheldAuthority: null,
            transferFeeConfigAuthority: null,
          }),
        }),
      ),
    );

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(reasonsText(v)).toMatch(/exceeds the/i);
    expect(reasonsText(v)).not.toMatch(/SCHEDULED FEE INCREASE/);
  });
});

/* ========================================================================== */
/* default account state                                                      */
/* ========================================================================== */

describe('checkMint: default account state', () => {
  it('rejects DefaultAccountState=Frozen, naming the unsellable new account', async () => {
    const v = await verdictFor({ tlv: [defaultAccountStateEntry(AccountState.Frozen)] });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.defaultAccountState).toEqual({ present: true, state: 'frozen', frozen: true });
    expect(v.facts.defaultsToFrozen).toBe(true);
    expect(reasonsText(v)).toMatch(/starts FROZEN/);
    expect(reasonsText(v)).toMatch(/cannot sell/i);
    // allowlist reason + frozen reason
    expect(v.reasons).toHaveLength(2);
  });

  it('does not raise a frozen reason for DefaultAccountState=Initialized', async () => {
    const v = await verdictFor({ tlv: [defaultAccountStateEntry(AccountState.Initialized)] });

    expect(v.outcome).toBe(OUTCOME.REJECT);
    expect(v.facts.defaultAccountState.frozen).toBe(false);
    expect(v.facts.defaultsToFrozen).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(reasonsText(v)).not.toMatch(/starts FROZEN/);
  });
});

/* ========================================================================== */
/* fail closed                                                                */
/* ========================================================================== */

describe('checkMint: fail closed', () => {
  const expectErrored = (v) => {
    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(v.outcome).not.toBe(OUTCOME.PASS);
    expect(v.layer).toBe(LAYER);
    // Unknown is null -- never [] (which would read as "no extensions found").
    expect(v.facts.extensions).toBeNull();
    expect(v.facts.disallowed).toBeNull();
    expect(v.facts.authorities).toBeNull();
    expect(v.facts.transferFee).toBeNull();
    expect(v.facts.defaultAccountState).toBeNull();
    expect(v.facts.hadUninitializedEntries).toBeNull();
    expect(v.facts.unverified).toContain('mintAccountBytes');
    expect(v.facts.residualRisk).toEqual(expect.any(String));
  };

  it('a thrown fetch becomes ERROR, never PASS', async () => {
    const ctx = ctxFor(async () => {
      throw new Error('getAccountInfo failed: 429 Too Many Requests');
    });

    const v = await checkMint(MINT, ctx);

    expectErrored(v);
    expect(reasonsText(v)).toMatch(/check failed/i);
    expect(reasonsText(v)).toMatch(/429/);
  });

  it('a real rpcError from fetchMintFacts becomes ERROR', async () => {
    const missingAccount = { getAccountInfo: async () => null };
    const ctx = ctxFor(() => fetchMintFacts(MINT, { rpc: missingAccount }));

    const v = await checkMint(MINT, ctx);

    expectErrored(v);
    expect(reasonsText(v)).toMatch(/does not exist on chain/i);
  });

  it('a timeout-shaped rejection becomes ERROR', async () => {
    const timeout = Object.assign(new Error('layer0-mint timed out after 4000ms'), {
      code: 'GATE_TIMEOUT',
    });
    const v = await checkMint(MINT, ctxFor(async () => Promise.reject(timeout)));

    expectErrored(v);
    expect(reasonsText(v)).toMatch(/timed out/i);
  });

  it('an already-aborted signal is an ERROR and never reads the account', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = ctxFor(await mintFactsFor({ token2022: false }), { signal: controller.signal });

    const v = await checkMint(MINT, ctx);

    expectErrored(v);
    expect(ctx.getMintFacts).not.toHaveBeenCalled();
    expect(reasonsText(v)).toMatch(/unread account is not a clean account/i);
  });

  it.each([
    ['null facts', null],
    ['undefined facts', undefined],
    ['an array', []],
    ['a string', 'clean'],
    ['a number', 0],
  ])('%s becomes ERROR', async (_label, value) => {
    expectErrored(await checkMint(MINT, ctxFor(async () => value)));
  });

  it.each([
    ['mintAuthority missing', { mintAuthority: undefined }],
    ['freezeAuthority missing', { freezeAuthority: undefined }],
    ['mintAuthority a non-address object', { mintAuthority: {} }],
    ['extensions missing', { extensions: undefined }],
    ['extensions not an array', { extensions: 'metadataPointer' }],
    ['an extension name that is not a string', { extensions: [7] }],
    ['isToken2022 missing', { isToken2022: undefined }],
    ['isInitialized missing', { isInitialized: undefined }],
    ['programId missing', { programId: undefined }],
    ['hadUninitializedEntries missing', { hadUninitializedEntries: undefined }],
    ['transferFee missing', { transferFee: undefined }],
    ['transferFee.present missing', { transferFee: { maxFeeBpsEver: 0 } }],
    [
      'a present fee with an unreadable peak',
      { transferFee: { present: true, maxFeeBpsEver: null, scheduledIncrease: false } },
    ],
    [
      'a present fee whose peak is a string',
      { transferFee: { present: true, maxFeeBpsEver: '0', scheduledIncrease: false } },
    ],
    ['defaultAccountState missing', { defaultAccountState: undefined }],
    ['defaultAccountState.frozen missing', { defaultAccountState: { present: true, state: 'x' } }],
  ])('%s becomes ERROR rather than a pass', async (_label, overrides) => {
    const v = await checkMint(MINT, ctxFor(syntheticFacts(overrides)));

    expectErrored(v);
  });

  it('a missing mint authority field is never read as revoked', async () => {
    const v = await checkMint(MINT, ctxFor(syntheticFacts({ mintAuthority: undefined })));

    expect(v.outcome).toBe(OUTCOME.ERROR);
    expect(reasonsText(v)).toMatch(/refusing to read an unknown authority as a revoked one/i);
  });

  it('facts describing a DIFFERENT mint become ERROR', async () => {
    const v = await checkMint(MINT, ctxFor(syntheticFacts({ mint: OTHER_MINT })));

    expectErrored(v);
    expect(reasonsText(v)).toMatch(/refusing to judge one mint by the bytes of another/i);
  });

  it.each([
    ['ctx undefined', undefined],
    ['ctx null', null],
    ['ctx without getMintFacts', {}],
    ['getMintFacts not a function', { getMintFacts: 'yes' }],
  ])('%s becomes ERROR', async (_label, ctx) => {
    const v = await checkMint(MINT, ctx);

    expectErrored(v);
    expect(reasonsText(v)).toMatch(/ctx\.getMintFacts must be a function/);
  });

  it.each([
    ['an empty mint', ''],
    ['a null mint', null],
    ['a numeric mint', 1234],
    ['an object mint', {}],
  ])('%s becomes ERROR without reading anything', async (_label, badMint) => {
    const ctx = ctxFor(syntheticFacts());

    const v = await checkMint(badMint, ctx);

    expectErrored(v);
    expect(ctx.getMintFacts).not.toHaveBeenCalled();
    expect(reasonsText(v)).toMatch(/must be a mint address/i);
  });

  it('never throws, whatever the context does', async () => {
    const hostile = {
      get getMintFacts() {
        return async () => {
          throw Object.assign(new Error('boom'), { cause: new Error('inner') });
        };
      },
      get signal() {
        return { aborted: false };
      },
    };

    await expect(checkMint(MINT, hostile)).resolves.toMatchObject({ outcome: OUTCOME.ERROR });
  });
});

/* ========================================================================== */
/* immutability and the pure rule set                                         */
/* ========================================================================== */

describe('checkMint: immutability', () => {
  it('returns a frozen verdict with frozen facts and never mutates the input', async () => {
    const facts = await mintFactsFor({ tlv: [permanentDelegateEntry()] });
    const before = JSON.stringify(facts);

    const v = await checkMint(MINT, ctxFor(facts));

    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.facts)).toBe(true);
    expect(Object.isFrozen(v.reasons)).toBe(true);
    expect(Object.isFrozen(v.facts.authorities)).toBe(true);
    expect(() => v.reasons.push('extra')).toThrow(TypeError);
    expect(JSON.stringify(facts)).toBe(before);
  });
});

describe('evaluateMintFacts', () => {
  it('is a pure function returning a frozen assessment with no reasons for a clean mint', async () => {
    const facts = await mintFactsFor({ token2022: false });

    const a = evaluateMintFacts(facts);

    expect(Object.isFrozen(a)).toBe(true);
    expect(a.reasons).toEqual([]);
    expect(a.disallowed).toEqual([]);
    expect(a.transferFeeExceedsLimit).toBe(false);
    expect(a.defaultsToFrozen).toBe(false);
  });

  it('throws on unreadable facts so the layer can fail closed', () => {
    expect(() => evaluateMintFacts(null)).toThrow(TypeError);
    expect(() => evaluateMintFacts(syntheticFacts({ extensions: undefined }))).toThrow(TypeError);
    expect(() => evaluateMintFacts(syntheticFacts(), OTHER_MINT)).toThrow(/refusing to judge/i);
  });

  it('gives the same answer twice for the same facts (deterministic)', async () => {
    const facts = await mintFactsFor({ tlv: [transferHookEntry()] });

    expect(evaluateMintFacts(facts, MINT).reasons).toEqual(evaluateMintFacts(facts, MINT).reasons);
  });
});

/* ========================================================================== */
/* honest limits + registry wiring                                            */
/* ========================================================================== */

describe('MINT_INSPECTION_LIMITATION', () => {
  it('states what layer 0 cannot prove', () => {
    const notProven = MINT_INSPECTION_LIMITATION.notProven.join(' | ');

    expect(Object.isFrozen(MINT_INSPECTION_LIMITATION)).toBe(true);
    expect(MINT_INSPECTION_LIMITATION.layer).toBe(LAYER);
    expect(notProven).toMatch(/liquidity/i);
    expect(notProven).toMatch(/holders/i);
    expect(notProven).toMatch(/route out/i);
    expect(notProven).toMatch(/soft rug/i);
    expect(MINT_INSPECTION_LIMITATION.allowlist).toEqual([...SAFETY.layer0.allowedExtensions]);
  });
});

describe('gate registry wiring', () => {
  it('is the function the orchestrator resolves for layer0', async () => {
    expect(LAYER).toBe(LAYER_SPECS.layer0.name);

    const fn = await loadLayerFn(LAYER_SPECS.layer0);

    expect(fn).toBe(checkMint);
  });
});
