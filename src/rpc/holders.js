/**
 * Holder distribution for layer 3. Part of the src/rpc/mint.js contract, kept in its
 * own file so neither module outgrows the size limit; mint.js re-exports it.
 *
 * WHAT THIS MODULE PROVES
 * -----------------------
 * The balances of the largest token ACCOUNTS the node returned, and the total supply,
 * both in the SAME unit: raw base units. Nothing is converted, so no percentage can
 * be computed across mixed units.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 *  - Not "the largest holders". getTokenLargestAccounts returns up to 20 token
 *    accounts. One person holding through 30 accounts looks like 30 holders, and
 *    accounts 21+ are invisible. Concentration measured from this is a FLOOR, never
 *    a proof of dispersion.
 *  - Not who owns them: see the `owner` note on fetchHolders.
 *  - Nothing about intent. A cluster of unrelated-looking wallets funded from one
 *    source is exactly what a bundled launch looks like; that is layer 3's insider
 *    graph, not this endpoint.
 *
 * FAIL CLOSED: an unknown supply, a zero supply, an unreadable entry, mismatched
 * decimals or an empty list all throw rpcError(UNPARSEABLE).
 */

import { resolveRpc } from './rpc-deps.js';
import { requireAddress } from './rpc-validate.js';
import { addressOrNull, amountOrNull, isPlainObject, unparseable } from './rpc-values.js';

/**
 * Float slack when comparing one holder's balance against total supply. A balance
 * above supply means the two figures are in different units, which would understate
 * concentration by 10**decimals. Mirrors holderConcentration.js deliberately: the
 * unit check happens at the boundary as well as in the maths.
 */
const UNIT_MISMATCH_TOLERANCE = 1.000001;

/** Supply in RAW base units, plus its decimals, so units can be cross-checked. */
function readSupplyResponse(response, address) {
  if (!isPlainObject(response)) {
    throw unparseable(
      `getTokenSupply(${address}) returned ${response === null ? 'null' : typeof response}`,
      { address },
    );
  }
  const supply = amountOrNull(response.amount);
  if (supply === null) {
    throw unparseable(
      `getTokenSupply(${address}) has no readable raw amount (got ${String(response.amount)})`,
      { address },
    );
  }
  if (supply <= 0) {
    // A zero denominator cannot yield a percentage, and 0/0 = NaN would compare
    // false against every threshold, i.e. pass. Refuse.
    throw unparseable(`getTokenSupply(${address}) reported a non-positive supply (${supply})`, {
      address,
    });
  }
  const decimals = Number.isInteger(response.decimals) ? response.decimals : null;
  return { supply, decimals };
}

/** One largest-accounts entry, in the shape normaliseHolders() expects. */
function readHolderEntry(raw, index, address, supply, supplyDecimals, owner) {
  if (!isPlainObject(raw)) {
    throw unparseable(`getTokenLargestAccounts(${address})[${index}] is not an object`, { address });
  }
  const holderAddress = addressOrNull(raw.address ?? raw.pubkey);
  if (holderAddress === null) {
    throw unparseable(`getTokenLargestAccounts(${address})[${index}] has no address`, { address });
  }
  const amount = amountOrNull(raw.amount);
  if (amount === null || amount < 0) {
    throw unparseable(
      `getTokenLargestAccounts(${address})[${index}] has no usable raw amount ` +
        `(got ${String(raw.amount)})`,
      { address },
    );
  }
  if (supplyDecimals !== null && Number.isInteger(raw.decimals) && raw.decimals !== supplyDecimals) {
    throw unparseable(
      `getTokenLargestAccounts(${address})[${index}] reports ${raw.decimals} decimals but the ` +
        `supply reports ${supplyDecimals}: the two figures are in different units`,
      { address },
    );
  }
  if (amount > supply * UNIT_MISMATCH_TOLERANCE) {
    throw unparseable(
      `getTokenLargestAccounts(${address})[${index}] holds ${amount} of a supply of ${supply}: ` +
        'holder amounts and supply are in different units',
      { address },
    );
  }
  return Object.freeze({
    address: holderAddress,
    owner,
    amount,
    /** The caller (layer 3) decides what is a vault; the node does not tell us. */
    isLpVault: false,
    /** Insider membership comes from the RugCheck graph, not from this endpoint. */
    insider: false,
  });
}

/** Optional owner lookup. Absent by default: see the note in fetchHolders' JSDoc. */
async function resolveOwnerMap(addresses, deps) {
  if (typeof deps.resolveOwners !== 'function') return null;
  const resolved = await deps.resolveOwners(addresses);
  if (resolved instanceof Map) return resolved;
  if (isPlainObject(resolved)) return new Map(Object.entries(resolved));
  throw unparseable(
    `deps.resolveOwners returned ${resolved === null ? 'null' : typeof resolved}, ` +
      'expected a Map or a plain object',
  );
}

/**
 * Largest token accounts plus total supply, in ONE unit: raw base units.
 *
 * The output is shaped for normaliseHolders() in src/safety/holderConcentration.js:
 * `{ address, owner, amount, isLpVault, insider }` entries with `amount` and
 * `supply` both raw.
 *
 * `owner` is null unless `deps.resolveOwners` is supplied. getTokenLargestAccounts
 * does not return owners, and resolving them costs an extra getMultipleAccounts per
 * 100 entries, which layer 3 does not always want to spend. The consequence is
 * documented and safe in one direction only: layer 3's exclusion set can then match
 * a vault by its token-account address but not by its owner, so a missed LP vault
 * makes a healthy token look concentrated -- a false REJECT, never a false PASS.
 *
 * An empty holder list THROWS: zero holders would compute as zero concentration,
 * which reads as "perfectly distributed" and passes layer 3. That is unknown data,
 * not a clean token.
 *
 * @param {string} mint
 * @param {{ rpc?: object, resolveOwners?: (a: readonly string[]) => Promise<Map|object> }} [deps]
 * @returns {Promise<Readonly<{ holders: readonly object[], amountField: string, supply: number }>>}
 * @throws rpcError(INVALID_ADDRESS | UNPARSEABLE)
 */
export async function fetchHolders(mint, deps = {}) {
  const address = requireAddress(mint, 'fetchHolders(mint)');
  const rpc = await resolveRpc(deps);
  const [largestAccounts, supplyResponse] = await Promise.all([
    rpc.getTokenLargestAccounts(address),
    rpc.getTokenSupply(address),
  ]);

  const { supply, decimals } = readSupplyResponse(supplyResponse, address);
  const list = Array.isArray(largestAccounts)
    ? largestAccounts
    : isPlainObject(largestAccounts) && Array.isArray(largestAccounts.value)
      ? largestAccounts.value
      : null;
  if (list === null) {
    throw unparseable(
      `getTokenLargestAccounts(${address}) returned ` +
        `${largestAccounts === null ? 'null' : typeof largestAccounts}, not a list`,
      { address },
    );
  }
  if (list.length === 0) {
    throw unparseable(
      `getTokenLargestAccounts(${address}) returned no holders: refusing to treat an ` +
        'empty list as zero concentration',
      { address },
    );
  }

  const addresses = Object.freeze(list.map((raw) => addressOrNull(raw?.address ?? raw?.pubkey)));
  const owners = await resolveOwnerMap(addresses, deps);
  const holders = list.map((raw, index) => {
    const owner = owners === null ? null : addressOrNull(owners.get(addresses[index]));
    return readHolderEntry(raw, index, address, supply, decimals, owner);
  });

  return Object.freeze({
    holders: Object.freeze(holders),
    /** Tells holderConcentration.js which field, and therefore which unit, we used. */
    amountField: 'amount',
    supply,
  });
}
