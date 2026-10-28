import type { CSSProperties } from 'react'
import type { RunningApplication } from './api'
import { branchOfWorktree } from './conversationBranch'
import { ExternalLink } from './externalLink'
import type { Conversation } from './types'

const WELL_KNOWN_PORTS: Record<number, string> = {
  27017: 'mongo',
  6379: 'redis',
  5432: 'postgres',
  3306: 'mysql',
  9200: 'elastic',
}

/** « affilae-api » dans affilae-mono → « api » : le préfixe du projet n'apprend rien. */
export function applicationShortName(application: Pick<RunningApplication, 'name' | 'port'>, projectName: string): string {
  const known = WELL_KNOWN_PORTS[application.port]
  if (known) return known
  const name = application.name.replace(/^@[^/]+\//, '')
  const prefix = `${projectName.split(/[-_.]/)[0]}-`
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name
}

export function applicationColor(shortName: string): string {
  let hash = 0
  for (const char of shortName) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `var(--app-${(hash % 6) + 1})`
}

const TRUNK_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'staging', 'preprod', 'production'])

/** Le tronc est partagé par tout le monde : il ne rattache aucun serveur à une conversation. */
function normalizedBranch(branch: string | null | undefined): string | null {
  const name = branch ? branch.replace(/^(?:refs\/heads\/|origin\/)/, '').replace(/\//g, '-').toLowerCase() : null
  return name === null || TRUNK_BRANCHES.has(name) ? null : name
}

/** Serveurs de la branche ou du ticket d'une conversation, ports uniques. */
export function applicationsForConversation(
  applications: RunningApplication[],
  conversation: Pick<Conversation, 'project_id' | 'ticket_key' | 'worktree_path' | 'worktree_paths' | 'created_on_branch'>,
): RunningApplication[] {
  const paths = (conversation.worktree_paths?.length ? conversation.worktree_paths : [conversation.worktree_path])
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  const branch = normalizedBranch(branchOfWorktree(conversation.worktree_path) ?? conversation.created_on_branch)
  const seen = new Set<number>()
  return applications
    .filter((application) => {
      if (application.projectId !== conversation.project_id) return false
      if (conversation.ticket_key && application.ticket?.key === conversation.ticket_key) return true
      if (paths.some((path) => application.cwd === path || application.cwd.startsWith(`${path}/`))) return true
      return branch !== null && normalizedBranch(application.branch) === branch
    })
    .filter((application) => (seen.has(application.port) ? false : (seen.add(application.port), true)))
    .sort((left, right) => left.port - right.port)
}

/** `inert` : simple repère, sans lien, pour les lignes qui sont déjà un bouton. */
export function PortChip({ application, projectName, href, inert = false }: {
  application: RunningApplication
  projectName: string
  href?: string
  inert?: boolean
}) {
  const shortName = applicationShortName(application, projectName)
  const url = href ?? application.url
  const title = `${url} · ${application.name} · ${application.process} (PID ${application.pid})`
  const style = { '--app-color': applicationColor(shortName) } as CSSProperties
  const content = (
    <>
      <span className="port-chip-dot" aria-hidden="true" />
      <span className="port-chip-name">{shortName}</span>
      <span className="port-chip-port">{application.port}</span>
    </>
  )
  if (inert) return <span className="port-chip" title={title} style={style}>{content}</span>
  return <ExternalLink href={url} className="port-chip" title={title} style={style}>{content}</ExternalLink>
}
