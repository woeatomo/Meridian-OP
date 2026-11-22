// wallet-exit-watch.js — Meridian-OP P0 B7: Smart Wallet Exit Watch.
//
// Bot standalone masuk karena beberapa smart wallet membuka posisi DLMM di token yang sama.
// Kalau wallet-wallet pemicu itu keluar, alasan masuk kita hilang -> sinyal exit dini
// (sebelum harga sempat jatuh ke SL).
//
// Per wallet pemicu dicek posisi DLMM MILIKNYA (yang tercatat saat sinyal masuk):
//   - akun posisi sudah tidak ada  -> keluar, KECUALI wallet itu masih punya posisi terbuka
//     di pool yang sama (rebalance / pindah posisi = masih yakin)
//   - share likuiditas turun >= walletExitShareDropPct (50%) -> keluar (menjual sebagian besar)
//   - gagal dibaca (RPC/API error) -> tidak diketahui, TIDAK dihitung keluar
// Sinyal exit bila jumlah wallet keluar >= min(walletExitMinWallets, jumlah pemicu).
// Hasil disimpan di cache memori; position-annotate menempelkannya ke posisi sebagai
// `wallet_exit_signal`, dan exit-rules Rule 6 menutup posisi (atau hanya log).

import { config } from "../config.js";
import { log } from "../logger.js";
import { getTrackedPosition } from "../state.js";

const cache = new Map(); // position -> { exitSignal, reason, exited, unknown, total, at }
let lastRefreshAt = 0;
let refreshing = null;

/**
 * Pure. results: [{ wallet, status: "holding" | "exited" | "unknown", detail }]
 */
export function evaluateTriggerExits(results, cfg = {}) {
  const total = results.length;
  const exited = results.filter((r) => r.status === "exited");
  const unknown = results.filter((r) => r.status === "unknown").length;
  const need = Math.max(1, Math.min(Number(cfg.walletExitMinWallets ?? 2), total));
  const exitSignal = total > 0 && exited.length >= need;
  return {
    exitSignal,
    exited: exited.length,
    unknown,
    total,
    reason: exitSignal
      ? `smart wallets exited (${exited.length}/${total}: ${exited.map((r) => `${r.wallet.slice(0, 4)} ${r.detail}`).join(", ")})`
      : `${exited.length}/${total} trigger wallets exited${unknown ? `, ${unknown} unreadable` : ""}`,
  };
}

/**
 * Status satu wallet pemicu. deps: { snapshot(position, wallet, pool) -> {shares}|null (throws on read error),
 * walletPools(wallet) -> string[] (throws on error) }
 */
export async function triggerStatus(t, deps, cfg = {}) {
  const dropPct = Number(cfg.walletExitShareDropPct ?? 50);
  let snap;
  try {
    snap = await deps.snapshot(t.position, t.wallet, t.pool);
  } catch (e) {
    return { wallet: t.wallet, status: "unknown", detail: `read failed (${e.message})` };
  }
  if (snap && snap.shares != null) {
    const now = BigInt(String(snap.shares));
    const orig = BigInt(String(t.shares));
    if (orig > 0n && now * 100n <= orig * BigInt(Math.max(0, 100 - dropPct))) {
      return { wallet: t.wallet, status: "exited", detail: `removed ${100 - Number((now * 100n) / orig)}% liquidity` };
    }
    return { wallet: t.wallet, status: "holding", detail: "position open" };
  }
  // Position gone (or no longer readable as theirs). Did they just move to a new position in the same pool?
  try {
    const pools = await deps.walletPools(t.wallet);
    if (Array.isArray(pools) && pools.includes(t.pool)) return { wallet: t.wallet, status: "holding", detail: "re-positioned in same pool" };
    return { wallet: t.wallet, status: "exited", detail: "closed position" };
  } catch (e) {
    return { wallet: t.wallet, status: "unknown", detail: `portfolio read failed (${e.message})` };
  }
}

/** Cek semua posisi terbuka yang punya trigger_wallets (throttled `walletExitCheckSec`). */
export async function refreshWalletExits(positions, deps, { now = Date.now(), force = false } = {}) {
  const cfg = config.management;
  if (cfg.walletExitWatchEnabled === false) return;
  const minMs = Math.max(15, Number(cfg.walletExitCheckSec ?? 60)) * 1000;
  if (!force && now - lastRefreshAt < minMs) return;
  if (refreshing) return refreshing;
  lastRefreshAt = now;
  refreshing = (async () => {
    const open = new Set();
    for (const p of positions || []) {
      open.add(p.position);
      const triggers = getTrackedPosition(p.position)?.trigger_wallets;
      if (!Array.isArray(triggers) || !triggers.length) continue;
      const results = [];
      for (const t of triggers) results.push(await triggerStatus(t, deps, cfg));
      const verdict = { ...evaluateTriggerExits(results, cfg), at: now };
      const prev = cache.get(p.position);
      if (!prev || prev.exitSignal !== verdict.exitSignal || prev.exited !== verdict.exited) {
        log(verdict.exitSignal ? "wallet_exit_warn" : "wallet_exit", `${p.pair ?? p.position.slice(0, 8)}: ${verdict.reason}`);
      }
      cache.set(p.position, verdict);
    }
    for (const key of cache.keys()) if (!open.has(key)) cache.delete(key);
  })();
  try { await refreshing; } finally { refreshing = null; }
}

export function getWalletExitState(position) {
  return cache.get(position) || null;
}

export function _setWalletExitState(position, state) { cache.set(position, state); }
export function _resetWalletExits() { cache.clear(); lastRefreshAt = 0; }
