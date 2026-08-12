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
}

export interface GitGraphCellGeometry {
  width: number
  height: number
  dot: { x: number, y: number }
  paths: Array<{ d: string, kind: 'continuation' | 'parent' }>
}

const LANE_WIDTH = 14
/** Doit rester égal au `min-height` de `.git-commit` (git.css) : sinon le
 *  graphe se coupe entre deux lignes. */
const ROW_HEIGHT = 58

/** Géométrie SVG d'une ligne de graphe : point du commit et courbes sortantes. */
export function gitGraphCellGeometry(row: GitGraphRow): GitGraphCellGeometry {
  const x = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2
  const height = ROW_HEIGHT
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
  return {
    width: row.laneCount * LANE_WIDTH,
    height,
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

export function layoutGitGraph(commits: GitCommit[]): GitGraphRow[] {
  let active: string[] = []
  return commits.map((commit) => {
    let lane = active.indexOf(commit.sha)
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
    }
  })
}
