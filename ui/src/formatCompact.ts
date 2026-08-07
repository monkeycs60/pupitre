/** Nombre abrégé : 1 234 567 → « 1,23 M », 12 340 → « 12,3 k ». */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k`
  }
  return String(value)
}
