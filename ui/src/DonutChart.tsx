import { Fragment, useId, useState } from 'react'
import { formatCompact } from './formatCompact'

const RADIUS = 52
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** Écart entre segments : la séparation ne repose pas que sur la couleur. */
const GAP = 3

export interface DonutSlice {
  label: string
  value: number
  /** Titre de regroupement affiché au-dessus de cette part dans la légende. */
  groupLabel?: string
  /** Précision sous le libellé : ce que la part recouvre exactement. */
  detail?: string
  /** Hachures : part subie, rechargée à chaque session, non compressible. */
  hatched?: boolean
  /** Teinte neutre : une absence de consommation, pas une catégorie. */
  muted?: boolean
  /** Légende en italique : valeur déduite plutôt que mesurée. */
  inferred?: boolean
  /**
   * Créneau de la palette (1 à 5). La palette validée n'en compte que cinq,
   * alors que la répartition peut avoir dix parts : les parts d'un même groupe
   * partagent donc le créneau et se distinguent par une rampe de luminosité —
   * une teinte, plusieurs valeurs, ce qu'autorise un dégradé séquentiel.
   */
  colorIndex?: number
  /** Rang dans son groupe, qui choisit le degré de la rampe. */
  shade?: number
}

/**
 * Anneau de répartition. Le survol d'un segment — ou de sa ligne de légende —
 * affiche son détail au centre, plutôt qu'une infobulle flottante.
 */
export function DonutChart({
  slices,
  total,
  caption,
  centerValue,
  selected = null,
  onSelect,
}: {
  slices: DonutSlice[]
  /** Référence des pourcentages : la fenêtre entière, pas la somme affichée. */
  total: number
  caption: string
  /** Valeur au centre au repos ; par défaut le total. */
  centerValue?: number
  /** Libellé de la part sélectionnée, quand l'anneau sert de filtre. */
  selected?: string | null
  /** Fourni : l'anneau devient cliquable et un second clic désélectionne. */
  onSelect?: (label: string | null) => void
}) {
  const [active, setActive] = useState<number | null>(null)
  const patternId = `donut-hatch-${useId().replace(/[^a-zA-Z0-9]/gu, '')}`
  if (total <= 0 || slices.length === 0) return null

  let consumed = 0
  const segments = slices.map((slice, index) => {
    const fraction = slice.value / total
    const length = Math.max(0, fraction * CIRCUMFERENCE - GAP)
    const segment = {
      slice,
      index,
      percent: fraction * 100,
      dash: `${length} ${CIRCUMFERENCE - length}`,
      offset: -consumed,
    }
    consumed += fraction * CIRCUMFERENCE
    return segment
  })

  /** Rampe séquentielle : la teinte du groupe, éclaircie vers le fond. */
  const sliceColor = (slice: DonutSlice, index: number) => {
    if (slice.muted) return 'var(--border-subtle)'
    const hue = `var(--viz-${slice.colorIndex ?? index + 1})`
    const shade = slice.shade ?? 0
    if (shade === 0) return hue
    // 22 % de fond par degré : trois nuances restent nettement séparées.
    return `color-mix(in srgb, ${hue} ${Math.max(30, 100 - shade * 22)}%, var(--bg-overlay))`
  }

  const focused = active === null ? null : segments[active]
  const percentLabel = (percent: number) =>
    `${percent.toLocaleString('fr-FR', { maximumFractionDigits: percent < 10 ? 1 : 0 })} %`
  const toggle = (label: string) => onSelect?.(selected === label ? null : label)

  return (
    <div className={`donut-chart ${onSelect ? 'is-selectable' : ''}`}>
      <svg viewBox="0 0 128 128" role="img" aria-label={caption}>
        <defs>
          <pattern
            id={patternId}
            width="6"
            height="6"
            patternTransform="rotate(45)"
            patternUnits="userSpaceOnUse"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--bg-overlay)" strokeWidth="2.5" />
          </pattern>
        </defs>
        <g transform="rotate(-90 64 64)">
          {segments.map((segment) => (
            <g key={segment.slice.label}>
              <circle
                className={[
                  'donut-arc',
                  active === segment.index ? 'is-active' : '',
                  segment.slice.muted ? 'is-muted' : '',
                  selected === segment.slice.label ? 'is-selected' : '',
                ].join(' ').trim()}
                cx="64"
                cy="64"
                r={RADIUS}
                stroke={sliceColor(segment.slice, segment.index)}
                strokeDasharray={segment.dash}
                strokeDashoffset={segment.offset}
                onMouseEnter={() => setActive(segment.index)}
                onMouseLeave={() => setActive(null)}
                onClick={() => toggle(segment.slice.label)}
              />
              {segment.slice.hatched ? (
                <circle
                  className={`donut-arc donut-arc-hatch ${active === segment.index ? 'is-active' : ''}`}
                  cx="64"
                  cy="64"
                  r={RADIUS}
                  stroke={`url(#${patternId})`}
                  strokeDasharray={segment.dash}
                  strokeDashoffset={segment.offset}
                />
              ) : null}
            </g>
          ))}
        </g>
        <text className="donut-value" x="64" y="60">
          {formatCompact(focused ? focused.slice.value : centerValue ?? total)}
        </text>
        <text className="donut-caption" x="64" y="76">
          {focused ? percentLabel(focused.percent) : `sur ${formatCompact(total)}`}
        </text>
      </svg>

      <ul className="donut-legend">
        {segments.map((segment, position) => (
          <Fragment key={segment.slice.label}>
          {segment.slice.groupLabel
            && segment.slice.groupLabel !== segments[position - 1]?.slice.groupLabel ? (
              <li className="donut-group-title" aria-hidden="true">
                {segment.slice.groupLabel}
              </li>
            ) : null}
          <li
            key={segment.slice.label}
            data-group={segment.slice.groupLabel}
            className={[
              active === segment.index ? 'is-active' : '',
              segment.slice.inferred ? 'is-inferred' : '',
              selected === segment.slice.label ? 'is-selected' : '',
            ].join(' ').trim()}
            onMouseEnter={() => setActive(segment.index)}
            onMouseLeave={() => setActive(null)}
            onClick={() => toggle(segment.slice.label)}
          >
            <span
              className={`donut-chip ${segment.slice.hatched ? 'is-hatched' : ''}`}
              style={{ background: sliceColor(segment.slice, segment.index) }}
              aria-hidden="true"
            />
            <span className="donut-label">
              {segment.slice.label}
              {segment.slice.hatched ? (
                <abbr title="Rechargé à chaque session : non compressible"> ▨</abbr>
              ) : null}
              {segment.slice.detail ? (
                <small className="donut-detail">{segment.slice.detail}</small>
              ) : null}
            </span>
            <span className="donut-tokens">{formatCompact(segment.slice.value)}</span>
            <span className="donut-percent">{percentLabel(segment.percent)}</span>
          </li>
          </Fragment>
        ))}
      </ul>
    </div>
  )
}
