// reshape-manager.js — Reshape satu arah ke bawah (Spot -> Bid-Ask).
// Lokasi yang disarankan: repo root / standalone/
// Aturan Atomo: reshape HANYA saat harga turun, TIDAK saat rebound.
// Turun pelan -> reshape. Dump cepat -> Emergency SL, JANGAN reshape.
// Input: { binsDown, minutesSinceLastReshape, reshapesDone, pnlPct,
//          dumpConfirmed, feesEarnedUsd, reshapeCostUsd, inRange }
// Output: { action: "RESHAPE" | "HOLD" | "EMERGENCY_SL", reason: string }
export function decideReshape(p) {
  if (p.dumpConfirmed === true) {
    return { action: "EMERGENCY_SL", reason: "dump confirmed — do not reshape, exit" };
  }
  if (typeof p.pnlPct === "number" && p.pnlPct <= -10) {
    return { action: "EMERGENCY_SL", reason: "PnL <= -10% — emergency exit, not reshape" };
  }
  if (p.inRange === false) {
    return { action: "HOLD", reason: "out of range — use exit rules, not reshape" };
  }
  if (p.reshapesDone >= 3) {
    return { action: "HOLD", reason: "max reshapes per position reached (3)" };
  }
  if (p.minutesSinceLastReshape < 45) {
    return { action: "HOLD", reason: "reshape cooldown (45m) not elapsed" };
  }
  if (p.binsDown < 5) {
    return { action: "HOLD", reason: "down < 5 bins — no reshape yet" };
  }
  if (typeof p.feesEarnedUsd === "number" && typeof p.reshapeCostUsd === "number") {
    if (p.feesEarnedUsd < 2 * p.reshapeCostUsd) {
      return { action: "HOLD", reason: "fees earned < 2x reshape cost — not economical" };
    }
  }
  return { action: "RESHAPE", reason: `down ${p.binsDown} bins, slow, economical — Spot -> Bid-Ask, re-centre down` };
}
