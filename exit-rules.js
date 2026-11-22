// Deterministic exit sizing rules shared by the legacy manager and the
// standalone runtime. No LLM input — these run identically in both modes.

import { config } from "./config.js";
import { log } from "./logger.js";
import { getTrackedPosition } from "./state.js";

/**
 * Rule-based close decision for a position (stop loss, take profit, range
 * exhaustion, low yield). Returns { action: "CLOSE", rule, reason } or null.
 */
export function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  // Meridian-OP Rule 0: Emergency SL. PnL <= -10% DAN dump terkonfirmasi.
  // Tanpa dump_confirmed, rule ini tidak jalan (bukan SL kedua yang berdiri sendiri).
  // dump_confirmed harus diisi monitor: 2 dari 3 (harga -5%/15 mnt, bin turun >=8/10 mnt,
  // 3 candle 5m merah + volume >2x).
  if (!pnlSuspect && position.pnl_pct != null
      && position.pnl_pct <= (managementConfig.emergencyStopLossPct ?? -10)
      && position.dump_confirmed === true) {
    return { action: "CLOSE", rule: 0, reason: "emergency stop loss (dump confirmed)" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  // With partial TP on, +takeProfitPct only takes a slice (modules/partial-tp.js); the
  // full close moves up to partialTpFinalPct and the runner is otherwise left to trailing/SL.
  const fullTpPct = managementConfig.partialTpEnabled === true
    ? (managementConfig.partialTpFinalPct ?? 20)
    : managementConfig.takeProfitPct;
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= fullTpPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  // Meridian-OP Rule 6: Smart Wallet Exit Watch — wallet pemicu entry sudah keluar.
  // walletExitAction "log" hanya mencatat (lihat modules/wallet-exit-watch.js).
  if (position.wallet_exit_signal === true && (managementConfig.walletExitAction ?? "close") === "close") {
    return { action: "CLOSE", rule: 6, reason: position.wallet_exit_reason || "smart wallets exited" };
  }
  // Meridian-OP Rule 3: pump jauh di atas range, HANYA bila PnL >= 0.
  // PnL minus -> HOLD, tunggu balik masuk range. Guard: jarak > max = breakout, tutup.
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    const binsAbove = position.active_bin - position.upper_bin;
    const maxBins = managementConfig.oorRightMaxBinsAbove ?? 25;
    if (binsAbove > maxBins) {
      return { action: "CLOSE", rule: 3, reason: "pumped far above range (breakout distance)" };
    }
    if (position.pnl_pct != null && position.pnl_pct >= 0) {
      return { action: "CLOSE", rule: 3, reason: "pumped far above range (PnL positive)" };
    }
    // PnL minus (atau tidak diketahui): HOLD, jangan close. Lanjut ke rule 4.
  }
  // Meridian-OP Rule 4: OOR kanan. Tutup hanya bila sudah lewat max wait (default 240 mnt).
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= (managementConfig.oorRightMaxWaitMinutes ?? 240)
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR right max wait exceeded" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

/**
 * Volatility-scaled bins below active bin, clamped to the configured range.
 * Throws on unknown volatility — never deploy a blind fixed range.
 */
export function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}
