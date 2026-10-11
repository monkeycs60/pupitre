import { useEffect, useMemo, useRef, useState } from 'react'
import { getCodeChanges, listCodeFiles, listCodeSources } from './api'
import { codeErrorMessage } from './codeFormat'
import { buildCodeScopes, defaultCodeScope, scopePrefixes } from './codeScopes'
import { CodeSourcePicker } from './CodeSourcePicker'
import {
  buildStructureTree,
  detectStructureSignals,
  layoutStructure,
  pruneStructureTree,
  summarizeStructure,
  type StructureNode,
  type StructureSourceInput,
} from './structureMap'
import type { StructurePalette, StructureScene } from './StructureScene'
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

const STATUS_LABELS: Record<string, string> = { A: 'Créé', M: 'Modifié', D: 'Supprimé', R: 'Renommé' }

function readPalette(element: HTMLElement): StructurePalette {
  const styles = getComputedStyle(element)
  const token = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    background: token('--bg-workspace', '#1c1e23'),
    ground: token('--bg-app', '#17181c'),
    platform: token('--bg-raised', '#26282f'),
    platformTouched: token('--bg-overlay', '#2a2d35'),
    untouched: token('--text-faint', '#898691'),
    added: token('--ok', '#4ec9a5'),
    modified: token('--warn', '#f0a852'),
    deleted: token('--danger', '#f2555a'),
    renamed: token('--viz-1', '#3987e5'),
    highlight: token('--text-strong', '#fbf9fd'),
  }
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

export function StructureView({ project, conversation, onOpenFile }: StructureViewProps) {
  const conversationId = conversation?.id ?? null
  const [sources, setSources] = useState<CodeSource[] | null>(null)
  const [scopeId, setScopeId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedScope | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [activeSignal, setActiveSignal] = useState<string | null>(null)
  const [hover, setHover] = useState<{ node: StructureNode, x: number, y: number } | null>(null)
  const [selected, setSelected] = useState<StructureNode | null>(null)
  const [sceneError, setSceneError] = useState<string | null>(null)
  const [sceneReady, setSceneReady] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<StructureScene | null>(null)

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
    setSelected(null)
    setActiveSignal(null)
    loadScope(project.id, scope.sources, scopePrefixes(scope), controller.signal)
      .then((data) => { if (!controller.signal.aborted) setLoaded(data) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(codeErrorMessage(reason)) })
    return () => controller.abort()
  }, [project.id, scopeKey, revision])

  const model = useMemo(() => {
    if (!loaded) return null
    const tree = buildStructureTree(loaded.inputs)
    return {
      summary: summarizeStructure(tree),
      signals: detectStructureSignals(tree),
      layout: layoutStructure(pruneStructureTree(tree)),
    }
  }, [loaded])

  const openFileRef = useRef(onOpenFile)
  openFileRef.current = onOpenFile

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let disposed = false
    let created: StructureScene | null = null
    import('./StructureScene')
      .then(({ StructureScene: Scene }) => {
        if (disposed) return
        created = new Scene(stage, readPalette(stage), {
          onHover: (node, x, y) => setHover(node ? { node, x, y } : null),
          onSelect: (node) => setSelected(node),
        })
        sceneRef.current = created
        setSceneReady(true)
      })
      .catch(() => { if (!disposed) setSceneError('Le rendu 3D n’a pas pu démarrer sur cet écran.') })
    return () => {
      disposed = true
      created?.dispose()
      sceneRef.current = null
      setSceneReady(false)
    }
  }, [])

  useEffect(() => {
    if (model && sceneReady) sceneRef.current?.setLayout(model.layout)
  }, [model, sceneReady])

  const signal = model?.signals.find((item) => item.kind === activeSignal) ?? null
  useEffect(() => {
    sceneRef.current?.setHighlight(signal ? signal.nodes.flatMap((entry) => descendantIds(entry.node)) : [])
  }, [signal, model, sceneReady])

  function selectSignalNode(node: StructureNode) {
    setSelected(node)
    const scene = sceneRef.current
    if (scene && !scene.focus(node.id)) scene.focus(descendantIds(node)[0] ?? '')
  }

  const summary = model?.summary ?? null
  const base = loaded?.bases.join(', ') || null

  return <div className="structure-view">
    <aside className="structure-panel" aria-label="Lecture du changement">
      <div className="structure-panel-head">
        <CodeSourcePicker scopes={scopes} value={activeScopeId} originConversationId={conversationId} onChange={setScopeId} />
        <button type="button" className="structure-refresh" title="Relire le dépôt" aria-label="Rafraîchir la carte" onClick={() => setRevision((value) => value + 1)}>
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
        {model.signals.map((item) => {
          const open = item.kind === activeSignal
          return <section key={item.kind} className={`structure-signal is-${item.severity}${open ? ' is-open' : ''}`}>
            <button type="button" aria-expanded={open} onClick={() => setActiveSignal(open ? null : item.kind)}>
              <span className="structure-signal-dot" aria-hidden="true" />
              <span className="structure-signal-label">{item.label}</span>
              <span className="structure-signal-count">{item.nodes.length}</span>
            </button>
            {open ? <>
              <p className="structure-signal-hint">{item.hint}</p>
              <ul>
                {item.nodes.map((entry) => <li key={entry.node.id}>
                  <button type="button" className={selected?.id === entry.node.id ? 'is-selected' : ''} title={entry.node.display} onClick={() => selectSignalNode(entry.node)}>
                    <span className="structure-signal-path">{entry.node.display}</span>
                    <span className="structure-signal-reason">{entry.reason}</span>
                  </button>
                </li>)}
              </ul>
            </> : null}
          </section>
        })}
      </div> : null}

      {selected?.file ? <div className="structure-selection">
        <p className="structure-selection-path">{selected.display}</p>
        <p className="structure-selection-meta">
          {selected.file.status ? STATUS_LABELS[selected.file.status] : 'Inchangé'}
          {selected.file.status ? <> · <span className="is-added">+{selected.file.added}</span> <span className="is-deleted">−{selected.file.removed}</span></> : null}
          {selected.file.uncommitted ? ' · non commité' : ''}
        </p>
        {selected.file.status !== 'D' ? <button type="button" className="secondary-button" onClick={() => openFileRef.current(selected.file!.source, selected.file!.path)}>Ouvrir dans Code</button> : null}
      </div> : null}

      <ul className="structure-legend" aria-label="Légende">
        <li><span className="structure-swatch is-added" />Créé</li>
        <li><span className="structure-swatch is-modified" />Modifié</li>
        <li><span className="structure-swatch is-deleted" />Supprimé</li>
        <li><span className="structure-swatch is-untouched" />Voisin inchangé</li>
        <li className="structure-legend-note">Hauteur : lignes changées. Toit clair : non commité. Contour vert : nouveau dossier.</li>
      </ul>
    </aside>

    <div className="structure-stage" ref={stageRef}>
      {error ? <p className="structure-overlay is-error">{error}</p> : null}
      {sceneError ? <p className="structure-overlay is-error">{sceneError}</p> : null}
      {!error && !loaded ? <p className="structure-overlay">Lecture du dépôt…</p> : null}
      {!error && summary && summary.files === 0 ? <p className="structure-overlay">Aucun fichier touché sur cette branche{base ? ` par rapport à ${base}` : ''}.</p> : null}
      {hover ? <div className="structure-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
        <strong>{hover.node.display}</strong>
        {hover.node.file?.status
          ? <span>{STATUS_LABELS[hover.node.file.status]} · +{hover.node.file.added} −{hover.node.file.removed}{hover.node.file.uncommitted ? ' · non commité' : ''}</span>
          : <span>{hover.node.kind === 'block' ? `${hover.node.total} fichier${hover.node.total > 1 ? 's' : ''} inchangé${hover.node.total > 1 ? 's' : ''}` : 'Inchangé'}</span>}
      </div> : null}
      <button type="button" className="structure-recenter" onClick={() => sceneRef.current?.resetCamera()}>Recentrer</button>
    </div>
  </div>
}

function descendantIds(node: StructureNode): string[] {
  return node.kind === 'file' ? [node.id] : node.children.flatMap(descendantIds)
}
