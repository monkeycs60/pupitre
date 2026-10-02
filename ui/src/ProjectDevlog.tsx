import { useState } from 'react'
import { launchRequest } from './api'
export function ProjectDevlog({ projectId }: { projectId: string }) {
  const [fromTag, setFromTag] = useState(''),
    [toTag, setToTag] = useState('')
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState('devlog'),
    [from, setFrom] = useState(
      new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
    ),
    [to, setTo] = useState(new Date().toISOString().slice(0, 10)),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  async function generate() {
    setBusy(true)
    try {
      await launchRequest(`/api/projects/${projectId}/devlog`, 'POST', {
        kind,
        from,
        to,
        fromTag: fromTag || undefined,
        toTag: toTag || undefined,
      })
      setMessage('Document publié dans la bibliothèque du projet.')
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section>
      <button className="secondary-button" onClick={() => setOpen(!open)}>
        Devlog et notes de version
      </button>
      {open && (
        <div>
          <label>
            Document
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="devlog">Devlog</option>
              <option value="release">Notes de version</option>
            </select>
          </label>
          <label>
            Du
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Au
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label>
            Tag de départ (facultatif)
            <input
              value={fromTag}
              onChange={(e) => setFromTag(e.target.value)}
            />
          </label>
          <label>
            Tag de fin
            <input value={toTag} onChange={(e) => setToTag(e.target.value)} />
          </label>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void generate()}
          >
            {busy ? 'Génération…' : 'Générer et publier'}
          </button>
          <p role="status">{message}</p>
        </div>
      )}
    </section>
  )
}
