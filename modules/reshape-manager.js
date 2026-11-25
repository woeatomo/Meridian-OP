// reshape-manager.js — Meridian-OP. Reshape satu arah ke bawah (Spot -> Bid-Ask).
//
// Aturan Atomo (BOT_BARU_SPEC.md §A):
//   - Reshape HANYA saat harga turun (per `reshapeBins` bin), TIDAK saat rebound.
//   - Turun pelan -> reshape. Dump cepat -> JANGAN reshape (exit-rules Emergency SL / SL).
//   - Guard: konfirmasi + hysteresis, cooldown, maks N per posisi, syarat ekonomi.
//   - OOR kiri tetap ketat (exit rules), jadi reshape hanya saat posisi masih in range.
//
// Eksekusi (tools/dlmm.js#reshapePosition): tarik semua likuiditas TANPA swap, lalu buka
// posisi baru di sekitar active bin sekarang:
//   - token (X) dipasang bid-ask DI ATAS harga, sampai bin atas awal (anchor) -> menjual
//     lebih banyak token di harga rebound yang lebih tinggi;
//   - SOL (Y) dipasang bid-ask DI BAWAH harga -> DCA, beli lebih banyak di harga lebih rendah.
// PnL posisi baru dirantai dengan PnL sebelumnya (lineage) sehingga SL tetap dihitung
// dari modal awal.

/**
 * Keputusan reshape. Pure.
 * p: {
 *   enabled, inRange, oorSide, activeBin, anchorBin, lowBin10m, binsDown10m,
 *   dumpConfirmed, pnlPct, pnlSuspicious, reshapesDone, minutesSinceLastReshape,
 *   feesSinceReshapeUsd, historyMin, hasExitSignal
 * }
 * cfg: config.management
 * Return { action: "RESHAPE" | "HOLD", reason, binsDown }
 */
export function decideReshape(p, cfg = {}) {
  const step = Number(cfg.reshapeBins ?? 5);
  const maxReshapes = Number(cfg.reshapeMaxPerPosition ?? 3);
  const cooldownMin = Number(cfg.reshapeCooldownMinutes ?? 45);
  const fastDrop = Number(cfg.dumpBinDrop ?? 8);
  const reboundTol = Number(cfg.reshapeReboundToleranceBins ?? 2);
  const minPnl = Number(cfg.reshapeMinPnlPct ?? -12);
  const costUsd = reshapeCostUsd(cfg);
  const costMult = Number(cfg.reshapeFeeCostMultiple ?? 2);
  const minHistory = Number(cfg.reshapeMinHistoryMin ?? 8);
  const hold = reason => ({ action: "HOLD", reason, binsDown });

  const binsDown = (p.anchorBin != null && p.activeBin != null) ? p.anchorBin - p.activeBin : null;

  if (!p.enabled) return hold("reshape disabled");
  if (p.hasExitSignal) return hold("exit signal pending — exits take priority");
  if (p.dumpConfirmed === true) return hold("dump confirmed — no reshape, exit rules decide");
  if (p.pnlSuspicious) return hold("PnL unpriceable this tick");
  if (p.inRange === false || p.oorSide) return hold(`out of range (${p.oorSide ?? "unknown"}) — exit rules, not reshape`);
  if (binsDown == null) return hold("bin data unavailable");
  if ((p.reshapesDone ?? 0) >= maxReshapes) return hold(`max reshapes per position reached (${maxReshapes})`);
  if (p.minutesSinceLastReshape != null && p.minutesSinceLastReshape < cooldownMin) {
    return hold(`reshape cooldown (${cooldownMin}m) not elapsed`);
  }
  if (binsDown < step) return hold(`down ${binsDown} < ${step} bins — no reshape yet`);
  // Fast-drop / rebound guards read the 10m tick history. Without enough of it (fresh
  // position, restart gap) they are blind — fail closed instead of reshaping into a dump.
  if (minHistory > 0 && !(Number(p.historyMin) >= minHistory)) {
    return hold(`movement history ${Number(p.historyMin) || 0}m < ${minHistory}m — warming up, dump/rebound guards not reliable yet`);
  }
  if ((p.binsDown10m ?? 0) >= fastDrop) return hold(`fast drop (${p.binsDown10m} bins / 10m) — treat as dump, no reshape`);
  if (p.lowBin10m != null && p.activeBin > p.lowBin10m + reboundTol) {
    return hold(`rebounding (${p.activeBin - p.lowBin10m} bins above 10m low) — no reshape on bounce`);
  }
  if (p.pnlPct != null && p.pnlPct <= minPnl) return hold(`PnL ${p.pnlPct}% <= ${minPnl}% — too close to stop loss, let SL decide`);
  const fees = Number(p.feesSinceReshapeUsd ?? p.feesEarnedUsd ?? 0) || 0;
  if (costUsd > 0 && fees < costMult * costUsd) {
    return hold(`fees since last reshape $${fees.toFixed(2)} < ${costMult}x reshape cost $${costUsd} — not economical`);
  }
  return { action: "RESHAPE", reason: `down ${binsDown} bins slowly (${p.binsDown10m ?? 0}/10m), economical — reshape to bid-ask, re-centre down`, binsDown };
}

/**
 * Estimated cost of one reshape in USD. An explicit `reshapeCostUsd` wins; otherwise it depends
 * on the mode: token_only is a few txs in the same position (no rent), full opens a new position
 * (position rent is mostly refunded, but more txs + bin-array risk).
 */
export function reshapeCostUsd(cfg = {}) {
  if (cfg.reshapeCostUsd != null && Number.isFinite(Number(cfg.reshapeCostUsd))) return Number(cfg.reshapeCostUsd);
  return (cfg.reshapeMode ?? "token_only") === "full" ? 0.25 : 0.08;
}

// Hysteresis: kondisi RESHAPE harus bertahan `reshapeConfirmMinutes` berturut-turut.
const pendingSince = new Map(); // position -> ts pertama kali kondisi RESHAPE terlihat

export function confirmReshape(position, wantsReshape, cfg = {}, now = Date.now()) {
  if (!wantsReshape) { pendingSince.delete(position); return false; }
  const first = pendingSince.get(position);
  if (first == null) { pendingSince.set(position, now); return (cfg.reshapeConfirmMinutes ?? 2) <= 0; }
  if (now - first >= (cfg.reshapeConfirmMinutes ?? 2) * 60_000) { pendingSince.delete(position); return true; }
  return false;
}

export function clearReshapePending(position) {
  pendingSince.delete(position);
}

/**
 * Rencana range posisi baru. Pure.
 * - Token (X) di [active+1 .. anchorTop] (min `reshapeBins`, maks `reshapeMaxBinsAbove`).
 * - SOL (Y) di [active - binsBelow .. active].
 */
export function planReshapeRange({ activeBin, anchorTop, binsBelow, hasX, hasY, cfg = {} }) {
  const minAbove = Math.max(1, Number(cfg.reshapeBins ?? 5));
  const maxAbove = Math.max(minAbove, Number(cfg.reshapeMaxBinsAbove ?? 69));
  const below = hasY ? Math.max(0, Math.round(Number(binsBelow) || 0)) : 0;
  const above = hasX ? Math.min(maxAbove, Math.max(minAbove, Math.round(Number(anchorTop) - activeBin))) : 0;
  return {
    minBinId: activeBin - below,
    maxBinId: activeBin + above,
    bins_below: below,
    bins_above: above,
    total_bins: below + above + 1,
  };
}

/** Faktor PnL lineage baru setelah reshape. Pure. pnlPct sudah berantai (dari annotate). */
export function nextPnlFactor(prevFactor, chainedPnlPct) {
  if (chainedPnlPct == null || !Number.isFinite(Number(chainedPnlPct))) return Number(prevFactor) > 0 ? Number(prevFactor) : 1;
  return Math.max(0.01, 1 + Number(chainedPnlPct) / 100);
}

/** Bangun input decideReshape dari posisi teranotasi + tracked state. Pure. */
export function reshapeInputFromPosition(p, tracked, cfg = {}, { hasExitSignal = false, now = Date.now() } = {}) {
  const lineage = tracked?.lineage ?? null;
  const anchorBin = lineage?.last_reshape_bin ?? tracked?.active_bin_at_deploy ?? tracked?.bin_range?.max ?? null;
  const lastAt = lineage?.last_reshape_at ? new Date(lineage.last_reshape_at).getTime() : null;
  // Lifetime fees of this position = claimed + unclaimed. The economics gate only counts what was
  // earned since the last reshape, otherwise every reshape after the first passes for free.
  const feesTotal = (Number(p.collected_fees_true_usd ?? 0) || 0) + (Number(p.unclaimed_fees_true_usd ?? 0) || 0);
  const feesAtReshape = Number(lineage?.fees_usd_at_reshape ?? 0) || 0;
  return {
    enabled: cfg.reshapeEnabled === true,
    inRange: p.in_range,
    oorSide: p.oor_side ?? null,
    activeBin: p.active_bin,
    anchorBin,
    lowBin10m: p.low_bin_10m ?? null,
    binsDown10m: p.bins_down_10m ?? 0,
    dumpConfirmed: p.dump_confirmed === true,
    pnlPct: p.pnl_pct,
    pnlSuspicious: !!p.pnl_pct_suspicious,
    reshapesDone: lineage?.reshape_count ?? 0,
    minutesSinceLastReshape: lastAt ? (now - lastAt) / 60_000 : null,
    feesTotalUsd: feesTotal,
    feesSinceReshapeUsd: Math.max(0, feesTotal - feesAtReshape),
    historyMin: p.move_history_min ?? null,
    hasExitSignal,
  };
}
