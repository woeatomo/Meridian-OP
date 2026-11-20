// sizing.js — P1 C3. Sizing berdasarkan confidence, bukan 35% tetap.
// Lokasi yang disarankan: repo root / tools/
// Input: { balanceSol, gasReserveSol, confidence0to100, deployFloorSol, deployCeilingSol }
// Output: { sizeSol: number, reason: string }
export function confidenceSizing(s) {
  const basePct = 0.2; // base 20% saldo (bukan 35% tetap)
  const available = Math.max(0, (s.balanceSol ?? 0) - (s.gasReserveSol ?? 0.2));
  const conf = Math.min(100, Math.max(0, s.confidence0to100 ?? 70));
  const multiplier = 0.5 + (conf / 100); // 70 -> 1,2x ; 90 -> 1,4x ; 50 -> 1,0x ; 30 -> 0,8x
  let size = available * basePct * multiplier;
  const floor = s.deployFloorSol ?? 0.5;
  const ceiling = s.deployCeilingSol ?? 50;
  size = Math.max(floor, Math.min(ceiling, size));
  if (size > available) size = Math.max(0, available);
  return { sizeSol: Math.round(size * 1000) / 1000, reason: `confidence ${conf} -> x${multiplier.toFixed(2)} dari base 20%` };
}
