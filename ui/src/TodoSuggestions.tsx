import { useState } from 'react'
import { acceptTodo, deleteTodo, type TodoItem } from './todos'

export function TodoSuggestions({ items, onChanged }: { items: TodoItem[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!items.length) return null
  async function act(id: string, action: () => Promise<unknown>) {
    setBusy(id)
    try { await action() } finally { setBusy(null); onChanged() }
  }
  return <section className="todo-suggestions" aria-label="Tâches suggérées">
    <h4>Tâches suggérées</h4>
    <ul>
      {items.map((item) => <li key={item.id}>
        <span title={item.message}>{item.title}</span>
        <button type="button" disabled={busy === item.id} onClick={() => void act(item.id, () => acceptTodo(item.id))}>Garder</button>
        <button type="button" disabled={busy === item.id} onClick={() => void act(item.id, () => deleteTodo(item.id))}>Écarter</button>
      </li>)}
    </ul>
  </section>
}
