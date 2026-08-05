import type { GitCommit, GitSnapshot } from './types'

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
