import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { getDesignAccess } from './api'
import type { DesignAccess } from './types'

/** Claude Design (claude.ai/design) n'existe que sur le web : pas d'API, pas de
 *  CLI. Pupitre l'embarque donc dans une fenêtre native dédiée — l'iframe est
 *  exclue, claude.ai envoyant `X-Frame-Options: SAMEORIGIN`.
 *
 *  Cette fenêtre ne fonctionne qu'au prix d'un user-agent qui se déclare Safari
 *  sur macOS, parce que claude.ai refuse la signature de WebKitGTK (le moteur de
 *  webview de Tauri sur Linux). Ce filtre appartient à Anthropic et peut se
 *  resserrer sans préavis : cette vue teste donc l'accès AVANT d'ouvrir quoi que
 *  ce soit, et bascule sur le navigateur système plutôt que de laisser
 *  l'utilisateur devant une fenêtre affichant un JSON d'erreur. */

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type WindowState =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'open' }
  | { kind: 'failed'; message: string }

export function DesignView() {
  const [access, setAccess] = useState<DesignAccess | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [windowState, setWindowState] = useState<WindowState>({ kind: 'idle' })
  const [probeVersion, setProbeVersion] = useState(0)
  // L'ouverture est déclenchée par l'effet du probe, mais elle ne doit pas se
  // rejouer à chaque re-render : sans ce garde, revenir sur la vue rouvrirait
  // une fenêtre à chaque passage.
  const autoOpened = useRef(false)

  const openWindow = useCallback(async () => {
    setWindowState({ kind: 'opening' })
    try {
      await invoke('open_design_window')
      setWindowState({ kind: 'open' })
    } catch (reason) {
      setWindowState({ kind: 'failed', message: errorMessage(reason) })
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setAccess(null)
    setProbeError(null)
    void getDesignAccess(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setAccess(result)
        if (result.ok && isTauriRuntime() && !autoOpened.current) {
          autoOpened.current = true
          void openWindow()
        }
      })
      .catch((reason) => {
        if (controller.signal.aborted) return
        setProbeError(errorMessage(reason))
      })
    return () => controller.abort()
  }, [openWindow, probeVersion])

  async function openInBrowser() {
    const url = access?.url ?? 'https://claude.ai/design/'
    if (isTauriRuntime()) await openUrl(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  }

  const browserButton = (
    <button type="button" className="design-action" onClick={() => void openInBrowser()}>
      Ouvrir dans le navigateur
    </button>
  )

  return (
    <div className="design-view">
      <header className="design-header">
        <h1>Claude Design</h1>
        <p className="design-subtitle">
          Ouvert dans une fenêtre native, sur ta session claude.ai.
        </p>
      </header>

      <div className="design-body">
        {probeError !== null ? (
          <section className="design-card is-warning">
            <h2>Vérification impossible</h2>
            <p>
              Le sidecar n'a pas pu tester l'accès à Claude Design : {probeError}
            </p>
            <div className="design-actions">
              <button type="button" className="design-action" onClick={() => setProbeVersion((v) => v + 1)}>
                Réessayer
              </button>
              {browserButton}
            </div>
          </section>
        ) : access === null ? (
          <section className="design-card">
            <p className="design-checking">Vérification de l'accès à Claude Design…</p>
          </section>
        ) : access.ok === false && access.reason === 'ua-refused' ? (
          <section className="design-card is-refused">
            <h2>Claude Design a refusé la webview</h2>
            <p>
              claude.ai a rejeté l'user-agent de la fenêtre intégrée (HTTP {access.status}).
              C'est le risque connu de cette intégration : le filtre appartient à
              Anthropic et vient probablement de se resserrer.
            </p>
            <p>
              Rien à réparer côté Pupitre — passe par ton navigateur, où ta session
              fonctionne normalement.
            </p>
            <div className="design-actions">
              {browserButton}
              <button type="button" className="design-action is-quiet" onClick={() => setProbeVersion((v) => v + 1)}>
                Refaire le test
              </button>
            </div>
          </section>
        ) : access.ok === false ? (
          <section className="design-card is-warning">
            <h2>Claude Design est injoignable</h2>
            <p>
              {access.reason === 'unreachable'
                ? `Aucune réponse de claude.ai : ${access.message}. Vérifie ta connexion.`
                : `claude.ai répond en erreur (HTTP ${access.status}). Ce n'est pas un refus de la webview, plutôt une panne passagère côté Anthropic.`}
            </p>
            <div className="design-actions">
              <button type="button" className="design-action" onClick={() => setProbeVersion((v) => v + 1)}>
                Réessayer
              </button>
              {browserButton}
            </div>
          </section>
        ) : !isTauriRuntime() ? (
          <section className="design-card">
            <h2>Accès accordé</h2>
            <p>
              claude.ai accepte la webview, mais la fenêtre native n'existe que
              dans l'application Tauri — pas dans le navigateur de développement.
            </p>
            <div className="design-actions">{browserButton}</div>
          </section>
        ) : windowState.kind === 'failed' ? (
          <section className="design-card is-warning">
            <h2>Ouverture de la fenêtre impossible</h2>
            <p>{windowState.message}</p>
            <div className="design-actions">
              <button type="button" className="design-action" onClick={() => void openWindow()}>
                Réessayer
              </button>
              {browserButton}
            </div>
          </section>
        ) : (
          <section className="design-card is-open">
            <h2>{windowState.kind === 'opening' ? 'Ouverture…' : 'Fenêtre ouverte'}</h2>
            <p>
              Claude Design tourne dans une fenêtre dédiée. Sa taille et sa position
              sont mémorisées, et ta session claude.ai persiste entre les lancements.
            </p>
            <div className="design-actions">
              <button
                type="button"
                className="design-action"
                onClick={() => void openWindow()}
                disabled={windowState.kind === 'opening'}
              >
                Rouvrir la fenêtre
              </button>
              {browserButton}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
