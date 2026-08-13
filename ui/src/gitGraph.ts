import type { GitCommit, GitSnapshot } from './types'

export type GitCompareTarget = 'base' | 'head'

export interface GitCompareRefs {
  baseRef: string
  headRef: string
}

export interface GitGraphSegment {
  from: number
  to: number
  kind: 'continuation' | 'parent'
}

export interface GitGraphRow {
  commit: GitCommit
  lane: number
  laneCount: number
  segments: GitGraphSegment[]
  /**
   * Vrai si la lane du commit était déjà occupée au-dessus, c'est-à-dire s'il a
   * un enfant dans la fenêtre affichée. Le rendu s'en sert pour descendre le
   * trait du haut de la ligne jusqu'au point ; sans lui, le graphe est coupé
   * d'une demi-ligne sous chaque commit.
   */
  hasIncoming: boolean
}

export interface GitGraphCellGeometry {
  width: number
  /** Hauteur du repère, pas des pixels : voir `VIEWBOX_HEIGHT`. */
  viewBoxHeight: number
  /** `x` en pixels (jamais déformé), `y` dans le repère du viewBox. */
  dot: { x: number, y: number }
  paths: Array<{ d: string, kind: 'continuation' | 'parent' }>
}

const LANE_WIDTH = 14

/**
 * La hauteur d'une ligne de commit dépend de son contenu (un sujet long, des
 * boutons de conversation) : mesurée dans l'app, elle varie de 58 à 98 px. Le
 * graphe est donc dessiné dans un repère vertical arbitraire, que le SVG étire
 * à la hauteur réelle de sa ligne via `preserveAspectRatio="none"`.
 *
 * L'étirement est exact plutôt qu'approché : les ordonnées des courbes ne
 * valent que 0, la moitié ou la totalité de cette hauteur, donc les mettre à
 * l'échelle revient à les recalculer. Seul le point du commit s'ovaliserait —
 * il est dessiné en CSS, hors du SVG.
 */
const VIEWBOX_HEIGHT = 100

/**
 * Ce que le graphe dit visuellement, en toutes lettres : sans lui, la topologie
 * du dépôt est réservée à qui voit le tracé.
 */
export function gitGraphRowLabel(row: GitGraphRow): string {
  const parents = row.commit.parents.length
  const nature = parents > 1 ? `fusion de ${parents} parents` : 'commit'
  const place = row.laneCount > 1 ? `, voie ${row.lane + 1} sur ${row.laneCount}` : ''
  return `${nature}${place}`
}

/** Géométrie d'une ligne de graphe : point du commit et courbes sortantes. */
export function gitGraphCellGeometry(row: GitGraphRow): GitGraphCellGeometry {
  const x = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2
  const height = VIEWBOX_HEIGHT
  const middle = height / 2
  const paths = row.segments.map((segment) => segment.kind === 'continuation'
    ? {
        kind: segment.kind,
        d: `M ${x(segment.from)} 0 C ${x(segment.from)} ${middle}, ${x(segment.to)} ${middle}, ${x(segment.to)} ${height}`,
      }
    : {
        kind: segment.kind,
        d: `M ${x(row.lane)} ${middle} C ${x(row.lane)} ${height}, ${x(segment.to)} ${middle}, ${x(segment.to)} ${height}`,
      })
  // Le trait entrant : du haut de la ligne jusqu'au point. Les segments ne
  // couvrent que ce qui sort du commit, d'où un graphe coupé sans lui.
  if (row.hasIncoming) {
    paths.unshift({ kind: 'parent', d: `M ${x(row.lane)} 0 L ${x(row.lane)} ${middle}` })
  }
  return {
    width: row.laneCount * LANE_WIDTH,
    viewBoxHeight: height,
    dot: { x: x(row.lane), y: middle },
    paths,
  }
}

export function updateGitCompareRef(
  refs: GitCompareRefs,
  target: GitCompareTarget,
  value: string,
): GitCompareRefs {
  return target === 'base'
    ? { ...refs, baseRef: value }
    : { ...refs, headRef: value }
}

export function gitRefOptions(snapshot: GitSnapshot): Array<[string, string]> {
  const values = new Map<string, string>()
  snapshot.branches.forEach((branch) => values.set(branch.sha, branch.name))
  snapshot.commits.forEach((commit) => {
    if (!values.has(commit.sha)) values.set(commit.sha, `${commit.sha.slice(0, 8)} · ${commit.subject}`)
  })
  snapshot.headParents.forEach((sha, index) => {
    if (!values.has(sha)) {
      const parentLabel = snapshot.headParents.length === 1 ? 'Parent de HEAD' : `Parent ${index + 1} de HEAD`
      values.set(sha, `${sha.slice(0, 8)} · ${parentLabel}`)
    }
  })
  return [...values.entries()]
}

/** Comparaison utile à l'ouverture : branche de base distante → HEAD du
 * worktree courant. Le parent direct n'explique qu'un commit et masquait les
 * changements précédents d'une branche de travail. */
export function defaultGitCompareRefs(snapshot: GitSnapshot): GitCompareRefs {
  const remoteBase = snapshot.branches.find((branch) => (
    branch.name === 'origin/master' || branch.name === 'origin/main'
  ))
  return {
    baseRef: remoteBase?.sha ?? snapshot.headParents[0] ?? '',
    headRef: snapshot.head ?? '',
  }
}

export function layoutGitGraph(commits: GitCommit[]): GitGraphRow[] {
  let active: string[] = []
  return commits.map((commit) => {
    let lane = active.indexOf(commit.sha)
    const hasIncoming = lane !== -1
    if (lane === -1) {
      lane = active.length
      active.push(commit.sha)
    }
    const before = [...active]
    const next = before.filter((_, index) => index !== lane)
    let insertion = lane
    for (const parent of commit.parents) {
      if (!next.includes(parent)) {
        next.splice(Math.min(insertion, next.length), 0, parent)
        insertion += 1
      }
    }
    const segments: GitGraphSegment[] = []
    before.forEach((sha, from) => {
      if (from === lane) return
      const to = next.indexOf(sha)
      if (to !== -1) segments.push({ from, to, kind: 'continuation' })
    })
    commit.parents.forEach((parent) => {
      const to = next.indexOf(parent)
      if (to !== -1) segments.push({ from: lane, to, kind: 'parent' })
    })
    active = next
    return {
      commit,
      lane,
      laneCount: Math.max(before.length, next.length, 1),
      segments,
      hasIncoming,
    }
  })
}
