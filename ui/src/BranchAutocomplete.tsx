import { useId, useLayoutEffect, useRef, useState } from 'react'
import { BranchIcon } from './BranchIcon'

/** Le composer touche le bas de la fenêtre : la liste y remonte au lieu d'être coupée. */
function opensUpward(field: HTMLElement | null, placement: 'top' | 'bottom'): boolean {
  if (placement === 'bottom') return false
  const rect = field?.getBoundingClientRect()
  if (rect === undefined) return false
  return window.innerHeight - rect.bottom < 240
}

export function BranchAutocomplete({ value, branches, currentBranch, disabled, placement = 'top', onChange }: {
  value: string
  branches: string[]
  currentBranch?: string | null
  disabled: boolean
  placement?: 'top' | 'bottom'
  onChange: (value: string) => void
}) {
  const id = useId()
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [upward, setUpward] = useState(false)
  const [active, setActive] = useState(-1)
  const matches = branches.filter((branch) => branch.toLowerCase().includes(value.toLowerCase()))

  useLayoutEffect(() => {
    if (open) setUpward(opensUpward(fieldRef.current, placement))
  }, [open, placement])

  function choose(branch: string) {
    onChange(branch)
    setOpen(false)
    setActive(-1)
  }

  return <div className={`branch-field${open ? ' is-open' : ''}`} ref={fieldRef}>
    <BranchIcon className="branch-field-icon" />
    <input role="combobox" aria-label="Branche cible" aria-expanded={open} aria-controls={id}
      aria-autocomplete="list" aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
      value={value} placeholder={currentBranch ?? 'branche du projet'} disabled={disabled}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onChange={(event) => { onChange(event.target.value); setOpen(true); setActive(-1) }}
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
    {value !== '' ? <button type="button" className="branch-field-clear" aria-label="Revenir au dépôt principal"
      disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => onChange('')}>×</button> : null}
    {open ? <ul className={`branch-suggestions${upward ? ' is-up' : ''}`} id={id} role="listbox" aria-label="Branches existantes">
      {matches.map((branch, index) => <li role="option" id={`${id}-${index}`} aria-selected={active === index}
        key={branch} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(branch)}>{branch}</li>)}
      {!matches.length ? <li role="presentation">Aucune branche correspondante</li> : null}
    </ul> : null}
  </div>
}
