import type { CodeCommitSummary } from './types'

export interface CodeGraphSegment {
  from: number
  to: number
  kind: 'continuation' | 'parent'
}

export interface CodeGraphRow {
  commit: CodeCommitSummary
  lane: number
  laneCount: number
  segments: CodeGraphSegment[]
  /** Vrai quand un enfant affiché occupe déjà la lane : le trait descend alors du haut de la ligne jusqu'au point. */
  hasIncoming: boolean
}

export interface CodeGraphPath {
  d: string
  lane: number
}

export const CODE_GRAPH_LANE_WIDTH = 12

export function layoutCodeGraph(commits: CodeCommitSummary[]): CodeGraphRow[] {
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
    const segments: CodeGraphSegment[] = []
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
    return { commit, lane, laneCount: Math.max(before.length, next.length, 1), segments, hasIncoming }
  })
}

export function codeGraphLaneX(lane: number): number {
  return lane * CODE_GRAPH_LANE_WIDTH + CODE_GRAPH_LANE_WIDTH / 2
}

/** Tracés d'une ligne de hauteur fixe : chaque courbe finit en bas sur la lane où la ligne suivante la reprend. */
export function codeGraphPaths(row: CodeGraphRow, height: number): CodeGraphPath[] {
  const middle = height / 2
  const x = codeGraphLaneX
  const paths: CodeGraphPath[] = []
  if (row.hasIncoming) paths.push({ lane: row.lane, d: `M ${x(row.lane)} 0 L ${x(row.lane)} ${middle}` })
  for (const segment of row.segments) {
    if (segment.kind === 'continuation') {
      paths.push({
        lane: segment.to,
        d: segment.from === segment.to
          ? `M ${x(segment.from)} 0 L ${x(segment.to)} ${height}`
          : `M ${x(segment.from)} 0 C ${x(segment.from)} ${middle}, ${x(segment.to)} ${middle}, ${x(segment.to)} ${height}`,
      })
    } else {
      paths.push({
        lane: segment.to,
        d: segment.to === row.lane
          ? `M ${x(row.lane)} ${middle} L ${x(row.lane)} ${height}`
          : `M ${x(row.lane)} ${middle} C ${x(row.lane)} ${height}, ${x(segment.to)} ${middle}, ${x(segment.to)} ${height}`,
      })
    }
  }
  return paths
}

export interface CodeRef {
  label: string
  kind: 'head' | 'local' | 'remote' | 'tag'
}

export function parseCodeRefs(refs: string[]): CodeRef[] {
  const parsed: CodeRef[] = []
  for (const raw of refs) {
    if (raw === 'HEAD') continue
    if (raw.startsWith('HEAD -> ')) parsed.push({ label: raw.slice(8), kind: 'head' })
    else if (raw.startsWith('tag: ')) parsed.push({ label: raw.slice(5), kind: 'tag' })
    else if (raw.includes('/') && /^(origin|upstream|github|gitlab)\//.test(raw)) {
      if (!raw.endsWith('/HEAD')) parsed.push({ label: raw, kind: 'remote' })
    } else parsed.push({ label: raw, kind: 'local' })
  }
  return parsed
}
