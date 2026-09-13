import type { CodeSource } from './types'

export type CodeScopeKind = 'ticket' | 'mains' | 'source'

/**
 * Ce que l'onglet Code affiche : un worktree, ou plusieurs quand un même
 * ticket vit dans plusieurs dépôts (affilae-mono : hapigator + reactor).
 */
export interface CodeScope {
  id: string
  kind: CodeScopeKind
  label: string
  detail: string
  sources: CodeSource[]
}

export interface CodeLocation {
  source: string
  path: string
}

const BRANCH_TICKET = /(?:^|[/_-])([A-Za-z]{2,10})-(\d{3,})(?=$|[/_-])/
const PATH_TICKET = /(?:^|-)([A-Za-z]{2,10})-?(\d{4,})(?=$|-)/

export function repositoryShortLabel(source: CodeSource): string {
  return source.repositoryLabel.split('/').pop() || source.repositoryLabel
}

export function sourceBranchLabel(source: CodeSource): string {
  return source.branch ?? (source.head ? `HEAD détaché ${source.head.slice(0, 7)}` : 'HEAD détaché')
}

export function ticketKeyOfSource(source: CodeSource): string | null {
  const fromBranch = source.branch?.match(BRANCH_TICKET)
  if (fromBranch) return `${fromBranch[1]!.toUpperCase()}-${fromBranch[2]}`
  const fromPath = (source.path.split('/').pop() ?? '').match(PATH_TICKET)
  return fromPath ? `${fromPath[1]!.toUpperCase()}-${fromPath[2]}` : null
}

function preferredSource(candidates: CodeSource[]): CodeSource {
  return candidates.find((source) => source.branch !== null && !/-before$/i.test(source.path))
    ?? candidates.find((source) => !/-before$/i.test(source.path))
    ?? candidates[0]!
}

export function buildCodeScopes(sources: CodeSource[]): CodeScope[] {
  const byTicket = new Map<string, CodeSource[]>()
  for (const source of sources) {
    if (source.main) continue
    const key = ticketKeyOfSource(source)
    if (key) byTicket.set(key, [...(byTicket.get(key) ?? []), source])
  }

  const tickets: CodeScope[] = []
  for (const [key, candidates] of byTicket) {
    const repositories = [...new Set(candidates.map((source) => source.repositoryPath))]
    if (repositories.length < 2) continue
    const chosen = repositories.map((repository) => preferredSource(candidates.filter((source) => source.repositoryPath === repository)))
    tickets.push({ id: `ticket:${key}`, kind: 'ticket', label: key, detail: chosen.map(repositoryShortLabel).join(' + '), sources: chosen })
  }
  tickets.sort((left, right) => right.label.localeCompare(left.label, undefined, { numeric: true }))

  const mains = sources.filter((source) => source.main)
  const overview: CodeScope[] = mains.length > 1
    ? [{ id: 'mains', kind: 'mains', label: 'Tous les dépôts', detail: `${mains.length} checkouts principaux`, sources: mains }]
    : []

  const single = sources.map((source): CodeScope => ({
    id: `source:${source.path}`,
    kind: 'source',
    label: sourceBranchLabel(source),
    detail: source.repositoryLabel,
    sources: [source],
  }))
  return [...tickets, ...overview, ...single]
}

export function defaultCodeScope(scopes: CodeScope[], conversationId: string | null, worktreePath: string | null): string | null {
  const singles = scopes.filter((scope) => scope.kind === 'source').map((scope) => scope.sources[0]!)
  const chosen = conversationId
    ? singles.find((source) => !source.main && source.conversations.some((item) => item.id === conversationId))
      ?? singles.find((source) => source.path === worktreePath)
      ?? singles.find((source) => source.conversations.some((item) => item.id === conversationId))
    : undefined
  if (chosen) {
    const ticket = scopes.find((scope) => scope.kind === 'ticket' && scope.sources.some((source) => source.path === chosen.path))
    return ticket?.id ?? `source:${chosen.path}`
  }
  return scopes.find((scope) => scope.kind === 'source')?.id ?? null
}

export function codeScopeMatches(scope: CodeScope, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = [
    scope.label,
    scope.detail,
    ...scope.sources.flatMap((source) => [
      source.branch ?? '',
      source.repositoryLabel,
      source.path.split('/').pop() ?? '',
      ...source.conversations.map((item) => item.title),
    ]),
  ].join('\n').toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/** Préfixe de chaque worktree dans un état multi-dépôts ; vide quand un seul worktree est affiché. */
export function scopePrefixes(scope: CodeScope): Map<string, string> {
  const prefixes = new Map<string, string>()
  if (scope.sources.length < 2) {
    for (const source of scope.sources) prefixes.set(source.path, '')
    return prefixes
  }
  const shortLabels = scope.sources.map(repositoryShortLabel)
  scope.sources.forEach((source, index) => {
    const short = shortLabels[index]!
    const duplicated = shortLabels.filter((label) => label === short).length > 1
    prefixes.set(source.path, duplicated ? source.repositoryLabel.replaceAll('/', '-') : short)
  })
  return prefixes
}

export function toScopePath(scope: CodeScope, source: string, path: string): string {
  const prefix = scopePrefixes(scope).get(source) ?? ''
  return prefix ? `${prefix}/${path}` : path
}

export function fromScopePath(scope: CodeScope, display: string): CodeLocation | null {
  if (scope.sources.length === 1) return { source: scope.sources[0]!.path, path: display }
  for (const [source, prefix] of scopePrefixes(scope)) {
    if (display.startsWith(`${prefix}/`)) return { source, path: display.slice(prefix.length + 1) }
  }
  return null
}
