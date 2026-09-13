import { useEffect, useMemo, useRef, useState } from 'react'
import { BranchIcon } from './BranchIcon'
import { relativeCodeDate } from './codeFormat'
import { codeScopeMatches, isStaleScope, repositoryShortLabel, sourceBranchLabel, type CodeScope } from './codeScopes'
import { ProviderMark } from './ProviderMark'

interface CodeSourcePickerProps {
  scopes: CodeScope[]
  value: string | null
  originConversationId: string | null
  onChange: (scopeId: string) => void
}

function scopeKind(scope: CodeScope, originConversationId: string | null): string {
  if (scope.kind === 'ticket') return `Chantier sur ${scope.sources.length} dépôts`
  if (scope.kind === 'mains') return scope.detail
  const source = scope.sources[0]!
  if (source.ref !== null) return 'Branche sans worktree, lecture seule'
  if (originConversationId && !source.main && source.conversations.some((item) => item.id === originConversationId)) {
    return 'Worktree de la conversation'
  }
  return source.main ? 'Checkout principal' : 'Worktree'
}

function isOriginScope(scope: CodeScope, originConversationId: string | null): boolean {
  if (!originConversationId || scope.kind === 'mains') return false
  return scope.sources.some((source) => !source.main && source.conversations.some((item) => item.id === originConversationId))
}

export function CodeSourcePicker({ scopes, value, originConversationId, onChange }: CodeSourcePickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const current = scopes.find((scope) => scope.id === value) ?? null

  const hiddenCount = useMemo(
    () => (query ? 0 : scopes.filter((scope) => isStaleScope(scope) && scope.id !== value).length),
    [scopes, query, value],
  )
  const sections = useMemo(() => {
    const filtered = scopes.filter((scope) => (
      codeScopeMatches(scope, query) && (query !== '' || scope.id === value || !isStaleScope(scope))
    ))
    const result: Array<{ label: string, scopes: CodeScope[] }> = []
    const tickets = filtered.filter((scope) => scope.kind === 'ticket')
    if (tickets.length > 0) result.push({ label: 'Chantiers multi-dépôts', scopes: tickets })
    const overview = filtered.filter((scope) => scope.kind === 'mains')
    if (overview.length > 0) result.push({ label: 'Vue d’ensemble', scopes: overview })
    const singles = filtered.filter((scope) => scope.kind === 'source')
    for (const repository of [...new Set(singles.map((scope) => scope.detail))]) {
      const inRepository = singles.filter((scope) => scope.detail === repository)
      result.push({
        label: repository,
        scopes: [
          ...inRepository.filter((scope) => scope.sources[0]!.ref === null),
          ...inRepository.filter((scope) => scope.sources[0]!.ref !== null),
        ],
      })
    }
    return result
  }, [scopes, query, value])
  const ordered = sections.flatMap((section) => section.scopes)
  const boundedActive = Math.min(activeIndex, Math.max(ordered.length - 1, 0))

  useEffect(() => {
    if (!open) return
    function handlePointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handlePointer)
    return () => window.removeEventListener('mousedown', handlePointer)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, boundedActive])

  function openMenu() {
    setQuery('')
    setActiveIndex(Math.max(scopes.findIndex((scope) => scope.id === value), 0))
    setOpen(true)
  }

  function choose(scope: CodeScope | undefined) {
    if (!scope) return
    onChange(scope.id)
    setOpen(false)
    setQuery('')
  }

  return <div className="code-source-picker" ref={rootRef}>
    <button
      type="button"
      className="code-source-button"
      aria-haspopup="dialog"
      aria-expanded={open}
      title={current?.sources.map((source) => source.path).join('\n')}
      onClick={() => (open ? setOpen(false) : openMenu())}
    >
      <BranchIcon />
      <span className="code-source-button-text">
        {current ? <span className="code-source-repo">{current.kind === 'mains' ? 'Checkouts principaux' : current.detail}</span> : null}
        <span className="code-source-branch">{current?.label ?? 'Choisir un état du code'}</span>
        {current ? <span className="code-source-kind">{scopeKind(current, originConversationId)}</span> : null}
      </span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>

    {open ? <div className="code-source-menu" role="dialog" aria-label="Choisir l’état du code">
      <div className="code-source-filter">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3 3" /></g></svg>
        <input
          autoFocus
          type="search"
          value={query}
          placeholder="Filtrer : ticket, branche, dépôt, conversation"
          aria-label="Filtrer les états du code"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex(Math.min(boundedActive + 1, ordered.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex(Math.max(boundedActive - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              choose(ordered[boundedActive])
            } else if (event.key === 'Escape') {
              event.preventDefault()
              if (query) setQuery('')
              else setOpen(false)
            }
          }}
        />
        <span className="code-source-count">{ordered.length}</span>
      </div>
      <div className="code-source-list" role="listbox" aria-label="États du code" ref={listRef}>
        {ordered.length === 0 ? <p className="code-empty-note">Aucun état du code ne correspond.</p> : null}
        {hiddenCount > 0
          ? <p className="code-truncated-note">{hiddenCount} branches sans commit depuis quatre mois sont masquées : filtre pour les retrouver.</p>
          : null}
        {sections.map((section) => <div className="code-source-group" key={section.label}>
          <p className="code-source-group-label">{section.label}</p>
          {section.scopes.map((scope) => {
            const index = ordered.indexOf(scope)
            const isCurrent = scope.id === value
            const source = scope.sources[0]!
            return <button
              key={scope.id}
              type="button"
              role="option"
              aria-selected={isCurrent}
              data-active={index === boundedActive}
              className={`code-source-option${isCurrent ? ' is-current' : ''}${index === boundedActive ? ' is-active' : ''}`}
              title={scope.sources.map((item) => item.path).join('\n')}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(scope)}
            >
              <span className="code-source-option-main">
                <span className="code-source-branch">{scope.label}</span>
                {scope.kind === 'source' && source.main ? <span className="code-source-badge">principal</span> : null}
                {scope.kind === 'source' && source.ref !== null
                  ? <span className="code-source-badge">{source.ref === source.branch ? 'branche' : 'branche distante'}</span>
                  : null}
                {isOriginScope(scope, originConversationId) ? <span className="code-source-badge is-origin">cette conversation</span> : null}
              </span>
              {scope.kind === 'ticket' ? <span className="code-source-repos">
                {scope.sources.map((item) => <span key={item.path}><strong>{repositoryShortLabel(item)}</strong> {sourceBranchLabel(item)}</span>)}
              </span> : null}
              {scope.kind === 'mains' ? <span className="code-source-option-meta">{scope.sources.map(repositoryShortLabel).join(', ')}</span> : null}
              {scope.kind === 'source' && source.ref !== null
                ? <span className="code-source-option-meta">Dernier commit {relativeCodeDate(source.updatedAt)}</span>
                : null}
              {scope.kind === 'source' && source.ref === null ? (source.conversations.length > 0 && !source.main
                ? <span className="code-source-conversations">
                  {source.conversations.slice(0, 2).map((item) => <span key={item.id}><ProviderMark provider={item.provider} />{item.title}</span>)}
                  {source.conversations.length > 2 ? <span>+{source.conversations.length - 2}</span> : null}
                </span>
                : <span className="code-source-option-meta">{source.path}</span>) : null}
            </button>
          })}
        </div>)}
      </div>
    </div> : null}
  </div>
}
