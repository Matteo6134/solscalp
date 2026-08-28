import { VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { fetch } from 'undici';
import { ENDPOINTS, KNOWN } from '../config.js';
import { broadcastJitoBundle, checkBundleStatus, getEscalatedTipLamports } from '../rpc/jito.js';

const JUPITER_API = ENDPOINTS.jupiterQuote;

/**
 * Gets a Jupiter swap quote.
 * @param {object} p
 * @param {string} p.inputMint
 * @param {string} p.outputMint
 * @param {number|string} p.amountInLamports (or smallest token units)
 * @param {number} [p.slippageBps=100]
 * @returns {Promise<object|null>}
 */
export async function getJupiterQuote({ inputMint, outputMint, amountInLamports, slippageBps = 100 }) {
  const url = `${JUPITER_API}/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${amountInLamports}&slippageBps=${slippageBps}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jupiter quote HTTP ${res.status}: ${text}`);
    }
    return await res.json();
  } catch (err) {
    console.error(`[executor] quote error: ${err.message}`);
    return null;
  }
}

/**
 * Builds and signs a Jupiter swap transaction.
 * @param {object} p
 * @param {object} p.wallet
 * @param {object} p.quoteResponse
 * @returns {Promise<VersionedTransaction|null>}
 */
export async function buildSwapTransaction({ wallet, quoteResponse }) {
  const url = `${JUPITER_API}/swap`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPublicKey: wallet.address,
        quoteResponse,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jupiter swap HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    if (!data.swapTransaction) {
      throw new Error('Jupiter response missing swapTransaction base64');
    }
    const buf = Buffer.from(data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([wallet.keypair]);
    return tx;
  } catch (err) {
    console.error(`[executor] swap build error: ${err.message}`);
    return null;
  }
}

/**
 * Sends a signed transaction and waits for confirmation with Jito tip escalation and resilient retries.
 * @param {object} p
 * @param {VersionedTransaction} p.tx
 * @param {object} p.wallet
 * @param {boolean} [p.useJito=false]
 * @param {number} [p.maxAttempts=3]
 * @param {boolean} [p.isEmergencyExit=false]
 * @returns {Promise<{ success: boolean, signature?: string, error?: string, method?: string, attempt?: number }>}
 */
export async function sendAndConfirmSwap({
  tx,
  wallet,
  useJito = false,
  maxAttempts = 3,
  isEmergencyExit = false,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = tx.serialize();

      if (useJito) {
        try {
          const jitoRes = await broadcastJitoBundle([tx]);
          if (jitoRes?.bundleId) {
            for (let i = 0; i < 3; i++) {
              await new Promise((r) => setTimeout(r, 600));
              const status = await checkBundleStatus(jitoRes.bundleId);
              if (status.landed) {
                return {
                  success: true,
                  signature: jitoRes.bundleId,
                  method: 'jito',
                  engine: jitoRes.engine,
                  attempt,
                };
              }
            }
          }
        } catch (jitoErr) {
          lastError = jitoErr.message;
        }
      }

      // Direct RPC fallback with high priority fee
      const signature = await wallet.connection.sendRawTransaction(raw, {
        skipPreflight: true,
        maxRetries: 2,
      });

      const latestBlockhash = await wallet.connection.getLatestBlockhash('confirmed');
      const confirmation = await wallet.connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        'confirmed',
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction on-chain revert: ${JSON.stringify(confirmation.value.err)}`);
      }

      return { success: true, signature, method: 'rpc', attempt };
    } catch (err) {
      lastError = err.message;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  }

  return { success: false, error: lastError ?? 'Swap confirmation timed out across all attempts' };
}

/**
 * High-level On-Chain Buy Order (SOL -> Token).
 * @param {object} p
 * @param {object} p.wallet
 * @param {string} p.mint
 * @param {number} p.amountSol
 * @param {number} [p.slippageBps=100]
 * @returns {Promise<object>}
 */
export async function executeBuyOrder({ wallet, mint, amountSol, slippageBps = 100 }) {
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const quote = await getJupiterQuote({
    inputMint: KNOWN.WSOL,
    outputMint: mint,
    amountInLamports: lamports,
    slippageBps,
  });
  if (!quote) return { success: false, error: 'Could not fetch Jupiter buy quote' };

  const tx = await buildSwapTransaction({ wallet, quoteResponse: quote });
  if (!tx) return { success: false, error: 'Could not build signed buy transaction' };

  const res = await sendAndConfirmSwap({ tx, wallet });
  return {
    ...res,
    inAmountSol: amountSol,
    outTokenQty: Number(quote.outAmount),
    quote,
  };
}

/**
 * High-level On-Chain Sell Order (Token -> SOL).
 * @param {object} p
 * @param {object} p.wallet
 * @param {string} p.mint
 * @param {number|string} p.tokenQtySmallestUnits
 * @param {number} [p.slippageBps=150]
 * @returns {Promise<object>}
 */
export async function executeSellOrder({ wallet, mint, tokenQtySmallestUnits, slippageBps = 150 }) {
  const quote = await getJupiterQuote({
    inputMint: mint,
    outputMint: KNOWN.WSOL,
    amountInLamports: tokenQtySmallestUnits,
    slippageBps,
  });
  if (!quote) return { success: false, error: 'Could not fetch Jupiter sell quote' };

  const tx = await buildSwapTransaction({ wallet, quoteResponse: quote });
  if (!tx) return { success: false, error: 'Could not build signed sell transaction' };

  const res = await sendAndConfirmSwap({ tx, wallet });
  return {
    ...res,
    outAmountSol: Number(quote.outAmount) / LAMPORTS_PER_SOL,
    inTokenQty: tokenQtySmallestUnits,
    quote,
  };
}
