import { useRef, useState } from 'react'
import { PROVIDER_MODELS } from './modelOptions'
import { buildTodoInput } from './todoDraft'
import { createTodo, startTodo, type TodoItem } from './todos'
import type { ConversationConfig } from './ConfigPanel'

/** Config d'exécution des tâches saisies à la volée, alignée sur TodoEditor. */
const QUICK_CONFIG: ConversationConfig = {
  presetId: null,
  provider: 'claude',
  model: PROVIDER_MODELS.claude[0],
  effort: 'high',
  speed: 'standard',
  permissionMode: null,
  orchestrator: true,
  subagentPresetId: null,
  subagentEffort: null,
}

interface Draft {
  id: string
  message: string
  branch: string
  integrate: boolean
  checks: string
  open: boolean
  busy: 'queue' | 'start' | null
  error: string | null
}

function draft(message: string): Draft {
  return { id: crypto.randomUUID(), message, branch: '', integrate: false, checks: '', open: false, busy: null, error: null }
}

export function TodoQuickAdd({ projectId, onCreated }: {
  projectId: string
  onCreated: (todo: TodoItem) => void
}) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [entry, setEntry] = useState('')
  const entryRef = useRef<HTMLInputElement>(null)

  function patch(id: string, change: Partial<Draft>) {
    setDrafts((current) => current.map((item) => item.id === id ? { ...item, ...change } : item))
  }

  function addLines(text: string) {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) return
    setDrafts((current) => [...current, ...lines.map(draft)])
    setEntry('')
  }

  async function submit(item: Draft, mode: 'queue' | 'start') {
    const message = item.message.trim()
    if (!message || item.busy !== null) return
    if (item.integrate && !item.checks.trim()) {
      patch(item.id, { open: true, error: 'Renseigne au moins une vérification avant d’autoriser le push.' })
      return
    }
    patch(item.id, { busy: mode, error: null })
    try {
      const input = buildTodoInput(
        { ...QUICK_CONFIG, branch: item.branch.trim() || undefined },
        { message, ticketId: null, integrate: item.integrate, autonomy: 'local', checks: item.checks, attachments: [] },
      )
      const created = await createTodo(projectId, input)
      if (mode === 'start') await startTodo(created.id)
      onCreated(created)
      setDrafts((current) => current.filter((candidate) => candidate.id !== item.id))
    } catch (failure) {
      patch(item.id, { busy: null, error: failure instanceof Error ? failure.message : 'Création impossible.' })
    }
  }

  async function queueAll() {
    for (const item of drafts) await submit(item, 'queue')
  }

  return (
    <section className="todo-quick" aria-label="Ajouter des tâches">
      <form
        className="todo-quick-entry"
        onSubmit={(event) => { event.preventDefault(); addLines(entry) }}
      >
        <input
          ref={entryRef}
          type="text"
          value={entry}
          placeholder="Une tâche par ligne, Entrée pour la suivante…"
          aria-label="Nouvelle tâche"
          onChange={(event) => setEntry(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text')
            if (!pasted.includes('\n')) return
            event.preventDefault()
            addLines(`${entry}${pasted}`)
          }}
        />
        <button type="submit" disabled={entry.trim().length === 0}>Ajouter</button>
      </form>

      {drafts.length === 0 ? null : (
        <ul className="todo-quick-list">
          {drafts.map((item) => (
            <li key={item.id} className={`todo-quick-row${item.open ? ' is-open' : ''}`}>
              <div className="todo-quick-line">
                <input
                  type="text"
                  value={item.message}
                  aria-label="Description de la tâche"
                  onChange={(event) => patch(item.id, { message: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    entryRef.current?.focus()
                  }}
                />
                <button
                  type="button"
                  className={`todo-quick-toggle${item.branch || item.integrate ? ' is-set' : ''}`}
                  aria-expanded={item.open}
                  aria-label="Branche et publication"
                  title="Branche et publication"
                  onClick={() => patch(item.id, { open: !item.open })}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="todo-quick-action"
                  disabled={item.busy !== null || item.message.trim().length === 0}
                  onClick={() => void submit(item, 'queue')}
                  title="Ajouter à la file"
                >
                  {item.busy === 'queue' ? 'File…' : 'File'}
                </button>
                <button
                  type="button"
                  className="todo-quick-action is-primary"
                  disabled={item.busy !== null || item.message.trim().length === 0}
                  onClick={() => void submit(item, 'start')}
                  title="Lancer la tâche maintenant"
                >
                  {item.busy === 'start' ? 'Départ…' : 'Lancer'}
                </button>
                <button
                  type="button"
                  className="todo-quick-remove"
                  aria-label="Retirer cette tâche"
                  onClick={() => setDrafts((current) => current.filter((candidate) => candidate.id !== item.id))}
                >
                  ×
                </button>
              </div>

              {item.open ? (
                <div className="todo-quick-options">
                  <label>
                    <span>Branche cible</span>
                    <input
                      type="text"
                      value={item.branch}
                      placeholder="main"
                      onChange={(event) => patch(item.id, { branch: event.target.value })}
                    />
                  </label>
                  <label className="todo-quick-integrate">
                    <input
                      type="checkbox"
                      checked={item.integrate}
                      onChange={(event) => patch(item.id, { integrate: event.target.checked })}
                    />
                    <span>Commiter et pousser après vérification</span>
                  </label>
                  {item.integrate ? (
                    <label>
                      <span>Vérifications, une commande par ligne</span>
                      <textarea
                        rows={2}
                        value={item.checks}
                        placeholder={'bun test\nbun run build'}
                        onChange={(event) => patch(item.id, { checks: event.target.value })}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}

              {item.error ? <p className="todo-quick-error" role="alert">{item.error}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {drafts.length > 1 ? (
        <button type="button" className="todo-quick-queue-all" onClick={() => void queueAll()}>
          Tout mettre en file ({drafts.length})
        </button>
      ) : null}

      <p className="todo-quick-note">Chaque tâche part dans son propre worktree. La file les enchaîne quand tu la lances.</p>
    </section>
  )
}
