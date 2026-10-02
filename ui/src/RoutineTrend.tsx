import type { RoutineRun } from './types'

export function RoutineTrend({ runs }: { runs: RoutineRun[] }) {
  const points = runs
    .filter((run) => run.status === 'done' && run.output)
    .slice()
    .reverse()
    .flatMap((run) => {
      try {
        const value = JSON.parse(run.output!)
        return value && typeof value === 'object' && !Array.isArray(value)
          ? [{ at: run.started_at, values: value as Record<string, unknown> }]
          : []
      } catch {
        return []
      }
    })
  const keys = [
    ...new Set(points.flatMap((point) => Object.keys(point.values))),
  ].filter(
    (key) =>
      points.filter(
        (point) =>
          typeof point.values[key] === 'number' &&
          Number.isFinite(point.values[key]),
      ).length >= 2,
  )
  if (!keys.length) return null
  return (
    <section aria-label="Tendances des sorties JSON">
      {keys.map((key) => {
        const series = points.flatMap((point) =>
          typeof point.values[key] === 'number' &&
          Number.isFinite(point.values[key])
            ? [{ at: point.at, value: point.values[key] as number }]
            : [],
        )
        const min = Math.min(...series.map((point) => point.value)),
          max = Math.max(...series.map((point) => point.value))
        return (
          <figure key={key}>
            <figcaption>
              {key} · {series.at(-1)!.value} · {series.length} passages
            </figcaption>
            <svg
              viewBox="0 0 360 90"
              role="img"
              aria-label={`${key} de ${series[0]!.value} à ${series.at(-1)!.value}`}
              style={{ width: '100%', maxWidth: 600, height: 120 }}
            >
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                points={series
                  .map(
                    (point, index) =>
                      `${10 + (index * 340) / (series.length - 1)},${max === min ? 45 : 80 - ((point.value - min) * 70) / (max - min)}`,
                  )
                  .join(' ')}
              />
            </svg>
            <small>
              {new Date(series[0]!.at).toLocaleDateString('fr-FR')} —{' '}
              {new Date(series.at(-1)!.at).toLocaleDateString('fr-FR')}
            </small>
          </figure>
        )
      })}
    </section>
  )
}
