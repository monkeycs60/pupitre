import { useId, useState } from 'react'

export function BranchAutocomplete({ value, branches, disabled, onChange }: {
  value: string
  branches: string[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const matches = branches.filter((branch) => branch.toLowerCase().includes(value.toLowerCase()))
  function choose(branch: string) {
    onChange(branch)
    setOpen(false)
    setActive(-1)
  }
  return <div className="branch-autocomplete">
    <input role="combobox" aria-label="Branche cible" aria-expanded={open} aria-controls={id}
      aria-autocomplete="list" aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
      value={value} placeholder="Branche de référence du projet" disabled={disabled}
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
    {open ? <ul className="branch-suggestions" id={id} role="listbox" aria-label="Branches existantes">
      {matches.map((branch, index) => <li role="option" id={`${id}-${index}`} aria-selected={active === index}
        key={branch} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(branch)}>{branch}</li>)}
      {!matches.length ? <li role="presentation">Aucune branche correspondante</li> : null}
    </ul> : null}
  </div>
}
