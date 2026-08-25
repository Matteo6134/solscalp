/**
 * The byte-level boundary for Token-2022 inspection: validating an unpacked mint and
 * reading single extension structs out of its TLV blob.
 *
 * WHAT THIS MODULE PROVES: that the bytes it was handed are readable, and how long
 * each extension entry actually is.
 * WHAT IT DOES NOT PROVE: anything about what those bytes mean -- naming and risk
 * live in token2022.js, which is the only intended caller.
 *
 * Extracted so the parsing rules (what counts as malformed, what counts as
 * truncated) sit in one place and token2022.js stays a readable list of findings.
 * Pure: no network, no clock, no randomness.
 */

import { getExtensionData, getExtensionTypes } from '@solana/spl-token';

/**
 * The all-zero pubkey. Token-2022 extension structs carry no Option flag on their
 * authority fields, so "no authority" is encoded as this address. Reporting it as a
 * real authority would invent a party that does not exist, so it becomes null.
 */
const NULL_ADDRESS = '11111111111111111111111111111111';

/** Longest error message fragment we quote back when chaining a decode failure. */
const MAX_ERROR_CHARS = 200;

/** Short, log-safe description of a throwable, for error chaining. */
function errText(err) {
  if (err === null || err === undefined) return 'unknown error';
  const message = String(err.message ?? err);
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}...` : message;
}

/**
 * Accept a Buffer or any Uint8Array view. spl-token's TLV readers call
 * `readUInt16LE`, which a plain Uint8Array does not have, so wrap without copying.
 */
function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * Validate the unpacked mint at the boundary and return a frozen shallow copy whose
 * `tlvData` is a Buffer. The argument itself is never mutated.
 * @param {unknown} unpackedMint output of spl-token's unpackMint()
 * @param {string} label caller name, for the error message
 * @returns {Readonly<object>}
 */
export function normaliseMint(unpackedMint, label) {
  if (unpackedMint === null || typeof unpackedMint !== 'object' || Array.isArray(unpackedMint)) {
    const got =
      unpackedMint === null
        ? 'null'
        : Array.isArray(unpackedMint)
          ? 'an array'
          : typeof unpackedMint;
    throw new TypeError(`${label}: expected an unpacked mint object, got ${got}`);
  }
  const tlvData = asBuffer(unpackedMint.tlvData);
  if (tlvData === null) {
    throw new TypeError(
      `${label}: mint.tlvData must be a Buffer/Uint8Array, got ` +
        `${unpackedMint.tlvData === undefined ? 'undefined' : typeof unpackedMint.tlvData}` +
        ' -- refusing to guess that the mint carries no extensions',
    );
  }
  return Object.freeze({ ...unpackedMint, tlvData });
}

/**
 * A pubkey-ish value as a base58 string, or null when absent or the all-zero
 * "no authority" address. Unknown is null, never a fabricated address.
 * @param {unknown} value
 * @returns {string|null}
 */
export function addressOrNull(value) {
  if (value === null || value === undefined) return null;
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value.toBase58 === 'function') text = value.toBase58();
  else return null;
  return text.length === 0 || text === NULL_ADDRESS ? null : text;
}

/**
 * Normalise a u64/u16 field the layout may hand back as a number or a bigint.
 * Anything else, or a non-integer, is unparseable -> throw (never a zero).
 * @param {unknown} value
 * @param {string} what field description for the error message
 * @returns {number}
 */
export function integerOrThrow(value, what) {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) {
      throw new TypeError(`${what} is not a finite integer (${value})`);
    }
    return asNumber;
  }
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new TypeError(
    `${what} must be a number or bigint integer, got ${typeof value} (${String(value)})`,
  );
}

/**
 * Raw TLV extension codes, in the order the account stores them.
 * A malformed / truncated blob throws: half-read TLV data is not "no extensions".
 * @param {Readonly<object>} mint output of normaliseMint()
 * @param {string} label
 * @returns {readonly number[]}
 */
export function readExtensionCodes(mint, label) {
  try {
    return getExtensionTypes(mint.tlvData);
  } catch (err) {
    throw new TypeError(
      `${label}: mint TLV data is malformed and cannot be enumerated (${errText(err)})`,
      { cause: err },
    );
  }
}

/**
 * Decode one extension struct, but only when the TLV data says it is there.
 *
 * Present-but-undecodable is the dangerous case: the struct exists, we cannot read
 * it, and reporting `present: false` would be a lie that lets the mint through. So
 * it throws. Absent returns null, which each caller turns into an all-null result.
 *
 * The length check is not paranoia. `new PublicKey(<short buffer>)` succeeds and
 * yields the all-zero key, so a TLV entry that declares 64 bytes and stores none
 * would decode into a transfer hook with a null program id -- i.e. truncated data
 * reported as "no authority, nothing to worry about". Short data is refused instead.
 *
 * @param {Readonly<object>} mint output of normaliseMint()
 * @param {number} code ExtensionType member
 * @param {(mint: object) => object|null} reader the spl-token getter for that struct
 * @param {number} expectedSize minimum bytes the struct must actually occupy
 * @param {string} label
 * @returns {object|null} decoded struct, or null when the extension is absent
 */
export function readExtension(mint, code, reader, expectedSize, label) {
  if (!readExtensionCodes(mint, label).includes(code)) return null;
  const data = getExtensionData(code, mint.tlvData);
  if (data === null) {
    throw new TypeError(
      `${label}: extension is present in the TLV data but its bytes could not be located`,
    );
  }
  if (data.length < expectedSize) {
    throw new TypeError(
      `${label}: extension is present in the TLV data but only ${data.length} of ` +
        `${expectedSize} bytes are stored; refusing to decode partial data as zeros`,
    );
  }
  let decoded;
  try {
    decoded = reader(mint);
  } catch (err) {
    throw new TypeError(
      `${label}: extension is present in the TLV data but its struct did not decode ` +
        `(${errText(err)})`,
      { cause: err },
    );
  }
  if (decoded === null || typeof decoded !== 'object') {
    throw new TypeError(
      `${label}: TLV data lists the extension but the decoder returned ` +
        `${decoded === null ? 'null' : typeof decoded}`,
    );
  }
  return decoded;
}
