// portfolio-runner.js — Meridian-OP P0 B3: Daily Loss Limit + Kill Switch.
//
// Ekuitas = saldo wallet (SOL + token yang punya harga) + nilai semua posisi terbuka.
// Default diukur dalam SOL (`portfolioGuardUnit: "sol"`), karena bot ini LP sisi SOL:
// harga SOL turun di pasar bukan kerugian strategi, jadi tidak boleh memicu kill switch.
//
//   - Rugi harian <= dailyLossLimitPct (default -5%) dari ekuitas awal hari
//     -> stop deploy baru sampai hari berikutnya. Posisi yang ada tetap dikelola.
//   - Drawdown <= portfolioKillSwitchPct (default -10%) dari peak
//     -> KILL SWITCH: tutup semua posisi, pause entry `killSwitchPauseHours` (24 jam).
//   - Data ekuitas tidak lengkap -> blok deploy tick itu saja, TIDAK pernah menutup posisi.
//
// Hari dihitung di zona `portfolioDayUtcOffsetHours` (default +7, WIB).
// Deposit / withdraw manual ke wallet akan terbaca sebagai profit / rugi:
// setelah transfer, jalankan `node cli.js guard --reset` (atau /guard reset di Telegram).

import { config } from "../config.js";
import { log } from "../logger.js";
import { getPortfolioState, savePortfolioState, getTrackedPositions } from "../state.js";
import { portfolioGuard } from "./portfolio-guard.js";
import { isRpcSafeMode, rpcConnection } from "./rpc-health.js";
import { PublicKey } from "@solana/web3.js";

const STALE_MS = 15 * 60_000;
let lastEvalAt = 0;
let evaluating = null;
let lastWalletActivityAt = 0;
let lastKillLogAt = 0;
const streaks = { kill: { count: 0, since: 0 }, daily: { count: 0, since: 0 } };

/** "off" | "log" | "enforce" (default "log": never closes or pauses, only logs a would-trip). */
export function killSwitchMode() {
  const m = String(config.management.killSwitchMode ?? "log").toLowerCase();
  return ["off", "log", "enforce"].includes(m) ? m : "log";
}

/** Called by the executor after every wallet-mutating tool (deploy/close/claim/swap/reshape). */
export function markWalletActivity(now = Date.now()) { lastWalletActivityAt = now; }

/** Consecutive-check confirmation. Returns true once `checks` hits AND `minutes` elapsed. */
function confirmStreak(key, active, now, checks = 1, minutes = 0) {
  const s = streaks[key];
  if (!active) { s.count = 0; s.since = 0; return false; }
  if (s.count === 0) s.since = now;
  s.count++;
  return s.count >= Math.max(1, Number(checks)) && now - s.since >= Math.max(0, Number(minutes)) * 60_000;
}

/**
 * Pure. Compare the live (Meteora-indexed) position list with the bot's own tracking.
 * - notIndexed: tracked open, missing from the live list, opened/reshaped within
 *   `portfolioIndexGraceMin` -> its SOL left the wallet but it isn't counted yet.
 * - stale: still listed live but already closed in tracking (funds back in the wallet).
 * Returns { positions (live minus stale), notIndexed, stale }.
 */
export function reconcileWithTracked(livePositions, tracked, now = Date.now(), cfg = {}) {
  const live = Array.isArray(livePositions) ? livePositions : [];
  const all = Array.isArray(tracked) ? tracked : [];
  const liveSet = new Set(live.map((p) => p.position));
  const closedSet = new Set(all.filter((t) => t.closed).map((t) => t.position));
  const graceMs = Math.max(0, Number(cfg.portfolioIndexGraceMin ?? 10)) * 60_000;
  const notIndexed = all.filter((t) => {
    if (t.closed || liveSet.has(t.position)) return false;
    const opened = new Date(t.lineage?.last_reshape_at || t.deployed_at || 0).getTime();
    return Number.isFinite(opened) && now - opened <= graceMs;
  }).map((t) => t.position);
  const stale = live.filter((p) => closedSet.has(p.position)).map((p) => p.position);
  return { positions: live.filter((p) => !closedSet.has(p.position)), notIndexed, stale };
}

/** Test helper. */
export function _resetPortfolioRunner() {
  lastEvalAt = 0; lastWalletActivityAt = 0; lastKillLogAt = 0; evaluating = null;
  for (const s of Object.values(streaks)) { s.count = 0; s.since = 0; }
}

/** Tanggal "hari trading" untuk offset jam tertentu. Pure. */
export function tradingDay(now = Date.now(), offsetHours = 7) {
  return new Date(now + offsetHours * 3600_000).toISOString().slice(0, 10);
}

/**
 * Hitung ekuitas dari saldo wallet (priceBalances) + posisi (getMyPositions). Pure.
 * Token tanpa harga diabaikan (dust / rug), tetapi harga SOL dan nilai posisi wajib ada.
 * Return { equity, unit, wallet_usd, positions_usd, sol_price } atau { error }.
 */
export function computeEquity(balances, positions, unit = "sol", { rentSol = 0 } = {}) {
  if (!balances || balances.error) return { error: "balance read unavailable" };
  const solPrice = Number(balances.sol_price);
  if (!(solPrice > 0) || !Number.isFinite(Number(balances.sol))) return { error: "SOL price unavailable" };
  const walletUsd = Number(balances.sol) * solPrice
    + (balances.tokens || []).reduce((sum, t) => sum + (Number.isFinite(Number(t.usd)) ? Number(t.usd) : 0), 0);
  let positionsUsd = 0;
  for (const p of positions || []) {
    const v = Number(p.total_value_true_usd ?? (config.management.solMode ? NaN : p.total_value_usd));
    if (!Number.isFinite(v)) return { error: `position value unavailable (${String(p.position).slice(0, 8)})` };
    // Unclaimed fees belong to the position's value too.
    positionsUsd += v + (Number(p.unclaimed_fees_true_usd) || 0);
  }
  // Position account rent (~0.057 SOL each) left the wallet at deploy and comes back in full at
  // close — it's a deposit, not a loss. Meteora's position value excludes it, so add it back.
  const rentUsd = Math.max(0, Number(rentSol) || 0) * solPrice;
  const totalUsd = walletUsd + positionsUsd + rentUsd;
  return {
    equity: unit === "usd" ? totalUsd : totalUsd / solPrice,
    unit: unit === "usd" ? "usd" : "sol",
    wallet_usd: walletUsd,
    positions_usd: positionsUsd,
    rent_sol: Math.max(0, Number(rentSol) || 0),
    sol_price: solPrice,
  };
}

/** "realized" (default) | "equity". */
export function dailyLossBasis() {
  const b = String(config.management.dailyLossBasis ?? "realized").toLowerCase();
  return b === "equity" ? "equity" : "realized";
}

/**
 * Pure. Mark-to-market equity minus the unrealized PnL of open positions (Meteora's per-position
 * pnl_true_usd = value + withdrawals + fees − deposits), i.e. open positions counted at what went
 * in. Moves only when positions close (or on gas / swap costs). Missing pnl counts as 0.
 */
export function realizedEquity(eq, positions) {
  const unrealUsd = (positions || []).reduce((s, p) => s + (Number.isFinite(Number(p.pnl_true_usd)) ? Number(p.pnl_true_usd) : 0), 0);
  return eq.unit === "usd" ? eq.equity - unrealUsd : eq.equity - unrealUsd / eq.sol_price;
}

/**
 * Rent locked in the given position accounts, in SOL. One getMultipleAccountsInfo call
 * (≤100 accounts). Falls back to `portfolioPositionRentSol` per position if the read fails.
 */
export async function positionsRentSol(addresses, { connection = null, fallbackPerPosition = 0.0575 } = {}) {
  const list = (addresses || []).filter(Boolean);
  if (!list.length) return 0;
  try {
    const conn = connection || rpcConnection("confirmed");
    let lamports = 0;
    for (let i = 0; i < list.length; i += 100) {
      const infos = await conn.getMultipleAccountsInfo(list.slice(i, i + 100).map((a) => new PublicKey(a)), "confirmed");
      for (const info of infos) lamports += Number(info?.lamports || 0);
    }
    return lamports / 1e9;
  } catch {
    return list.length * fallbackPerPosition;
  }
}

/** Status blokir deploy dari state terakhir (tanpa I/O jaringan). */
export function getDeployBlock(now = Date.now()) {
  const cfg = config.management;
  if (isRpcSafeMode()) return "RPC safe mode — all RPC endpoints down";
  if (cfg.portfolioGuardEnabled === false) return null;
  const st = getPortfolioState();
  if (killSwitchMode() === "enforce" && st.kill_switch_until && now < new Date(st.kill_switch_until).getTime()) {
    return `Kill switch active until ${st.kill_switch_until} (${st.kill_switch_reason || "drawdown"})`;
  }
  if (st.day_blocked && st.day === tradingDay(now, cfg.portfolioDayUtcOffsetHours ?? 7)) {
    return `Daily loss limit hit today (${st.day_blocked_reason || "daily loss"})`;
  }
  return null;
}

export function isPortfolioStateStale(now = Date.now()) {
  const st = getPortfolioState();
  const last = st.last_at ? new Date(st.last_at).getTime() : 0;
  return !last || now - last > STALE_MS;
}

/** Reset baseline (setelah deposit / withdraw manual). Tidak mengubah kill switch aktif kecuali `clearKill`. */
export function resetPortfolioBaseline({ equity, dayStartEquity = equity, basis = dailyLossBasis(), unit = "sol", clearKill = false, now = Date.now() } = {}) {
  const cfg = config.management;
  const patch = {
    day: tradingDay(now, cfg.portfolioDayUtcOffsetHours ?? 7),
    day_start_equity: dayStartEquity ?? null,
    day_start_basis: basis,
    last_daily_equity: dayStartEquity ?? null,
    peak_equity: equity ?? null,
    last_equity: equity ?? null,
    unit,
    day_blocked: false,
    day_blocked_reason: null,
    baseline_reset_at: new Date(now).toISOString(),
  };
  if (clearKill) Object.assign(patch, { kill_switch_until: null, kill_switch_reason: null });
  return savePortfolioState(patch);
}

/**
 * Evaluasi guard. Dipanggil dari siklus manajemen (dan throttled dari poller).
 * deps: { getWalletBalances, positions, executeTool, notify, now, force }
 * - positions: array posisi teranotasi (dari getMyPositions) — wajib.
 * - executeTool: dipakai untuk menutup semua posisi saat kill switch. Tanpa executeTool
 *   (mis. dari safety check deploy) kill switch dicatat dan eksekusinya di siklus berikutnya.
 */
export async function evaluatePortfolio({ positions, getWalletBalances, getPositionRentSol = null, executeTool = null, notify = null, now = Date.now(), minIntervalMs = 0 } = {}) {
  const cfg = config.management;
  if (cfg.portfolioGuardEnabled === false) return { allowDeploy: true, reason: "portfolio guard disabled" };
  if (minIntervalMs > 0 && now - lastEvalAt < minIntervalMs) return null;
  if (evaluating) return evaluating;
  lastEvalAt = now;
  evaluating = (async () => {
    const unit = cfg.portfolioGuardUnit === "usd" ? "usd" : "sol";
    const killMode = killSwitchMode();
    // Right after a deploy/close/reshape the wallet balance and the Meteora position list are
    // briefly out of sync (SOL already left the wallet, the position isn't indexed yet).
    // Don't measure equity at all during that window.
    const settleMs = Math.max(0, Number(cfg.portfolioSettleSec ?? 120)) * 1000;
    if (now - lastWalletActivityAt < settleMs) {
      return { allowDeploy: !getDeployBlock(now), killSwitch: false, settling: true, reason: "settling after a transaction — equity check skipped" };
    }
    const rec = reconcileWithTracked(positions, getTrackedPositions(false), now, cfg);
    if (rec.notIndexed.length) {
      log("portfolio", `Equity check skipped: ${rec.notIndexed.length} tracked position(s) not indexed by Meteora yet`);
      return { allowDeploy: !getDeployBlock(now), killSwitch: false, settling: true, reason: "position(s) not indexed yet — equity check skipped" };
    }
    if (rec.stale.length) log("portfolio", `Ignoring ${rec.stale.length} already-closed position(s) still listed by Meteora`);
    const balances = await getWalletBalances({ force: true }).catch((e) => ({ error: e.message }));
    const rentSol = await (getPositionRentSol || positionsRentSol)(rec.positions.map((p) => p.position), { fallbackPerPosition: Number(cfg.portfolioPositionRentSol ?? 0.0575) });
    const eq = computeEquity(balances, rec.positions, unit, { rentSol });
    let st = getPortfolioState();
    const day = tradingDay(now, cfg.portfolioDayUtcOffsetHours ?? 7);

    if (eq.error) {
      if (process.env.DRY_RUN === "true") {
        // Shadow / dry-run without a readable wallet: don't block proposals on missing equity.
        return { allowDeploy: true, killSwitch: false, reason: `equity unavailable in DRY_RUN (${eq.error}) — not blocking` };
      }
      log("portfolio_warn", `Equity unavailable: ${eq.error} — deploys paused this tick`);
      return { allowDeploy: false, killSwitch: false, reason: `equity unavailable: ${eq.error}` };
    }

    // Daily-loss basis: "realized" (default) ignores open positions' unrealized PnL — their
    // current value is replaced by what went into them, so only closed positions (plus gas /
    // swap costs) move the daily number. "equity" = mark-to-market (open losses count too).
    const basis = dailyLossBasis();
    const dailyEquity = basis === "realized" ? realizedEquity(eq, rec.positions) : eq.equity;

    // Unit changed (config edit) -> old numbers are meaningless: re-baseline.
    if (st.unit && st.unit !== eq.unit) st = resetPortfolioBaseline({ equity: eq.equity, dayStartEquity: dailyEquity, basis, unit: eq.unit, now });

    const patch = { last_equity: eq.equity, last_daily_equity: dailyEquity, last_at: new Date(now).toISOString(), unit: eq.unit, sol_price: eq.sol_price, last_rent_sol: eq.rent_sol };
    // New trading day (or the daily basis changed): new day-start baseline, clear the daily block.
    const basisChanged = (st.day_start_basis ?? "equity") !== basis;
    if (st.day !== day || !(st.day_start_equity > 0) || basisChanged) {
      Object.assign(patch, { day, day_start_equity: dailyEquity, day_start_basis: basis, day_blocked: false, day_blocked_reason: null });
      if (st.day && st.day !== day) log("portfolio", `New trading day ${day}: start ${basis} equity ${dailyEquity.toFixed(4)} ${eq.unit.toUpperCase()}`);
      else if (basisChanged && st.day) log("portfolio", `Daily loss basis → ${basis}: day start re-baselined to ${dailyEquity.toFixed(4)} ${eq.unit.toUpperCase()}`);
    }
    // Kill switch expired: resume with a fresh peak (the drawdown already happened).
    const killUntil = st.kill_switch_until ? new Date(st.kill_switch_until).getTime() : 0;
    if (killUntil && now >= killUntil) {
      Object.assign(patch, { kill_switch_until: null, kill_switch_reason: null, kill_switch_pending_close: false, peak_equity: eq.equity });
      log("portfolio", `Kill switch expired — entries resume, peak reset to ${eq.equity.toFixed(4)} ${eq.unit.toUpperCase()}`);
      notify?.("KILL_SWITCH", `Kill switch expired — entries resume. Equity ${eq.equity.toFixed(4)} ${eq.unit.toUpperCase()}`);
    } else if (!(st.peak_equity > 0) || eq.equity > st.peak_equity) {
      patch.peak_equity = eq.equity;
    }
    st = savePortfolioState(patch);

    const guardInput = {
      dayStartEquity: st.day_start_equity,
      dailyEquity,
      equity: eq.equity,
      peakEquity: st.peak_equity,
      killSwitchUntil: killMode === "enforce" && st.kill_switch_until ? new Date(st.kill_switch_until).getTime() : null,
      now,
    };
    let decision = portfolioGuard(guardInput, cfg);

    // Kill switch: must hold for N consecutive checks spanning >= M minutes (a single bad read
    // never closes everything). Outside "enforce" it only logs what it would have done.
    if (decision.killSwitch) {
      const confirmed = confirmStreak("kill", true, now, cfg.killSwitchConfirmChecks ?? 3, cfg.killSwitchConfirmMinutes ?? 3);
      if (killMode !== "enforce") {
        if (confirmed && killMode === "log" && now - lastKillLogAt > 3600_000) {
          lastKillLogAt = now;
          log("portfolio_warn", `KILL SWITCH WOULD TRIP (log-only, killSwitchMode=${killMode}): ${decision.reason} — no positions closed, entries not paused`);
        }
        decision = portfolioGuard({ ...guardInput, peakEquity: null }, cfg); // daily-loss rule only
      } else if (!confirmed) {
        decision = { ...decision, killSwitch: false, reason: `${decision.reason} (confirming ${streaks.kill.count}/${cfg.killSwitchConfirmChecks ?? 3})` };
      }
    } else {
      confirmStreak("kill", false, now);
    }

    // Daily loss: also confirmed over consecutive checks before blocking the day.
    if (decision.tripped === "daily_loss" && !st.day_blocked) {
      if (!confirmStreak("daily", true, now, cfg.dailyLossConfirmChecks ?? 2, 0)) {
        decision = { ...decision, reason: `${decision.reason} (confirming ${streaks.daily.count}/${cfg.dailyLossConfirmChecks ?? 2})` };
      }
    } else if (decision.tripped !== "daily_loss") {
      confirmStreak("daily", false, now);
    }
    decision.equity = eq.equity;
    decision.unit = eq.unit;

    if (decision.tripped === "daily_loss" && !st.day_blocked && streaks.daily.count >= (cfg.dailyLossConfirmChecks ?? 2)) {
      savePortfolioState({ day_blocked: true, day_blocked_reason: decision.reason });
      log("portfolio_warn", `DAILY LOSS LIMIT: ${decision.reason}`);
      notify?.("DAILY_LOSS_LIMIT", `${decision.reason}\n${basis === "realized" ? "Realized equity" : "Equity"} ${dailyEquity.toFixed(4)} ${eq.unit.toUpperCase()} (day start ${st.day_start_equity.toFixed(4)}). Existing positions keep being managed.`);
    }

    if (decision.killSwitch) {
      const pauseHours = Math.max(0, Number(cfg.killSwitchPauseHours ?? 24));
      const until = new Date(now + pauseHours * 3600_000).toISOString();
      savePortfolioState({ kill_switch_until: until, kill_switch_reason: decision.reason, kill_switch_at: new Date(now).toISOString(), kill_switch_pending_close: true });
      log("portfolio_warn", `KILL SWITCH: ${decision.reason} — closing all positions, entries paused until ${until}`);
      notify?.("KILL_SWITCH", `${decision.reason}\nEquity ${eq.equity.toFixed(4)} ${eq.unit.toUpperCase()} (peak ${st.peak_equity.toFixed(4)}). Closing ${positions?.length ?? 0} position(s); entries paused until ${until}.`);
    }

    // Close-all runs for a fresh trip AND for a trip recorded earlier without an executor —
    // only while the kill switch is enforced (a trip recorded before switching to log/off is ignored).
    if (killMode === "enforce" && getPortfolioState().kill_switch_pending_close && typeof executeTool === "function") {
      decision.closed = await closeAll(positions, executeTool);
      if (decision.closed.every((c) => c.ok)) savePortfolioState({ kill_switch_pending_close: false });
    }
    return decision;
  })();
  try { return await evaluating; } finally { evaluating = null; }
}

async function closeAll(positions, executeTool) {
  const out = [];
  for (const p of positions || []) {
    const res = await executeTool("close_position", { position_address: p.position, reason: "portfolio kill switch" })
      .catch((e) => ({ error: e.message }));
    const ok = res?.success !== false && !res?.error && !res?.blocked;
    log(ok ? "portfolio" : "portfolio_warn", `Kill switch close ${p.pair ?? p.position.slice(0, 8)}: ${ok ? "closed" : `FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    out.push({ position: p.position, ok });
  }
  return out;
}

/** Teks status untuk Telegram / CLI. */
export function formatGuardStatus(now = Date.now()) {
  const cfg = config.management;
  const st = getPortfolioState();
  const u = (st.unit || cfg.portfolioGuardUnit || "sol").toUpperCase();
  const f = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(4) : "?");
  const dayNow = st.last_daily_equity ?? st.last_equity;
  const dayPnl = st.day_start_equity > 0 && dayNow > 0 ? ((dayNow - st.day_start_equity) / st.day_start_equity) * 100 : null;
  const dd = st.peak_equity > 0 && st.last_equity > 0 ? ((st.last_equity - st.peak_equity) / st.peak_equity) * 100 : null;
  const block = getDeployBlock(now);
  return [
    `Portfolio guard: ${cfg.portfolioGuardEnabled === false ? "DISABLED" : "on"} (${u}) | kill switch: ${killSwitchMode()}`,
    `Equity: ${f(st.last_equity)} ${u} (incl. ${f(st.last_rent_sol ?? 0)} SOL refundable position rent) | day start ${f(st.day_start_equity)} (${st.day || "?"}) | peak ${f(st.peak_equity)}`,
    `Day PnL (${st.day_start_basis ?? dailyLossBasis()}): ${dayPnl == null ? "?" : dayPnl.toFixed(2)}% (limit ${cfg.dailyLossLimitPct}%) | Drawdown: ${dd == null ? "?" : dd.toFixed(2)}% (kill ${cfg.portfolioKillSwitchPct}%)`,
    `Deploys: ${block ? `BLOCKED — ${block}` : "allowed"}`,
    `Last check: ${st.last_at || "never"}`,
  ].join("\n");
}

/** Reset baseline ke ekuitas sekarang (setelah deposit / withdraw manual). */
export async function resetGuardNow({ getMyPositions, getWalletBalances, clearKill = false }) {
  const live = await getMyPositions({ force: true, silent: true });
  if (live?.error || !Array.isArray(live?.positions)) throw new Error("Position read unavailable");
  const balances = await getWalletBalances({ force: true });
  const rec = reconcileWithTracked(live.positions, getTrackedPositions(false));
  const rentSol = await positionsRentSol(rec.positions.map((p) => p.position), { fallbackPerPosition: Number(config.management.portfolioPositionRentSol ?? 0.0575) });
  const eq = computeEquity(balances, rec.positions, config.management.portfolioGuardUnit === "usd" ? "usd" : "sol", { rentSol });
  if (eq.error) throw new Error(eq.error);
  resetPortfolioBaseline({ equity: eq.equity, dayStartEquity: dailyLossBasis() === "realized" ? realizedEquity(eq, rec.positions) : eq.equity, unit: eq.unit, clearKill });
  log("portfolio", `Baseline reset to ${eq.equity.toFixed(4)} ${eq.unit.toUpperCase()}${clearKill ? " (kill switch cleared)" : ""}`);
  return formatGuardStatus();
}
