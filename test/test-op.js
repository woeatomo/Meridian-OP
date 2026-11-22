/**
 * Meridian-OP unit tests: dump detector, Emergency SL, reshape decisions/plan,
 * PnL lineage, swap guard. Pure functions only — no network, no wallet, no state writes.
 * Run: node test/test-op.js
 */

import { config } from "../config.js";
import { getDeterministicCloseRule } from "../exit-rules.js";
import { recordTick, movementStats, assessDump, redCandleSignal, normalizeCandles, binMovePct, forgetPosition } from "../modules/dump-detector.js";
import { decideReshape, planReshapeRange, nextPnlFactor, confirmReshape, reshapeInputFromPosition } from "../modules/reshape-manager.js";
import { chainPnlPct, oorSide } from "../modules/position-annotate.js";
import { parseOrderPriceImpactPct } from "../tools/wallet.js";
import { swapGuard } from "../modules/swap-guard.js";

let failed = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const cfg = { ...config.management };
const MIN = 60_000;
const T0 = 1_800_000_000_000;

console.log("\n[1] dump detector — movement from tick history");
{
  // Fast dump: 12 bins down in 6 minutes on bin step 100 (~-11%).
  const P = "PosFastDump";
  for (let i = 0; i <= 12; i++) recordTick(P, { active_bin: 1000 - i, pnl_pct: -i }, T0 + i * 30_000);
  const now = T0 + 12 * 30_000;
  const s = movementStats(P, { binStep: 100, cfg, now });
  check("bins_down_10m counts drop inside window", s.bins_down_10m === 12, JSON.stringify(s));
  check("price change from bin step", s.price_change_15m_pct < -10 && s.price_change_15m_pct > -12, String(s.price_change_15m_pct));
  const d = await assessDump(P, { binStep: 100, cfg, now });
  check("fast dump confirmed (price + bins)", d.dump_confirmed && d.signals.price && d.signals.bins, JSON.stringify(d.signals));
  forgetPosition(P);
}
{
  // Slow bleed: 6 bins over 30 minutes — never a dump.
  const P = "PosSlow";
  for (let i = 0; i <= 30; i++) recordTick(P, { active_bin: 1000 - Math.floor(i / 5), pnl_pct: -i / 10 }, T0 + i * MIN);
  const d = await assessDump(P, { binStep: 100, cfg, now: T0 + 30 * MIN });
  check("slow drop is not a dump", !d.dump_confirmed && !d.signals.bins, JSON.stringify(d));
  forgetPosition(P);
}
{
  // One signal only (bins) → candles consulted; red candles + volume → confirmed.
  const P = "PosOneSignal";
  for (let i = 0; i <= 10; i++) recordTick(P, { active_bin: 1000 - i, pnl_pct: 0 }, T0 + i * 30_000);
  const now = T0 + 10 * 30_000;
  let asked = 0;
  const redCandles = [...Array(10)].map((_, i) => ({ open: 10, close: 10.1, volume: 100, ts: i }))
    .concat([{ open: 10, close: 9, volume: 400, ts: 11 }, { open: 9, close: 8, volume: 400, ts: 12 }, { open: 8, close: 7, volume: 400, ts: 13 }]);
  const d = await assessDump(P, { pool: "Pool", binStep: 1, cfg, now, getCandles: async () => { asked++; return redCandles; } });
  check("bins-only + red candles w/ volume → confirmed", d.dump_confirmed && d.signals.bins && d.signals.candles && asked === 1, JSON.stringify(d.signals));
  const d2 = await assessDump(P, { pool: "Pool", binStep: 1, cfg, now, getCandles: async () => null });
  check("candle fetch failure → not confirmed (conservative)", !d2.dump_confirmed, JSON.stringify(d2.signals));
  forgetPosition(P);
}
{
  const P = "PosNoHistory";
  recordTick(P, { active_bin: 900, pnl_pct: -20 }, T0);
  const d = await assessDump(P, { binStep: 100, cfg, now: T0 });
  check("single tick never confirms a dump", !d.dump_confirmed);
  forgetPosition(P);
}
check("binMovePct sign/size", Math.abs(binMovePct(100, 90, 100) - ((1.01 ** -10 - 1) * 100)) < 1e-9);
check("red candles need volume spike", !redCandleSignal([{ open: 1, close: 1.1, volume: 100 }, { open: 1, close: 0.9, volume: 100 }, { open: 1, close: 0.9, volume: 100 }, { open: 1, close: 0.9, volume: 100 }]));
check("normalizeCandles handles {data:[...]} + arrays", normalizeCandles({ data: [[2, 1, 0, 0, 2, 5], [1, 1, 0, 0, 0.5, 7]] }).map(c => c.ts).join(",") === "1,2");

console.log("\n[2] Emergency SL (exit-rules Rule 0)");
{
  const pos = base => ({ position: "PosRule0", pair: "T/SOL", pnl_pct: 0, active_bin: 100, upper_bin: 120, lower_bin: 60, minutes_out_of_range: 0, age_minutes: 90, fee_per_tvl_24h: 10, ...base });
  check("-11% + dump confirmed → Rule 0", getDeterministicCloseRule(pos({ pnl_pct: -11, dump_confirmed: true }), cfg)?.rule === 0);
  check("-11% without dump → hold (no rule)", getDeterministicCloseRule(pos({ pnl_pct: -11 }), cfg) === null);
  check("-16% without dump → normal SL Rule 1", getDeterministicCloseRule(pos({ pnl_pct: -16 }), cfg)?.rule === 1);
  check("suspect PnL blocks Rule 0", getDeterministicCloseRule(pos({ pnl_pct: -11, dump_confirmed: true, pnl_pct_suspicious: true }), cfg) === null);
  check("OOR right with PnL < 0 → hold", getDeterministicCloseRule(pos({ active_bin: 125, pnl_pct: -2, minutes_out_of_range: 60 }), cfg) === null);
  check("OOR right with PnL >= 0 far above → close", getDeterministicCloseRule(pos({ active_bin: 135, pnl_pct: 1 }), cfg)?.rule === 3);
}

console.log("\n[3] reshape decisions");
{
  const rcfg = { ...cfg, reshapeEnabled: true };
  const base = {
    enabled: true, inRange: true, oorSide: null, activeBin: 94, anchorBin: 100, lowBin10m: 94, binsDown10m: 3,
    dumpConfirmed: false, pnlPct: -4, pnlSuspicious: false, reshapesDone: 0, minutesSinceLastReshape: null,
    feesEarnedUsd: 5, hasExitSignal: false,
  };
  check("slow 6-bin drop, economical → RESHAPE", decideReshape(base, rcfg).action === "RESHAPE", decideReshape(base, rcfg).reason);
  check("disabled → HOLD", decideReshape({ ...base, enabled: false }, rcfg).action === "HOLD");
  check("dump confirmed → HOLD (exit rules decide)", /dump/.test(decideReshape({ ...base, dumpConfirmed: true }, rcfg).reason));
  check("PnL -10 without dump is NOT an emergency exit", decideReshape({ ...base, pnlPct: -10 }, rcfg).action === "RESHAPE");
  check("too close to SL → HOLD", decideReshape({ ...base, pnlPct: -13 }, rcfg).action === "HOLD");
  check("fast drop (>= dumpBinDrop / 10m) → HOLD", /fast drop/.test(decideReshape({ ...base, binsDown10m: 8 }, rcfg).reason));
  check("rebound above 10m low → HOLD", /rebound/.test(decideReshape({ ...base, activeBin: 97, lowBin10m: 94, anchorBin: 103 }, rcfg).reason));
  check("< reshapeBins → HOLD", decideReshape({ ...base, activeBin: 97, lowBin10m: 97 }, rcfg).action === "HOLD");
  check("OOR left → HOLD", decideReshape({ ...base, inRange: false, oorSide: "left" }, rcfg).action === "HOLD");
  check("cooldown → HOLD", /cooldown/.test(decideReshape({ ...base, minutesSinceLastReshape: 10 }, rcfg).reason));
  check("max reshapes → HOLD", /max reshapes/.test(decideReshape({ ...base, reshapesDone: 3 }, rcfg).reason));
  check("fees < 2x cost → HOLD", /economical/.test(decideReshape({ ...base, feesEarnedUsd: 0.1 }, rcfg).reason));
  check("exit pending → HOLD", decideReshape({ ...base, hasExitSignal: true }, rcfg).action === "HOLD");

  // Hysteresis: must hold for reshapeConfirmMinutes.
  const P = "PosConfirm";
  check("confirm: first sighting does not fire", confirmReshape(P, true, rcfg, T0) === false);
  check("confirm: before window does not fire", confirmReshape(P, true, rcfg, T0 + 60_000) === false);
  check("confirm: after window fires", confirmReshape(P, true, rcfg, T0 + 2 * MIN) === true);
  confirmReshape(P, true, rcfg, T0);
  confirmReshape(P, false, rcfg, T0 + MIN); // condition broke → reset
  check("confirm: reset when condition breaks", confirmReshape(P, true, rcfg, T0 + 2 * MIN) === false);

  // Input builder uses lineage anchor after a reshape.
  const tracked = { active_bin_at_deploy: 100, bin_range: { max: 100 }, lineage: { last_reshape_bin: 94, reshape_count: 1, last_reshape_at: new Date(T0).toISOString() } };
  const inp = reshapeInputFromPosition({ in_range: true, active_bin: 90, pnl_pct: -3, collected_fees_true_usd: 2 }, tracked, rcfg, { now: T0 + 60 * MIN });
  check("anchor = last reshape bin; cooldown minutes from lineage", inp.anchorBin === 94 && inp.reshapesDone === 1 && Math.round(inp.minutesSinceLastReshape) === 60);
}

console.log("\n[4] reshape range plan + PnL lineage");
{
  const p = planReshapeRange({ activeBin: 94, anchorTop: 100, binsBelow: 50, hasX: true, hasY: true, cfg });
  check("token above up to anchor, SOL below", p.maxBinId === 100 && p.minBinId === 44 && p.bins_above === 6 && p.bins_below === 50, JSON.stringify(p));
  const p2 = planReshapeRange({ activeBin: 98, anchorTop: 100, binsBelow: 50, hasX: true, hasY: true, cfg });
  check("token side at least reshapeBins wide", p2.bins_above === cfg.reshapeBins);
  const p3 = planReshapeRange({ activeBin: 94, anchorTop: 100, binsBelow: 50, hasX: false, hasY: true, cfg });
  check("no token → single-sided SOL ending at active", p3.maxBinId === 94 && p3.bins_above === 0);
  const p4 = planReshapeRange({ activeBin: 0, anchorTop: 500, binsBelow: 10, hasX: true, hasY: true, cfg });
  check("token side capped at reshapeMaxBinsAbove", p4.bins_above === cfg.reshapeMaxBinsAbove);

  check("chain: -5% then -5% = -9.75%", chainPnlPct(-5, nextPnlFactor(1, -5)) === -9.75);
  check("chain: no lineage keeps raw", chainPnlPct(-3, 1) === -3 && chainPnlPct(null, 0.9) === null);
  check("factor compounds across reshapes", Math.abs(nextPnlFactor(0.95, chainPnlPct(-5, 0.95)) - 0.95 * 0.95) < 1e-9);
  check("oorSide", oorSide({ active_bin: 5, lower_bin: 10, upper_bin: 20 }) === "left" && oorSide({ active_bin: 25, lower_bin: 10, upper_bin: 20 }) === "right" && oorSide({ active_bin: 15, lower_bin: 10, upper_bin: 20 }) === null);
}

console.log("\n[5] swap guard");
{
  check("Ultra priceImpact (percent)", parseOrderPriceImpactPct({ priceImpact: -4.2 }) === 4.2);
  check("v6 priceImpactPct (fraction)", Math.abs(parseOrderPriceImpactPct({ priceImpactPct: "0.012" }) - 1.2) < 1e-9);
  check("unknown impact → null", parseOrderPriceImpactPct({}) === null);
  check("guard blocks above max", swapGuard({ priceImpactPct: 4, maxPriceImpactPct: 3 }).allow === false);
  check("guard allows unknown impact (never strands exits)", swapGuard({ priceImpactPct: null, maxPriceImpactPct: 3 }).allow === true);
}

console.log("\n[6] portfolio guard (daily loss + kill switch)");
{
  const { portfolioGuard } = await import("../modules/portfolio-guard.js");
  const { computeEquity, tradingDay } = await import("../modules/portfolio-runner.js");
  const g = (x) => portfolioGuard({ dayStartEquity: 10, peakEquity: 10, now: T0, ...x }, cfg);
  check("flat → allow", g({ equity: 10 }).allowDeploy === true);
  check("-5% day → block deploys, no kill", g({ equity: 9.5, peakEquity: 9.6 }).tripped === "daily_loss" && !g({ equity: 9.5, peakEquity: 9.6 }).killSwitch);
  check("-10% from peak → kill switch", g({ equity: 9, peakEquity: 10, dayStartEquity: 9.2 }).killSwitch === true);
  check("kill already active → no deploy, no second kill", (() => { const d = g({ equity: 9, killSwitchUntil: T0 + 1000 }); return !d.allowDeploy && !d.killSwitch; })());
  check("incomplete data → block deploys, NEVER kill", (() => { const d = portfolioGuard({ equity: null, dayStartEquity: 10 }, cfg); return !d.allowDeploy && !d.killSwitch; })());

  const bal = { sol: 2, sol_price: 100, tokens: [{ mint: "A", usd: 50 }, { mint: "Dust", usd: null }] };
  const eq = computeEquity(bal, [{ position: "p", total_value_true_usd: 150, unclaimed_fees_true_usd: 10 }], "sol");
  check("equity in SOL = (wallet + positions + fees) / SOL price; unpriced dust ignored", Math.abs(eq.equity - 4.1) < 1e-9, JSON.stringify(eq));
  check("equity in USD", computeEquity(bal, [], "usd").equity === 250);
  check("missing position value → error (no false loss)", !!computeEquity(bal, [{ position: "p" }], "sol").error);
  check("missing SOL price → error", !!computeEquity({ sol: 1, tokens: [] }, [], "sol").error);
  check("trading day uses WIB offset", tradingDay(Date.UTC(2026, 10, 22, 18, 0), 7) === "2026-11-23" && tradingDay(Date.UTC(2026, 10, 22, 16, 0), 7) === "2026-11-22");
}

console.log("\n[7] regime gate (acute rules, fail-open)");
{
  const { regimeGate } = await import("../modules/regime-gate.js");
  const { parseCoinGeckoMarkets, parseBinance } = await import("../modules/regime-runner.js");
  check("calm market → allow", regimeGate({ solChange24hPct: -3, btcChange1hPct: -1 }, cfg).allow);
  check("SOL -10%/24h → would block", !regimeGate({ solChange24hPct: -10.5, btcChange1hPct: 0 }, cfg).allow);
  check("BTC -5%/1h → would block", !regimeGate({ solChange24hPct: 0, btcChange1hPct: -5.2 }, cfg).allow);
  check("missing data → allow (fail-open)", regimeGate({}, cfg).allow && !regimeGate({}, cfg).complete);
  check("trend rule off by default", regimeGate({ solChange24hPct: 0, btcChange1hPct: 0, solClose: 90, solEma50: 95, solEma200: 100 }, cfg).allow);
  check("trend rule when enabled", !regimeGate({ solChange24hPct: 0, btcChange1hPct: 0, solClose: 90, solEma50: 95, solEma200: 100 }, { ...cfg, regimeUseTrendRule: true }).allow);
  const cg = parseCoinGeckoMarkets([
    { id: "bitcoin", current_price: 90000, price_change_percentage_1h_in_currency: -0.4 },
    { id: "solana", current_price: 150, price_change_percentage_24h_in_currency: -2.1 },
  ]);
  check("parse CoinGecko markets", cg.btcChange1hPct === -0.4 && cg.solChange24hPct === -2.1 && cg.solPrice === 150);
  const bn = parseBinance({ priceChangePercent: "-11.2", lastPrice: "140" }, [[0, "100", 0, 0, "100"], [0, "100", 0, 0, "94"]]);
  check("parse Binance fallback", bn.solChange24hPct === -11.2 && Math.abs(bn.btcChange1hPct + 6) < 1e-9);
}

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
