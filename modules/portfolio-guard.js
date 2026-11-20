// portfolio-guard.js — P0 B3 + P1 C2.
// Lokasi yang disarankan: repo root / standalone/
// Pure functions. Dipanggil tiap cycle manager sebelum deploy / reshape.
// Input guard: { dayStartEquityUsd, equityUsd, peakEquityUsd }
// Input hold: { ageMinutes, fee24hUsd, positionUsd }
export function portfolioGuard(g) {
  if (!g || !g.dayStartEquityUsd || !g.equityUsd) {
    return { allowDeploy: false, killSwitch: true, reason: "equity data incomplete — safe mode" };
  }
  const dayPnlPct = ((g.equityUsd - g.dayStartEquityUsd) / g.dayStartEquityUsd) * 100;
  if (dayPnlPct <= -5) {
    return { allowDeploy: false, killSwitch: false, reason: `daily loss ${dayPnlPct.toFixed(2)}% <= -5% — stop deploy today` };
  }
  if (g.peakEquityUsd && g.equityUsd < g.peakEquityUsd * 0.9) {
    return { allowDeploy: false, killSwitch: true, reason: "drawdown -10% from peak — kill switch, close all, shadow 24h" };
  }
  return { allowDeploy: true, killSwitch: false, reason: "portfolio guard OK" };
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
