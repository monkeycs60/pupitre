import { useEffect, useState } from 'react'
import { getProjectDashboard } from './api'
import type { TicketRow } from './types'

interface Props {
  projectId: string
  value: string | null
  onChange: (ticket: TicketRow | null) => void
  className?: string
}

export function TicketSelect({ projectId, value, onChange, className = 'todo-field' }: Props) {
  const [tickets, setTickets] = useState<TicketRow[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void getProjectDashboard(projectId, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setTickets(data.tickets) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [projectId])
  if (!tickets.length && !value && !error) return null
  return <label className={className}><span>Ticket</span><select aria-label="Ticket lié" value={value ?? ''} onChange={(event) => onChange(tickets.find((ticket) => ticket.id === event.target.value) ?? null)}>
    <option value="">Sans ticket</option>
    {value && !tickets.some((ticket) => ticket.id === value) ? <option value={value}>Ticket sélectionné</option> : null}
    {tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.key} · {ticket.title}</option>)}
  </select>{error ? <span role="status">Tickets indisponibles</span> : null}</label>
}
