// rpc-health.js — Meridian-OP P1 C5: multi-endpoint RPC failover + safe mode.
//
// Endpoints (urutan = prioritas), digabung tanpa duplikat:
//   1. RPC_URL (.env)                      -> "primary"
//   2. rpc-endpoints.json (repo root, gitignored — berisi API key!)  { "endpoints": [{ "name", "url" }] }
//   3. RPC_URLS (.env, dipisah koma)
//   4. FALLBACK_RPC_URL / user-config fallbackRpcUrl
// rpc-endpoints.json dibaca ulang otomatis bila file berubah (tanpa restart).
//
// Rotasi (sticky failover — satu endpoint aktif, pindah hanya saat bermasalah):
//   - Setiap request RPC sungguhan dilaporkan (fetch wrapper). HTTP 429 -> endpoint
//     di-cooldown `rpcRateLimitCooldownSec` dan langsung pindah. 5xx / timeout / network
//     error >= `rpcErrorThreshold` kali dalam `rpcErrorWindowSec` -> cooldown
//     `rpcErrorCooldownSec` dan pindah.
//   - Probe getSlot tiap `rpcHealthCheckSec`: endpoint aktif tiap tick, primary tiap tick
//     saat tidak aktif (untuk failback), sisanya tiap `rpcProbeOthersEvery` tick atau saat
//     endpoint aktif gagal. `rpcFailoverAfterFailures` probe gagal beruntun -> pindah.
//   - Kembali ke primary setelah sehat `rpcFailbackAfterOk` probe beruntun (rpcPreferPrimary).
//   - Semua endpoint gagal > `rpcSafeModeSec` -> SAFE MODE: deploy & reshape diblokir,
//     close tetap dicoba. Alert Telegram RPC_FAILOVER / RPC_DOWN / RPC_RECOVERED.
// URL tidak pernah di-log (berisi API key) — hanya `name`.

import fs from "node:fs";
import { Connection } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";

const ENDPOINTS_FILE = repoPath("rpc-endpoints.json");

const state = {
  endpoints: null,   // [{ name, url, fails, oks, cooldownUntil, errors: [ts], requests, errorsTotal }]
  fileMtime: null,
  override: false,   // set by tests
  active: 0,
  tick: 0,
  downSince: null,
  safeMode: false,
  timer: null,
  notify: null,
};
const connections = new Map();

function cfg() { return config.management || {}; }

function validUrl(u) {
  if (typeof u !== "string") return null;
  const t = u.trim();
  return /^https?:\/\/\S+$/i.test(t) ? t : null;
}

/** Parse rpc-endpoints.json content. Pure. Accepts {endpoints:[...]} or a bare array of objects/strings. */
export function parseEndpointsFile(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.endpoints) ? raw.endpoints : [];
  return list
    .map((e, i) => (typeof e === "string" ? { name: `file-${i + 1}`, url: e } : e))
    .filter((e) => e && e.enabled !== false)
    .map((e, i) => ({ name: String(e.name || `file-${i + 1}`).replace(/[^\w.-]/g, "").slice(0, 32) || `file-${i + 1}`, url: validUrl(e.url) }))
    .filter((e) => e.url);
}

function readFileEndpoints() {
  try {
    const st = fs.statSync(ENDPOINTS_FILE);
    return { mtime: st.mtimeMs, list: parseEndpointsFile(JSON.parse(fs.readFileSync(ENDPOINTS_FILE, "utf8"))) };
  } catch (e) {
    if (e.code !== "ENOENT") log("rpc_warn", `rpc-endpoints.json unreadable (${e.message}) — ignoring file`);
    return { mtime: null, list: [] };
  }
}

function buildEndpoints() {
  const file = readFileEndpoints();
  state.fileMtime = file.mtime;
  const raw = [
    { name: "primary", url: validUrl(process.env.RPC_URL) },
    ...file.list,
    ...String(process.env.RPC_URLS || "").split(",").map((u, i) => ({ name: `env-${i + 1}`, url: validUrl(u) })),
    { name: "fallback", url: validUrl(config.standalone?.fallbackRpcUrl || process.env.FALLBACK_RPC_URL) },
  ].filter((e) => e.url);
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push(e);
  }
  return out;
}

function freshEndpoint(e, prev) {
  return { name: e.name, url: e.url, fails: prev?.fails ?? 0, oks: prev?.oks ?? 0, cooldownUntil: prev?.cooldownUntil ?? 0, errors: prev?.errors ?? [], requests: prev?.requests ?? 0, errorsTotal: prev?.errorsTotal ?? 0 };
}

function endpoints() {
  if (!state.endpoints) {
    state.endpoints = buildEndpoints().map((e) => freshEndpoint(e));
    if (state.endpoints.length > 1) log("rpc", `RPC endpoints: ${state.endpoints.map((e) => e.name).join(", ")}`);
  }
  return state.endpoints;
}

/** Hot-reload rpc-endpoints.json when its mtime changes (keeps per-URL health). */
function maybeReload() {
  if (state.override) return;
  endpoints(); // initial build records the file mtime
  let mtime = null;
  try { mtime = fs.statSync(ENDPOINTS_FILE).mtimeMs; } catch { mtime = null; }
  if (mtime === state.fileMtime) return;
  const activeUrl = endpoints()[state.active]?.url;
  const byUrl = new Map(endpoints().map((e) => [e.url, e]));
  state.endpoints = buildEndpoints().map((e) => freshEndpoint(e, byUrl.get(e.url)));
  const idx = state.endpoints.findIndex((e) => e.url === activeUrl);
  state.active = idx >= 0 ? idx : 0;
  log("rpc", `rpc-endpoints.json reloaded: ${state.endpoints.length} endpoint(s) (${state.endpoints.map((e) => e.name).join(", ")})`);
}

export function rpcUrls() { return endpoints().map((e) => e.url); }

export function getActiveRpcUrl() {
  const list = endpoints();
  return list[state.active]?.url ?? list[0]?.url ?? process.env.RPC_URL;
}

export function getActiveRpcName() { return endpoints()[state.active]?.name ?? "none"; }

/** URLs ordered for a read with retries: active first, then healthy, cooling ones last. */
export function orderedRpcUrls(now = Date.now()) {
  const list = endpoints();
  const order = list.map((_, i) => (state.active + i) % list.length);
  const healthy = order.filter((i) => list[i].cooldownUntil <= now);
  const cooling = order.filter((i) => list[i].cooldownUntil > now);
  return [...healthy, ...cooling].map((i) => list[i].url);
}

function indexOfUrl(url) { return endpoints().findIndex((e) => e.url === url); }

function switchTo(idx, why, now = Date.now()) {
  if (idx === state.active || idx < 0) return;
  const from = endpoints()[state.active]?.name, to = endpoints()[idx]?.name;
  state.active = idx;
  log("rpc_warn", `RPC failover: ${from} → ${to} (${why})`);
  state.notify?.("RPC_FAILOVER", `RPC switched ${from} → ${to} (${why})`);
}

/** Next usable endpoint after `from` that is not cooling down; null if none. */
function nextHealthy(from, now = Date.now()) {
  const list = endpoints();
  for (let k = 1; k < list.length; k++) {
    const i = (from + k) % list.length;
    if (list[i].cooldownUntil <= now) return i;
  }
  return null;
}

/**
 * Report the outcome of a real RPC request (called by the fetch wrapper).
 * status: HTTP status, or 0 for network error / timeout.
 */
export function reportRpcOutcome(url, ok, status = 0, now = Date.now()) {
  const idx = indexOfUrl(url);
  if (idx < 0) return;
  const e = endpoints()[idx];
  e.requests++;
  if (ok) { e.errors = []; return; }
  e.errorsTotal++;
  const c = cfg();
  if (status === 429) {
    e.cooldownUntil = now + Math.max(5, Number(c.rpcRateLimitCooldownSec ?? 60)) * 1000;
    e.errors = [];
    log("rpc_warn", `RPC ${e.name} rate-limited (429) — cooling down`);
    if (idx === state.active) { const n = nextHealthy(idx, now); if (n != null) switchTo(n, "rate limited", now); }
    return;
  }
  const windowMs = Math.max(5, Number(c.rpcErrorWindowSec ?? 30)) * 1000;
  e.errors = [...e.errors.filter((t) => now - t <= windowMs), now];
  if (e.errors.length >= Math.max(1, Number(c.rpcErrorThreshold ?? 3))) {
    e.cooldownUntil = now + Math.max(5, Number(c.rpcErrorCooldownSec ?? 120)) * 1000;
    e.errors = [];
    log("rpc_warn", `RPC ${e.name}: repeated errors (last status ${status || "network"}) — cooling down`);
    if (idx === state.active) { const n = nextHealthy(idx, now); if (n != null) switchTo(n, `errors (${status || "network"})`, now); }
  }
}

/** fetch for web3.js Connection that reports every request's outcome for `url`. */
export function trackedFetch(url, timeoutMs = 15_000) {
  return async (input, init = {}) => {
    try {
      const res = await fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
      reportRpcOutcome(url, res.ok, res.status);
      return res;
    } catch (e) {
      reportRpcOutcome(url, false, 0);
      throw e;
    }
  };
}

/** Connection for a specific URL with outcome tracking (cached). */
export function trackedConnection(url, commitment = "confirmed", extra = {}) {
  const key = `${commitment}|${url}|${extra.wsEndpoint || ""}`;
  if (!connections.has(key)) {
    connections.set(key, new Connection(url, { commitment, disableRetryOnRateLimit: true, ...extra, fetch: trackedFetch(url) }));
  }
  return connections.get(key);
}

/** Connection to the currently active RPC. */
export function rpcConnection(commitment = "confirmed") {
  const url = getActiveRpcUrl();
  if (!url) throw new Error("RPC_URL not set");
  return trackedConnection(url, commitment);
}

export function isRpcSafeMode() { return state.safeMode; }

export function rpcStatus(now = Date.now()) {
  return {
    active: getActiveRpcName(),
    safe_mode: state.safeMode,
    down_since: state.downSince ? new Date(state.downSince).toISOString() : null,
    endpoints: endpoints().map((e) => ({
      name: e.name,
      cooling_sec: e.cooldownUntil > now ? Math.round((e.cooldownUntil - now) / 1000) : 0,
      probe_fails: e.fails,
      requests: e.requests,
      errors: e.errorsTotal,
    })),
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
    if (res.status === 429) return { ok: false, status: 429 };
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json();
    return { ok: Number.isFinite(Number(body?.result)) && !body?.error, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** One health pass. Exported for tests; the monitor calls it on an interval. */
export async function checkRpcHealth({ fetchImpl = globalThis.fetch, notify = state.notify, now = Date.now() } = {}) {
  if (notify) state.notify = notify;
  maybeReload();
  const c = cfg();
  const list = endpoints();
  if (!list.length) return rpcStatus(now);
  const failoverAfter = Math.max(1, Number(c.rpcFailoverAfterFailures ?? 2));
  const failbackAfter = Math.max(1, Number(c.rpcFailbackAfterOk ?? 3));
  const safeAfterMs = Math.max(0, Number(c.rpcSafeModeSec ?? 60)) * 1000;
  const timeoutMs = Math.max(1000, Number(c.rpcProbeTimeoutMs ?? 8000));
  const othersEvery = Math.max(1, Number(c.rpcProbeOthersEvery ?? 4));
  state.tick++;

  // Probe set: active always; primary when not active (failback); everyone when the
  // active one is struggling or on the periodic sweep. Keeps idle credit use low.
  const activeStruggling = list[state.active].fails > 0 || list[state.active].cooldownUntil > now;
  const toProbe = list.map((_, i) => i).filter((i) =>
    i === state.active || (i === 0 && c.rpcPreferPrimary !== false) || activeStruggling || state.tick % othersEvery === 0);
  const results = new Map();
  await Promise.all(toProbe.map(async (i) => { results.set(i, await probe(list[i].url, fetchImpl, timeoutMs)); }));
  for (const [i, r] of results) {
    const e = list[i];
    e.fails = r.ok ? 0 : e.fails + 1;
    e.oks = r.ok ? e.oks + 1 : 0;
    if (r.status === 429) e.cooldownUntil = now + Math.max(5, Number(c.rpcRateLimitCooldownSec ?? 60)) * 1000;
    if (r.ok && e.cooldownUntil > now && e.oks >= failbackAfter) e.cooldownUntil = 0; // proven healthy again
  }

  // A cooled-down / failing active endpoint gets replaced by the best healthy one.
  const act = list[state.active];
  if (act.fails >= failoverAfter || act.cooldownUntil > now) {
    const healthy = [...results.entries()].filter(([i, r]) => r.ok && i !== state.active && list[i].cooldownUntil <= now).map(([i]) => i);
    const pick = healthy.length ? Math.min(...healthy) : nextHealthy(state.active, now);
    if (pick != null) switchTo(pick, act.cooldownUntil > now ? "cooling down" : "health probe failed", now);
  } else if (state.active !== 0 && c.rpcPreferPrimary !== false && list[0].oks >= failbackAfter && list[0].cooldownUntil <= now) {
    switchTo(0, "primary healthy again", now);
  }

  const anyOk = [...results.values()].some((r) => r.ok);
  if (anyOk) {
    if (state.safeMode) {
      log("rpc", `RPC recovered (${getActiveRpcName()}) — leaving safe mode`);
      state.notify?.("RPC_RECOVERED", `RPC back (${getActiveRpcName()}) — deploys allowed again`);
    }
    state.downSince = null;
    state.safeMode = false;
  } else {
    state.downSince ??= now;
    if (!state.safeMode && now - state.downSince >= safeAfterMs) {
      state.safeMode = true;
      log("rpc_warn", `All RPC endpoints down ${Math.round((now - state.downSince) / 1000)}s — SAFE MODE (no deploy/reshape)`);
      state.notify?.("RPC_DOWN", `All ${list.length} RPC endpoint(s) down >${Math.round(safeAfterMs / 1000)}s — safe mode: no new deploys or reshapes, exits still attempted`);
    }
  }
  return rpcStatus(now);
}

export function startRpcHealthMonitor({ notify = null } = {}) {
  if (state.timer) return;
  state.notify = notify;
  const sec = Math.max(5, Number(cfg().rpcHealthCheckSec ?? 15));
  state.timer = setInterval(() => { void checkRpcHealth(); }, sec * 1000);
  state.timer.unref?.();
  void checkRpcHealth();
  log("rpc", `RPC health monitor: ${endpoints().length} endpoint(s), probe every ${sec}s`);
}

export function stopRpcHealthMonitor() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

export function formatRpcStatus() {
  const s = rpcStatus();
  return [
    `RPC active: ${s.active}${s.safe_mode ? " | SAFE MODE" : ""}`,
    ...s.endpoints.map((e) => `  ${e.name}: ${e.cooling_sec ? `cooling ${e.cooling_sec}s` : "ok"} | probe fails ${e.probe_fails} | requests ${e.requests} | errors ${e.errors}`),
  ].join("\n");
}

/** Test helper: urls = array of URL strings or {name,url}; null = rebuild from env/file. */
export function _resetRpcHealth(urls = null) {
  state.override = Array.isArray(urls);
  state.endpoints = Array.isArray(urls)
    ? urls.map((u, i) => freshEndpoint(typeof u === "string" ? { name: i === 0 ? "primary" : `ep-${i}`, url: u } : u))
    : null;
  state.fileMtime = null;
  state.active = 0;
  state.tick = 0;
  state.downSince = null;
  state.safeMode = false;
  state.notify = null;
  connections.clear();
}
