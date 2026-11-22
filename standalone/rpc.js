import { Connection } from '@solana/web3.js';
import { config } from '../config.js';
import { orderedRpcUrls, trackedConnection } from '../modules/rpc-health.js';

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Data request failed (HTTP ${response.status})`);
  return response.json();
}
export function connection(url, wsEndpoint) {
  if (!url) throw new Error('No RPC configured: add endpoints to rpc-endpoints.json (or set RPC_URL)');
  return new Connection(url, {
    commitment: 'confirmed', ...(wsEndpoint ? { wsEndpoint } : {}),
    disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
  });
}
const connections = new Map();
// Reads go through the shared endpoint list (modules/rpc-health.js): active endpoint
// first, cooling ones last, every request's outcome reported so 429s / errors rotate
// the whole bot. A dedicated MONITOR_RPC_URL / BALANCE_RPC_URL (different from RPC_URL)
// stays first for its kind.
export async function readRpc(kind, fn) {
  const dedicated = kind === 'balance' ? config.standalone.balanceRpcUrl : config.standalone.monitorRpcUrl;
  const shared = orderedRpcUrls();
  const urls = [...new Set([dedicated !== process.env.RPC_URL ? dedicated : null, ...shared, config.standalone.fallbackRpcUrl].filter(Boolean))];
  if (!urls.length) throw new Error('No RPC configured: add endpoints to rpc-endpoints.json (or set RPC_URL)');
  let error;
  for (const url of urls) {
    try {
      if (!connections.has(url)) connections.set(url, trackedConnection(url, 'confirmed'));
      return await fn(connections.get(url));
    } catch (e) { error = e; }
  }
  // Provider errors may contain authenticated URLs. Keep them out of persisted state.
  throw new Error(`RPC ${kind} read failed (${error?.name || 'Error'})`);
}
