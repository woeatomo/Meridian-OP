// Meridian-OP entry filter: refuse to buy into a token that is falling right now.
//
// Single-sided SOL below the price means we BUY the token as it falls. Entering while the
// price is already sliding (1h ≤ −entryMaxDrop1hPct) or while 5m candles show a dump is the
// fastest way to an Emergency / Stop loss. Pure logic + a thin async wrapper over the pool
// OHLCV fetch already used by the dump detector. Fail-open on missing candle data.

import { config } from "../config.js";
import { fetchPoolCandles, redCandleSignal } from "./dump-detector.js";

const pct = (from, to) => (from > 0 && Number.isFinite(to) ? Math.round(((to - from) / from) * 10000) / 100 : null);

/**
 * Price change over the last `minutes` from 5m candles (old → new). Pure.
 * Uses the open of the first candle inside the window and the latest close.
 */
export function priceChangeFromCandles(candles, minutes, candleMin = 5) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const n = Math.max(1, Math.round(minutes / candleMin));
  const window = candles.slice(-n);
  if (window.length < Math.min(n, 2)) return null;
  return pct(Number(window[0].open), Number(window[window.length - 1].close));
}

/**
 * Decide whether an entry is allowed. Pure.
 * Returns { block: boolean, reason: string|null, price_change_1h_pct, price_change_15m_pct, red_candles }.
 */
export function assessEntry(candles, cfg = {}) {
  const out = { block: false, reason: null, price_change_1h_pct: null, price_change_15m_pct: null, red_candles: false };
  if (cfg.entryFilterEnabled === false) return out;
  if (!Array.isArray(candles) || candles.length < 4) return out; // fail-open: no data
  out.price_change_1h_pct = priceChangeFromCandles(candles, 60);
  out.price_change_15m_pct = priceChangeFromCandles(candles, 15);
  out.red_candles = redCandleSignal(candles, { count: cfg.dumpRedCandles ?? 3, volumeMult: cfg.dumpVolumeMult ?? 2 });

  const maxDrop1h = Number(cfg.entryMaxDrop1hPct ?? 10);
  if (maxDrop1h > 0 && out.price_change_1h_pct != null && out.price_change_1h_pct <= -maxDrop1h) {
    out.block = true;
    out.reason = `price ${out.price_change_1h_pct}% in 1h (limit −${maxDrop1h}%)`;
    return out;
  }
  if (cfg.entryBlockOnDump !== false) {
    const drop15 = Number(cfg.dumpPriceDropPct ?? 5);
    const fast = out.price_change_15m_pct != null && out.price_change_15m_pct <= -drop15;
    if (fast && out.red_candles) {
      out.block = true;
      out.reason = `dump in progress: ${out.price_change_15m_pct}% in 15m + heavy red candles`;
    } else if (fast && out.price_change_15m_pct <= -2 * drop15) {
      out.block = true;
      out.reason = `dump in progress: ${out.price_change_15m_pct}% in 15m`;
    }
  }
  return out;
}

/** Async wrapper: fetch 5m candles for the pool and assess. Never throws (fail-open). */
export async function checkEntry(pool, { getCandles = fetchPoolCandles, cfg = config.management } = {}) {
  if (!pool || cfg.entryFilterEnabled === false) return { block: false, reason: null };
  try {
    const candles = await getCandles(pool);
    return assessEntry(candles, cfg);
  } catch {
    return { block: false, reason: null };
  }
}
