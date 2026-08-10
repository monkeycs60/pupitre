export function formatActiveDuration(activeMs: number): string {
  const minutes = Math.floor(Math.max(0, activeMs) / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')}`
}
