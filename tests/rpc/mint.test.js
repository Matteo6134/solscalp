import { describe, expect, it, vi } from 'vitest';
import { AccountState, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { SAFETY } from '../../src/config.js';
import { RPC_ERROR } from '../../src/rpc/rpc-errors.js';
import {
  fetchCreator,
  fetchDeployerHistory,
  fetchHolders,
  fetchMintFacts,
} from '../../src/rpc/mint.js';
import {
  buildExclusionSet,
  computeConcentration,
  normaliseHolders,
  readSupply,
} from '../../src/safety/holderConcentration.js';
import {
  ADDRESSES,
  accountInfo,
  defaultAccountStateEntry,
  mintAccountData,
  opaqueExtension,
  permanentDelegateEntry,
  transferFeeEntry,
  truncatedEntry,
} from '../fixtures/token2022-fixtures.js';

const MINT = ADDRESSES.mint;
const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();
/** Any program that is not a token program. */
const SOME_OTHER_PROGRAM = '11111111111111111111111111111111';

/** Every RPC method a fetcher may touch, all failing loudly unless overridden. */
const makeRpc = (overrides = {}) => ({
  getAccountInfo: vi.fn(async () => {
    throw new Error('getAccountInfo not stubbed');
  }),
  getTokenLargestAccounts: vi.fn(async () => {
    throw new Error('getTokenLargestAccounts not stubbed');
  }),
  getTokenSupply: vi.fn(async () => {
    throw new Error('getTokenSupply not stubbed');
  }),
  getSignaturesForAddress: vi.fn(async () => {
    throw new Error('getSignaturesForAddress not stubbed');
  }),
  getParsedTransaction: vi.fn(async () => {
    throw new Error('getParsedTransaction not stubbed');
  }),
  ...overrides,
});

const legacyMintAccount = (options = {}) =>
  accountInfo({ owner: TOKEN_PROGRAM, data: mintAccountData({ token2022: false, ...options }) });

const token2022Account = (options) =>
  accountInfo({ owner: TOKEN_2022_PROGRAM, data: mintAccountData({ token2022: true, ...options }) });

const expectRpcError = async (promise, code) => {
  await expect(promise).rejects.toMatchObject({ name: 'RpcError', code });
};

/* -------------------------------------------------------------------------- */
/* fetchMintFacts                                                             */
/* -------------------------------------------------------------------------- */

describe('fetchMintFacts', () => {
  it('reads a clean legacy SPL mint with both authorities revoked', async () => {
    const rpc = makeRpc({ getAccountInfo: vi.fn(async () => legacyMintAccount()) });

    const facts = await fetchMintFacts(MINT, { rpc });

    expect(rpc.getAccountInfo).toHaveBeenCalledWith(MINT);
    expect(facts.mint).toBe(MINT);
    expect(facts.programId).toBe(TOKEN_PROGRAM);
    expect(facts.isToken2022).toBe(false);
    expect(facts.decimals).toBe(6);
    expect(facts.supplyRaw).toBe('1000000000');
    expect(facts.supplyUi).toBe(1_000);
    expect(facts.mintAuthority).toBeNull();
    expect(facts.freezeAuthority).toBeNull();
    expect(facts.isInitialized).toBe(true);
    expect(facts.extensions).toEqual([]);
    expect(facts.extensionCodes).toEqual([]);
    expect(facts.hadUninitializedEntries).toBe(false);
    expect(facts.transferFee.present).toBe(false);
    expect(facts.transferFee.maxFeeBpsEver).toBeNull();
    expect(facts.defaultAccountState.frozen).toBe(false);
    expect(facts.transferHook.present).toBe(false);
    expect(facts.permanentDelegate.present).toBe(false);
    expect(facts.raw).toEqual({ owner: TOKEN_PROGRAM, lamports: 1_461_600, dataLength: 82 });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.raw)).toBe(true);
  });

  it('reports live authorities instead of hiding them', async () => {
    const rpc = makeRpc({
      getAccountInfo: vi.fn(async () =>
        legacyMintAccount({
          mintAuthority: ADDRESSES.authority,
          freezeAuthority: ADDRESSES.delegate,
        }),
      ),
    });

    const facts = await fetchMintFacts(MINT, { rpc });

    expect(facts.mintAuthority).toBe(ADDRESSES.authority);
    expect(facts.freezeAuthority).toBe(ADDRESSES.delegate);
    expect(SAFETY.layer0.requireMintAuthorityRevoked).toBe(true);
    expect(SAFETY.layer0.requireFreezeAuthorityRevoked).toBe(true);
  });

  it('surfaces every dangerous Token-2022 extension on one mint', async () => {
    const rpc = makeRpc({
      getAccountInfo: vi.fn(async () =>
        token2022Account({
          tlv: [
            opaqueExtension(ExtensionType.MetadataPointer),
            permanentDelegateEntry(),
            transferFeeEntry({ olderFeeBps: 0, newerFeeBps: 10_000, newerEpoch: 900 }),
            defaultAccountStateEntry(AccountState.Frozen),
            opaqueExtension(ExtensionType.PausableConfig),
          ],
        }),
      ),
    });

    const facts = await fetchMintFacts(MINT, { rpc });

    expect(facts.isToken2022).toBe(true);
    expect(facts.programId).toBe(TOKEN_2022_PROGRAM);
    expect(facts.extensions).toEqual([
      'metadataPointer',
      'permanentDelegate',
      'transferFeeConfig',
      'defaultAccountState',
      'pausableConfig',
    ]);
    expect(facts.permanentDelegate.delegate).toBe(ADDRESSES.delegate);
    // 0% today, 100% at a future epoch: caught through maxFeeBpsEver.
    expect(facts.transferFee.maxFeeBpsEver).toBe(10_000);
    expect(facts.transferFee.scheduledIncrease).toBe(true);
    expect(facts.transferFee.maxFeeBpsEver > SAFETY.layer0.maxTransferFeeBps).toBe(true);
    expect(facts.defaultAccountState.frozen).toBe(true);
  });

  it('throws ACCOUNT_NOT_FOUND for a null account', async () => {
    const rpc = makeRpc({ getAccountInfo: vi.fn(async () => null) });
    await expectRpcError(fetchMintFacts(MINT, { rpc }), RPC_ERROR.ACCOUNT_NOT_FOUND);
  });

  it('throws ACCOUNT_NOT_FOUND for an undefined account', async () => {
    const rpc = makeRpc({ getAccountInfo: vi.fn(async () => undefined) });
    await expectRpcError(fetchMintFacts(MINT, { rpc }), RPC_ERROR.ACCOUNT_NOT_FOUND);
  });

  it('throws NOT_A_MINT when the owner is neither token program', async () => {
    const rpc = makeRpc({
      getAccountInfo: vi.fn(async () =>
        accountInfo({ owner: SOME_OTHER_PROGRAM, data: mintAccountData({ token2022: false }) }),
      ),
    });
    await expectRpcError(fetchMintFacts(MINT, { rpc }), RPC_ERROR.NOT_A_MINT);
    await expect(fetchMintFacts(MINT, { rpc })).rejects.toThrow(/not a mint/);
  });

  it('throws NOT_A_MINT when a token-owned account is too small to be a mint', async () => {
    const rpc = makeRpc({
      getAccountInfo: vi.fn(async () => accountInfo({ owner: TOKEN_PROGRAM, data: Buffer.alloc(10) })),
    });
    await expectRpcError(fetchMintFacts(MINT, { rpc }), RPC_ERROR.NOT_A_MINT);
  });

  it('throws NOT_A_MINT when the Token-2022 account-type byte says it is not a mint', async () => {
    const data = mintAccountData({ tlv: [opaqueExtension(ExtensionType.MetadataPointer)] });
    const notAMint = Buffer.from(data);
    notAMint[165] = 2; // AccountType.Account
    const rpc = makeRpc({
      getAccountInfo: vi.fn(async () => accountInfo({ owner: TOKEN_2022_PROGRAM, data: notAMint })),
    });
    await expectRpcError(fetchMintFacts(MINT, { rpc }), RPC_ERROR.NOT_A_MINT);
  });

  it('throws INVALID_ADDRESS before spending a single request', async () => {
    const rpc = makeRpc();
    await expectRpcError(fetchMintFacts('not-a-base58-address', { rpc }), RPC_ERROR.INVALID_ADDRESS);
    await expectRpcError(fetchMintFacts(null, { rpc }), RPC_ERROR.INVALID_ADDRESS);
    await expectRpcError(fetchMintFacts(undefined, { rpc }), RPC_ERROR.INVALID_ADDRESS);
    expect(rpc.getAccountInfo).not.toHaveBeenCalled();
  });

  it('throws INVALID_ADDRESS for base58 that is not a 32-byte key', async () => {
    const rpc = makeRpc({ getAccountInfo: vi.fn(async () => legacyMintAccount()) });
    await expectRpcError(fetchMintFacts('z'.repeat(44), { rpc }), RPC_ERROR.INVALID_ADDRESS);
  });

  it('throws UNPARSEABLE when the account envelope is unreadable', async () => {
    await expectRpcError(
      fetchMintFacts(MINT, { rpc: makeRpc({ getAccountInfo: vi.fn(async () => 'nope') }) }),
      RPC_ERROR.UNPARSEABLE,
    );
    await expectRpcError(
      fetchMintFacts(MINT, {
        rpc: makeRpc({ getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(82) })) }),
      }),
      RPC_ERROR.UNPARSEABLE,
    );
    await expectRpcError(
      fetchMintFacts(MINT, {
        rpc: makeRpc({
          getAccountInfo: vi.fn(async () => ({ owner: TOKEN_PROGRAM, data: 'base64-string' })),
        }),
      }),
      RPC_ERROR.UNPARSEABLE,
    );
  });

  it('throws UNPARSEABLE on malformed TLV rather than reporting no extensions', async () => {
    const rpc = makeRpc({
      getAccountInfo: vi.fn(async () =>
        accountInfo({
          owner: TOKEN_2022_PROGRAM,
          data: mintAccountData({ tlv: [Buffer.from([1, 0, 4])] }),
        }),
      ),
    });
    await expectRpcError(fetchMintFacts(MINT, { rpc }), RPC_ERROR.UNPARSEABLE);
    await expect(fetchMintFacts(MINT, { rpc })).rejects.toThrow(/extension data could not be/);
  });

  it('throws UNPARSEABLE when an extension is present but truncated', async () => {
    const rpc = makeRpc({
      getAccountInfo: vi.fn(async () =>
        token2022Account({ tlv: [truncatedEntry(ExtensionType.TransferFeeConfig)] }),
      ),
    });
    await expectRpcError(fetchMintFacts(MINT, { rpc }), RPC_ERROR.UNPARSEABLE);
  });

  it('lets a transport failure propagate: there is no default mint', async () => {
    const boom = new Error('503 Service Unavailable');
    const rpc = makeRpc({
      getAccountInfo: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(fetchMintFacts(MINT, { rpc })).rejects.toThrow(boom);
  });

  it('accepts the frozen, string-owner, Uint8Array shape the RpcClient returns', async () => {
    // src/rpc/connection.js hands back Object.freeze({...accountInfo}) after
    // requireAccountInfo(), so nothing here may need to mutate or re-wrap it.
    const rpc = makeRpc({
      getAccountInfo: vi.fn(async () =>
        Object.freeze({
          owner: TOKEN_PROGRAM,
          data: new Uint8Array(mintAccountData({ token2022: false })),
          lamports: 1_461_600,
          executable: false,
          rentEpoch: 0,
        }),
      ),
    });

    const facts = await fetchMintFacts(MINT, { rpc });

    expect(facts.programId).toBe(TOKEN_PROGRAM);
    expect(facts.supplyRaw).toBe('1000000000');
    expect(facts.raw.dataLength).toBe(82);
  });

  it('does not mutate the account info it was handed', async () => {
    const info = legacyMintAccount();
    const snapshot = { ...info, data: Buffer.from(info.data) };
    const rpc = makeRpc({ getAccountInfo: vi.fn(async () => info) });

    await fetchMintFacts(MINT, { rpc });

    expect(info.owner.toBase58()).toBe(snapshot.owner.toBase58());
    expect(Buffer.compare(info.data, snapshot.data)).toBe(0);
    expect(Object.keys(info).sort()).toEqual(Object.keys(snapshot).sort());
  });
});

/* -------------------------------------------------------------------------- */
/* fetchHolders                                                               */
/* -------------------------------------------------------------------------- */

const HOLDER_A = 'BXBrfBZ3TjZBhWKS4TVMuFVvUnHqDLgvsSVFnLQVWyq5';
const HOLDER_B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const HOLDER_C = '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj';

const largestAccount = (address, amount, decimals = 6) => ({
  address,
  amount: String(amount),
  decimals,
  uiAmount: Number(amount) / 10 ** decimals,
  uiAmountString: String(Number(amount) / 10 ** decimals),
});

const supplyResponse = (amount, decimals = 6) => ({
  amount: String(amount),
  decimals,
  uiAmount: Number(amount) / 10 ** decimals,
});

const holdersRpc = (largest, supply) =>
  makeRpc({
    getTokenLargestAccounts: vi.fn(async () => largest),
    getTokenSupply: vi.fn(async () => supply),
  });

describe('fetchHolders', () => {
  it('returns raw base units in the exact shape holderConcentration.js consumes', async () => {
    const rpc = holdersRpc(
      [
        largestAccount(HOLDER_A, 300_000_000),
        largestAccount(HOLDER_B, 100_000_000),
        largestAccount(HOLDER_C, 50_000_000),
      ],
      supplyResponse(1_000_000_000),
    );

    const result = await fetchHolders(MINT, { rpc });

    expect(result.amountField).toBe('amount');
    expect(result.supply).toBe(1_000_000_000);
    expect(result.holders[0]).toEqual({
      address: HOLDER_A,
      owner: null,
      amount: 300_000_000,
      isLpVault: false,
      insider: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.holders)).toBe(true);
    expect(Object.isFrozen(result.holders[0])).toBe(true);

    // The contract that matters: layer 3 must be able to use this untouched.
    const { holders, amountField } = normaliseHolders(result.holders);
    const supply = readSupply(result.supply, amountField);
    const concentration = computeConcentration({
      holders,
      supply,
      exclusion: buildExclusionSet({ poolAddresses: [HOLDER_A] }),
    });
    expect(concentration.topNPct).toBeCloseTo(15, 10);
    expect(concentration.singleLargestPct).toBeCloseTo(10, 10);
  });

  it('accepts the { value: [...] } RPC envelope', async () => {
    const rpc = holdersRpc(
      { value: [largestAccount(HOLDER_A, 1)] },
      supplyResponse(1_000_000_000),
    );
    const result = await fetchHolders(MINT, { rpc });
    expect(result.holders).toHaveLength(1);
  });

  it('resolves owners when a resolver is injected', async () => {
    const rpc = holdersRpc([largestAccount(HOLDER_A, 10)], supplyResponse(100));
    const resolveOwners = vi.fn(async () => new Map([[HOLDER_A, ADDRESSES.deployer]]));

    const result = await fetchHolders(MINT, { rpc, resolveOwners });

    expect(resolveOwners).toHaveBeenCalledWith([HOLDER_A]);
    expect(result.holders[0].owner).toBe(ADDRESSES.deployer);
  });

  it('accepts a plain object from the owner resolver and rejects anything else', async () => {
    const rpc = holdersRpc([largestAccount(HOLDER_A, 10)], supplyResponse(100));
    const viaObject = await fetchHolders(MINT, {
      rpc,
      resolveOwners: async () => ({ [HOLDER_A]: ADDRESSES.deployer }),
    });
    expect(viaObject.holders[0].owner).toBe(ADDRESSES.deployer);

    await expectRpcError(
      fetchHolders(MINT, { rpc, resolveOwners: async () => 'nope' }),
      RPC_ERROR.UNPARSEABLE,
    );
  });

  it('throws rather than treating an empty holder list as zero concentration', async () => {
    await expectRpcError(
      fetchHolders(MINT, { rpc: holdersRpc([], supplyResponse(1_000)) }),
      RPC_ERROR.UNPARSEABLE,
    );
    await expect(
      fetchHolders(MINT, { rpc: holdersRpc([], supplyResponse(1_000)) }),
    ).rejects.toThrow(/no holders/);
  });

  it('throws when the largest-accounts response is not a list at all', async () => {
    await expectRpcError(
      fetchHolders(MINT, { rpc: holdersRpc(null, supplyResponse(1_000)) }),
      RPC_ERROR.UNPARSEABLE,
    );
  });

  it('throws on an unknown, empty or non-positive supply instead of dividing by it', async () => {
    const holders = [largestAccount(HOLDER_A, 1)];
    for (const supply of [
      null,
      {},
      { amount: '' },
      { amount: 'abc' },
      { amount: '0' },
      { amount: '-5' },
    ]) {
      await expectRpcError(
        fetchHolders(MINT, { rpc: holdersRpc(holders, supply) }),
        RPC_ERROR.UNPARSEABLE,
      );
    }
  });

  it('throws when a holder entry is unreadable', async () => {
    const supply = supplyResponse(1_000);
    for (const entry of [null, 'x', {}, { address: HOLDER_A }, { address: HOLDER_A, amount: '' }]) {
      await expectRpcError(
        fetchHolders(MINT, { rpc: holdersRpc([entry], supply) }),
        RPC_ERROR.UNPARSEABLE,
      );
    }
  });

  it('refuses a decimals mismatch between a holder and the supply', async () => {
    const rpc = holdersRpc(
      [largestAccount(HOLDER_A, 100, 9)],
      supplyResponse(1_000_000_000, 6),
    );
    await expect(fetchHolders(MINT, { rpc })).rejects.toThrow(/different units/);
  });

  it('refuses a balance larger than the supply: the units cannot both be raw', async () => {
    const rpc = holdersRpc([largestAccount(HOLDER_A, 2_000)], supplyResponse(1_000));
    await expect(fetchHolders(MINT, { rpc })).rejects.toThrow(/different units/);
  });

  it('accepts a holder that owns exactly the whole supply (boundary)', async () => {
    const rpc = holdersRpc([largestAccount(HOLDER_A, 1_000)], supplyResponse(1_000));
    const result = await fetchHolders(MINT, { rpc });
    expect(result.holders[0].amount).toBe(1_000);
    expect(result.supply).toBe(1_000);
  });

  it('validates the mint before making either call', async () => {
    const rpc = holdersRpc([], supplyResponse(1));
    await expectRpcError(fetchHolders('nope', { rpc }), RPC_ERROR.INVALID_ADDRESS);
    expect(rpc.getTokenSupply).not.toHaveBeenCalled();
    expect(rpc.getTokenLargestAccounts).not.toHaveBeenCalled();
  });

  it('lets a transport failure propagate', async () => {
    const rpc = makeRpc({
      getTokenLargestAccounts: vi.fn(async () => {
        throw new Error('429 too many requests');
      }),
      getTokenSupply: vi.fn(async () => supplyResponse(1_000)),
    });
    await expect(fetchHolders(MINT, { rpc })).rejects.toThrow(/429/);
  });
});

/* -------------------------------------------------------------------------- */
/* fetchCreator                                                               */
/* -------------------------------------------------------------------------- */

const signatureEntry = (signature, blockTime = 1_700_000_000) => ({
  signature,
  slot: 1,
  blockTime,
  err: null,
});

const parsedTx = ({
  feePayer = ADDRESSES.deployer,
  blockTime = 1_700_000_000,
  instructions = [],
  inner = [],
} = {}) => ({
  blockTime,
  transaction: {
    message: {
      accountKeys: [
        { pubkey: feePayer, signer: true, writable: true },
        { pubkey: HOLDER_A, signer: false, writable: true },
      ],
      instructions,
    },
  },
  meta: inner.length > 0 ? { innerInstructions: [{ index: 0, instructions: inner }] } : { logs: [] },
});

const initMintIx = (mint, programId = TOKEN_PROGRAM) => ({
  program: 'spl-token',
  programId,
  parsed: { type: 'initializeMint', info: { mint, decimals: 6, mintAuthority: ADDRESSES.deployer } },
});

describe('fetchCreator', () => {
  it('returns the fee payer of the oldest transaction', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [
        signatureEntry('newest', 1_800_000_000),
        signatureEntry('oldest', 1_700_000_000),
      ]),
      getParsedTransaction: vi.fn(async () => parsedTx({ blockTime: 1_700_000_000 })),
    });

    const creator = await fetchCreator(MINT, { rpc });

    expect(creator).toEqual({
      creator: ADDRESSES.deployer,
      createdAtMs: 1_700_000_000_000,
      signature: 'oldest',
    });
    expect(Object.isFrozen(creator)).toBe(true);
    expect(rpc.getParsedTransaction).toHaveBeenCalledWith('oldest');
  });

  it('pages back to the genuinely oldest signature', async () => {
    const pages = [
      [signatureEntry('s1'), signatureEntry('s2')],
      [signatureEntry('s3')],
    ];
    const getSignaturesForAddress = vi.fn(async (_address, options) =>
      options.before === undefined ? pages[0] : pages[1],
    );
    const rpc = makeRpc({
      getSignaturesForAddress,
      getParsedTransaction: vi.fn(async () => parsedTx()),
    });

    const creator = await fetchCreator(MINT, { rpc, signaturePageLimit: 2 });

    expect(creator.signature).toBe('s3');
    expect(getSignaturesForAddress).toHaveBeenNthCalledWith(2, MINT, { limit: 2, before: 's2' });
  });

  it('returns null (unknown) when the history is deeper than the page cap', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [signatureEntry('s1')]),
      getParsedTransaction: vi.fn(async () => parsedTx()),
    });
    const logger = { debug: vi.fn() };

    const creator = await fetchCreator(MINT, {
      rpc,
      signaturePageLimit: 1,
      maxSignaturePages: 1,
      logger,
    });

    expect(creator).toBeNull();
    expect(logger.debug).toHaveBeenCalled();
    expect(rpc.getParsedTransaction).not.toHaveBeenCalled();
  });

  it('returns null when the node refuses deep history', async () => {
    const refusal = Object.assign(new Error('Transaction history is not available'), {
      code: -32011,
    });
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => {
        throw refusal;
      }),
    });
    const logger = { debug: vi.fn() };

    expect(await fetchCreator(MINT, { rpc, logger })).toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('returns null when the address has no transactions at all', async () => {
    const rpc = makeRpc({ getSignaturesForAddress: vi.fn(async () => []) });
    expect(await fetchCreator(MINT, { rpc })).toBeNull();
  });

  it('returns null when a signature entry or a page is unreadable', async () => {
    const noSignature = makeRpc({ getSignaturesForAddress: vi.fn(async () => [{ slot: 1 }]) });
    expect(await fetchCreator(MINT, { rpc: noSignature })).toBeNull();

    const notAList = makeRpc({ getSignaturesForAddress: vi.fn(async () => ({ value: [] })) });
    expect(await fetchCreator(MINT, { rpc: notAList })).toBeNull();
  });

  it('returns null when the creating transaction cannot be read', async () => {
    const throwing = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [signatureEntry('oldest')]),
      getParsedTransaction: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    expect(await fetchCreator(MINT, { rpc: throwing })).toBeNull();

    const pruned = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [signatureEntry('oldest')]),
      getParsedTransaction: vi.fn(async () => null),
    });
    expect(await fetchCreator(MINT, { rpc: pruned })).toBeNull();
  });

  it('falls back to the signature blockTime, then to a null age', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [signatureEntry('oldest', 1_650_000_000)]),
      getParsedTransaction: vi.fn(async () => parsedTx({ blockTime: null })),
    });
    expect((await fetchCreator(MINT, { rpc })).createdAtMs).toBe(1_650_000_000_000);

    const noTime = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [signatureEntry('oldest', null)]),
      getParsedTransaction: vi.fn(async () => parsedTx({ blockTime: null })),
    });
    const creator = await fetchCreator(MINT, { rpc: noTime });
    expect(creator.creator).toBe(ADDRESSES.deployer);
    expect(creator.createdAtMs).toBeNull();
  });

  it('validates the mint before any request', async () => {
    const rpc = makeRpc();
    await expectRpcError(fetchCreator('nope', { rpc }), RPC_ERROR.INVALID_ADDRESS);
    expect(rpc.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* fetchDeployerHistory                                                       */
/* -------------------------------------------------------------------------- */

const NOW_MS = 1_800_000_000_000;
const secondsAgo = (days) => (NOW_MS - days * 86_400_000) / 1_000;
const MINT_ONE = 'BXBrfBZ3TjZBhWKS4TVMuFVvUnHqDLgvsSVFnLQVWyq5';
const MINT_TWO = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('fetchDeployerHistory', () => {
  it('counts the mints the wallet paid to create inside the lookback window', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [
        signatureEntry('tx1', secondsAgo(1)),
        signatureEntry('tx2', secondsAgo(2)),
        signatureEntry('tx3', secondsAgo(3)),
      ]),
      getParsedTransaction: vi.fn(async (signature) =>
        signature === 'tx3'
          ? parsedTx({ feePayer: HOLDER_A, instructions: [initMintIx('somebodyElsesMint')] })
          : parsedTx({
              instructions: [initMintIx(signature === 'tx1' ? MINT_ONE : MINT_TWO)],
            }),
      ),
    });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
    });

    expect(history.address).toBe(ADDRESSES.deployer);
    expect(history.mintCount).toBe(2);
    expect(history.knownMints).toEqual([MINT_ONE, MINT_TWO]);
    expect(history.lookbackDays).toBe(SAFETY.layer4.deployerHistoryLookbackDays);
    expect(history.scannedTransactions).toBe(3);
    expect(history.mintCountIsLowerBound).toBe(false);
    expect(history.source).toBe('onchain:initializeMint-scan');
    expect(Object.isFrozen(history)).toBe(true);
  });

  it('never reports a rug rate it cannot derive: null, and null is not zero', async () => {
    const rpc = makeRpc({ getSignaturesForAddress: vi.fn(async () => []) });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
    });

    expect(history.priorRugRate).toBeNull();
    expect(history.priorRugRate).not.toBe(0);
    expect(history.ruggedCount).toBeNull();
    expect(history.mintCount).toBe(0);
    expect(history.unverified.join(' ')).toMatch(/must not be read as 0/);
    // A null rate can never trip layer 4's threshold; layer 4 must handle unknown.
    expect(history.priorRugRate > SAFETY.layer4.maxDeployerPriorRugRate).toBe(false);
  });

  it('counts a mint created through a CPI (launchpad pattern)', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [signatureEntry('tx1', secondsAgo(1))]),
      getParsedTransaction: vi.fn(async () =>
        parsedTx({ inner: [initMintIx(MINT_ONE, TOKEN_2022_PROGRAM)] }),
      ),
    });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
    });

    expect(history.knownMints).toEqual([MINT_ONE]);
  });

  it('stops at the edge of the lookback window', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [
        signatureEntry('recent', secondsAgo(1)),
        signatureEntry('ancient', secondsAgo(SAFETY.layer4.deployerHistoryLookbackDays + 1)),
      ]),
      getParsedTransaction: vi.fn(async () => parsedTx({ instructions: [initMintIx(MINT_ONE)] })),
    });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
    });

    expect(history.scannedTransactions).toBe(1);
    expect(history.mintCount).toBe(1);
    expect(history.mintCountIsLowerBound).toBe(false);
  });

  it('uses RugCheck wallet risk for the rate, reporting the boundary as not-exceeded', async () => {
    const rpc = makeRpc({ getSignaturesForAddress: vi.fn(async () => []) });
    const getWalletRisk = vi.fn(async () => ({
      address: ADDRESSES.deployer,
      rugCount: 3,
      mintCount: 12,
      priorRugRate: SAFETY.layer4.maxDeployerPriorRugRate,
      rugged: false,
    }));

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk,
    });

    expect(getWalletRisk).toHaveBeenCalledWith(ADDRESSES.deployer);
    expect(history.ruggedCount).toBe(3);
    expect(history.priorRugRate).toBe(SAFETY.layer4.maxDeployerPriorRugRate);
    expect(history.priorRugRate > SAFETY.layer4.maxDeployerPriorRugRate).toBe(false);
    expect(history.source).toBe('onchain:initializeMint-scan+rugcheck:wallet-risk');
  });

  it('keeps the rate null when RugCheck knows the wallet but not its history', async () => {
    const rpc = makeRpc({ getSignaturesForAddress: vi.fn(async () => []) });
    const getWalletRisk = vi.fn(async () => ({ riskScore: 40, priorRugRate: null }));

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk,
    });

    expect(history.priorRugRate).toBeNull();
    expect(history.ruggedCount).toBeNull();
  });

  it('survives a RugCheck outage without failing the whole lookup', async () => {
    const rpc = makeRpc({ getSignaturesForAddress: vi.fn(async () => []) });
    const logger = { debug: vi.fn() };

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      logger,
      getWalletRisk: async () => {
        throw new Error('503');
      },
    });

    expect(history.source).toBe('onchain:initializeMint-scan');
    expect(history.priorRugRate).toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('reports an unreadable signature history as unknown, not as zero mints', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => {
        throw new Error('Transaction history is not available');
      }),
    });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
    });

    expect(history.mintCount).toBeNull();
    expect(history.mintCountIsLowerBound).toBe(true);
    expect(history.knownMints).toEqual([]);
    expect(history.source).toBe('none');
    expect(history.unverified.join(' ')).toMatch(/could not be read/);
  });

  it('falls back to the RugCheck mint count only when the chain scan failed', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => {
        throw new Error('history unavailable');
      }),
    });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: async () => ({ mintCount: 9, rugCount: null, priorRugRate: null }),
    });

    expect(history.mintCount).toBe(9);
    expect(history.mintCountIsLowerBound).toBe(true);
  });

  it('marks the count as a floor when the page cap is hit', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [signatureEntry('tx1', secondsAgo(1))]),
      getParsedTransaction: vi.fn(async () => parsedTx({ instructions: [initMintIx(MINT_ONE)] })),
    });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
      signaturePageLimit: 1,
      maxSignaturePages: 1,
    });

    expect(history.mintCount).toBe(1);
    expect(history.mintCountIsLowerBound).toBe(true);
    expect(history.unverified.join(' ')).toMatch(/floor/);
  });

  it('marks the count as a floor when the inspection cap is hit', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [
        signatureEntry('tx1', secondsAgo(1)),
        signatureEntry('tx2', secondsAgo(2)),
      ]),
      getParsedTransaction: vi.fn(async () => parsedTx({ instructions: [initMintIx(MINT_ONE)] })),
    });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
      maxTransactionInspections: 1,
    });

    expect(history.scannedTransactions).toBe(1);
    expect(history.mintCountIsLowerBound).toBe(true);
  });

  it('marks the count as a floor when one transaction cannot be read', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [
        signatureEntry('good', secondsAgo(1)),
        signatureEntry('bad', secondsAgo(2)),
      ]),
      getParsedTransaction: vi.fn(async (signature) => {
        if (signature === 'bad') throw new Error('timeout');
        return parsedTx({ instructions: [initMintIx(MINT_ONE)] });
      }),
    });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
    });

    expect(history.mintCount).toBe(1);
    expect(history.scannedTransactions).toBe(1);
    expect(history.mintCountIsLowerBound).toBe(true);
  });

  it('stops walking when the layer budget is already aborted', async () => {
    const rpc = makeRpc({ getSignaturesForAddress: vi.fn(async () => [signatureEntry('tx1')]) });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
      signal: { aborted: true },
    });

    expect(rpc.getSignaturesForAddress).not.toHaveBeenCalled();
    // Nothing was looked at, so nothing is claimed -- least of all "0 prior mints".
    expect(history.mintCount).toBeNull();
    expect(history.mintCountIsLowerBound).toBe(true);
    expect(history.source).toBe('none');
  });

  it('reports null, not 0, when the walk was cut short before finding any mint', async () => {
    const rpc = makeRpc({
      getSignaturesForAddress: vi.fn(async () => [signatureEntry('tx1', secondsAgo(1))]),
      getParsedTransaction: vi.fn(async () => parsedTx({ instructions: [] })),
    });

    const history = await fetchDeployerHistory(ADDRESSES.deployer, {
      rpc,
      nowMs: NOW_MS,
      getWalletRisk: null,
      signaturePageLimit: 1,
      maxSignaturePages: 1,
    });

    expect(history.mintCount).toBeNull();
    expect(history.mintCountIsLowerBound).toBe(true);
    expect(history.unverified.join(' ')).toMatch(/cut short/);
  });

  it('validates the deployer address before any request', async () => {
    const rpc = makeRpc();
    await expectRpcError(fetchDeployerHistory('nope', { rpc }), RPC_ERROR.INVALID_ADDRESS);
    await expectRpcError(fetchDeployerHistory(null, { rpc }), RPC_ERROR.INVALID_ADDRESS);
    expect(rpc.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});
