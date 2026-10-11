export type StructureStatus = 'A' | 'M' | 'D' | 'R'

export interface StructureSourceInput {
  source: string
  label: string
  paths: string[]
  changes: Array<{ path: string, status: string, added: number | null, removed: number | null }>
  dirty: Array<{ path: string, status: string }>
}

export interface StructureFile {
  source: string
  path: string
  status: StructureStatus | null
  added: number
  removed: number
  uncommitted: boolean
}

export interface StructureNode {
  id: string
  name: string
  display: string
  kind: 'dir' | 'file' | 'block'
  children: StructureNode[]
  file: StructureFile | null
  total: number
  touched: number
  churn: number
  isNew: boolean
}

export interface StructureRect {
  node: StructureNode
  x: number
  z: number
  width: number
  depth: number
  level: number
}

export interface StructureLayout {
  platforms: StructureRect[]
  buildings: StructureRect[]
  size: number
}

export type StructureSignalKind = 'new-directory' | 'suspect' | 'isolated' | 'large' | 'uncommitted' | 'deleted'

export interface StructureSignal {
  kind: StructureSignalKind
  label: string
  hint: string
  severity: 'alert' | 'warn' | 'info'
  nodes: Array<{ node: StructureNode, reason: string }>
}

const UNTOUCHED_SIBLING_LIMIT = 48
const LARGE_ADDITION = 400
const TEMPORARY_NAME = /(^|[._-])(tmp|temp|bak|backup|old|copy|draft|scratch|debug|wip)([._-]|$)|\.(orig|rej|log|bak|tmp)$|~$/i
const GENERATED_FILE = /(^|\/)__snapshots__\/|\.snap$|(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/
const NOTE_FILE = /\.(md|txt)$/i
const DOCUMENTATION_PATH = /(^|\/)(docs?|documentation|\.claude|\.ai-kit|changelog|adr)(\/|$)|(^|\/)(readme|changelog|claude|agents|context|license)\.[a-z]+$/i

function normalizeStatus(status: string): StructureStatus {
  const letter = status.charAt(0).toUpperCase()
  if (letter === 'A' || letter === '?') return 'A'
  if (letter === 'D') return 'D'
  if (letter === 'R') return 'R'
  return 'M'
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

function directory(id: string, name: string, display: string): StructureNode {
  return { id, name, display, kind: 'dir', children: [], file: null, total: 0, touched: 0, churn: 0, isNew: false }
}

export function buildStructureTree(inputs: StructureSourceInput[]): StructureNode {
  const root = directory('', '', '')
  const prefixed = inputs.length > 1

  for (const input of inputs) {
    const base = prefixed ? directory(`${input.source}\n`, input.label, input.label) : root
    if (prefixed) root.children.push(base)
    const directories = new Map<string, StructureNode>([['', base]])
    const files = new Map<string, StructureNode>()

    const ensureDirectory = (path: string): StructureNode => {
      const existing = directories.get(path)
      if (existing) return existing
      const cut = path.lastIndexOf('/')
      const parent = ensureDirectory(cut === -1 ? '' : path.slice(0, cut))
      const name = cut === -1 ? path : path.slice(cut + 1)
      const node = directory(`${input.source}\n${path}/`, name, prefixed ? `${input.label}/${path}` : path)
      parent.children.push(node)
      directories.set(path, node)
      return node
    }

    const ensureFile = (path: string): StructureNode => {
      const existing = files.get(path)
      if (existing) return existing
      const cut = path.lastIndexOf('/')
      const parent = ensureDirectory(cut === -1 ? '' : path.slice(0, cut))
      const node: StructureNode = {
        id: `${input.source}\n${path}`,
        name: cut === -1 ? path : path.slice(cut + 1),
        display: prefixed ? `${input.label}/${path}` : path,
        kind: 'file',
        children: [],
        file: { source: input.source, path, status: null, added: 0, removed: 0, uncommitted: false },
        total: 1,
        touched: 0,
        churn: 0,
        isNew: false,
      }
      parent.children.push(node)
      files.set(path, node)
      return node
    }

    for (const path of input.paths) ensureFile(path)
    for (const change of input.changes) {
      const file = ensureFile(change.path).file!
      file.status = normalizeStatus(change.status)
      file.added = change.added ?? 0
      file.removed = change.removed ?? 0
    }
    for (const entry of input.dirty) {
      const file = ensureFile(entry.path).file!
      file.uncommitted = true
      if (file.status === null || entry.status === 'D') file.status = normalizeStatus(entry.status)
    }
  }

  aggregate(root)
  return root
}

function aggregate(node: StructureNode): void {
  if (node.kind === 'file') {
    const file = node.file!
    node.touched = file.status === null ? 0 : 1
    node.churn = file.added + file.removed
    node.isNew = file.status === 'A'
    return
  }
  node.total = 0
  node.touched = 0
  node.churn = 0
  for (const child of node.children) {
    aggregate(child)
    node.total += child.total
    node.touched += child.touched
    node.churn += child.churn
  }
  node.isNew = node.children.length > 0 && node.children.every((child) => child.isNew)
}

/** Replie ce qui n'a pas changé pour que la carte tienne à l'écran, en gardant les voisins directs des fichiers touchés. */
export function pruneStructureTree(root: StructureNode): StructureNode {
  const prune = (node: StructureNode): StructureNode => {
    if (node.kind !== 'dir') return node
    if (node.touched === 0) return { ...node, kind: 'block', children: [] }

    let current = node
    let name = node.name
    while (current.children.length === 1 && current.children[0]!.kind === 'dir' && current.children[0]!.touched > 0 && current.name !== '') {
      current = current.children[0]!
      name = `${name}/${current.name}`
    }

    const directories = current.children.filter((child) => child.kind === 'dir').map(prune)
    const touchedFiles = current.children.filter((child) => child.kind === 'file' && child.touched > 0)
    const untouchedFiles = current.children.filter((child) => child.kind === 'file' && child.touched === 0)
    const kept = untouchedFiles.slice(0, UNTOUCHED_SIBLING_LIMIT)
    const overflow = untouchedFiles.length - kept.length
    const children = [...directories, ...touchedFiles, ...kept]
    if (overflow > 0) {
      children.push({
        id: `${current.id}\n+`,
        name: `${overflow} autres fichiers`,
        display: `${current.display} (${overflow} autres fichiers)`,
        kind: 'block',
        children: [],
        file: null,
        total: overflow,
        touched: 0,
        churn: 0,
        isNew: false,
      })
    }
    return { ...current, name, children }
  }
  return prune(root)
}

function weightOf(node: StructureNode): number {
  if (node.kind === 'file') return node.touched > 0 ? 5 + Math.log2(1 + node.churn) : 1
  if (node.kind === 'block') return Math.min(14, Math.max(1.5, Math.sqrt(node.total)))
  return node.children.reduce((total, child) => total + weightOf(child), 0) + 1.5
}

interface Box { x: number, z: number, width: number, depth: number }

function squarify(items: Array<{ node: StructureNode, weight: number }>, box: Box): Array<{ node: StructureNode, box: Box }> {
  const placed: Array<{ node: StructureNode, box: Box }> = []
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  if (total <= 0 || box.width <= 0 || box.depth <= 0) return placed
  const scale = (box.width * box.depth) / total
  const queue = items.map((item) => ({ node: item.node, area: item.weight * scale })).sort((left, right) => right.area - left.area)
  let free = { ...box }

  const worst = (row: number[], side: number): number => {
    const sum = row.reduce((accumulator, value) => accumulator + value, 0)
    const max = Math.max(...row)
    const min = Math.min(...row)
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
  }

  let index = 0
  while (index < queue.length) {
    const side = Math.min(free.width, free.depth)
    const row = [queue[index]!]
    let areas = [row[0]!.area]
    let next = index + 1
    while (next < queue.length) {
      const candidate = [...areas, queue[next]!.area]
      if (worst(candidate, side) > worst(areas, side)) break
      areas = candidate
      row.push(queue[next]!)
      next += 1
    }
    const rowArea = areas.reduce((sum, value) => sum + value, 0)
    const thickness = rowArea / side
    let offset = 0
    for (const item of row) {
      const length = item.area / thickness
      placed.push({
        node: item.node,
        box: free.width >= free.depth
          ? { x: free.x, z: free.z + offset, width: thickness, depth: length }
          : { x: free.x + offset, z: free.z, width: length, depth: thickness },
      })
      offset += length
    }
    free = free.width >= free.depth
      ? { x: free.x + thickness, z: free.z, width: free.width - thickness, depth: free.depth }
      : { x: free.x, z: free.z + thickness, width: free.width, depth: free.depth - thickness }
    index = next
  }
  return placed
}

export function layoutStructure(root: StructureNode): StructureLayout {
  const size = Math.max(24, Math.sqrt(weightOf(root)) * 2.6)
  const platforms: StructureRect[] = []
  const buildings: StructureRect[] = []

  const place = (node: StructureNode, box: Box, level: number): void => {
    if (node.kind !== 'dir') {
      const gap = Math.min(0.12, box.width * 0.12, box.depth * 0.12)
      buildings.push({ node, x: box.x + gap, z: box.z + gap, width: box.width - gap * 2, depth: box.depth - gap * 2, level })
      return
    }
    if (node.name !== '') platforms.push({ node, x: box.x, z: box.z, width: box.width, depth: box.depth, level })
    const padding = node.name === '' ? 0 : Math.min(0.32, box.width * 0.08, box.depth * 0.08)
    const inner = { x: box.x + padding, z: box.z + padding, width: box.width - padding * 2, depth: box.depth - padding * 2 }
    const items = node.children.map((child) => ({ node: child, weight: weightOf(child) }))
    for (const child of squarify(items, inner)) place(child.node, child.box, node.name === '' ? level : level + 1)
  }

  place(root, { x: -size / 2, z: -size / 2, width: size, depth: size }, 0)
  return { platforms, buildings, size }
}

function touchedFiles(root: StructureNode): StructureNode[] {
  const found: StructureNode[] = []
  const walk = (node: StructureNode): void => {
    if (node.kind === 'file' && node.touched > 0) found.push(node)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return found
}

function areaOf(file: StructureFile): string {
  return `${file.source}\n${file.path.split('/').slice(0, 2).join('/')}`
}

export function detectStructureSignals(root: StructureNode): StructureSignal[] {
  const files = touchedFiles(root)
  const signals: StructureSignal[] = []

  const newDirectories: StructureSignal['nodes'] = []
  const walkDirectories = (node: StructureNode, parentIsNew: boolean): void => {
    if (node.kind !== 'dir') return
    const fresh = node.isNew && node.name !== ''
    if (fresh && !parentIsNew) newDirectories.push({ node, reason: `${node.total} fichier${node.total > 1 ? 's' : ''}, dossier absent de la base` })
    for (const child of node.children) walkDirectories(child, parentIsNew || fresh)
  }
  walkDirectories(root, false)
  if (newDirectories.length > 0) {
    signals.push({ kind: 'new-directory', label: 'Nouveaux dossiers', hint: 'La structure du dépôt a été étendue.', severity: 'alert', nodes: newDirectories })
  }

  const siblingsByDirectory = new Map<string, StructureNode[]>()
  const collect = (node: StructureNode): void => {
    if (node.kind === 'dir') siblingsByDirectory.set(node.id, node.children.filter((child) => child.kind === 'file'))
    for (const child of node.children) collect(child)
  }
  collect(root)

  const suspects: StructureSignal['nodes'] = []
  for (const node of files) {
    const file = node.file!
    if (file.status !== 'A') continue
    const cut = file.path.lastIndexOf('/')
    const siblings = (siblingsByDirectory.get(`${file.source}\n${cut === -1 ? '' : `${file.path.slice(0, cut)}/`}`) ?? siblingsByDirectory.get(`${file.source}\n`) ?? [])
      .filter((sibling) => sibling !== node && sibling.file?.status !== 'A')
    const extension = extensionOf(node.name)
    if (TEMPORARY_NAME.test(node.name)) suspects.push({ node, reason: 'nom de fichier temporaire ou de sauvegarde' })
    else if (NOTE_FILE.test(node.name) && !DOCUMENTATION_PATH.test(file.path)) suspects.push({ node, reason: 'note ou document créé hors des dossiers de documentation' })
    else if (cut === -1) suspects.push({ node, reason: 'créé à la racine du dépôt' })
    else if (extension && siblings.length >= 3 && !siblings.some((sibling) => extensionOf(sibling.name) === extension)) {
      suspects.push({ node, reason: `seul fichier .${extension} de ce dossier` })
    }
  }
  if (suspects.length > 0) {
    signals.push({ kind: 'suspect', label: 'Fichiers créés à vérifier', hint: 'Emplacement ou nom inhabituel pour ce dépôt.', severity: 'alert', nodes: suspects })
  }

  const perArea = new Map<string, StructureNode[]>()
  for (const node of files) {
    const area = areaOf(node.file!)
    perArea.set(area, [...(perArea.get(area) ?? []), node])
  }
  if (files.length >= 8 && perArea.size >= 3) {
    const isolated = [...perArea.values()]
      .filter((group) => group.length <= 2 && group.length / files.length < 0.06)
      .flat()
      .map((node) => ({ node, reason: 'loin du reste du changement' }))
    if (isolated.length > 0) {
      signals.push({ kind: 'isolated', label: 'Fichiers isolés', hint: 'Touchés à l’écart des zones où se concentre le changement.', severity: 'warn', nodes: isolated })
    }
  }

  const large = files
    .filter((node) => node.file!.status === 'A' && node.file!.added >= LARGE_ADDITION && !GENERATED_FILE.test(node.file!.path))
    .map((node) => ({ node, reason: `${node.file!.added} lignes ajoutées d’un coup` }))
  if (large.length > 0) signals.push({ kind: 'large', label: 'Gros fichiers créés', hint: `${LARGE_ADDITION} lignes ou plus.`, severity: 'warn', nodes: large })

  const uncommitted = files.filter((node) => node.file!.uncommitted).map((node) => ({ node, reason: 'modification non commitée' }))
  if (uncommitted.length > 0) signals.push({ kind: 'uncommitted', label: 'Non commités', hint: 'Présents dans le worktree, absents de la branche.', severity: 'info', nodes: uncommitted })

  const deleted = files.filter((node) => node.file!.status === 'D').map((node) => ({ node, reason: `${node.file!.removed} lignes retirées` }))
  if (deleted.length > 0) signals.push({ kind: 'deleted', label: 'Fichiers supprimés', hint: 'Retirés par la branche.', severity: 'info', nodes: deleted })

  return signals
}

export interface StructureSummary {
  files: number
  created: number
  modified: number
  deleted: number
  added: number
  removed: number
  directories: number
}

export function summarizeStructure(root: StructureNode): StructureSummary {
  const files = touchedFiles(root)
  const directories = new Set(files.map((node) => `${node.file!.source}\n${node.file!.path.slice(0, Math.max(0, node.file!.path.lastIndexOf('/')))}`))
  return {
    files: files.length,
    created: files.filter((node) => node.file!.status === 'A').length,
    modified: files.filter((node) => node.file!.status === 'M' || node.file!.status === 'R').length,
    deleted: files.filter((node) => node.file!.status === 'D').length,
    added: files.reduce((total, node) => total + node.file!.added, 0),
    removed: files.reduce((total, node) => total + node.file!.removed, 0),
    directories: directories.size,
  }
}
