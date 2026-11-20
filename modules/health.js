// health.js — P1 C5. Interface failover RPC + event alert (bukan sender Telegram baru).
// Lokasi yang disarankan: repo root / standalone/
// Input: { rpcDownSeconds, primaryRpc, fallbackRpc }
// Output: { mode: "NORMAL" | "SAFE" | "FAILOVER", alert: string | null }
export function healthCheck(h) {
  if ((h.rpcDownSeconds ?? 0) > 60) {
    return { mode: "SAFE", alert: "RPC down >60s — safe mode: no deploy, monitor only" };
  }
  if (h.primaryRpc === false && h.fallbackRpc === true) {
    return { mode: "FAILOVER", alert: "primary RPC down — using fallback RPC" };
  }
  return { mode: "NORMAL", alert: null };
}

// Event yang boleh kirim alert Telegram (bukan tiap cycle): deploy, reshape,
// Emergency SL, kill switch, RPC down, ringkasan harian.
export const ALERT_EVENTS = ["DEPLOY", "RESHAPE", "EMERGENCY_SL", "KILL_SWITCH", "RPC_DOWN", "DAILY_SUMMARY"];
