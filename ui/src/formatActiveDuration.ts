export function formatActiveDuration(activeMs: number): string {
  const minutes = Math.floor(Math.max(0, activeMs) / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')}`
}

/** Comme ci-dessus, mais garde la seconde sous la minute : un tour de 19 s ne
 *  doit pas s'afficher « 0 min » dans une infobulle qui prétend le détailler. */
export function formatShortDuration(milliseconds: number): string {
  const bounded = Math.max(0, milliseconds)
  if (bounded < 60_000) return `${Math.round(bounded / 1_000)} s`
  return formatActiveDuration(bounded)
}
