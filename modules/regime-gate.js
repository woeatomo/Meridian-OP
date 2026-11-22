// regime-gate.js — P0 B1 (Meridian-OP). Pure function: tanpa LLM, tanpa I/O.
// Dipanggil SEBELUM deploy baru (bukan di screening): tidak mengubah filter pool,
// hanya saklar "boleh buka posisi baru sekarang?" berdasarkan kondisi market.
//
// Hanya syarat AKUT secara default (jarang terjadi, durasi pendek):
//   - SOL turun <= regimeSol24hDropPct (default -10%) dalam 24 jam
//   - BTC turun <= regimeBtc1hDropPct (default -5%) dalam 1 jam
// Syarat tren (SOL di bawah EMA200 dst.) bisa bertahan berminggu-minggu dan
// membuat bot praktis tidak deploy — hanya aktif bila regimeUseTrendRule=true.
//
// Data tidak lengkap -> allow (fail-open): gate ini tambahan, bukan pengaman utama.
// Input m: { solChange24hPct, btcChange1hPct, solClose?, solEma50?, solEma200? }
// Output: { allow, reasons: string[], reason, complete }
export function regimeGate(m, cfg = {}) {
  const solLimit = Number(cfg.regimeSol24hDropPct ?? -10);
  const btcLimit = Number(cfg.regimeBtc1hDropPct ?? -5);
  const reasons = [];
  const sol = Number(m?.solChange24hPct);
  const btc = Number(m?.btcChange1hPct);
  const hasSol = m?.solChange24hPct != null && Number.isFinite(sol);
  const hasBtc = m?.btcChange1hPct != null && Number.isFinite(btc);
  if (hasSol && sol <= solLimit) reasons.push(`SOL ${sol.toFixed(2)}% in 24h (<= ${solLimit}%)`);
  if (hasBtc && btc <= btcLimit) reasons.push(`BTC ${btc.toFixed(2)}% in 1h (<= ${btcLimit}%)`);
  if (cfg.regimeUseTrendRule === true && [m?.solClose, m?.solEma50, m?.solEma200].every((v) => Number.isFinite(Number(v)))) {
    if (m.solClose < m.solEma200 && m.solEma50 < m.solEma200) reasons.push("SOL downtrend (below EMA200, EMA50 < EMA200)");
  }
  const complete = hasSol && hasBtc;
  return {
    allow: reasons.length === 0,
    reasons,
    reason: reasons.length ? reasons.join("; ") : complete ? "regime OK" : "regime data incomplete — allowing (fail-open)",
    complete,
  };
}
