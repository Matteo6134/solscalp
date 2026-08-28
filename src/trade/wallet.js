import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync, existsSync } from 'fs';
import { loadEnv } from '../env.js';

/**
 * Parses secret key from Base58 string, JSON byte array, or keypair file.
 * @param {string} raw
 * @returns {Uint8Array}
 */
export function parseSecretKey(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('SOLANA_PRIVATE_KEY is empty or not provided');
  }
  const trimmed = raw.trim();

  // If it's a file path
  if (existsSync(trimmed)) {
    const content = readFileSync(trimmed, 'utf8').trim();
    return parseSecretKey(content);
  }

  // If it's JSON array [1,2,3...]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const arr = JSON.parse(trimmed);
      return new Uint8Array(arr);
    } catch (e) {
      throw new Error(`Failed to parse JSON byte array private key: ${e.message}`);
    }
  }

  // Fallback to Base58
  try {
    return bs58.decode(trimmed);
  } catch (e) {
    throw new Error(`Failed to decode Base58 private key: ${e.message}`);
  }
}

/**
 * Loads wallet from environment or explicit key.
 * @param {object} [opts]
 * @param {string} [opts.secretKey]
 * @param {string} [opts.rpcUrl]
 * @returns {{ keypair: Keypair, publicKey: import('@solana/web3.js').PublicKey, address: string, connection: Connection }}
 */
export function loadWallet(opts = {}) {
  const env = loadEnv();
  const rawKey = opts.secretKey ?? process.env.SOLANA_PRIVATE_KEY;
  if (!rawKey) {
    return null;
  }

  const secretBytes = parseSecretKey(rawKey);
  const keypair = Keypair.fromSecretKey(secretBytes);
  const rpcUrl = opts.rpcUrl ?? env.solanaRpcUrl ?? 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  return {
    keypair,
    publicKey: keypair.publicKey,
    address: keypair.publicKey.toBase58(),
    connection,
  };
}

/**
 * Fetches live SOL balance for a wallet.
 * @param {{ publicKey: import('@solana/web3.js').PublicKey, connection: Connection }} wallet
 * @returns {Promise<{ lamports: number, sol: number }>}
 */
export async function getWalletBalance(wallet) {
  if (!wallet?.publicKey || !wallet?.connection) {
    return { lamports: 0, sol: 0 };
  }
  try {
    const lamports = await wallet.connection.getBalance(wallet.publicKey);
    return {
      lamports,
      sol: lamports / LAMPORTS_PER_SOL,
    };
  } catch (err) {
    console.error(`[wallet] failed to fetch SOL balance: ${err.message}`);
    return { lamports: 0, sol: 0 };
  }
}
