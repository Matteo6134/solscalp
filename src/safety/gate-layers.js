/**
 * The layer registry: what the gate runs, in what order, and where the real
 * implementation lives.
 *
 * Ordering rule: cheap-and-decisive first. Layer 0 is one getAccountInfo and
 * kills most scams outright; layer 5 is a third-party HTTP veto. Every layer we
 * never reach is a request we never paid for -- and, more importantly, a fact we
 * must report as UNPROVEN rather than as a pass.
 */

/** @typedef {import('./verdict.js').Outcome} Outcome */

/**
 * A layer implementation. Receives the mint and a context object (data
 * fetchers, an AbortSignal, its own budget) and returns a verdict.
 * @typedef {(mint: string, ctx: Readonly<Record<string, any>>) => Promise<object>|object} LayerFn
 */

/**
 * @typedef {object} LayerSpec
 * @property {string} id          registry key, e.g. 'layer0'
 * @property {string} name        canonical verdict layer name, e.g. 'layer0-mint'
 * @property {string} module      module specifier, resolved relative to this file
 * @property {readonly string[]} exports candidate export names, most-expected first
 * @property {string} proves      what a PASS from this layer actually establishes
 * @property {string} unproven    what a PASS from this layer does NOT establish
 */

/** Execution order. Never reorder without re-reading the cost note above. */
export const LAYER_ORDER = Object.freeze(['layer0', 'layer1', 'layer2', 'layer3', 'layer4', 'layer5']);

/** @type {Readonly<Record<string, LayerSpec>>} */
export const LAYER_SPECS = Object.freeze({
  layer0: Object.freeze({
    id: 'layer0',
    name: 'layer0-mint',
    module: './layer0-mint.js',
    exports: Object.freeze(['checkMint', 'runLayer0', 'layer0', 'checkMintAccount']),
    proves: 'mint and freeze authority are revoked and every Token-2022 extension is on the allowlist',
    unproven: 'nothing about liquidity, holders, or whether a route out exists',
  }),
  layer1: Object.freeze({
    id: 'layer1',
    name: 'layer1-sellsim',
    module: './layer1-sellsim.js',
    exports: Object.freeze(['checkSellability', 'simulateSell', 'checkSellSimulation', 'runLayer1', 'layer1']),
    proves: 'a sell of the probe size simulated successfully on one route at one instant',
    unproven: 'that the same exit exists at your real size, later, or on every route',
  }),
  layer2: Object.freeze({
    id: 'layer2',
    name: 'layer2-liquidity',
    module: './layer2-liquidity.js',
    // runLayer2 FIRST: it is the (mint, ctx) adapter. checkLiquidity takes
    // (pair, options), so it is only a last-resort candidate -- called with a
    // mint string it rejects the shape and errors, which the gate blocks on.
    exports: Object.freeze(['runLayer2', 'layer2', 'checkLiquidity']),
    proves: 'reported pool depth clears the floor and LP looks burned or locked',
    unproven: 'that reported depth is real, unbundled, or will still be there next block',
  }),
  layer3: Object.freeze({
    id: 'layer3',
    name: 'layer3-holders',
    module: './layer3-holders.js',
    exports: Object.freeze(['checkHolders', 'runLayer3', 'layer3']),
    proves: 'no single wallet or visible cluster holds enough to nuke the price alone',
    unproven: 'that one entity is not simply spread across many unlinkable wallets',
  }),
  layer4: Object.freeze({
    id: 'layer4',
    name: 'layer4-deployer',
    module: './layer4-deployer.js',
    exports: Object.freeze(['checkDeployer', 'runLayer4', 'layer4']),
    proves: 'the deployer address has no prior rug rate above the configured ceiling',
    unproven: 'anything about a deployer using a fresh address, which is free to do',
  }),
  layer5: Object.freeze({
    id: 'layer5',
    name: 'layer5-thirdparty',
    module: './layer5-thirdparty.js',
    exports: Object.freeze(['checkThirdParty', 'checkRugcheck', 'runLayer5', 'layer5']),
    proves: 'a third-party scanner did not veto the token',
    unproven: 'anything positive -- third-party silence is not evidence of safety',
  }),
});

/**
 * @param {readonly string[]} [order]
 * @returns {readonly string[]} validated copy; throws on an unknown layer id
 */
export function normaliseOrder(order) {
  if (order === undefined) return LAYER_ORDER;
  if (!Array.isArray(order)) throw new TypeError('deps.order must be an array of layer ids');
  const unknown = order.filter((id) => !Object.hasOwn(LAYER_SPECS, id));
  if (unknown.length > 0) {
    throw new TypeError(
      'deps.order contains unknown layer ids: ' +
        unknown.join(', ') +
        ' (known: ' +
        LAYER_ORDER.join(', ') +
        ')',
    );
  }
  return Object.freeze([...order]);
}

/**
 * Resolve a layer's real implementation from its module.
 *
 * Tolerant about the export NAME (layer modules are owned independently, and a
 * rename must not silently disable a safety check) but never about the result:
 * anything unresolvable throws, and the orchestrator turns that into errored(),
 * i.e. a reject. A missing layer can never read as a pass.
 *
 * @param {LayerSpec} spec
 * @param {(specifier: string) => Promise<any>} [importer] injectable for tests
 * @returns {Promise<LayerFn>}
 */
export async function loadLayerFn(spec, importer = defaultImporter) {
  const mod = await importer(spec.module);
  if (mod === null || typeof mod !== 'object') {
    throw new Error(spec.module + ' did not export a module namespace');
  }
  for (const name of spec.exports) {
    if (typeof mod[name] === 'function') return mod[name];
  }
  if (typeof mod.default === 'function') return mod.default;

  const functions = Object.entries(mod).filter((entry) => typeof entry[1] === 'function');
  if (functions.length === 1) return functions[0][1];

  throw new Error(
    spec.module +
      ' exports no recognisable layer function (looked for ' +
      spec.exports.join(', ') +
      '; module exports: ' +
      (Object.keys(mod).join(', ') || 'nothing') +
      ')',
  );
}

/**
 * Wrap a spec into a LayerFn that imports lazily, on first use.
 * Lazy on purpose: the gate must stay importable, and unit-testable with fakes,
 * even while a sibling layer module is missing or broken.
 * @param {LayerSpec} spec
 * @param {(specifier: string) => Promise<any>} [importer]
 * @returns {LayerFn}
 */
export function lazyLayer(spec, importer) {
  return async (mint, ctx) => {
    const fn = await loadLayerFn(spec, importer);
    return fn(mint, ctx);
  };
}

/** @param {string} specifier */
function defaultImporter(specifier) {
  return import(specifier);
}
