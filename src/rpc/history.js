/**
 * Deep-history reading for the RPC layer: walking an address's signature list
 * backwards in time, and pulling single facts out of a parsed transaction.
 *
 * WHAT THIS MODULE PROVES
 * -----------------------
 * Only what the endpoint we happened to reach was willing to serve. Nothing more.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * Public RPC nodes prune history and refuse deep queries outright (JSON-RPC -32011,
 * "transaction history is not available"). An answer here is therefore frequently
 * INCOMPLETE, and an incomplete walk cannot support a count, let alone a rate. So
 * every walk reports `truncated` / `reachedEnd`, and the callers in mint.js must
 * turn incompleteness into `null` (UNKNOWN) rather than into a number.
 *
 * Extracted from mint.js so the paging loop is unit-testable on its own and so
 * neither file grows past the size limit. No network default lives here: the caller
 * passes the RpcClient, which is how the tests stay socket-free.
 */

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { RPC_ERROR, rpcError } from './rpc-errors.js';
import { addressOrNull, isPlainObject } from './rpc-values.js';

/** Max signatures getSignaturesForAddress accepts in one call (RPC protocol limit). */
export const SIGNATURE_PAGE_LIMIT = 1_000;

/**
 * How many pages we are willing to walk before declaring the history too deep.
 * Bounded on purpose: layer budgets are in the low seconds and the RPC limit is
 * LIMITS.rpc.requestsPerSecond, so an unbounded walk would blow both.
 */
export const DEFAULT_MAX_SIGNATURE_PAGES = 3;

/** Unit conversion: RPC blockTime is unix SECONDS, everything else here is ms. */
const MS_PER_SECOND = 1_000;

/** The `parsed.type` values that mean "a new mint account was created here". */
const INITIALIZE_MINT_TYPES = new Set(['initializeMint', 'initializeMint2']);

const TOKEN_PROGRAM_IDS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);

/**
 * `blockTime` (unix seconds) as unix milliseconds, or null when the node did not
 * report one. Null is a real answer here: pruned nodes omit blockTime.
 * @param {unknown} source a signature entry or a parsed transaction
 * @returns {number|null}
 */
export function blockTimeMs(source) {
  if (!isPlainObject(source)) return null;
  const seconds = source.blockTime;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return seconds * MS_PER_SECOND;
}

/**
 * Validate one signature-list entry. An unreadable entry throws: a list we cannot
 * parse must not be silently shortened into "this is the oldest transaction".
 */
function readEntry(raw, index) {
  if (!isPlainObject(raw)) {
    throw rpcError(`getSignaturesForAddress[${index}] is not an object (got ${typeof raw})`, {
      code: RPC_ERROR.UNPARSEABLE,
    });
  }
  const signature = addressOrNull(raw.signature);
  if (signature === null) {
    throw rpcError(`getSignaturesForAddress[${index}] has no signature`, {
      code: RPC_ERROR.UNPARSEABLE,
    });
  }
  return Object.freeze({
    signature,
    blockTimeMs: blockTimeMs(raw),
    err: raw.err ?? null,
    raw: Object.freeze(raw),
  });
}

/**
 * Walk an address's signatures newest-first, page by page.
 *
 * @param {object} p
 * @param {{ getSignaturesForAddress: (a: string, o?: object) => Promise<readonly object[]> }} p.rpc
 * @param {string} p.address
 * @param {number|null} [p.sinceMs] stop once an entry is older than this (window walk).
 *   Null walks towards the very first transaction (creation walk).
 * @param {number} [p.pageLimit]
 * @param {number} [p.maxPages]
 * @param {{ aborted: boolean }} [p.signal] stop early rather than burn rate-limit budget
 * @returns {Promise<Readonly<{ entries: readonly object[], pages: number,
 *   truncated: boolean, reachedEnd: boolean, oldest: object|null }>>}
 *   `truncated` means we stopped at the page cap or on an abort, so the walk is
 *   incomplete; `reachedEnd` means we saw the address's first transaction.
 */
export async function walkSignatures({
  rpc,
  address,
  sinceMs = null,
  pageLimit = SIGNATURE_PAGE_LIMIT,
  maxPages = DEFAULT_MAX_SIGNATURE_PAGES,
  signal,
}) {
  if (rpc === null || typeof rpc?.getSignaturesForAddress !== 'function') {
    throw new TypeError('walkSignatures requires an rpc client with getSignaturesForAddress()');
  }
  const entries = [];
  let before;
  let pages = 0;
  let reachedEnd = false;
  let truncated = false;
  let hitWindowEdge = false;

  while (pages < maxPages) {
    if (signal?.aborted === true) {
      truncated = true;
      break;
    }
    const options = before === undefined ? { limit: pageLimit } : { limit: pageLimit, before };
    const page = await rpc.getSignaturesForAddress(address, options);
    pages += 1;
    if (!Array.isArray(page)) {
      throw rpcError(
        `getSignaturesForAddress(${address}) returned ${page === null ? 'null' : typeof page}, ` +
          'not an array',
        { code: RPC_ERROR.UNPARSEABLE, address },
      );
    }
    if (page.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const [index, raw] of page.entries()) {
      const entry = readEntry(raw, index);
      if (sinceMs !== null && entry.blockTimeMs !== null && entry.blockTimeMs < sinceMs) {
        hitWindowEdge = true;
        break;
      }
      entries.push(entry);
    }
    if (hitWindowEdge) break;
    before = readEntry(page[page.length - 1], page.length - 1).signature;
    if (page.length < pageLimit) {
      reachedEnd = true;
      break;
    }
  }
  if (!reachedEnd && !hitWindowEdge) truncated = true;

  return Object.freeze({
    entries: Object.freeze(entries),
    pages,
    truncated,
    reachedEnd,
    /** Only meaningful when reachedEnd is true; otherwise the real oldest is deeper. */
    oldest: entries.length > 0 ? entries[entries.length - 1] : null,
  });
}

/**
 * Fee payer of a parsed transaction: the first signing account key. That is the
 * account that paid for the mint's creation, which is what "creator" means here.
 * @param {unknown} parsedTx output of getParsedTransaction
 * @returns {string|null} null when the shape is not readable -- never a guess
 */
export function feePayerOf(parsedTx) {
  const keys = isPlainObject(parsedTx) ? parsedTx?.transaction?.message?.accountKeys : null;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const signer = keys.find((k) => isPlainObject(k) && k.signer === true) ?? keys[0];
  return addressOrNull(isPlainObject(signer) ? (signer.pubkey ?? signer) : signer);
}

/** Outer plus inner (CPI) instructions of a parsed transaction, in one flat list. */
function parsedInstructions(parsedTx) {
  if (!isPlainObject(parsedTx)) return [];
  const message = parsedTx.transaction?.message;
  const outer = Array.isArray(message?.instructions) ? message.instructions : [];
  const innerGroups = Array.isArray(parsedTx.meta?.innerInstructions)
    ? parsedTx.meta.innerInstructions
    : [];
  const inner = innerGroups.flatMap((group) =>
    Array.isArray(group?.instructions) ? group.instructions : [],
  );
  return [...outer, ...inner];
}

/**
 * Mints initialised by a parsed transaction, deduplicated.
 *
 * Inner instructions are scanned too: launchpads create the mint through a CPI, so
 * an outer-only scan would report zero mints for exactly the deployers we care about.
 *
 * @param {unknown} parsedTx
 * @returns {readonly string[]} frozen; empty when this transaction created no mint
 */
export function initialisedMintsIn(parsedTx) {
  const mints = new Set();
  for (const instruction of parsedInstructions(parsedTx)) {
    if (!isPlainObject(instruction)) continue;
    const programId = addressOrNull(instruction.programId);
    if (programId !== null && !TOKEN_PROGRAM_IDS.has(programId)) continue;
    const parsed = instruction.parsed;
    if (!isPlainObject(parsed) || !INITIALIZE_MINT_TYPES.has(parsed.type)) continue;
    const mint = addressOrNull(isPlainObject(parsed.info) ? parsed.info.mint : null);
    if (mint !== null) mints.add(mint);
  }
  return Object.freeze([...mints]);
}
