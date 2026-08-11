import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { getDesignReachability } from './api'
import type { DesignReachability } from './types'

/** Claude Design (claude.ai/design) n'existe que sur le web : pas d'API, pas de
 *  CLI. Pupitre l'embarque donc dans une fenêtre native dédiée — l'iframe est
 *  exclue, claude.ai envoyant `X-Frame-Options: SAMEORIGIN`.
 *
 *  Cette fenêtre ne fonctionne qu'au prix d'un user-agent qui se déclare Safari
 *  sur macOS, parce que claude.ai refuse la signature de WebKitGTK (le moteur de
 *  webview de Tauri sur Linux). Ce filtre appartient à Anthropic et peut se
 *  resserrer sans préavis.
 *
 *  Ce risque ne peut PAS être détecté avant d'ouvrir : un `fetch` depuis le
 *  sidecar reçoit un 403 même avec l'user-agent exact de la fenêtre, Cloudflare
 *  discriminant sur l'empreinte TLS. Un preflight bloquerait donc la fenêtre en
 *  permanence alors qu'elle marche. Le repli est donc structurel plutôt que
 *  conditionnel : le bouton navigateur est toujours là, et cette vue explique
 *  quoi faire si la fenêtre affiche une erreur de claude.ai. */

const DESIGN_URL_FALLBACK = 'https://claude.ai/design/'

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
  const [windowState, setWindowState] = useState<WindowState>({ kind: 'idle' })
  const [reachability, setReachability] = useState<DesignReachability | null>(null)
  // L'ouverture automatique ne doit pas se rejouer à chaque re-render : sans ce
  // garde, revenir sur la vue rouvrirait une fenêtre à chaque passage.
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
    if (autoOpened.current || !isTauriRuntime()) return
    autoOpened.current = true
    void openWindow()
  }, [openWindow])

  useEffect(() => {
    const controller = new AbortController()
    void getDesignReachability(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setReachability(result)
      })
      .catch(() => {
        // La joignabilité n'est qu'un complément d'explication : son échec ne
        // doit rien changer à l'ouverture de la fenêtre.
      })
    return () => controller.abort()
  }, [])

  async function openInBrowser() {
    const url = reachability?.url ?? DESIGN_URL_FALLBACK
    if (isTauriRuntime()) await openUrl(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  }

  const offline = reachability !== null && !reachability.reachable

  return (
    <div className="design-view">
      <header className="design-header">
        <h1>Claude Design</h1>
        <p className="design-subtitle">
          Ouvert dans une fenêtre native, sur ta session claude.ai.
        </p>
      </header>

      <div className="design-body">
        {offline ? (
          <section className="design-card is-warning">
            <h2>claude.ai est injoignable</h2>
            <p>
              Aucune réponse de claude.ai
              {reachability !== null && !reachability.reachable ? ` : ${reachability.message}` : ''}.
              La fenêtre restera vide, et le navigateur n'ira pas plus loin — c'est
              la connexion réseau qu'il faut vérifier.
            </p>
          </section>
        ) : windowState.kind === 'failed' ? (
          <section className="design-card is-warning">
            <h2>Ouverture de la fenêtre impossible</h2>
            <p>{windowState.message}</p>
          </section>
        ) : !isTauriRuntime() ? (
          <section className="design-card">
            <h2>Fenêtre native indisponible</h2>
            <p>
              La fenêtre dédiée n'existe que dans l'application Tauri, pas dans le
              navigateur de développement.
            </p>
          </section>
        ) : (
          <section className="design-card is-open">
            <h2>{windowState.kind === 'opening' ? 'Ouverture…' : 'Fenêtre ouverte'}</h2>
            <p>
              Claude Design tourne dans une fenêtre dédiée. Sa taille et sa position
              sont mémorisées, et ta session claude.ai persiste entre les lancements.
            </p>
          </section>
        )}

        <section className="design-card design-escape">
          <h2>Si la fenêtre affiche une erreur</h2>
          <p>
            Pupitre présente à claude.ai un user-agent Safari macOS, sans quoi la
            webview est refusée. Ce filtre appartient à Anthropic : s'il se
            resserre, la fenêtre affichera un message d'erreur de claude.ai et il
            n'y aura rien à réparer côté Pupitre.
          </p>
          <p>Ton navigateur, lui, continuera de fonctionner normalement.</p>
          <div className="design-actions">
            <button
              type="button"
              className="design-action"
              onClick={() => void openWindow()}
              disabled={windowState.kind === 'opening' || !isTauriRuntime()}
            >
              Rouvrir la fenêtre
            </button>
            <button type="button" className="design-action" onClick={() => void openInBrowser()}>
              Ouvrir dans le navigateur
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
