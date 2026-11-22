// regime-runner.js — Meridian-OP. Regime gate dengan mode:
//   "off"     — tidak dicek sama sekali
//   "log"     — (default) dicek tiap deploy; bila kondisi buruk, deploy TETAP jalan tapi
//               dicatat (decision-log + flag di posisi) agar hasilnya bisa dibandingkan nanti
//   "enforce" — deploy diblokir saat kondisi buruk
// Laporan: `node cli.js regime` (atau /regime di Telegram legacy) — PnL deploy yang
// "seharusnya diblokir" vs yang tidak, untuk memutuskan apakah layak di-enforce.

import fs from "fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { appendDecision } from "../decision-log.js";
import { getTrackedPositions } from "../state.js";
import { regimeGate } from "./regime-gate.js";

let cache = null; // { at, metrics }

async function fetchJson(url, fetchImpl, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Parse CoinGecko /coins/markets (ids=bitcoin,solana, price_change_percentage=1h,24h). Pure. */
export function parseCoinGeckoMarkets(rows) {
  if (!Array.isArray(rows)) return null;
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    solChange24hPct: num(by.solana?.price_change_percentage_24h_in_currency ?? by.solana?.price_change_percentage_24h),
    btcChange1hPct: num(by.bitcoin?.price_change_percentage_1h_in_currency),
    solPrice: num(by.solana?.current_price),
    btcPrice: num(by.bitcoin?.current_price),
    source: "coingecko",
  };
}

/** Parse Binance fallback: SOL 24h ticker + BTC 1m klines (61 candles ≈ 1h). Pure. */
export function parseBinance(solTicker, btcKlines) {
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  let btc1h = null;
  if (Array.isArray(btcKlines) && btcKlines.length >= 2) {
    const open = num(btcKlines[0]?.[1]);
    const close = num(btcKlines[btcKlines.length - 1]?.[4]);
    if (open > 0 && close != null) btc1h = (close / open - 1) * 100;
  }
  return {
    solChange24hPct: num(solTicker?.priceChangePercent),
    btcChange1hPct: btc1h,
    solPrice: num(solTicker?.lastPrice),
    btcPrice: Array.isArray(btcKlines) && btcKlines.length ? num(btcKlines[btcKlines.length - 1]?.[4]) : null,
    source: "binance",
  };
}

/** Ambil metrik market (cache `regimeCheckSec`). Gagal semua sumber -> metrik kosong (fail-open). */
export async function getRegimeMetrics({ fetchImpl = globalThis.fetch, now = Date.now(), force = false } = {}) {
  const ttl = Math.max(30, Number(config.management.regimeCheckSec ?? 300)) * 1000;
  if (!force && cache && now - cache.at < ttl) return cache.metrics;
  let metrics = null;
  try {
    metrics = parseCoinGeckoMarkets(await fetchJson(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,solana&price_change_percentage=1h,24h",
      fetchImpl,
    ));
  } catch (e) {
    log("regime_warn", `CoinGecko unavailable: ${e.message}`);
  }
  if (!metrics || metrics.solChange24hPct == null || metrics.btcChange1hPct == null) {
    try {
      const [sol, btc] = await Promise.all([
        fetchJson("https://api.binance.com/api/v3/ticker/24hr?symbol=SOLUSDT", fetchImpl),
        fetchJson("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=61", fetchImpl),
      ]);
      const b = parseBinance(sol, btc);
      metrics = {
        solChange24hPct: metrics?.solChange24hPct ?? b.solChange24hPct,
        btcChange1hPct: metrics?.btcChange1hPct ?? b.btcChange1hPct,
        solPrice: metrics?.solPrice ?? b.solPrice,
        btcPrice: metrics?.btcPrice ?? b.btcPrice,
        source: metrics ? "coingecko+binance" : "binance",
      };
    } catch (e) {
      log("regime_warn", `Binance fallback unavailable: ${e.message}`);
    }
  }
  metrics = metrics || { solChange24hPct: null, btcChange1hPct: null, source: "none" };
  metrics.at = new Date(now).toISOString();
  cache = { at: now, metrics };
  return metrics;
}

export function _resetRegimeCache() { cache = null; }

/**
 * Gate untuk deploy. Return:
 *   null                              — mode off
 *   { block: true, reason }           — mode enforce + kondisi buruk
 *   { block: false, wouldBlock, flag } — mode log (flag ditempel ke posisi setelah deploy)
 */
export async function regimeDeployGate({ pool = null, poolName = null, fetchImpl, now = Date.now() } = {}) {
  const mode = String(config.management.regimeGateMode ?? "log").toLowerCase();
  if (mode === "off") return null;
  const metrics = await getRegimeMetrics({ fetchImpl, now });
  const g = regimeGate(metrics, config.management);
  if (g.allow) return { block: false, wouldBlock: false, reason: g.reason, metrics };
  const flag = { mode, reason: g.reason, at: new Date(now).toISOString(), sol_24h: metrics.solChange24hPct, btc_1h: metrics.btcChange1hPct };
  appendDecision({
    type: mode === "enforce" ? "skip" : "regime_flag",
    actor: "REGIME",
    pool,
    pool_name: poolName,
    summary: mode === "enforce" ? "Deploy blocked by regime gate" : "Regime gate would block (log-only) — deploy allowed",
    reason: g.reason,
    metrics: { sol_24h_pct: metrics.solChange24hPct, btc_1h_pct: metrics.btcChange1hPct, source: metrics.source },
  });
  log("regime", `${mode === "enforce" ? "BLOCK" : "WOULD BLOCK (log-only)"} ${poolName || pool || "deploy"}: ${g.reason}`);
  if (mode === "enforce") return { block: true, reason: g.reason, metrics };
  return { block: false, wouldBlock: true, reason: g.reason, flag, metrics };
}

/** Laporan: hasil deploy yang di-flag vs tidak (gabung state.json + lessons.json). */
export function regimeReport() {
  let perf = [];
  try { perf = JSON.parse(fs.readFileSync(repoPath("lessons.json"), "utf8")).performance || []; } catch { /* none yet */ }
  const positions = getTrackedPositions(false);
  const byAddr = Object.fromEntries(positions.map((p) => [p.position, p]));
  // A reshaped lineage carries its root's flag; its performance is recorded under the last position.
  const flagOf = (entry) => byAddr[entry.position]?.regime_flag || byAddr[entry.lineage_root]?.regime_flag || null;
  const groups = { flagged: [], normal: [] };
  for (const e of perf) {
    const deployedAfter = byAddr[e.lineage_root || e.position]?.deployed_at;
    if (!deployedAfter) continue; // only positions this agent tracked
    (flagOf(e) ? groups.flagged : groups.normal).push(e);
  }
  const summarize = (arr) => {
    if (!arr.length) return { n: 0 };
    const pnl = arr.map((e) => Number(e.pnl_pct) || 0);
    return {
      n: arr.length,
      win_rate: Math.round((pnl.filter((v) => v >= 0).length / arr.length) * 100),
      avg_pnl_pct: Math.round((pnl.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100,
      total_pnl_usd: Math.round(arr.reduce((a, e) => a + (Number(e.pnl_usd) || 0), 0) * 100) / 100,
      emergency_or_sl: arr.filter((e) => /stop loss|emergency|kill switch/i.test(String(e.close_reason || ""))).length,
    };
  };
  const openFlagged = positions.filter((p) => !p.closed && p.regime_flag).length;
  return { mode: config.management.regimeGateMode ?? "log", flagged: summarize(groups.flagged), normal: summarize(groups.normal), open_flagged: openFlagged };
}

export function formatRegimeReport() {
  const r = regimeReport();
  const line = (label, s) => s.n
    ? `${label}: ${s.n} closed | win ${s.win_rate}% | avg ${s.avg_pnl_pct}% | total $${s.total_pnl_usd} | SL/emergency ${s.emergency_or_sl}`
    : `${label}: no closed positions yet`;
  const m = cache?.metrics;
  return [
    `Regime gate mode: ${r.mode}`,
    m ? `Last market read (${m.source}, ${m.at}): SOL 24h ${m.solChange24hPct ?? "?"}% | BTC 1h ${m.btcChange1hPct ?? "?"}%` : "Last market read: none in this process",
    line("Would-block deploys", r.flagged),
    line("Normal deploys     ", r.normal),
    `Open flagged positions: ${r.open_flagged}`,
    "Enforce only if would-block deploys clearly underperform over a meaningful sample (20+).",
  ].join("\n");
}
