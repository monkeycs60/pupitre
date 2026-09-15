import { useId, useLayoutEffect, useRef, useState } from 'react'
import { BranchIcon } from './BranchIcon'
import type { GitBranchOption, GitWorkspaceSelection } from './types'

/** Le composer touche le bas de la fenêtre : la liste y remonte au lieu d'être coupée. */
function opensUpward(field: HTMLElement | null, placement: 'top' | 'bottom'): boolean {
  if (placement === 'bottom') return false
  const rect = field?.getBoundingClientRect()
  if (rect === undefined) return false
  return window.innerHeight - rect.bottom < 240
}

export function BranchAutocomplete({ value, branches, selected, currentBranch, disabled, placement = 'top', onChange, onToggle }: {
  value: string
  branches: GitBranchOption[]
  selected: GitWorkspaceSelection[]
  currentBranch?: string | null
  disabled: boolean
  placement?: 'top' | 'bottom'
  onChange: (value: string, repositoryPath: string | null) => void
  onToggle: (branch: GitBranchOption) => void
}) {
  const id = useId()
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [upward, setUpward] = useState(false)
  const [active, setActive] = useState(-1)
  const matches = branches.filter((branch) =>
    `${branch.name} ${branch.repositoryLabel}`.toLowerCase().includes(value.toLowerCase()))
  const selectedKeys = new Set(selected.map((item) => `${item.repositoryPath}\0${item.branch}`))

  useLayoutEffect(() => {
    if (open) setUpward(opensUpward(fieldRef.current, placement))
  }, [open, placement])

  function choose(branch: GitBranchOption) {
    onToggle(branch)
  }

  return <div className={`branch-field${open ? ' is-open' : ''}`} ref={fieldRef}>
    <BranchIcon className="branch-field-icon" />
    <input role="combobox" aria-label="Branche cible" aria-expanded={open} aria-controls={id}
      aria-autocomplete="list" aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
      value={value} placeholder={currentBranch ?? 'branche du projet'} disabled={disabled}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onChange={(event) => { onChange(event.target.value, null); setOpen(true); setActive(-1) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { setOpen(false); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setOpen(true)
          setActive((current) => matches.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : -1)
        }
        if (event.key === 'Enter' && open) {
          event.preventDefault()
          if (active >= 0 && matches[active]) choose(matches[active])
          else setOpen(false)
        }
      }} />
    {selected.length > 1 ? <span className="branch-field-count">{selected.length} dépôts</span> : null}
    {value !== '' ? <button type="button" className="branch-field-clear" aria-label="Revenir au dépôt principal"
      disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => onChange('', null)}>×</button> : null}
    {open ? <ul className={`branch-suggestions${upward ? ' is-up' : ''}`} id={id} role="listbox" aria-label="Branches existantes">
      {matches.map((branch, index) => {
        const checked = selectedKeys.has(`${branch.repositoryPath}\0${branch.name}`)
        return <li role="option" id={`${id}-${index}`} aria-selected={checked} className={active === index ? 'is-active' : undefined}
        key={`${branch.repositoryPath}:${branch.name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(branch)}>
        <span className="branch-suggestion-name">{checked ? <i aria-hidden="true">✓</i> : null}{branch.name}</span>
        <span className="branch-suggestion-repository">{branch.repositoryLabel}</span>
      </li>})}
      {!matches.length ? <li role="presentation">Aucune branche correspondante</li> : null}
    </ul> : null}
  </div>
}
