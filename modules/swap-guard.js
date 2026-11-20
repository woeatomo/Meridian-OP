// swap-guard.js — P1 C4. Cek sebelum swap token -> SOL (reshape / close).
// Lokasi yang disarankan: repo root / tools/
// Input: { priceImpactPct, slippagePct, maxPriceImpactPct }
// Output: { allow: boolean, reason: string }
export function swapGuard(s) {
  const maxImpact = s.maxPriceImpactPct ?? 3;
  if (typeof s.priceImpactPct === "number" && s.priceImpactPct > maxImpact) {
    return { allow: false, reason: `price impact ${s.priceImpactPct}% > ${maxImpact}% — tolak swap, coba pecah jadi 2x` };
  }
  return { allow: true, reason: "swap guard OK" };
}
