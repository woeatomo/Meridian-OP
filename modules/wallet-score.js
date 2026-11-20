// wallet-score.js — P0 B2 + P0 B7 (interface).
// Lokasi yang disarankan: repo root / standalone/
// Skor wallet 0-100 dari metrik 30 hari. Wallet lolos bila skor >= 70
// DAN semua cek keras lolos (sama seperti checklist Bot Strategy 5).
// Input: { pnl30dUsd, winRatePct, activeDays30, maxDrawdownPct, profitFactor,
//          walletAgeDays, trades30 }
// Output: { score: number, pass: boolean, fails: string[] }
export function scoreWallet(w) {
  const fails = [];
  if (!w) return { score: 0, pass: false, fails: ["no wallet data"] };
  if (!(w.pnl30dUsd > 0)) fails.push("PnL 30 hari tidak positif");
  if (!(w.winRatePct >= 40)) fails.push("win rate < 40%");
  if (!(w.activeDays30 >= 5)) fails.push("hari aktif < 5 dalam 30 hari");
  if (!(w.maxDrawdownPct >= -30)) fails.push("max drawdown lebih dalam dari -30%");
  if (!(w.profitFactor >= 1.2)) fails.push("profit factor < 1,2");
  if (!(w.walletAgeDays >= 30)) fails.push("wallet berumur < 30 hari");
  let score = 0;
  score += Math.min(30, Math.max(0, (w.pnl30dUsd / 1000) * 5));
  score += Math.min(20, (w.winRatePct / 100) * 20);
  score += Math.min(15, (w.activeDays30 / 30) * 15);
  score += Math.min(15, Math.max(0, 15 + (w.maxDrawdownPct / 2)));
  score += Math.min(20, Math.max(0, (w.profitFactor - 1) * 20));
  score = Math.round(Math.min(100, Math.max(0, score)));
  const pass = fails.length === 0 && score >= 70;
  return { score, pass, fails };
}

// P0 B7 — interface Smart Wallet Exit Watch (wiring ke monitor belum).
// Panggil tiap cycle manager dengan posisi wallet pemicu saat ini.
// Bila >=2 wallet pemicu menjual/keluar >50% dalam 30 mnt -> exitSignal true.
export function walletExited(triggerWallets) {
  if (!Array.isArray(triggerWallets)) return { exitSignal: false, reason: "no data" };
  const exited = triggerWallets.filter((t) => t?.soldPct30m >= 50);
  if (exited.length >= 2) {
    return { exitSignal: true, reason: `${exited.length} trigger wallets exited >50% in 30m` };
  }
  return { exitSignal: false, reason: "trigger wallets still holding" };
}
