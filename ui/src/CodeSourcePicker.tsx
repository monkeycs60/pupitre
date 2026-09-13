import { useEffect, useRef, useState } from 'react'
import { BranchIcon } from './BranchIcon'
import { ProviderMark } from './ProviderMark'
import type { CodeSource } from './types'

interface CodeSourcePickerProps {
  sources: CodeSource[]
  value: string | null
  originConversationId: string | null
  onChange: (path: string) => void
}

function sourceKind(source: CodeSource, originConversationId: string | null): string {
  if (originConversationId && source.conversations.some((item) => item.id === originConversationId) && !source.main) {
    return 'Worktree de la conversation'
  }
  return source.main ? 'Checkout principal' : 'Worktree'
}

function branchLabel(source: CodeSource): string {
  return source.branch ?? (source.head ? `HEAD détaché ${source.head.slice(0, 7)}` : 'HEAD détaché')
}

export function CodeSourcePicker({ sources, value, originConversationId, onChange }: CodeSourcePickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const current = sources.find((source) => source.path === value) ?? null
  const repositories = [...new Set(sources.map((source) => source.repositoryLabel))]

  useEffect(() => {
    if (!open) return
    function handlePointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handlePointer)
    return () => window.removeEventListener('mousedown', handlePointer)
  }, [open])

  return <div
    className="code-source-picker"
    ref={rootRef}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        setOpen(false)
      }
    }}
  >
    <button
      type="button"
      className="code-source-button"
      aria-haspopup="menu"
      aria-expanded={open}
      title={current?.path}
      onClick={() => setOpen((value) => !value)}
    >
      <BranchIcon />
      <span className="code-source-button-text">
        {current && repositories.length > 1 ? <span className="code-source-repo">{current.repositoryLabel}</span> : null}
        <span className="code-source-branch">{current ? branchLabel(current) : 'Choisir un état du code'}</span>
        {current ? <span className="code-source-kind">{sourceKind(current, originConversationId)}</span> : null}
      </span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open ? <div className="code-source-menu" role="menu" aria-label="État du code">
      {repositories.map((repository) => <div className="code-source-group" key={repository}>
        {repositories.length > 1 ? <p className="code-source-group-label">{repository}</p> : null}
        {sources.filter((source) => source.repositoryLabel === repository).map((source) => {
          const isCurrent = source.path === value
          const isOrigin = originConversationId !== null && source.conversations.some((item) => item.id === originConversationId)
          return <button
            key={source.path}
            type="button"
            role="menuitemradio"
            aria-checked={isCurrent}
            className={`code-source-option${isCurrent ? ' is-current' : ''}`}
            title={source.path}
            onClick={() => {
              onChange(source.path)
              setOpen(false)
            }}
          >
            <span className="code-source-option-main">
              <span className="code-source-branch">{branchLabel(source)}</span>
              {source.main ? <span className="code-source-badge">principal</span> : null}
              {isOrigin ? <span className="code-source-badge is-origin">cette conversation</span> : null}
            </span>
            {source.conversations.length > 0 && !source.main ? <span className="code-source-conversations">
              {source.conversations.slice(0, 2).map((item) => <span key={item.id}>
                <ProviderMark provider={item.provider} />
                {item.title}
              </span>)}
              {source.conversations.length > 2 ? <span>+{source.conversations.length - 2}</span> : null}
            </span> : <span className="code-source-option-meta">{source.path}</span>}
          </button>
        })}
      </div>)}
    </div> : null}
  </div>
}
