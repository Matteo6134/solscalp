/**
 * The boundary check on MintFacts, extracted so layer0-mint.js stays a readable
 * list of rules.
 *
 * WHAT THIS MODULE PROVES: that the object handed back by `ctx.getMintFacts()` has
 * the shape and the types layer 0 needs, and that it describes the mint layer 0 was
 * actually asked about.
 * WHAT IT DOES NOT PROVE: anything about the mint being safe. Naming, risk and the
 * verdict live in layer0-mint.js, which is the only intended caller.
 *
 * FAIL CLOSED, and specifically: unknown is never a pass. `mintAuthority: undefined`
 * is NOT a revoked authority, `extensions: undefined` is NOT "no extensions", and a
 * present transfer fee whose basis points will not parse is NOT a zero fee. Every
 * one of those throws, so the layer reports errored() and the gate rejects.
 *
 * Pure: no network, no clock, no randomness. The argument is never mutated; every
 * value returned is frozen.
 */

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Short, log-safe description of an unexpected value, for error messages.
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function requireBoolean(value, what) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${what} must be a boolean, got ${describeValue(value)}`);
  }
  return value;
}

function requireNonEmptyString(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${what} must be a non-empty string, got ${describeValue(value)}`);
  }
  return value;
}

/**
 * An authority is a base58 address or explicitly `null` (revoked). `undefined`, a
 * number or an object is UNKNOWN, and unknown must never read as revoked -- that
 * single confusion is the difference between a pass and a drained wallet.
 */
function requireAuthority(value, what) {
  if (value === null) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new TypeError(
    `${what} must be a base58 address or null (revoked), got ${describeValue(value)} -- ` +
      'refusing to read an unknown authority as a revoked one',
  );
}

function requireNameArray(value, what) {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${what} must be an array of extension names, got ${describeValue(value)} -- ` +
        'refusing to read unknown extensions as no extensions',
    );
  }
  value.forEach((name, i) => requireNonEmptyString(name, `${what}[${i}]`));
  return Object.freeze([...value]);
}

/** Informational integer: absent stays null, never 0. */
const integerOrNull = (value) => (Number.isInteger(value) ? value : null);

/** Informational finite number: absent stays null, never 0. */
const finiteOrNull = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The transfer-fee shape produced by token2022.js `inspectTransferFee`. When
 * `present`, `maxFeeBpsEver` MUST be a readable integer: an unreadable fee is not a
 * zero fee, and this is the number the layer compares against the configured limit.
 */
function readTransferFee(raw) {
  const what = 'MintFacts.transferFee';
  if (!isPlainObject(raw)) {
    throw new TypeError(`${what} must be an object, got ${describeValue(raw)}`);
  }
  const present = requireBoolean(raw.present, `${what}.present`);
  if (!present) {
    return Object.freeze({
      present: false,
      olderEpoch: null,
      olderFeeBps: null,
      newerEpoch: null,
      newerFeeBps: null,
      maxFeeBpsEver: null,
      scheduledIncrease: false,
    });
  }
  const maxFeeBpsEver = integerOrNull(raw.maxFeeBpsEver);
  if (maxFeeBpsEver === null) {
    throw new TypeError(
      `${what}.maxFeeBpsEver must be an integer when the extension is present, got ` +
        `${describeValue(raw.maxFeeBpsEver)} -- an unreadable fee is not a zero fee`,
    );
  }
  return Object.freeze({
    present: true,
    olderEpoch: integerOrNull(raw.olderEpoch),
    olderFeeBps: integerOrNull(raw.olderFeeBps),
    newerEpoch: integerOrNull(raw.newerEpoch),
    newerFeeBps: integerOrNull(raw.newerFeeBps),
    maxFeeBpsEver,
    scheduledIncrease: raw.scheduledIncrease === true,
  });
}

/** The shape produced by token2022.js `inspectDefaultAccountState`. */
function readDefaultAccountState(raw) {
  const what = 'MintFacts.defaultAccountState';
  if (!isPlainObject(raw)) {
    throw new TypeError(`${what} must be an object, got ${describeValue(raw)}`);
  }
  return Object.freeze({
    present: requireBoolean(raw.present, `${what}.present`),
    state: typeof raw.state === 'string' && raw.state.length > 0 ? raw.state : null,
    frozen: requireBoolean(raw.frozen, `${what}.frozen`),
  });
}

/**
 * A presence-only struct (transfer hook, permanent delegate). Recorded for the log:
 * the extension allowlist is what actually rejects them, so a missing struct is
 * `null` (not reported) rather than an error.
 */
function readPresence(raw, what) {
  if (!isPlainObject(raw)) return null;
  return Object.freeze({ ...raw, present: requireBoolean(raw.present, `${what}.present`) });
}

/**
 * Validate MintFacts and return a frozen view of exactly the fields layer 0 reads.
 *
 * @param {unknown} raw value returned by `ctx.getMintFacts()`
 * @param {string} [expectedMint] when supplied, facts for a different mint throw
 * @returns {Readonly<object>} frozen; the argument is never mutated
 * @throws {TypeError|Error} anything unreadable, so the caller reports errored()
 */
export function readMintFacts(raw, expectedMint) {
  if (!isPlainObject(raw)) {
    throw new TypeError(
      `ctx.getMintFacts() returned ${describeValue(raw)}, not MintFacts -- refusing to ` +
        'treat an unreadable mint account as a clean one',
    );
  }
  const mint = requireNonEmptyString(raw.mint, 'MintFacts.mint');
  if (typeof expectedMint === 'string' && expectedMint.length > 0 && mint !== expectedMint) {
    throw new Error(
      `MintFacts describe ${mint} but layer 0 was asked about ${expectedMint}: refusing to ` +
        'judge one mint by the bytes of another',
    );
  }
  return Object.freeze({
    mint,
    programId: requireNonEmptyString(raw.programId, 'MintFacts.programId'),
    isToken2022: requireBoolean(raw.isToken2022, 'MintFacts.isToken2022'),
    isInitialized: requireBoolean(raw.isInitialized, 'MintFacts.isInitialized'),
    decimals: integerOrNull(raw.decimals),
    supplyRaw: typeof raw.supplyRaw === 'string' ? raw.supplyRaw : null,
    supplyUi: finiteOrNull(raw.supplyUi),
    mintAuthority: requireAuthority(raw.mintAuthority, 'MintFacts.mintAuthority'),
    freezeAuthority: requireAuthority(raw.freezeAuthority, 'MintFacts.freezeAuthority'),
    extensions: requireNameArray(raw.extensions, 'MintFacts.extensions'),
    hadUninitializedEntries: requireBoolean(
      raw.hadUninitializedEntries,
      'MintFacts.hadUninitializedEntries',
    ),
    transferFee: readTransferFee(raw.transferFee),
    defaultAccountState: readDefaultAccountState(raw.defaultAccountState),
    transferHook: readPresence(raw.transferHook, 'MintFacts.transferHook'),
    permanentDelegate: readPresence(raw.permanentDelegate, 'MintFacts.permanentDelegate'),
  });
}
