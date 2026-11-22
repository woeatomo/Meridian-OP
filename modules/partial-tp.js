// partial-tp.js — Meridian-OP P0 B5. Partial take profit (pure).
//
// Ganti TP all-or-nothing (+5% tutup semua) dengan bertahap:
//   TP1 PnL >= partialTp1Pct (+5%)  -> tarik partialTp1Fraction (50%) dari ukuran AWAL
//   TP2 PnL >= partialTp2Pct (+10%) -> tarik partialTp2Fraction (25%) lagi dari ukuran awal
//   sisa (25%) jalan terus: trailing TP / SL / TP final (`partialTpFinalPct`) yang menutupnya.
// Fraksi dihitung terhadap ukuran awal, lalu dikonversi ke bps dari SISA likuiditas
// (removeLiquidity bekerja relatif ke likuiditas yang tersisa).
//
// Input p: { pnlPct, pnlSuspicious, state: { tp1_done, tp2_done, withdrawn_fraction } }
// Output: { action: "PARTIAL_CLOSE" | "HOLD", stage, fraction, bps, reason }
export function partialTp(p, cfg = {}) {
  const hold = (reason) => ({ action: "HOLD", stage: null, fraction: 0, bps: 0, reason });
  if (cfg.partialTpEnabled !== true) return hold("partial TP disabled");
  if (p?.pnlSuspicious || typeof p?.pnlPct !== "number" || !Number.isFinite(p.pnlPct)) return hold("no PnL");
  const st = p.state || {};
  const t1 = Number(cfg.partialTp1Pct ?? 5), f1 = Number(cfg.partialTp1Fraction ?? 0.5);
  const t2 = Number(cfg.partialTp2Pct ?? 10), f2 = Number(cfg.partialTp2Fraction ?? 0.25);
  const withdrawn = Math.min(0.99, Math.max(0, Number(st.withdrawn_fraction ?? 0)));
  const remaining = 1 - withdrawn;

  let stage = null, fraction = 0;
  const due1 = !st.tp1_done && p.pnlPct >= t1;
  const due2 = !st.tp2_done && p.pnlPct >= t2;
  if (due1 && due2) { stage = "tp1+tp2"; fraction = f1 + f2; }       // gap through both levels: one withdrawal
  else if (due1) { stage = "tp1"; fraction = f1; }
  else if (due2 && st.tp1_done) { stage = "tp2"; fraction = f2; }
  if (!stage) return hold(st.tp1_done ? (st.tp2_done ? "TP1 + TP2 done — remainder on trailing" : `below TP2 (${t2}%)`) : `below TP1 (${t1}%)`);

  fraction = Math.min(fraction, remaining - 0.05); // always leave a runner of >= 5% of original
  if (fraction <= 0) return hold("nothing left to take");
  const bps = Math.max(1, Math.min(9900, Math.round((fraction / remaining) * 10_000)));
  return {
    action: "PARTIAL_CLOSE",
    stage,
    fraction: Math.round(fraction * 10_000) / 10_000,
    bps,
    reason: `${stage.toUpperCase()} at PnL ${p.pnlPct}% — withdraw ${Math.round(fraction * 100)}% of original size (${bps / 100}% of remaining)`,
  };
}
