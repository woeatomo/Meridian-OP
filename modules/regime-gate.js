// regime-gate.js — P0 B1. Lokasi yang disarankan: repo root / standalone/
// Pure function: tanpa LLM, tanpa I/O. Dipanggil SEBELUM deploy baru.
// Input: { btcEma50, btcEma200, btcClose, solEma50, solEma200, solClose,
//          solChange24hPct, btcChange1hPct, btcRegimeYesterday }
//   btcRegimeYesterday: "Bull" | "Bear" | "Sideways" (lagged, seperti Bot Trend).
// Output: { allow: boolean, reason: string }
export function regimeGate(m) {
  if (!m || typeof m.solClose !== "number" || typeof m.btcClose !== "number") {
    return { allow: false, reason: "regime data incomplete — refuse deploy" };
  }
  if (m.btcRegimeYesterday === "Bear" && m.solClose < m.solEma200) {
    return { allow: false, reason: "BTC Bear (kemarin) + SOL di bawah EMA200" };
  }
  if (typeof m.solChange24hPct === "number" && m.solChange24hPct <= -10) {
    return { allow: false, reason: "SOL -10% dalam 24 jam" };
  }
  if (typeof m.btcChange1hPct === "number" && m.btcChange1hPct <= -5) {
    return { allow: false, reason: "BTC -5% dalam 1 jam" };
  }
  if (m.solClose < m.solEma200 && m.solEma50 < m.solEma200) {
    return { allow: false, reason: "SOL downtrend (di bawah EMA200, EMA50 < EMA200)" };
  }
  return { allow: true, reason: "regime OK" };
}
