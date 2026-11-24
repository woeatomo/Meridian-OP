// portfolio-guard.js — P0 B3 + P1 C2.
// Lokasi yang disarankan: repo root / standalone/
// Pure functions. Dipanggil tiap cycle manager sebelum deploy / reshape.
// Input guard: { dayStartEquity, equity, peakEquity, killSwitchUntil, now } — satuan bebas (SOL atau USD), konsisten.
// Input hold: { ageMinutes, fee24hUsd, positionUsd }
export function portfolioGuard(g, cfg = {}) {
  const dailyLimit = Number(cfg.dailyLossLimitPct ?? -5);
  const killPct = Number(cfg.portfolioKillSwitchPct ?? -10);
  const now = g?.now ?? Date.now();
  // Kill switch already tripped: no deploys until it expires (positions already closed).
  if (g?.killSwitchUntil && now < g.killSwitchUntil) {
    return { allowDeploy: false, killSwitch: false, tripped: "kill_switch", reason: `kill switch active until ${new Date(g.killSwitchUntil).toISOString()}` };
  }
  // Missing equity data = unknown, NOT a loss: block new deploys this tick, never close positions.
  if (!g || !(g.dayStartEquity > 0) || !(g.equity > 0)) {
    return { allowDeploy: false, killSwitch: false, tripped: null, reason: "equity data incomplete — no new deploys this tick" };
  }
  // Daily loss can use a different basis (e.g. realized-only) than the drawdown / kill switch.
  const dayEquity = Number.isFinite(Number(g.dailyEquity)) ? Number(g.dailyEquity) : g.equity;
  const dayPnlPct = ((dayEquity - g.dayStartEquity) / g.dayStartEquity) * 100;
  const drawdownPct = g.peakEquity > 0 ? ((g.equity - g.peakEquity) / g.peakEquity) * 100 : 0;
  const metrics = { dayPnlPct: Math.round(dayPnlPct * 100) / 100, drawdownPct: Math.round(drawdownPct * 100) / 100 };
  if (drawdownPct <= killPct) {
    return { allowDeploy: false, killSwitch: true, tripped: "kill_switch", ...metrics, reason: `drawdown ${metrics.drawdownPct}% from peak <= ${killPct}% — kill switch: close all, pause entries` };
  }
  if (dayPnlPct <= dailyLimit) {
    return { allowDeploy: false, killSwitch: false, tripped: "daily_loss", ...metrics, reason: `daily loss ${metrics.dayPnlPct}% <= ${dailyLimit}% — no new deploys today` };
  }
  return { allowDeploy: true, killSwitch: false, tripped: null, ...metrics, reason: "portfolio guard OK" };
}

// P1 C2: max hold 48 jam / fee decay. Tutup bila fee 24 jam terakhir < 1% posisi
// dan posisi sudah berumur >= 24 jam — modal lebih baik dipindah ke pool ramai.
export function feeDecayExit(h) {
  if (!h || typeof h.ageMinutes !== "number") return { close: false, reason: "no data" };
  if (h.ageMinutes >= 2880) return { close: true, reason: "max hold 48h reached" };
  if (h.ageMinutes >= 1440 && typeof h.fee24hUsd === "number" && typeof h.positionUsd === "number" && h.positionUsd > 0) {
    if (h.fee24hUsd < 0.01 * h.positionUsd) {
      return { close: true, reason: "fee decay: fee 24h < 1% posisi setelah 24 jam" };
    }
  }
  return { close: false, reason: "hold time / fee OK" };
}
