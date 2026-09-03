import { useState } from 'react'
import { rotateVisualFeedbackPairing } from './api'

interface Props {
  initialPaired: boolean
  rotate?: () => Promise<{ token: string }>
}

export function VisualFeedbackSettings({
  initialPaired,
  rotate = rotateVisualFeedbackPairing,
}: Props) {
  const [paired, setPaired] = useState(initialPaired)
  const [loading, setLoading] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleRotate() {
    if (paired && !window.confirm('Révoquer le jeton actuellement utilisé par l’extension ?')) return
    setLoading(true)
    setError(null)
    try {
      const result = await rotate()
      setToken(result.token)
      setPaired(true)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function copyToken() {
    if (!token) return
    await navigator.clipboard.writeText(token)
  }

  return (
    <div className="settings-card">
      <div>
        <h2>Retours visuels Chrome</h2>
        <p>
          L’extension locale permet de pointer une zone sur un projet localhost,
          choisir sa branche et envoyer la correction dans une conversation.
        </p>
      </div>
      <div className="settings-token-heading">
        <strong>Extension Chrome</strong>
        <span aria-label="Statut extension Chrome">{loading ? 'vérification…' : paired ? 'appairée' : 'non appairée'}</span>
      </div>
      {token ? (
        <div className="settings-pairing-token">
          <label className="settings-select-label" htmlFor="visual-feedback-token">
            Jeton à saisir dans l’extension
            <input id="visual-feedback-token" value={token} readOnly />
          </label>
          <button type="button" className="secondary-button" onClick={() => void copyToken()}>Copier le jeton</button>
          <p className="settings-help">Ce jeton ne sera plus affiché après avoir quitté cet écran.</p>
        </div>
      ) : null}
      <button type="button" className="secondary-button" disabled={loading} onClick={() => void handleRotate()}>
        {paired ? 'Renouveler le jeton' : 'Générer un jeton'}
      </button>
      {error ? <p className="modal-error" role="alert">{error}</p> : null}
    </div>
  )
}
