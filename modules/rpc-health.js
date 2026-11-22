// rpc-health.js — Meridian-OP P1 C5: RPC failover + safe mode.
//
// Semua koneksi utama (kirim tx + baca pool di tools/dlmm.js, saldo di tools/wallet.js,
// PnL RPC bila memakai RPC_URL yang sama) mengambil Connection dari sini.
//   - RPC_URL = primary, FALLBACK_RPC_URL (atau user-config fallbackRpcUrl) = cadangan.
//   - Probe getSlot tiap `rpcHealthCheckSec` (15 dtk). `rpcFailoverAfterFailures` (2) gagal
//     beruntun -> pindah ke RPC berikutnya yang sehat. Kembali ke primary setelah primary
//     sehat `rpcFailbackAfterOk` (3) probe beruntun.
//   - Semua RPC gagal > `rpcSafeModeSec` (60 dtk) -> SAFE MODE: deploy & reshape diblokir,
//     close tetap dicoba. Alert Telegram RPC_DOWN / pulih.
// URL tidak pernah di-log (sering berisi API key) — hanya label primary / fallback-N.

import { Connection } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";

const state = {
  urls: null,
  active: 0,
  fails: [],
  oks: [],
  downSince: null,
  safeMode: false,
  timer: null,
};
const connections = new Map();

function label(i) { return i === 0 ? "primary" : `fallback-${i}`; }

export function rpcUrls() {
  if (!state.urls) {
    const list = [process.env.RPC_URL, config.standalone?.fallbackRpcUrl, process.env.FALLBACK_RPC_URL]
      .map((u) => (typeof u === "string" ? u.trim() : ""))
      .filter(Boolean);
    state.urls = [...new Set(list)];
    state.fails = state.urls.map(() => 0);
    state.oks = state.urls.map(() => 0);
  }
  return state.urls;
}

export function getActiveRpcUrl() {
  const urls = rpcUrls();
  return urls[state.active] ?? urls[0] ?? process.env.RPC_URL;
}

/** Connection to the currently active RPC (cached per URL). */
export function rpcConnection(commitment = "confirmed") {
  const url = getActiveRpcUrl();
  if (!url) throw new Error("RPC_URL not set");
  const key = `${commitment}|${url}`;
  if (!connections.has(key)) connections.set(key, new Connection(url, commitment));
  return connections.get(key);
}

export function isRpcSafeMode() { return state.safeMode; }

export function rpcStatus() {
  const urls = rpcUrls();
  return {
    active: label(state.active),
    endpoints: urls.length,
    safe_mode: state.safeMode,
    down_since: state.downSince ? new Date(state.downSince).toISOString() : null,
    fails: [...state.fails],
  };
}

async function probe(url, fetchImpl, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "confirmed" }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Number.isFinite(Number(body?.result)) && !body?.error;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** One health pass. Exported for tests; the monitor calls it on an interval. */
export async function checkRpcHealth({ fetchImpl = globalThis.fetch, notify = null, now = Date.now() } = {}) {
  const cfg = config.management;
  const urls = rpcUrls();
  if (!urls.length) return rpcStatus();
  const failoverAfter = Math.max(1, Number(cfg.rpcFailoverAfterFailures ?? 2));
  const failbackAfter = Math.max(1, Number(cfg.rpcFailbackAfterOk ?? 3));
  const safeAfterMs = Math.max(0, Number(cfg.rpcSafeModeSec ?? 60)) * 1000;
  const timeoutMs = Math.max(1000, Number(cfg.rpcProbeTimeoutMs ?? 8000));

  const results = await Promise.all(urls.map((u) => probe(u, fetchImpl, timeoutMs)));
  results.forEach((ok, i) => {
    state.fails[i] = ok ? 0 : state.fails[i] + 1;
    state.oks[i] = ok ? state.oks[i] + 1 : 0;
  });

  const prev = state.active;
  if (state.fails[state.active] >= failoverAfter) {
    const healthy = results.findIndex((ok) => ok);
    if (healthy >= 0 && healthy !== state.active) state.active = healthy;
  } else if (state.active !== 0 && state.oks[0] >= failbackAfter) {
    state.active = 0; // primary is stable again
  }
  if (prev !== state.active) {
    log("rpc_warn", `RPC failover: ${label(prev)} → ${label(state.active)}`);
    notify?.("RPC_FAILOVER", `RPC switched ${label(prev)} → ${label(state.active)}`);
  }

  const anyOk = results.some(Boolean);
  if (anyOk) {
    if (state.safeMode) {
      log("rpc", `RPC recovered (${label(state.active)}) — leaving safe mode`);
      notify?.("RPC_RECOVERED", `RPC back (${label(state.active)}) — deploys allowed again`);
    }
    state.downSince = null;
    state.safeMode = false;
  } else {
    state.downSince ??= now;
    if (!state.safeMode && now - state.downSince >= safeAfterMs) {
      state.safeMode = true;
      log("rpc_warn", `All RPC endpoints down ${Math.round((now - state.downSince) / 1000)}s — SAFE MODE (no deploy/reshape)`);
      notify?.("RPC_DOWN", `All ${urls.length} RPC endpoint(s) down >${Math.round(safeAfterMs / 1000)}s — safe mode: no new deploys or reshapes, exits still attempted`);
    }
  }
  return rpcStatus();
}

export function startRpcHealthMonitor({ notify = null } = {}) {
  if (state.timer) return;
  const sec = Math.max(5, Number(config.management.rpcHealthCheckSec ?? 15));
  state.timer = setInterval(() => { void checkRpcHealth({ notify }); }, sec * 1000);
  state.timer.unref?.();
  void checkRpcHealth({ notify });
  log("rpc", `RPC health monitor: ${rpcUrls().length} endpoint(s), probe every ${sec}s`);
}

export function stopRpcHealthMonitor() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** Test helper. */
export function _resetRpcHealth(urls = null) {
  state.urls = urls;
  state.active = 0;
  state.fails = (urls || []).map(() => 0);
  state.oks = (urls || []).map(() => 0);
  state.downSince = null;
  state.safeMode = false;
  connections.clear();
}
