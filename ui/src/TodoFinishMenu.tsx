import { useEffect, useRef, useState } from 'react'
import { Checkmark, Chevron } from './ModelConfigSelector'
import { TODO_FINISH_LABELS, type TodoFinish } from './todos'

const FINISH_HINTS: Record<TodoFinish, string> = {
  none: 'Changements laissés en place',
  commit: 'Commit local',
  commit_push: 'Commit puis push',
}

export function TodoFinishMenu({ value, onChange }: { value: TodoFinish; onChange: (value: TodoFinish) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function closeWhenClickingAway(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
    }
    document.addEventListener('mousedown', closeWhenClickingAway)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeWhenClickingAway)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className="composer-finish" ref={rootRef}>
      <button
        type="button"
        className="composer-finish-trigger"
        aria-label="Fin de tâche"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Ce que la file fait du résultat de l’agent"
        onClick={() => setOpen((current) => !current)}
      >
        {TODO_FINISH_LABELS[value]}
        <Chevron />
      </button>
      {open ? (
        <section className="model-strip-pop composer-finish-pop" role="menu" aria-label="Choisir la fin de tâche">
          {(Object.keys(TODO_FINISH_LABELS) as TodoFinish[]).map((option) => (
            <button
              type="button"
              key={option}
              role="menuitemradio"
              aria-checked={value === option}
              className={value === option ? 'is-selected' : ''}
              onClick={() => { onChange(option); setOpen(false) }}
            >
              <span className="model-strip-check-slot">{value === option ? <Checkmark /> : null}</span>
              <strong>{TODO_FINISH_LABELS[option]}</strong>
              <small>{FINISH_HINTS[option]}</small>
            </button>
          ))}
        </section>
      ) : null}
    </div>
  )
}
