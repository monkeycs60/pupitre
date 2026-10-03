import { useState } from 'react'
import { launchRequest } from './api'
export function AutomaticCalls() {
  const [rows, setRows] = useState<
      Array<{ day: string; kind: string; count: number }>
    >([]),
    [error, setError] = useState('')
  return (
    <section>
      <button
        className="secondary-button"
        onClick={() =>
          void launchRequest<typeof rows>('/api/automatic-calls')
            .then(setRows)
            .catch((e) => setError(String(e)))
        }
      >
        Appels automatiques par jour
      </button>
      {error && <p role="alert">{error}</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Jour</th>
              <th>Usage</th>
              <th>Appels</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.day}:${row.kind}`}>
                <td>{row.day}</td>
                <td>{row.kind}</td>
                <td>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
