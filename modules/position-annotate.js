// position-annotate.js — Meridian-OP. Dipanggil sekali per fetch posisi (getMyPositions)
// SEBELUM rule exit dievaluasi. Menambahkan ke tiap posisi:
//   - pnl_pct berantai (lineage) untuk posisi hasil reshape: SL/TP/trailing menghitung
//     dari modal awal, bukan dari deposit ulang. pnl_pct asli disimpan di pnl_pct_raw.
//   - dump_confirmed / dump_signals / bins_down_10m / price_change_15m_pct / low_bin_10m
//     dari modules/dump-detector.js (dipakai exit-rules Rule 0 + reshape-manager).
//   - oor_side: "left" (harga di bawah range) | "right" (di atas) | null.

import { config } from "../config.js";
import { log } from "../logger.js";
import { getTrackedPosition } from "../state.js";
import { recordTick, assessDump, fetchPoolCandles, pruneHistory } from "./dump-detector.js";
import { getWalletExitState } from "./wallet-exit-watch.js";

const round2 = v => Math.round(v * 100) / 100;
const lastDumpState = new Map(); // position -> boolean (log hanya saat berubah)

/** Gabungkan faktor PnL lineage dengan PnL posisi saat ini. Pure. */
export function chainPnlPct(rawPnlPct, pnlFactor) {
  if (rawPnlPct == null || !Number.isFinite(Number(rawPnlPct))) return rawPnlPct;
  const f = Number(pnlFactor);
  if (!Number.isFinite(f) || f <= 0 || f === 1) return rawPnlPct;
  return round2((f * (1 + Number(rawPnlPct) / 100) - 1) * 100);
}

/** Sisi OOR dari bin. Pure. */
export function oorSide(p) {
  const a = p.active_bin, lo = p.lower_bin, hi = p.upper_bin;
  if (a == null || lo == null || hi == null) return null;
  if (a < lo) return "left";
  if (a > hi) return "right";
  return null;
}

export async function annotatePositions(positions, { binStepFor = null, getCandles = fetchPoolCandles, now = Date.now() } = {}) {
  if (!Array.isArray(positions)) return positions;
  const cfg = config.management;
  for (const p of positions) {
    try {
      const tracked = getTrackedPosition(p.position);
      const lineage = tracked?.lineage;
      if (lineage && p.pnl_pct_raw === undefined) {
        p.pnl_pct_raw = p.pnl_pct;
        p.pnl_pct = chainPnlPct(p.pnl_pct, lineage.pnl_factor);
        p.reshape_count = lineage.reshape_count ?? 0;
      }
      p.oor_side = oorSide(p);
      const walletExit = getWalletExitState(p.position);
      p.wallet_exit_signal = walletExit?.exitSignal === true;
      p.wallet_exit_reason = walletExit?.reason ?? null;
      recordTick(p.position, p, now);
      let binStep = tracked?.bin_step ?? null;
      if (binStep == null && typeof binStepFor === "function") binStep = await binStepFor(p.pool).catch(() => null);
      const d = await assessDump(p.position, { pool: p.pool, binStep, cfg, getCandles, now });
      p.dump_confirmed = d.dump_confirmed;
      p.dump_signals = d.signals;
      p.bins_down_10m = d.stats.bins_down_10m;
      p.price_change_15m_pct = d.stats.price_change_15m_pct;
      p.low_bin_10m = d.stats.low_bin_10m;
      if (lastDumpState.get(p.position) !== d.dump_confirmed) {
        if (d.dump_confirmed || lastDumpState.has(p.position)) {
          log(d.dump_confirmed ? "dump_warn" : "dump", `${p.pair ?? p.position.slice(0, 8)}: dump ${d.dump_confirmed ? "CONFIRMED" : "cleared"} — price15m=${d.stats.price_change_15m_pct ?? "?"}% bins10m=-${d.stats.bins_down_10m} candles=${d.signals.candles} (${d.count}/3)`);
        }
        lastDumpState.set(p.position, d.dump_confirmed);
      }
    } catch (e) {
      // Anotasi tidak boleh mematikan jalur exit: biarkan field default (dump_confirmed undefined).
      log("dump_warn", `annotate failed for ${p.position?.slice?.(0, 8)}: ${e.message}`);
    }
  }
  pruneHistory(positions.map((p) => p.position));
  for (const key of lastDumpState.keys()) if (!positions.some((p) => p.position === key)) lastDumpState.delete(key);
  return positions;
}
