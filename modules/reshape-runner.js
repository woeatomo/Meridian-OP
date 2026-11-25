// reshape-runner.js — Meridian-OP. Orkestrasi reshape dari poller (standalone & legacy).
// Keputusan murni ada di reshape-manager.js; di sini hanya: baca state, hysteresis,
// eksekusi lewat executor (wallet lock + safety check), dan log transisi.

import { config } from "../config.js";
import { log } from "../logger.js";
import { getTrackedPosition } from "../state.js";
import { decideReshape, confirmReshape, clearReshapePending, reshapeInputFromPosition } from "./reshape-manager.js";
import { fetchPoolCandles } from "./dump-detector.js";
import { priceChangeFromCandles } from "./entry-filter.js";

const lastReason = new Map(); // position -> alasan terakhir (log hanya bila berubah)
const inflight = new Set();
const dryRunAt = new Map(); // DRY_RUN or failed attempt: lineage unchanged, so back off for the cooldown

/**
 * Evaluasi + eksekusi reshape untuk satu posisi teranotasi (output getMyPositions).
 * Return hasil executeTool bila reshape dijalankan, null bila tidak.
 */
export async function maybeReshape(p, { hasExitSignal = false, executeTool, now = Date.now(), getCandles = fetchPoolCandles } = {}) {
  const cfg = config.management;
  if (cfg.reshapeEnabled !== true || !p?.position || inflight.has(p.position)) return null;
  const tracked = getTrackedPosition(p.position);
  if (!tracked || tracked.closed) return null;
  const lastDry = dryRunAt.get(p.position);
  if (lastDry && now - lastDry < (cfg.reshapeCooldownMinutes ?? 45) * 60_000) return null;

  const input = reshapeInputFromPosition(p, tracked, cfg, { hasExitSignal, now });
  let decision = decideReshape(input, cfg);
  // Trend gate needs candles: fetch only when everything else already says RESHAPE (cached 60s).
  if (decision.action === "RESHAPE" && Number(cfg.reshapeMax1hDropPct ?? 8) > 0 && p.pool) {
    const candles = await getCandles(p.pool).catch(() => null);
    input.priceChange1hPct = priceChangeFromCandles(candles, 60);
    decision = decideReshape(input, cfg);
  }
  const wants = decision.action === "RESHAPE";
  // Log on a change of KIND of reason, not every time a number in it moves (fees tick up every poll).
  const reasonKind = `${decision.action}:${decision.reason.replace(/[-+$]?\d[\d.,]*%?/g, "#")}`;
  if (lastReason.get(p.position) !== reasonKind && (wants || (decision.binsDown ?? 0) >= (cfg.reshapeBins ?? 5))) {
    log("reshape", `${p.pair ?? p.position.slice(0, 8)}: ${decision.action} — ${decision.reason}`);
  }
  lastReason.set(p.position, reasonKind);
  if (!confirmReshape(p.position, wants, cfg, now)) return null;

  inflight.add(p.position);
  try {
    log("reshape", `${p.pair ?? p.position.slice(0, 8)}: reshape confirmed (${cfg.reshapeConfirmMinutes ?? 2}m) — executing`);
    const res = await executeTool("reshape_position", { position_address: p.position, reason: decision.reason })
      .catch((e) => ({ success: false, error: e.message }));
    const ok = res?.success === true || res?.dry_run === true;
    if (res?.dry_run || !ok) dryRunAt.set(p.position, now);
    log(ok ? "reshape" : "reshape_error", `${p.pair ?? p.position.slice(0, 8)}: ${ok ? (res.dry_run ? "DRY RUN reshape planned" : res.in_place ? "token re-shaped in place" : `reshaped → ${res.new_position}`) : `reshape FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    return res;
  } finally {
    clearReshapePending(p.position);
    lastReason.delete(p.position);
    inflight.delete(p.position);
  }
}
