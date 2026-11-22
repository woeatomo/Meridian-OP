// reshape-runner.js — Meridian-OP. Orkestrasi reshape dari poller (standalone & legacy).
// Keputusan murni ada di reshape-manager.js; di sini hanya: baca state, hysteresis,
// eksekusi lewat executor (wallet lock + safety check), dan log transisi.

import { config } from "../config.js";
import { log } from "../logger.js";
import { getTrackedPosition } from "../state.js";
import { decideReshape, confirmReshape, clearReshapePending, reshapeInputFromPosition } from "./reshape-manager.js";

const lastReason = new Map(); // position -> alasan terakhir (log hanya bila berubah)
const inflight = new Set();
const dryRunAt = new Map(); // DRY_RUN or failed attempt: lineage unchanged, so back off for the cooldown

/**
 * Evaluasi + eksekusi reshape untuk satu posisi teranotasi (output getMyPositions).
 * Return hasil executeTool bila reshape dijalankan, null bila tidak.
 */
export async function maybeReshape(p, { hasExitSignal = false, executeTool, now = Date.now() } = {}) {
  const cfg = config.management;
  if (cfg.reshapeEnabled !== true || !p?.position || inflight.has(p.position)) return null;
  const tracked = getTrackedPosition(p.position);
  if (!tracked || tracked.closed) return null;
  const lastDry = dryRunAt.get(p.position);
  if (lastDry && now - lastDry < (cfg.reshapeCooldownMinutes ?? 45) * 60_000) return null;

  const decision = decideReshape(reshapeInputFromPosition(p, tracked, cfg, { hasExitSignal, now }), cfg);
  const wants = decision.action === "RESHAPE";
  if (lastReason.get(p.position) !== decision.reason && (wants || (decision.binsDown ?? 0) >= (cfg.reshapeBins ?? 5))) {
    log("reshape", `${p.pair ?? p.position.slice(0, 8)}: ${decision.action} — ${decision.reason}`);
  }
  lastReason.set(p.position, decision.reason);
  if (!confirmReshape(p.position, wants, cfg, now)) return null;

  inflight.add(p.position);
  try {
    log("reshape", `${p.pair ?? p.position.slice(0, 8)}: reshape confirmed (${cfg.reshapeConfirmMinutes ?? 2}m) — executing`);
    const res = await executeTool("reshape_position", { position_address: p.position, reason: decision.reason })
      .catch((e) => ({ success: false, error: e.message }));
    const ok = res?.success === true || res?.dry_run === true;
    if (res?.dry_run || !ok) dryRunAt.set(p.position, now);
    log(ok ? "reshape" : "reshape_error", `${p.pair ?? p.position.slice(0, 8)}: ${ok ? (res.dry_run ? "DRY RUN reshape planned" : `reshaped → ${res.new_position}`) : `reshape FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    return res;
  } finally {
    clearReshapePending(p.position);
    lastReason.delete(p.position);
    inflight.delete(p.position);
  }
}
