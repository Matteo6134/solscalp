import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { getBestPairs } from '../src/data/dexscreener.js';
import { startMemoryGuard } from '../src/supervisor/memoryGuard.js';

startMemoryGuard({ processName: 'radar', maxHeapMb: 1000 });

const out = (msg) => {
  const ts = new Date().toISOString();
  console.log(`${ts} ${msg}`);
};
const describeError = (err) => err?.message || String(err);

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const RADAR_FILE = path.join(process.cwd(), 'data', 'radar.txt');
const SEEN_FILE = path.join(process.cwd(), 'data', 'radar_seen.txt');

const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const PUMP_FUN = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfX9PNn2A62QA2ZJk1R');
const WSOL = 'So11111111111111111111111111111111111111112';

// mint -> retryCount (max 12 retries * 5s = 60s)
const mintRetries = new Map();
let isPolling = false;

// Seen cache across restarts
const seenMints = new Set();
try {
  if (fs.existsSync(SEEN_FILE)) {
    const lines = fs.readFileSync(SEEN_FILE, 'utf-8').split('\n');
    for (const l of lines) {
      const trimmed = l.trim();
      if (trimmed) seenMints.add(trimmed);
    }
  }
} catch (e) {}

async function startRadar() {
  const wsUrl = RPC_URL.replace('https://', 'wss://').replace('http://', 'ws://');
  const rpc = new Connection(RPC_URL, { wsEndpoint: wsUrl, commitment: 'confirmed' });
  
  out(`Radar connected to ${RPC_URL.split('?')[0]} via WebSockets`);

  // Listen to Pump.fun
  rpc.onLogs(PUMP_FUN, async (logs) => {
    if (logs.err) return;
    const isCreate = logs.logs.some((l) => {
      const lower = l.toLowerCase();
      return lower.includes('initializemint') || lower.includes('instruction: create');
    });
    if (isCreate) {
      await extractMint(rpc, logs.signature, 'Pump.fun');
    }
  }, 'confirmed');

  // Listen to Raydium V4
  rpc.onLogs(RAYDIUM_V4, async (logs) => {
    if (logs.err) return;
    const isInit = logs.logs.some((l) => {
      const lower = l.toLowerCase();
      return lower.includes('initialize2') || lower.includes('initializeinstruction');
    });
    if (isInit) {
      await extractMint(rpc, logs.signature, 'Raydium-V4');
    }
  }, 'confirmed');

  // Listen to Raydium CPMM
  rpc.onLogs(RAYDIUM_CPMM, async (logs) => {
    if (logs.err) return;
    const isInit = logs.logs.some((l) => {
      const lower = l.toLowerCase();
      return lower.includes('initialize') || lower.includes('createpool');
    });
    if (isInit) {
      await extractMint(rpc, logs.signature, 'Raydium-CPMM');
    }
  }, 'confirmed');

  out('Listening for new token launches in real-time...');
  setInterval(pollDexScreener, 5000);
}

async function extractMint(rpc, signature, source) {
  try {
    const tx = await rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.meta || !tx.meta.postTokenBalances) return;
    
    // Find the new mint (skip WSOL)
    const mints = [...new Set(tx.meta.postTokenBalances.map((b) => b.mint))];
    const newMint = mints.find((m) => m && m !== WSOL);
    
    if (newMint && !seenMints.has(newMint)) {
      out(`[${source}] New token detected on-chain! Mint: ${newMint}`);
      
      seenMints.add(newMint);
      fs.appendFileSync(SEEN_FILE, newMint + '\n');
      mintRetries.set(newMint, 0);
    }
  } catch (err) {
    // Non-fatal: transient RPC errors or unparseable txs are silently skipped
  }
}

async function pollDexScreener() {
  if (isPolling || mintRetries.size === 0) return;
  isPolling = true;

  const mintsToFetch = Array.from(mintRetries.keys()).slice(0, 30);
  
  try {
    const pairsMap = await getBestPairs(mintsToFetch);
    const validPairs = [...pairsMap.values()].filter((p) => p !== null);
    const indexedMints = new Set(validPairs.map((p) => p.mint));

    for (const pair of validPairs) {
      out(`[DexScreener] Indexed new token! ${pair.baseToken?.symbol ?? 'TOKEN'} @ $${pair.priceUsd} (Liq: $${pair.liquidityUsd})`);
      mintRetries.delete(pair.mint);
      fs.appendFileSync(RADAR_FILE, pair.mint + '\n');
    }

    // Clean up or increment retries
    for (const mint of mintsToFetch) {
      if (!indexedMints.has(mint)) {
        const retries = (mintRetries.get(mint) ?? 0) + 1;
        if (retries >= 12) {
          // Drop unindexed token after 60s of retries so the queue never clogs
          mintRetries.delete(mint);
        } else {
          mintRetries.set(mint, retries);
        }
      }
    }
  } catch (err) {
    out(`[DexScreener Error] ${describeError(err)}`);
  } finally {
    isPolling = false;
  }
}

startRadar().catch((err) => {
  out(`Fatal: ${describeError(err)}`);
  process.exit(1);
});
