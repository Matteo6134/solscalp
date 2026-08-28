/**
 * Jito MEV Bundle & Dynamic Priority Validator Tip Module.
 *
 * Provides real-time tip floor queries from Jito block engines to guarantee
 * top-of-block transaction inclusion during high network congestion.
 */

const JITO_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

export const JITO_BLOCK_ENGINES = Object.freeze([
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
]);

/** Official Jito tip accounts for MEV inclusion */
export const JITO_TIP_ACCOUNTS = Object.freeze([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

const LAMPORTS_PER_SOL = 1_000_000_000;
const CACHE_TTL_MS = 30_000; // Cache tip floor for 30s to avoid unnecessary network calls
const FALLBACK_TIP_LAMPORTS = 200_000; // 0.0002 SOL fallback floor

let cachedTipFloor = null;
let lastFetchTs = 0;

/**
 * Fetch the latest live tip percentiles from Jito's validator block engines.
 * @param {number} [now]
 * @returns {Promise<object>}
 */
export async function fetchJitoTipFloor(now = Date.now()) {
  if (cachedTipFloor && now - lastFetchTs < CACHE_TTL_MS) {
    return cachedTipFloor;
  }

  try {
    const res = await fetch(JITO_TIP_FLOOR_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      cachedTipFloor = data[0];
      lastFetchTs = now;
      return cachedTipFloor;
    }
  } catch (err) {
    // Graceful fallback when offline
  }

  return cachedTipFloor ?? {
    landed_tips_25th_percentile: 0.000005,
    landed_tips_50th_percentile: 0.00001,
    landed_tips_75th_percentile: 0.00005,
    landed_tips_95th_percentile: 0.0002,
  };
}

/**
 * Calculate the optimal dynamic tip in lamports for top-of-block execution.
 * @param {object} [options]
 * @param {'low'|'medium'|'high'|'ultra'} [options.speed] urgency tier
 * @param {number} [options.now]
 * @returns {Promise<number>} lamports to tip validator
 */
export async function getOptimalJitoTipLamports({ speed = 'high', now = Date.now() } = {}) {
  const floor = await fetchJitoTipFloor(now);

  let tipSol = floor.landed_tips_75th_percentile;
  if (speed === 'low') tipSol = floor.landed_tips_25th_percentile;
  else if (speed === 'medium') tipSol = floor.landed_tips_50th_percentile;
  else if (speed === 'high') tipSol = floor.landed_tips_75th_percentile;
  else if (speed === 'ultra') tipSol = floor.landed_tips_95th_percentile;

  if (typeof tipSol !== 'number' || !Number.isFinite(tipSol) || tipSol <= 0) {
    return FALLBACK_TIP_LAMPORTS;
  }

  const lamports = Math.round(tipSol * LAMPORTS_PER_SOL);
  // Enforce sanity floor (min 5,000 lamports) and cap (max 0.01 SOL)
  return Math.min(10_000_000, Math.max(5_000, lamports));
}

/**
 * Pick a random Jito tip account for inclusion in bundle.
 * @returns {string} public key string
 */
/**
 * Calculate escalated tip in lamports for retry attempts to guarantee inclusion during congestion.
 * @param {object} p
 * @param {number} p.attempt Attempt index (1, 2, 3...)
 * @param {'low'|'medium'|'high'|'ultra'} [p.baseSpeed='high']
 * @returns {Promise<number>} lamports
 */
export async function getEscalatedTipLamports({ attempt = 1, baseSpeed = 'high' } = {}) {
  const floor = await fetchJitoTipFloor();
  let baseSol = floor.landed_tips_75th_percentile ?? 0.00005;

  if (attempt === 1) {
    if (baseSpeed === 'ultra') baseSol = floor.landed_tips_95th_percentile;
    else if (baseSpeed === 'medium') baseSol = floor.landed_tips_50th_percentile;
    else if (baseSpeed === 'low') baseSol = floor.landed_tips_25th_percentile;
  } else if (attempt === 2) {
    // Attempt 2: Escalate to 95th percentile or 1.8x base
    baseSol = Math.max(floor.landed_tips_95th_percentile ?? 0.0002, baseSol * 1.8);
  } else {
    // Attempt 3+: Emergency exit tier: 2.5x of 95th percentile
    baseSol = Math.max((floor.landed_tips_95th_percentile ?? 0.0002) * 2.5, baseSol * 2.5);
  }

  const lamports = Math.round(baseSol * LAMPORTS_PER_SOL);
  // Cap at 0.015 SOL max tip to prevent extreme overspending
  return Math.min(15_000_000, Math.max(5_000, lamports));
}

/**
 * Pick a random Jito tip account for inclusion in bundle.
 * @returns {string} public key string
 */
export function getRandomTipAccount() {
  const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return JITO_TIP_ACCOUNTS[idx];
}

/**
 * Submit a serialized transaction bundle directly to a specific Jito Block Engine.
 * @param {string[]} serializedBase58Txs
 * @param {string} [endpoint]
 * @returns {Promise<string>} bundle ID
 */
export async function sendJitoBundle(serializedBase58Txs, endpoint = JITO_BLOCK_ENGINES[0]) {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendBundle',
    params: [serializedBase58Txs],
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4_000),
  });

  if (!res.ok) throw new Error(`Jito bundle submission failed with HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Jito RPC Error: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

/**
 * Broadcasts a bundle concurrently across all global Jito block engines (Frankfurt, NY, Amsterdam, Tokyo)
 * to eliminate regional network routing drops.
 * @param {string[]} serializedBase58Txs
 * @returns {Promise<{ bundleId: string, engine: string }>}
 */
export async function broadcastJitoBundle(serializedBase58Txs) {
  const calls = JITO_BLOCK_ENGINES.map(async (engine) => {
    const bundleId = await sendJitoBundle(serializedBase58Txs, engine);
    return { bundleId, engine };
  });

  // Return as soon as the fastest regional block engine accepts the bundle
  return await Promise.any(calls);
}

/**
 * Query bundle inclusion status from Jito.
 * @param {string} bundleId
 * @returns {Promise<{ landed: boolean, status: string }>}
 */
export async function checkBundleStatus(bundleId) {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getInflightBundleStatuses',
    params: [[bundleId]],
  };

  try {
    const res = await fetch(JITO_BLOCK_ENGINES[0], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { landed: false, status: 'unknown' };
    const json = await res.json();
    const result = json?.result?.value?.[0];
    if (!result) return { landed: false, status: 'pending' };
    return {
      landed: result.status === 'Landed',
      status: result.status,
      landedSlot: result.landed_slot,
    };
  } catch {
    return { landed: false, status: 'error' };
  }
}
