export interface CodeTreeNode {
  name: string
  path: string
  kind: 'directory' | 'file'
  children: CodeTreeNode[]
}

export interface CodeTreeRow {
  node: CodeTreeNode
  /** Nom affiché : une chaîne de dossiers à enfant unique est fusionnée (`src/lib`). */
  label: string
  depth: number
}

export interface CodePathMatch {
  path: string
  score: number
  /** Positions des caractères retrouvés dans `path`, pour les souligner. */
  indices: number[]
}

function compareNodes(left: CodeTreeNode, right: CodeTreeNode): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true })
}

export function buildCodeTree(paths: string[]): CodeTreeNode {
  const root: CodeTreeNode = { name: '', path: '', kind: 'directory', children: [] }
  const directories = new Map<string, CodeTreeNode>([['', root]])
  for (const path of paths) {
    const segments = path.split('/').filter(Boolean)
    let parent = root
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!
      const nodePath = segments.slice(0, index + 1).join('/')
      if (index === segments.length - 1) {
        parent.children.push({ name, path: nodePath, kind: 'file', children: [] })
        break
      }
      let directory = directories.get(nodePath)
      if (!directory) {
        directory = { name, path: nodePath, kind: 'directory', children: [] }
        directories.set(nodePath, directory)
        parent.children.push(directory)
      }
      parent = directory
    }
  }
  for (const directory of directories.values()) directory.children.sort(compareNodes)
  return root
}

export function flattenCodeTree(root: CodeTreeNode, expanded: ReadonlySet<string>): CodeTreeRow[] {
  const rows: CodeTreeRow[] = []
  const visit = (nodes: CodeTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.kind === 'file') {
        rows.push({ node, label: node.name, depth })
        continue
      }
      let target = node
      let label = node.name
      while (target.children.length === 1 && target.children[0]!.kind === 'directory') {
        target = target.children[0]!
        label = `${label}/${target.name}`
      }
      rows.push({ node: target, label, depth })
      if (expanded.has(target.path)) visit(target.children, depth + 1)
    }
  }
  visit(root.children, 0)
  return rows
}

export function ancestorDirectories(path: string): string[] {
  const segments = path.split('/').filter(Boolean)
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
}

function subsequence(haystack: string, needle: string, from: number): number[] | null {
  const indices: number[] = []
  let cursor = from
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)
    if (found === -1) return null
    indices.push(found)
    cursor = found + 1
  }
  return indices
}

/**
 * Recherche floue façon « ouverture rapide » : les caractères doivent apparaître
 * dans l'ordre. Le nom de fichier et les suites contiguës pèsent plus que le
 * chemin, pour que `routes` trouve `routes.js` avant `src/router/tests.ts`.
 */
export function matchCodePaths(paths: string[], query: string, limit = 200): CodePathMatch[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, '')
  if (needle === '') return []
  const matches: CodePathMatch[] = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    const nameStart = lower.lastIndexOf('/') + 1
    const inName = subsequence(lower, needle, nameStart)
    const indices = inName ?? subsequence(lower, needle, 0)
    if (!indices) continue
    let score = inName ? 100 : 0
    for (let index = 1; index < indices.length; index += 1) {
      if (indices[index] === indices[index - 1]! + 1) score += 8
    }
    const contiguous = lower.indexOf(needle, nameStart)
    if (contiguous === nameStart) score += 60
    else if (contiguous !== -1) score += 30
    score -= path.length * 0.1
    matches.push({ path, score, indices })
  }
  return matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, limit)
}
