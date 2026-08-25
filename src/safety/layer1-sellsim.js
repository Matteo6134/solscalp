/**
 * Layer 1 -- sell simulation. The definitive honeypot test: prove the exit exists.
 *
 * WHAT THIS LAYER ACTUALLY PROVES (read this before trusting a PASS)
 * -----------------------------------------------------------------
 * The check performed here is a QUOTE-ONLY round trip: quote WSOL -> mint for a
 * fixed probe size, then quote the entire proceeds mint -> WSOL. That proves a
 * ROUTE exists on some DEX and prices the round trip. It does NOT prove that a
 * sell TRANSACTION would succeed on chain:
 *
 *   - a TransferHook program can revert the transfer at execution time;
 *   - a per-wallet blacklist inside the token or hook program can revert only
 *     for us while every route still quotes normally;
 *   - a frozen token account (freeze authority, DefaultAccountState) blocks the
 *     transfer while the pool still quotes;
 *   - the pool can be drained, paused or migrated between quote and execution.
 *
 * Full proof requires simulateTransaction on a BUILT sell transaction, signed
 * (or at least fee-payer-stamped) by an owner account that actually holds the
 * token. This project holds no keypair and no token balance by design, so that
 * stronger check is NOT performed here and is NOT faked. SAFETY.layer1
 * .requireSellSimulationSuccess therefore remains unsatisfied; SIMULATION_LIMITATION
 * below states exactly what is and is not proven so the gate can surface the
 * residual risk honestly rather than overstating what was verified.
 *
 * Fail closed: anything thrown, timed out or unparseable becomes ERROR, which
 * the gate treats as a REJECT.
 */

import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SAFETY } from '../config.js';
import { errored, pass, reject } from './verdict.js';

export const LAYER = 'layer1-sellsim';

/**
 * Honest, machine-readable statement of this layer's epistemic limits.
 * The gate is expected to attach this to any PASS it reports, so that "sellable"
 * is never read as "the sell transaction was simulated and succeeded".
 */
export const SIMULATION_LIMITATION = Object.freeze({
  layer: LAYER,
  method: 'quote-only-round-trip',
  proven: Object.freeze([
    'a swap route mint -> WSOL existed at quote time for the full proceeds of a probe buy',
    'the round-trip cost implied by those two quotes, including price impact and router fees',
  ]),
  notProven: Object.freeze([
    'that a sell transaction would land on chain: no transaction was built, simulated or sent',
    'that a TransferHook program would not revert the transfer at execution time',
    'that our specific wallet is not blacklisted by the token or its hook program',
    'that our token account would not be frozen (freeze authority / DefaultAccountState)',
    'that the quoted route still exists at execution time (pool drain, pause or migration)',
  ]),
  requiredForFullProof: Object.freeze([
    'an owner account holding a nonzero balance of the mint',
    'a built sell transaction (Jupiter /swap) for that owner',
    'connection.simulateTransaction on that transaction returning err === null',
  ]),
  /** Config flag this layer cannot satisfy while the bot is paper-trading only. */
  unsatisfiedConfigFlag: 'SAFETY.layer1.requireSellSimulationSuccess',
  residualRisk:
    'a quoted route can still revert on chain; treat a PASS as "an exit route exists", ' +
    'not as "the exit was executed successfully in simulation"',
  /** Complementary evidence: layer 0 rejects the mint-level causes listed above. */
  mitigatedBy: Object.freeze(['layer0-mint extension allowlist and authority checks']),
});

/** Probe size, derived from config only. Never hardcode a lamport amount. */
const probeLamports = () => Math.round(SAFETY.layer1.probeSizeSol * LAMPORTS_PER_SOL);

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate the round-trip result at the boundary: it comes from a network call
 * and an unreadable answer must never be mistaken for a sellable token.
 * @param {any} rt
 */
function assertRoundTripShape(rt) {
  if (rt === null || typeof rt !== 'object' || Array.isArray(rt)) {
    throw new TypeError(`getRoundTrip returned ${Array.isArray(rt) ? 'an array' : typeof rt}`);
  }
  if (typeof rt.sellRouteExists !== 'boolean') {
    throw new TypeError(`getRoundTrip.sellRouteExists must be boolean, got ${rt.sellRouteExists}`);
  }
  if (!isFiniteNumber(rt.roundTripLossPct)) {
    throw new TypeError(
      `getRoundTrip.roundTripLossPct must be a finite number, got ${rt.roundTripLossPct}`,
    );
  }
  if (rt.sellRouteExists && !isFiniteNumber(rt.returnedLamports)) {
    throw new TypeError(
      `getRoundTrip.returnedLamports must be a finite number, got ${rt.returnedLamports}`,
    );
  }
}

/** Price impact of one leg, or null when that leg produced no quote. */
const legImpact = (quote) =>
  quote && isFiniteNumber(quote.priceImpactPct) ? quote.priceImpactPct : null;

/**
 * Prove the exit exists for a mint.
 *
 * @param {string} mintAddress
 * @param {{ getRoundTrip: (p: { mint: string, probeLamports: number,
 *   slippageBps: number }) => Promise<object> }} deps
 * @returns {Promise<ReturnType<typeof pass>>} verdict for layer 'layer1-sellsim'
 */
export async function checkSellability(mintAddress, deps) {
  const startedAt = Date.now();
  const lamports = probeLamports();
  const baseFacts = Object.freeze({
    mint: typeof mintAddress === 'string' ? mintAddress : String(mintAddress),
    probeSizeSol: SAFETY.layer1.probeSizeSol,
    probeLamports: lamports,
    slippageBps: SAFETY.layer1.quoteSlippageBps,
    maxRoundTripLossPct: SAFETY.layer1.maxRoundTripLossPct,
    /** Stated on every verdict: no transaction was ever built or simulated. */
    sellTransactionSimulated: false,
    simulationMethod: SIMULATION_LIMITATION.method,
    /** Travels with the verdict so a PASS can never be logged as full proof. */
    residualRisk: SIMULATION_LIMITATION.residualRisk,
  });

  try {
    if (typeof mintAddress !== 'string' || mintAddress.length === 0) {
      throw new TypeError(`checkSellability: mintAddress must be a mint address, got ${mintAddress}`);
    }
    if (typeof deps?.getRoundTrip !== 'function') {
      throw new TypeError('checkSellability: deps.getRoundTrip must be a function');
    }

    const roundTrip = await deps.getRoundTrip({
      mint: mintAddress,
      probeLamports: lamports,
      slippageBps: SAFETY.layer1.quoteSlippageBps,
    });
    assertRoundTripShape(roundTrip);

    const facts = Object.freeze({
      ...baseFacts,
      sellRouteExists: roundTrip.sellRouteExists,
      returnedLamports: roundTrip.sellRouteExists ? roundTrip.returnedLamports : 0,
      roundTripLossPct: roundTrip.roundTripLossPct,
      buyPriceImpactPct: legImpact(roundTrip.buyQuote),
      sellPriceImpactPct: legImpact(roundTrip.sellQuote),
    });
    const ms = Date.now() - startedAt;

    if (!roundTrip.sellRouteExists) {
      return reject(
        LAYER,
        [
          `HONEYPOT: no sell route exists -- this token cannot be sold back to SOL. ` +
            `A ${SAFETY.layer1.probeSizeSol} SOL buy quotes fine but the proceeds ` +
            `have no route out, so any position would be unexitable.`,
        ],
        facts,
        ms,
      );
    }

    if (roundTrip.roundTripLossPct > SAFETY.layer1.maxRoundTripLossPct) {
      return reject(
        LAYER,
        [
          `round-trip loss ${roundTrip.roundTripLossPct.toFixed(2)}% exceeds the ` +
            `${SAFETY.layer1.maxRoundTripLossPct}% limit on a ` +
            `${SAFETY.layer1.probeSizeSol} SOL probe (sell exists but is punitive: ` +
            `transfer fee, thin liquidity or asymmetric taxation)`,
        ],
        facts,
        ms,
      );
    }

    return pass(LAYER, facts, ms);
  } catch (err) {
    // FAIL CLOSED: an unreachable or unreadable exit is not a proven exit.
    return errored(LAYER, err, baseFacts, Date.now() - startedAt);
  }
}
