// partial-tp.js — P0 B5. STAGED: butuh executor partial close.
// Lokasi yang disarankan: repo root / tools/
// Meridian saat ini hanya CLOSE semua. Fungsi ini mengembalikan fraksi yang
// harus ditutup; wiring ke close_position (parameter `fraction`) belum ada.
// Input: { pnlPct, tp1Hit, tp2Hit }
// Output: { action: "PARTIAL_CLOSE" | "HOLD", fraction: number, reason: string }
export function partialTp(p) {
  if (typeof p.pnlPct !== "number") return { action: "HOLD", fraction: 0, reason: "no PnL" };
  if (p.pnlPct >= 10 && !p.tp2Hit) {
    return { action: "PARTIAL_CLOSE", fraction: 0.25, reason: "TP2 +10% — close 25% more" };
  }
  if (p.pnlPct >= 5 && !p.tp1Hit) {
    return { action: "PARTIAL_CLOSE", fraction: 0.5, reason: "TP1 +5% — close 50%" };
  }
  return { action: "HOLD", fraction: 0, reason: "below TP1" };
}
