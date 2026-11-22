// rpc-endpoints-file.js — Meridian-OP. Reader for rpc-endpoints.json (no config import, so
// config.js can use it at load time to derive RPC_URL when .env / user-config have none).
//
// Format:
//   { "endpoints": [
//       { "name": "helius",    "url": "https://mainnet.helius-rpc.com/?api-key=KEY", "ws": "wss://..." },
//       { "name": "quicknode", "url": "env:QUICKNODE_RPC_URL", "ws": "env:QUICKNODE_WS_URL" },
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

/** Parse file content. Pure. Accepts {endpoints:[...]} or a bare array of objects / URL strings. */
export function parseEndpointsFile(raw, env = process.env) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.endpoints) ? raw.endpoints : [];
  return list
    .map((e, i) => (typeof e === "string" ? { name: `file-${i + 1}`, url: e } : e))
    .filter((e) => e && e.enabled !== false)
    .map((e, i) => ({
      name: String(e.name || `file-${i + 1}`).replace(/[^\w.-]/g, "").slice(0, 32) || `file-${i + 1}`,
      url: validHttp(resolveValue(e.url, env)),
      ws: validWs(resolveValue(e.ws, env)),
    }))
    .filter((e) => e.url);
}

/** Read + parse. Missing file -> []. Unreadable / invalid JSON -> { error }. */
export function readEndpointsFile(path, env = process.env) {
  try {
    const st = fs.statSync(path);
    return { mtime: st.mtimeMs, list: parseEndpointsFile(JSON.parse(fs.readFileSync(path, "utf8")), env) };
  } catch (e) {
    if (e.code === "ENOENT") return { mtime: null, list: [] };
    return { mtime: null, list: [], error: e.message };
  }
}
