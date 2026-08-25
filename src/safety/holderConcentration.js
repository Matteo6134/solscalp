/**
 * Holder-concentration maths for layer 3, extracted so the exclusion set and the
 * percentage arithmetic are independently unit-testable.
 *
 * UNITS: holder amounts and supply must be expressed in the SAME unit. The pair we
 * actually use is getTokenLargestAccounts().value[].amount (raw base units) with
 * getTokenSupply().value.amount (raw base units). normaliseHolders() records which
 * field it read and refuses a list that mixes raw `amount` with `uiAmount`, because
 * a silent unit mix would understate concentration by 10**decimals.
 */

import { KNOWN } from '../config.js';

/** How many holders make up the "top 10" test. Named, not inlined. */
export const TOP_N_HOLDERS = 10;
const PCT_MAX = 100;
/** Float slack when comparing a holder balance against total supply. */
const UNIT_MISMATCH_TOLERANCE = 1.000001;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/* -------------------------------------------------------------------------- */
/* exclusion set                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The addresses that must NOT count towards holder concentration: the pool's own
 * token vaults hold most of the float by design, and burned supply sits in the
 * incinerator. Getting this wrong makes every healthy token look concentrated, so
 * the set is explicit, ordered and returned as data.
 *
 * Both the token-account address AND its owner are matched, because callers may
 * know the AMM/pool authority (the owner) rather than the vault ATA, or vice versa.
 * KNOWN.WSOL / KNOWN.USDC are deliberately absent: those are mints, never holders.
 *
 * @param {object} [p]
 * @param {readonly string[]} [p.poolAddresses] pool, LP vault and pool-authority addresses
 * @param {readonly string[]} [p.extra] additional known-benign holders (lockers, treasuries)
 * @returns {{ has: (address?: string|null) => boolean, addresses: readonly string[], size: number }}
 */
export function buildExclusionSet({ poolAddresses = [], extra = [] } = {}) {
  if (!Array.isArray(poolAddresses)) {
    throw new TypeError(`poolAddresses must be an array, got ${typeof poolAddresses}`);
  }
  if (!Array.isArray(extra)) {
    throw new TypeError(`extra must be an array, got ${typeof extra}`);
  }
  const set = new Set(
    [KNOWN.INCINERATOR, ...poolAddresses, ...extra].map(nonEmptyString).filter((a) => a !== null),
  );
  const addresses = Object.freeze([...set]);
  return Object.freeze({
    addresses,
    size: set.size,
    has: (address) => typeof address === 'string' && set.has(address),
  });
}

/* -------------------------------------------------------------------------- */
/* holders                                                                    */
/* -------------------------------------------------------------------------- */

/** Fields we accept as a balance, in order of preference. */
const AMOUNT_FIELDS = Object.freeze(['amount', 'uiAmount', 'uiAmountString']);

function readEntryAmount(entry, index) {
  for (const field of AMOUNT_FIELDS) {
    const value = finiteOrNull(entry[field]);
    if (value !== null) return { field, value };
  }
  throw new TypeError(
    `holder[${index}] has no usable balance field (looked for ${AMOUNT_FIELDS.join('/')}, ` +
      `keys: ${Object.keys(entry).join(',') || 'none'})`,
  );
}

/**
 * Accepts a bare array or an RPC envelope ({ value: [...] }) of largest accounts
 * and returns frozen `{ address, owner, amount, isLpVault, insider }` entries.
 * @param {unknown} input
 * @returns {{ holders: readonly object[], amountField: string }}
 */
export function normaliseHolders(input) {
  const list = Array.isArray(input)
    ? input
    : isPlainObject(input) && Array.isArray(input.value)
      ? input.value
      : null;
  if (list === null) {
    throw new TypeError(
      `largest-holders response is neither an array nor { value: [] } (got ${
        input === null ? 'null' : typeof input
      })`,
    );
  }

  let amountField = null;
  const holders = list.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new TypeError(`holder[${index}] is not an object (got ${typeof raw})`);
    }
    const address = nonEmptyString(raw.address) ?? nonEmptyString(raw.pubkey);
    if (address === null) {
      throw new TypeError(`holder[${index}] has no address`);
    }
    const { field, value } = readEntryAmount(raw, index);
    if (value < 0) {
      throw new RangeError(`holder[${index}] (${address}) has a negative balance ${value}`);
    }
    if (amountField === null) amountField = field;
    else if (amountField !== field) {
      throw new TypeError(
        `largest-holders list mixes balance units: holder[${index}] used '${field}' ` +
          `while earlier entries used '${amountField}'`,
      );
    }
    return Object.freeze({
      address,
      owner: nonEmptyString(raw.owner),
      amount: value,
      isLpVault: raw.isLpVault === true,
      insider: raw.insider === true,
    });
  });

  return { holders: Object.freeze(holders), amountField: amountField ?? AMOUNT_FIELDS[0] };
}

/**
 * Total supply in the same unit the holders used. Unknown supply throws: layer 3
 * cannot compute a percentage of an unknown denominator and must fail closed.
 * @param {unknown} supply number|bigint|string|{amount,uiAmount}|{value:{...}}
 * @param {string} amountField field normaliseHolders() read, so units line up
 */
export function readSupply(supply, amountField = AMOUNT_FIELDS[0]) {
  const source = isPlainObject(supply) && isPlainObject(supply.value) ? supply.value : supply;
  const value = isPlainObject(source)
    ? finiteOrNull(source[amountField] ?? source.amount ?? source.uiAmount)
    : finiteOrNull(source);
  if (value === null) {
    throw new TypeError(
      `supply is unknown or unparseable (got ${supply === null ? 'null' : typeof supply}); ` +
        'holder concentration cannot be computed',
    );
  }
  if (value <= 0) {
    throw new RangeError(`supply must be positive, got ${value}`);
  }
  return value;
}

/**
 * @param {object} p
 * @param {readonly object[]} p.holders output of normaliseHolders().holders
 * @param {number} p.supply same unit as holder amounts
 * @param {{ has: (a?: string|null) => boolean }} p.exclusion
 * @param {number} [p.topN]
 */
export function computeConcentration({ holders, supply, exclusion, topN = TOP_N_HOLDERS }) {
  const excluded = [];
  const considered = [];

  for (const h of holders) {
    const reason = exclusion.has(h.address)
      ? 'address in exclusion set'
      : exclusion.has(h.owner)
        ? 'owner in exclusion set'
        : h.isLpVault
          ? 'flagged as LP vault by the caller'
          : null;
    if (reason !== null) excluded.push(Object.freeze({ ...h, reason }));
    else considered.push(h);
  }

  // A balance larger than total supply means holders and supply are in different
  // units; percentages would be meaningless, so refuse rather than under-report.
  for (const h of holders) {
    if (h.amount > supply * UNIT_MISMATCH_TOLERANCE) {
      throw new RangeError(
        `holder ${h.address} balance ${h.amount} exceeds supply ${supply}: ` +
          'holder amounts and supply are in different units',
      );
    }
  }

  const sorted = Object.freeze([...considered].sort((a, b) => b.amount - a.amount));
  const top = Object.freeze(
    sorted.slice(0, topN).map((h) =>
      Object.freeze({ address: h.address, owner: h.owner, pct: (h.amount / supply) * PCT_MAX }),
    ),
  );
  const topSum = sorted.slice(0, topN).reduce((sum, h) => sum + h.amount, 0);

  return Object.freeze({
    supply,
    topN,
    holderCount: holders.length,
    consideredCount: considered.length,
    excluded: Object.freeze(excluded),
    top,
    topNPct: (topSum / supply) * PCT_MAX,
    singleLargestPct: sorted.length > 0 ? (sorted[0].amount / supply) * PCT_MAX : 0,
    /** Address -> amount, for insider-cluster maths. */
    amountByAddress: Object.freeze(Object.fromEntries(holders.map((h) => [h.address, h.amount]))),
    amountByOwner: Object.freeze(
      Object.fromEntries(holders.filter((h) => h.owner !== null).map((h) => [h.owner, h.amount])),
    ),
  });
}

/* -------------------------------------------------------------------------- */
/* insider clusters                                                           */
/* -------------------------------------------------------------------------- */

function pickNetworks(graph) {
  if (Array.isArray(graph)) return graph;
  if (isPlainObject(graph)) {
    const candidate = graph.networks ?? graph.insiderNetworks ?? graph.clusters ?? graph.data;
    if (Array.isArray(candidate)) return candidate;
  }
  throw new TypeError(
    `insider graph has no recognisable network array (got ${
      graph === null ? 'null' : typeof graph
    })`,
  );
}

function networkAddresses(network) {
  if (!isPlainObject(network)) return [];
  const list =
    [network.addresses, network.nodes, network.accounts, network.wallets, network.participants].find(
      Array.isArray,
    ) ?? [];
  return list
    .map((n) =>
      typeof n === 'string'
        ? nonEmptyString(n)
        : isPlainObject(n)
          ? nonEmptyString(n.address) ?? nonEmptyString(n.owner) ?? nonEmptyString(n.id)
          : null,
    )
    .filter((a) => a !== null);
}

/**
 * Largest insider-cluster share of supply, as a percentage.
 *
 * A null/undefined graph THROWS: "we do not know" must never be flattened to 0,
 * which would read as "no insiders" and pass the layer. An empty network list is
 * a real answer (RugCheck found no clusters) and yields 0.
 *
 * @param {unknown} graph normalised client output, or the raw API array
 * @param {object} p
 * @param {object} p.concentration output of computeConcentration()
 * @param {{ has: (a?: string|null) => boolean }} p.exclusion
 * @returns {number} percentage of supply, 0-100
 */
export function resolveInsiderClusterPct(graph, { concentration, exclusion }) {
  if (graph === null || graph === undefined) {
    throw new Error(
      'insider graph unavailable: refusing to treat unknown insider concentration as zero',
    );
  }
  if (isPlainObject(graph) && finiteOrNull(graph.largestClusterPct) !== null) {
    return finiteOrNull(graph.largestClusterPct);
  }

  const networks = pickNetworks(graph);
  if (networks.length === 0) return 0;

  const pcts = networks.map((network, index) => {
    const declared = isPlainObject(network)
      ? finiteOrNull(network.pct ?? network.percentage ?? network.tokenPct)
      : null;
    if (declared !== null) return declared;

    const addresses = networkAddresses(network).filter((a) => !exclusion.has(a));
    if (addresses.length === 0) {
      throw new TypeError(
        `insider network[${index}] reports neither a percentage nor any resolvable ` +
          'member address; cluster share is unknown',
      );
    }
    const amount = addresses.reduce(
      (sum, a) =>
        sum + (concentration.amountByAddress[a] ?? concentration.amountByOwner[a] ?? 0),
      0,
    );
    return (amount / concentration.supply) * PCT_MAX;
  });

  return Math.max(...pcts);
}
