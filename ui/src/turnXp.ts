/**
 * Reproduction fidèle côté UI de la formule d'XP de tokens du sidecar.
 * Source de vérité : sidecar/src/gamification.ts (tokenXp, complexityMultiplier).
 * Toute divergence entre ce fichier et le sidecar doit être corrigée ici.
 */

const COMPLEXITY_MULTIPLIERS = [1, 1.05, 1.1, 1.2, 1.3, 1.45, 1.6] as const

export function tokenXp(inputTokens: number, outputTokens: number): number {
  const input = Math.log1p(Math.max(0, inputTokens) / 5_000) * 4
  const output = Math.log1p(Math.max(0, outputTokens) / 1_000) * 7
  return Math.max(1, Math.round(input + output))
}

export function complexityMultiplier(complexity: number): number {
  return COMPLEXITY_MULTIPLIERS[Math.max(0, Math.min(6, complexity))] ?? 1
}

export function turnTokenXp(
  input: number,
  output: number,
  complexity: number,
  focusMultiplier: number,
): number {
  return Math.max(1, Math.round(tokenXp(input, output) * complexityMultiplier(complexity) * focusMultiplier))
}
