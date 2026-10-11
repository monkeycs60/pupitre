import { useEffect, useMemo, useRef, useState } from 'react'
import { getCodeChanges, listCodeFiles, listCodeSources } from './api'
import { codeErrorMessage } from './codeFormat'
import { buildCodeScopes, defaultCodeScope, scopePrefixes } from './codeScopes'
import { CodeSourcePicker } from './CodeSourcePicker'
import {
  buildStructureTree,
  detectStructureSignals,
  summarizeStructure,
  type StructureNode,
  type StructureSignal,
  type StructureSourceInput,
} from './structureMap'
import type { CodeSource, Conversation, Project } from './types'

interface StructureViewProps {
  project: Project
  conversation: Conversation | null
  onOpenFile: (source: string, path: string) => void
}

interface LoadedScope {
  inputs: StructureSourceInput[]
  bases: string[]
  truncated: boolean
}

interface Flag {
  kind: StructureSignal['kind']
  severity: StructureSignal['severity']
  text: string
}

interface TreeContext {
  flags: ReadonlyMap<string, Flag[]>
  focus: ReadonlySet<string> | null
  collapsed: ReadonlySet<string>
  revealed: ReadonlySet<string>
  toggle: (id: string) => void
  reveal: (id: string) => void
  onOpenFile: (source: string, path: string) => void
}

const STATUS_LABELS: Record<string, string> = { A: 'créé', M: 'modifié', D: 'supprimé', R: 'renommé' }
const FLAG_LABELS: Record<StructureSignal['kind'], string> = {
  'new-directory': 'nouveau dossier',
  suspect: 'à vérifier',
  isolated: 'isolé',
  large: 'gros fichier',
  uncommitted: 'non commité',
  deleted: 'supprimé',
}

async function loadScope(projectId: string, sources: CodeSource[], prefixes: ReadonlyMap<string, string>, signal: AbortSignal): Promise<LoadedScope> {
  const loaded = await Promise.all(sources.map(async (source) => {
    const [files, changes] = await Promise.all([
      listCodeFiles(projectId, source.path, signal),
      getCodeChanges(projectId, source.path, signal),
    ])
    return { source, files, changes }
  }))
  return {
    inputs: loaded.map(({ source, files, changes }) => ({
      source: source.path,
      label: prefixes.get(source.path) || source.repositoryLabel.split('/').pop() || source.repositoryLabel,
      paths: files.paths,
      changes: changes.files,
      dirty: files.dirty,
    })),
    bases: [...new Set(loaded.map(({ changes }) => changes.base).filter((base): base is string => Boolean(base)))],
    truncated: loaded.some(({ files, changes }) => files.truncated || changes.filesTruncated),
  }
}

function byName(left: StructureNode, right: StructureNode): number {
  return left.name.localeCompare(right.name)
}

function churnWidth(value: number): number {
  return value > 0 ? Math.max(3, Math.round(Math.log2(value + 1) * 5)) : 0
}

function sumChurn(node: StructureNode, key: 'added' | 'removed'): number {
  return node.kind === 'file' ? node.file![key] : node.children.reduce((total, child) => total + sumChurn(child, key), 0)
}

function quietSummary(nodes: StructureNode[]): string {
  const directories = nodes.filter((node) => node.kind === 'dir').length
  const files = nodes.length - directories
  const parts: string[] = []
  if (directories > 0) parts.push(`${directories} dossier${directories > 1 ? 's' : ''}`)
  if (files > 0) parts.push(`${files} fichier${files > 1 ? 's' : ''}`)
  return `${parts.join(' et ')} sans changement`
}

function selfAndDescendantIds(node: StructureNode): string[] {
  return [node.id, ...node.children.flatMap(selfAndDescendantIds)]
}

function pathIds(root: StructureNode, targets: ReadonlySet<string>): Set<string> {
  const found = new Set<string>()
  const walk = (node: StructureNode): boolean => {
    let inside = targets.has(node.id)
    for (const child of node.children) if (walk(child)) inside = true
    if (inside) found.add(node.id)
    return inside
  }
  walk(root)
  return found
}

function ChurnBar({ added, removed }: { added: number, removed: number }) {
  return <span className="structure-churn" aria-hidden="true">
    <span className="structure-churn-added" style={{ width: churnWidth(added) }} />
    <span className="structure-churn-removed" style={{ width: churnWidth(removed) }} />
  </span>
}

function FlagChips({ flags }: { flags: Flag[] }) {
  return <>{flags.map((flag) => (
    <span key={flag.kind} className={`structure-flag is-${flag.severity}`} title={flag.text}>{FLAG_LABELS[flag.kind]}</span>
  ))}</>
}

function QuietRows({ id, nodes, context }: { id: string, nodes: StructureNode[], context: TreeContext }) {
  if (nodes.length === 0) return null
  const open = context.revealed.has(id)
  const sorted = [...nodes].sort((left, right) => Number(right.kind === 'dir') - Number(left.kind === 'dir') || byName(left, right))
  return <li className="structure-node">
    <button type="button" className="structure-row is-quiet-toggle" aria-expanded={open} onClick={() => context.reveal(id)}>
      <span className="structure-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span className="structure-name">{quietSummary(nodes)}</span>
    </button>
    {open ? <ul className="structure-children">
      {sorted.map((child) => <li key={child.id} className="structure-row is-quiet">
        <span className="structure-caret" aria-hidden="true" />
        <span className="structure-name">{child.name}{child.kind === 'dir' ? '/' : ''}</span>
        {child.kind === 'dir' ? <span className="structure-count">{child.total}</span> : null}
      </li>)}
    </ul> : null}
  </li>
}

function Children({ node, context }: { node: StructureNode, context: TreeContext }) {
  const touched = node.children.filter((child) => child.touched > 0)
  return <>
    {touched.filter((child) => child.kind === 'dir').sort(byName).map((child) => <DirectoryRows key={child.id} node={child} context={context} />)}
    {touched.filter((child) => child.kind === 'file').sort(byName).map((child) => <FileRow key={child.id} node={child} context={context} />)}
    <QuietRows id={node.id} nodes={node.children.filter((child) => child.touched === 0)} context={context} />
  </>
}

function DirectoryRows({ node, context }: { node: StructureNode, context: TreeContext }) {
  const chain = [node]
  let current = node
  while (current.children.length === 1 && current.children[0]!.kind === 'dir' && current.children[0]!.touched > 0) {
    current = current.children[0]!
    chain.push(current)
  }
  const flags = chain.flatMap((item) => context.flags.get(item.id) ?? [])
  const open = !context.collapsed.has(current.id)
  const dimmed = context.focus !== null && !chain.some((item) => context.focus!.has(item.id))

  return <li className="structure-node">
    <button
      type="button"
      className={`structure-row is-directory${chain.some((item) => item.isNew) ? ' is-new' : ''}${dimmed ? ' is-dimmed' : ''}`}
      aria-expanded={open}
      data-structure-id={current.id}
      onClick={() => context.toggle(current.id)}
    >
      <span className="structure-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span className="structure-name" title={current.display}>{chain.map((item) => item.name).join('/')}/</span>
      <FlagChips flags={flags} />
      <span className="structure-count">{current.touched} sur {current.total}</span>
      <ChurnBar added={sumChurn(current, 'added')} removed={sumChurn(current, 'removed')} />
    </button>
    {open ? <ul className="structure-children"><Children node={current} context={context} /></ul> : null}
  </li>
}

function FileRow({ node, context }: { node: StructureNode, context: TreeContext }) {
  const file = node.file!
  const dimmed = context.focus !== null && !context.focus.has(node.id)
  const className = `structure-row is-file${dimmed ? ' is-dimmed' : ''}`
  const content = <>
    <span className={`structure-status is-${file.status}`} title={STATUS_LABELS[file.status ?? 'M']}>{file.status}</span>
    <span className="structure-name">{node.name}</span>
    <FlagChips flags={context.flags.get(node.id) ?? []} />
    <span className="structure-count">{file.added + file.removed > 0 ? <><span className="is-added">+{file.added}</span> <span className="is-deleted">−{file.removed}</span></> : null}</span>
    <ChurnBar added={file.added} removed={file.removed} />
  </>
  return <li className="structure-node">
    {file.status === 'D'
      ? <div className={className} data-structure-id={node.id}>{content}</div>
      : <button type="button" className={className} data-structure-id={node.id} title={`Ouvrir ${node.display} dans Code`} onClick={() => context.onOpenFile(file.source, file.path)}>{content}</button>}
  </li>
}

export function StructureView({ project, conversation, onOpenFile }: StructureViewProps) {
  const conversationId = conversation?.id ?? null
  const [sources, setSources] = useState<CodeSource[] | null>(null)
  const [scopeId, setScopeId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedScope | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [activeSignal, setActiveSignal] = useState<StructureSignal['kind'] | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const treeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listCodeSources(project.id, controller.signal)
      .then((list) => { if (!controller.signal.aborted) setSources(list) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(codeErrorMessage(reason)) })
    return () => controller.abort()
  }, [project.id, revision])

  const scopes = useMemo(() => buildCodeScopes(sources ?? []), [sources])
  const activeScopeId = scopeId ?? defaultCodeScope(scopes, conversationId, conversation?.worktree_path ?? null, conversation?.created_on_branch ?? null)
  const scope = scopes.find((item) => item.id === activeScopeId) ?? null
  const scopeKey = scope ? `${scope.id}\n${scope.sources.map((source) => `${source.path}@${source.head ?? ''}`).join('\n')}` : ''

  useEffect(() => {
    if (!scope) return
    const controller = new AbortController()
    setLoaded(null)
    setError(null)
    setActiveSignal(null)
    setCollapsed(new Set())
    setRevealed(new Set())
    loadScope(project.id, scope.sources, scopePrefixes(scope), controller.signal)
      .then((data) => { if (!controller.signal.aborted) setLoaded(data) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(codeErrorMessage(reason)) })
    return () => controller.abort()
  }, [project.id, scopeKey, revision])

  const model = useMemo(() => {
    if (!loaded) return null
    const tree = buildStructureTree(loaded.inputs)
    const signals = detectStructureSignals(tree)
    const flags = new Map<string, Flag[]>()
    for (const signal of signals) {
      for (const entry of signal.nodes) {
        flags.set(entry.node.id, [...(flags.get(entry.node.id) ?? []), { kind: signal.kind, severity: signal.severity, text: entry.reason }])
      }
    }
    return { tree, signals, flags, summary: summarizeStructure(tree), roots: loaded.inputs.length > 1 ? tree.children : [tree] }
  }, [loaded])

  const signal = model?.signals.find((item) => item.kind === activeSignal) ?? null
  const focus = useMemo(() => {
    if (!model || !signal) return null
    return pathIds(model.tree, new Set(signal.nodes.flatMap((entry) => selfAndDescendantIds(entry.node))))
  }, [model, signal])

  function selectSignal(kind: StructureSignal['kind']) {
    const next = kind === activeSignal ? null : kind
    setActiveSignal(next)
    const target = next ? model?.signals.find((item) => item.kind === next)?.nodes[0]?.node : null
    if (!target || !model) return
    const path = pathIds(model.tree, new Set([target.id]))
    setCollapsed((current) => new Set([...current].filter((id) => !path.has(id))))
    const ids = new Set(selfAndDescendantIds(target))
    requestAnimationFrame(() => {
      const rows = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[data-structure-id]') ?? [])
      for (const row of rows) {
        if (!ids.has(row.dataset.structureId ?? '')) continue
        row.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
        break
      }
    })
  }

  function toggleIn(setter: typeof setCollapsed, id: string) {
    setter((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const summary = model?.summary ?? null
  const base = loaded?.bases.join(', ') || null
  const context: TreeContext | null = model ? {
    flags: model.flags,
    focus,
    collapsed,
    revealed,
    toggle: (id) => toggleIn(setCollapsed, id),
    reveal: (id) => toggleIn(setRevealed, id),
    onOpenFile,
  } : null

  return <div className="structure-view">
    <aside className="structure-panel" aria-label="Lecture du changement">
      <div className="structure-panel-head">
        <CodeSourcePicker scopes={scopes} value={activeScopeId} originConversationId={conversationId} onChange={setScopeId} />
        <button type="button" className="structure-refresh" title="Relire le dépôt" aria-label="Rafraîchir la structure" onClick={() => setRevision((value) => value + 1)}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>

      {summary ? <>
        <p className="structure-range">
          {base ? `Comparé à ${base}` : 'Aucune branche de base trouvée'}{loaded?.truncated ? ' · liste tronquée' : ''}
          {' · '}<span className="is-added">+{summary.added}</span> <span className="is-deleted">−{summary.removed}</span>
        </p>
        <dl className="structure-stats">
          <div><dt>Fichiers touchés</dt><dd>{summary.files}</dd></div>
          <div><dt>Créés</dt><dd className="is-added">{summary.created}</dd></div>
          <div><dt>Modifiés</dt><dd className="is-modified">{summary.modified}</dd></div>
          <div><dt>Supprimés</dt><dd className="is-deleted">{summary.deleted}</dd></div>
          <div><dt>Dossiers</dt><dd>{summary.directories}</dd></div>
        </dl>
      </> : null}

      {model && model.signals.length === 0 && summary && summary.files > 0 ? <p className="structure-quiet">Rien d’inhabituel dans l’emplacement des fichiers.</p> : null}

      {model && model.signals.length > 0 ? <div className="structure-signals">
        <h3>À regarder</h3>
        {model.signals.map((item) => (
          <button
            key={item.kind}
            type="button"
            className={`structure-signal is-${item.severity}${item.kind === activeSignal ? ' is-open' : ''}`}
            aria-pressed={item.kind === activeSignal}
            title={item.hint}
            onClick={() => selectSignal(item.kind)}
          >
            <span className="structure-signal-dot" aria-hidden="true" />
            <span className="structure-signal-label">{item.label}</span>
            <span className="structure-signal-count">{item.nodes.length}</span>
          </button>
        ))}
        {signal ? <p className="structure-signal-hint">{signal.hint} Le reste de l’arborescence est estompé.</p> : null}
      </div> : null}
    </aside>

    <div className="structure-tree" ref={treeRef}>
      {error ? <p className="structure-message is-error">{error}</p> : null}
      {!error && !loaded ? <p className="structure-message">Lecture du dépôt…</p> : null}
      {!error && summary && summary.files === 0 ? <p className="structure-message">Aucun fichier touché sur cette branche{base ? ` par rapport à ${base}` : ''}.</p> : null}
      {model && context && summary && summary.files > 0 ? <div className="structure-columns">
        {model.roots.filter((root) => root.touched > 0).map((root) => (
          <section key={root.id || 'root'} className="structure-column" aria-label={root.name || project.name}>
            {root.name ? <h2>{root.name}<span>{root.touched} fichier{root.touched > 1 ? 's' : ''} sur {root.total}</span></h2> : null}
            <ul className="structure-children is-root"><Children node={root} context={context} /></ul>
          </section>
        ))}
      </div> : null}
    </div>
  </div>
}
