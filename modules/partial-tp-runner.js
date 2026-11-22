// partial-tp-runner.js — Meridian-OP. Turns the pure partialTp() decision into a poller
// signal. The pollers feed it through registerExitSignal (same N-tick confirmation as
// exits), then execute `partial_close_position` with these args.

import { config } from "../config.js";
import { getTrackedPosition } from "../state.js";
import { partialTp } from "./partial-tp.js";

const failedAt = new Map(); // position -> ts of last failed attempt (5 min backoff)
const BACKOFF_MS = 5 * 60_000;

export function markPartialAttempt(position, ok, now = Date.now()) {
  if (ok) failedAt.delete(position); else failedAt.set(position, now);
}

/** Return { signal, reason, args } for a due partial TP, or null. */
export function partialTpSignal(p, now = Date.now()) {
  const cfg = config.management;
  if (cfg.partialTpEnabled !== true || !p?.position) return null;
  const failed = failedAt.get(p.position);
  if (failed && now - failed < BACKOFF_MS) return null;
  const tracked = getTrackedPosition(p.position);
  if (!tracked || tracked.closed) return null;
  const d = partialTp({ pnlPct: p.pnl_pct, pnlSuspicious: !!p.pnl_pct_suspicious, state: tracked.partial_tp }, cfg);
  if (d.action !== "PARTIAL_CLOSE") return null;
  return {
    signal: `PARTIAL_${d.stage.toUpperCase()}`,
    reason: d.reason,
    args: { position_address: p.position, bps: d.bps, fraction: d.fraction, stage: d.stage, reason: d.reason },
  };
}
