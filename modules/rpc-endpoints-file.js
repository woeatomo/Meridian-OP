// rpc-endpoints-file.js — Meridian-OP. Reader for rpc-endpoints.json (no config import, so
// config.js can use it at load time to derive RPC_URL when .env / user-config have none).
//
// Format:
//   { "endpoints": [
//       { "name": "helius-1",  "provider": "helius", "apiKey": "KEY" },
//       { "name": "quicknode", "url": "https://xxx.solana-mainnet.quiknode.pro/{apiKey}/",
//                              "ws":  "wss://xxx.solana-mainnet.quiknode.pro/{apiKey}/", "apiKey": "env:QN_KEY" },
//       { "name": "custom",    "url": "https://rpc.example.com", "apiKeyParam": "api-key", "apiKey": "KEY" },
//       { "name": "spare",     "url": "https://...", "enabled": false }
//   ] }
// "env:NAME" reads the value from process.env (so secrets can stay in the encrypted .env).
// "ws" is optional: without it web3.js derives the websocket URL from "url" (https -> wss),
// which is wrong for some providers — set it explicitly when the provider documents one.

import fs from "node:fs";

function resolveValue(v, env) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.startsWith("env:")) return (env[t.slice(4).trim()] || "").trim() || null;
  return t || null;
}

function validHttp(u) { return u && /^https?:\/\/\S+$/i.test(u) ? u : null; }
function validWs(u) { return u && /^wss?:\/\/\S+$/i.test(u) ? u : null; }

// Providers whose mainnet URL is fixed and only the key varies. Providers with a per-account
// endpoint (QuickNode, Chainstack, Triton, ...) use "url" with a {apiKey} placeholder instead.
export const PROVIDER_PRESETS = {
  helius: {
    url: "https://mainnet.helius-rpc.com/?api-key={apiKey}",
    ws: "wss://mainnet.helius-rpc.com/?api-key={apiKey}",
  },
  alchemy: {
    url: "https://solana-mainnet.g.alchemy.com/v2/{apiKey}",
    ws: "wss://solana-mainnet.g.alchemy.com/v2/{apiKey}",
  },
};

/**
 * Build the final URL: resolve env:, fill {apiKey}, or append ?<apiKeyParam>=<apiKey>.
 * Returns null when a {apiKey} placeholder can't be filled (missing key).
 */
function buildUrl(template, apiKey, apiKeyParam, env) {
  let u = resolveValue(template, env);
  if (!u) return null;
  if (u.includes("{apiKey}")) {
    if (!apiKey) return null;
    u = u.split("{apiKey}").join(encodeURIComponent(apiKey));
  } else if (apiKey && apiKeyParam) {
    try {
      const parsed = new URL(u);
      parsed.searchParams.set(String(apiKeyParam), apiKey);
      u = parsed.toString();
    } catch { return null; }
  }
  return u;
}

/**
 * Parse file content. Pure. Accepts {endpoints:[...]} or a bare array of objects / URL strings.
 * Entry fields:
 *   name         label shown in logs / status (URLs and keys are never shown)
 *   provider     "helius" | "alchemy" -> url/ws built from apiKey (url/ws may still override)
 *   apiKey       the key (or "env:VAR")
 *   url / ws     full URL, may contain {apiKey}; "env:VAR" allowed
 *   apiKeyParam  append the key as this query param to a url without {apiKey} (e.g. "api-key")
 *   enabled      false = skip
 */
export function parseEndpointsFile(raw, env = process.env) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.endpoints) ? raw.endpoints : [];
  return list
    .map((e, i) => (typeof e === "string" ? { name: `file-${i + 1}`, url: e } : e))
    .filter((e) => e && e.enabled !== false)
    .map((e, i) => {
      const preset = PROVIDER_PRESETS[String(e.provider || "").toLowerCase()] || null;
      const apiKey = resolveValue(e.apiKey, env);
      const name = String(e.name || e.provider || `file-${i + 1}`).replace(/[^\w.-]/g, "").slice(0, 32) || `file-${i + 1}`;
      const url = validHttp(buildUrl(e.url ?? preset?.url, apiKey, e.apiKeyParam, env));
      const wsTemplate = e.ws ?? (e.url == null ? preset?.ws : null);
      const ws = validWs(buildUrl(wsTemplate, apiKey, e.apiKeyParam, env));
      return { name, url, ws, provider: preset ? String(e.provider).toLowerCase() : null, hasApiKey: !!apiKey };
    })
    .filter((e) => e.url);
}

/** First enabled Helius endpoint's key (for tools that still read HELIUS_API_KEY). */
export function heliusApiKeyFromFile(raw, env = process.env) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.endpoints) ? raw.endpoints : [];
  for (const e of list) {
    if (!e || e.enabled === false || String(e.provider || "").toLowerCase() !== "helius") continue;
    const key = resolveValue(e.apiKey, env);
    if (key) return key;
  }
  return null;
}

/** Read + parse. Missing file -> []. Unreadable / invalid JSON -> { error }. */
export function readEndpointsFile(path, env = process.env) {
  try {
    const st = fs.statSync(path);
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    const list = parseEndpointsFile(raw, env);
    const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.endpoints) ? raw.endpoints : [];
    const enabled = entries.filter((e) => e && e.enabled !== false);
    const kept = new Set(list.map((e) => e.name));
    // Names only — never echo URLs or keys.
    const skipped = enabled
      .map((e, i) => (typeof e === "string" ? `file-${i + 1}` : String(e.name || e.provider || `file-${i + 1}`).replace(/[^\w.-]/g, "").slice(0, 32)))
      .filter((n) => !kept.has(n));
    return { mtime: st.mtimeMs, list, skipped, heliusApiKey: heliusApiKeyFromFile(raw, env) };
  } catch (e) {
    if (e.code === "ENOENT") return { mtime: null, list: [] };
    return { mtime: null, list: [], error: e.message };
  }
}
