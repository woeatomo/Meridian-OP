// fee-harvest.js — P1 C1. Pure decision: klaim atau tahan, compound atau tidak.
// Lokasi yang disarankan: repo root / standalone/
// Input: { unclaimedFeesUsd, gasCostUsd, positionUsd, claimMinUsd }
// Output: { claim: boolean, compound: boolean, reason: string }
export function feeHarvest(f) {
  const minClaim = f.claimMinUsd ?? 5;
  if (!(f.unclaimedFeesUsd >= minClaim)) {
    return { claim: false, compound: false, reason: `fees $${f.unclaimedFeesUsd} < min claim $${minClaim}` };
  }
  if (typeof f.gasCostUsd === "number" && f.gasCostUsd > 0.3 * f.unclaimedFeesUsd) {
    return { claim: false, compound: false, reason: "gas > 30% of fees — wait" };
  }
  const compound = typeof f.positionUsd === "number" && f.unclaimedFeesUsd >= 0.02 * f.positionUsd;
  return { claim: true, compound, reason: compound ? "claim + auto-compound (>=2% posisi)" : "claim only" };
}
