export function dollars(usd: number): string {
  if (usd === 0) return '0 $'
  if (usd < 0.0001) return '< 0,0001 $'
  const rounded = usd >= 1 ? Math.round(usd * 100) / 100 : Number(usd.toPrecision(2))
  return `${rounded.toLocaleString('fr-FR', { maximumFractionDigits: 6 })} $`
}
