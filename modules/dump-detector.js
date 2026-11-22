// dump-detector.js — Meridian-OP. Deteksi "dump terkonfirmasi" per posisi.
//
// Spec (BOT_BARU_SPEC.md §A): dump terkonfirmasi bila minimal 2 dari 3 sinyal:
//   A. harga turun >= dumpPriceDropPct (default 5%) dalam dumpPriceWindowMin (15 mnt)
//   B. active bin turun >= dumpBinDrop (default 8 bin) dalam dumpBinWindowMin (10 mnt)
//   C. dumpRedCandles (3) candle 5m merah berturut-turut + volume > dumpVolumeMult (2x) rata-rata
//
// A dan B dihitung dari riwayat tick posisi (active bin + PnL) yang direkam oleh
// getMyPositions — tanpa I/O. C butuh OHLCV pool (I/O), jadi hanya diambil bila
// tepat satu dari A/B aktif (A+B saja sudah cukup; nol sinyal tidak perlu C).
// Gagal fetch OHLCV = C dianggap tidak aktif (konservatif: butuh A+B).
//
// Riwayat juga dipakai reshape-manager: kecepatan turun (bin / 10 mnt) dan
// "low" 10 menit terakhir untuk mencegah reshape saat harga sedang rebound.

import fs from "node:fs";

const SAMPLE_EVERY_MS = 10_000;      // simpan maks 1 sampel / 10 detik per posisi
const KEEP_MS = 45 * 60_000;         // simpan 45 menit riwayat
const history = new Map();           // position -> [{ ts, bin, pnl }]

// ─── Persistence (Meridian-OP): survive restarts ───────────────────────────
// Enabled only by the runtimes (enableHistoryPersistence) so tests never touch disk.
// Saved at most every SAVE_EVERY_MS, atomically (tmp + rename); samples older than
// KEEP_MS are dropped on load, so a long downtime simply starts fresh.
const SAVE_EVERY_MS = 30_000;
let persistFile = null;
let lastSavedAt = 0;
let dirty = false;

export function enableHistoryPersistence(file, now = Date.now()) {
  persistFile = file;
  try {
    if (!fs.existsSync(file)) return 0;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    let n = 0;
    for (const [position, list] of Object.entries(raw?.history || {})) {
      if (!Array.isArray(list)) continue;
      const kept = list
        .filter((s) => Number.isFinite(s?.ts) && Number.isFinite(s?.bin) && now - s.ts <= KEEP_MS && s.ts <= now)
        .map((s) => ({ ts: s.ts, bin: s.bin, pnl: Number.isFinite(s.pnl) ? s.pnl : null, ...(Number.isFinite(s.maxBin) ? { maxBin: s.maxBin } : {}) }));
      if (kept.length) { history.set(position, kept); n += kept.length; }
    }
    return n;
  } catch {
    return 0; // corrupt file: start fresh, it is only a cache
  }
}

export function flushHistory(now = Date.now(), force = false) {
  if (!persistFile || (!dirty && !force)) return;
  if (!force && now - lastSavedAt < SAVE_EVERY_MS) return;
  try {
    const tmp = `${persistFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ saved_at: now, history: Object.fromEntries(history) }));
    fs.renameSync(tmp, persistFile);
    lastSavedAt = now;
    dirty = false;
  } catch { /* best-effort cache */ }
}

export function recordTick(position, { active_bin, pnl_pct }, now = Date.now()) {
  if (!position || active_bin == null || !Number.isFinite(Number(active_bin))) return;
  const list = history.get(position) ?? [];
  const sample = { ts: now, bin: Number(active_bin), pnl: Number.isFinite(Number(pnl_pct)) ? Number(pnl_pct) : null };
  const last = list[list.length - 1];
  if (last && now - last.ts < SAMPLE_EVERY_MS) {
    // Simpan titik terendah/terbaru dalam slot 10 detik yang sama: update sampel terakhir
    // tapi pertahankan bin maksimum agar puncak lokal tidak hilang.
    list[list.length - 1] = { ts: last.ts, bin: sample.bin, pnl: sample.pnl, maxBin: Math.max(last.maxBin ?? last.bin, sample.bin) };
  } else {
    list.push(sample);
  }
  while (list.length && now - list[0].ts > KEEP_MS) list.shift();
  history.set(position, list);
  dirty = true;
  flushHistory(now);
}

export function forgetPosition(position) {
  history.delete(position);
}

/** Drop history for positions no longer open. */
export function pruneHistory(openPositions) {
  const keep = new Set(openPositions);
  for (const key of history.keys()) if (!keep.has(key)) { history.delete(key); dirty = true; }
}

export function getHistory(position) {
  return history.get(position) ?? [];
}

function windowSamples(list, windowMs, now) {
  return list.filter(s => now - s.ts <= windowMs);
}

/** Price ratio between two bins: (1 + binStep/10000) ^ (toBin - fromBin). */
export function binMovePct(fromBin, toBin, binStep) {
  if (!Number.isFinite(binStep) || binStep <= 0) return null;
  return (Math.pow(1 + binStep / 10_000, toBin - fromBin) - 1) * 100;
}

/**
 * Metrik pergerakan dari riwayat tick. Pure (selain membaca buffer).
 * Return: {
 *   samples, coverage_min,            // berapa menit riwayat tersedia
 *   bins_down_10m,                     // max bin di jendela B - bin sekarang (>= 0)
 *   price_change_15m_pct,              // dari puncak jendela A ke sekarang (<= 0), null bila tak diketahui
 *   low_bin_10m,                       // bin terendah 10 menit terakhir
 * }
 */
export function movementStats(position, { binStep = null, cfg = {}, now = Date.now() } = {}) {
  const list = history.get(position) ?? [];
  if (!list.length) return { samples: 0, coverage_min: 0, bins_down_10m: 0, price_change_15m_pct: null, low_bin_10m: null, current_bin: null };
  const cur = list[list.length - 1];
  const binWin = windowSamples(list, (cfg.dumpBinWindowMin ?? 10) * 60_000, now);
  const priceWin = windowSamples(list, (cfg.dumpPriceWindowMin ?? 15) * 60_000, now);
  const maxBin = arr => Math.max(...arr.map(s => s.maxBin ?? s.bin));
  const binsDown = binWin.length ? Math.max(0, maxBin(binWin) - cur.bin) : 0;
  let priceChange = null;
  if (priceWin.length) {
    const fromBin = maxBin(priceWin);
    priceChange = binMovePct(fromBin, cur.bin, Number(binStep));
    if (priceChange == null) {
      // Bin step tidak diketahui: pakai perubahan PnL sebagai proxy (posisi SOL-side
      // yang sudah berisi token bergerak searah harga, tapi lebih lambat — konservatif).
      const pnls = priceWin.map(s => s.pnl).filter(v => v != null);
      if (pnls.length && cur.pnl != null) priceChange = Math.min(0, cur.pnl - Math.max(...pnls));
    }
  }
  return {
    samples: list.length,
    coverage_min: (now - list[0].ts) / 60_000,
    bins_down_10m: binsDown,
    price_change_15m_pct: priceChange == null ? null : Math.round(priceChange * 100) / 100,
    low_bin_10m: binWin.length ? Math.min(...binWin.map(s => s.bin)) : cur.bin,
    current_bin: cur.bin,
  };
}

/**
 * Sinyal C dari candle OHLCV (urut lama -> baru). Pure.
 * Candle terakhir boleh belum close; kita pakai N candle terakhir yang ada.
 */
export function redCandleSignal(candles, { count = 3, volumeMult = 2 } = {}) {
  if (!Array.isArray(candles) || candles.length < count + 1) return false;
  const lastN = candles.slice(-count);
  const allRed = lastN.every(c => Number(c.close) < Number(c.open));
  if (!allRed) return false;
  const prior = candles.slice(0, -count).map(c => Number(c.volume)).filter(v => Number.isFinite(v) && v >= 0);
  if (!prior.length) return false;
  const avgPrior = prior.reduce((a, b) => a + b, 0) / prior.length;
  const avgRecent = lastN.reduce((a, c) => a + (Number(c.volume) || 0), 0) / count;
  return avgPrior > 0 && avgRecent > volumeMult * avgPrior;
}

/** Normalisasi respons OHLCV yang bentuknya belum pasti -> [{open, close, volume, ts}]. */
export function normalizeCandles(raw) {
  const arr = Array.isArray(raw) ? raw
    : Array.isArray(raw?.data) ? raw.data
    : Array.isArray(raw?.candles) ? raw.candles
    : Array.isArray(raw?.ohlcv) ? raw.ohlcv
    : Array.isArray(raw?.data?.items) ? raw.data.items
    : [];
  const out = arr.map(c => Array.isArray(c)
    ? { ts: Number(c[0]), open: Number(c[1]), close: Number(c[4]), volume: Number(c[5]) }
    : {
        ts: Number(c.timestamp ?? c.time ?? c.t ?? c.unixTime ?? 0),
        open: Number(c.open ?? c.o),
        close: Number(c.close ?? c.c),
        volume: Number(c.volume ?? c.v ?? c.volume_usd ?? c.volumeUsd ?? 0),
      })
    .filter(c => Number.isFinite(c.open) && Number.isFinite(c.close));
  return out.sort((a, b) => a.ts - b.ts);
}

const candleCache = new Map(); // pool -> { at, candles }
const CANDLE_TTL_MS = 60_000;

export async function fetchPoolCandles(pool, { fetchImpl = globalThis.fetch, timeframe = "5m" } = {}) {
  const hit = candleCache.get(pool);
  if (hit && Date.now() - hit.at < CANDLE_TTL_MS) return hit.candles;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetchImpl(`https://dlmm.datapi.meteora.ag/pools/${pool}/ohlcv?timeframe=${timeframe}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const candles = normalizeCandles(await res.json());
    candleCache.set(pool, { at: Date.now(), candles });
    return candles;
  } catch {
    candleCache.set(pool, { at: Date.now(), candles: null });
    return null;
  }
}

/**
 * Nilai dump untuk satu posisi. Pure kecuali `getCandles` (opsional, async).
 * Return { dump_confirmed, signals: {price, bins, candles}, count, stats }.
 */
export async function assessDump(position, { pool = null, binStep = null, cfg = {}, now = Date.now(), getCandles = null } = {}) {
  const stats = movementStats(position, { binStep, cfg, now });
  // Butuh riwayat minimal agar satu tick acak tidak dianggap "dump 10 menit".
  const minCoverage = cfg.dumpMinHistoryMin ?? 2;
  const enough = stats.coverage_min >= minCoverage;
  const price = enough && stats.price_change_15m_pct != null && stats.price_change_15m_pct <= -(cfg.dumpPriceDropPct ?? 5);
  const bins = enough && stats.bins_down_10m >= (cfg.dumpBinDrop ?? 8);
  let candles = false;
  if ((price ? 1 : 0) + (bins ? 1 : 0) === 1 && pool && typeof getCandles === "function") {
    const list = await getCandles(pool).catch(() => null);
    candles = redCandleSignal(list, { count: cfg.dumpRedCandles ?? 3, volumeMult: cfg.dumpVolumeMult ?? 2 });
  }
  const count = (price ? 1 : 0) + (bins ? 1 : 0) + (candles ? 1 : 0);
  return {
    dump_confirmed: count >= (cfg.dumpSignalsRequired ?? 2),
    signals: { price, bins, candles },
    count,
    stats,
  };
}
