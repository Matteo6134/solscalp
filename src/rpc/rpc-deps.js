/**
 * The default-RpcClient seam.
 *
 * The client is created lazily, by dynamic import, so that (a) importing a fetcher
 * never constructs a Connection, and (b) a test that injects `deps.rpc` never touches
 * src/rpc/connection.js and therefore never opens a socket.
 *
 * Address validation deliberately lives in ./rpc-validate.js (`requireAddress`), so
 * the base58 rule has exactly one definition in this folder.
 */

/** Memoised default client. Only ever populated when a caller injects no rpc. */
let defaultClient = null;

/**
 * The RpcClient to use: the injected one, or a lazily created default.
 * @param {{ rpc?: object }} [deps]
 * @returns {Promise<object>} an RpcClient (see src/rpc/connection.js)
 */
export async function resolveRpc(deps = {}) {
  if (deps.rpc !== undefined && deps.rpc !== null) return deps.rpc;
  if (defaultClient === null) {
    const { createRpcClient } = await import('./connection.js');
    defaultClient = createRpcClient();
  }
  return defaultClient;
}
