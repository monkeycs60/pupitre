import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { getDesignReachability, getSettings, updateSettings } from './api'
import { needsDesignLogin, resumableDesignUrl } from './designSession'
import { HelpLink } from './HelpLink'
import type { DesignReachability } from './types'

/** Claude Design (claude.ai/design) n'existe que sur le web : pas d'API, pas de
 *  CLI. Pupitre l'ouvre donc dans une fenêtre native dédiée, et cette vue en est
 *  le panneau de pilotage — elle ne rend jamais claude.ai elle-même, l'iframe
 *  étant refusée par `X-Frame-Options: SAMEORIGIN`.
 *
 *  Une fenêtre séparée plutôt qu'un panneau intégré, et ce n'est pas un choix
 *  esthétique : le multiwebview de Tauri ne sait pas se positionner sous Linux.
 *  La webview enfant est empaquetée dans la GtkBox de la fenêtre, où `set_bounds`
 *  n'a aucun effet — elle partage alors l'espace verticalement avec l'interface.
 *  Voir `open_design_window` dans `src-tauri/src/lib.rs`.
 *
 *  Second point structurant : la fenêtre ne se charge qu'avec un user-agent qui
 *  se déclare Safari macOS, claude.ai refusant la signature de WebKitGTK. Ce
 *  filtre appartient à Anthropic et n'est pas détectable à l'avance, donc le
 *  repli navigateur est permanent plutôt que conditionnel. */

const DESIGN_URL_FALLBACK = 'https://claude.ai/design/'

const URL_POLL_MS = 2_500

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
  const [needsLogin, setNeedsLogin] = useState(false)
  const [reachability, setReachability] = useState<DesignReachability | null>(null)
  /** `undefined` : réglages pas encore lus. `null` : aucune reprise mémorisée. */
  const [resume, setResume] = useState<string | null | undefined>(undefined)
  /** Dernière valeur persistée, pour n'écrire que sur changement réel. */
  const savedResume = useRef<string | null>(null)
  const autoOpened = useRef(false)
  /** Une seule salve de nettoyage par visite : la commande est idempotente, mais
   *  la rappeler à chaque sondage serait du bruit pour rien. */
  const popupsClosed = useRef(false)

  const openWindow = useCallback(async (resumeUrl: string | null) => {
    setWindowState({ kind: 'opening' })
    try {
      // Ignorée si la fenêtre existe déjà : elle ne sert qu'à sa création.
      await invoke('open_design_window', { resumeUrl })
      setWindowState({ kind: 'open' })
    } catch (reason) {
      setWindowState({ kind: 'failed', message: errorMessage(reason) })
    }
  }, [])

  // Reprise : rouvrir sur la dernière page visitée plutôt que sur l'accueil.
  // Lue avant la première ouverture, la fenêtre ne consultant cette URL qu'à sa
  // création.
  useEffect(() => {
    const controller = new AbortController()
    void getSettings(controller.signal)
      .then((settings) => {
        if (controller.signal.aborted) return
        const url = resumableDesignUrl(settings.designLastUrl)
        savedResume.current = url
        setResume(url)
      })
      .catch(() => {
        // Réglages illisibles : ouvrir l'accueil plutôt que bloquer la vue.
        if (!controller.signal.aborted) setResume(null)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (resume === undefined || autoOpened.current || !isTauriRuntime()) return
    autoOpened.current = true
    void openWindow(resume)
  }, [openWindow, resume])

  // Détecte la redirection vers la page marketing, seul signe observable d'une
  // session absente, et mémorise la page atteinte. C'est Rust qui lit l'URL de la
  // fenêtre : la page distante ne reçoit aucun IPC.
  useEffect(() => {
    if (!isTauriRuntime()) return
    let stopped = false
    async function check() {
      try {
        const url = await invoke<string | null>('design_webview_url')
        if (stopped || typeof url !== 'string') return
        setNeedsLogin(needsDesignLogin(url))
        const resumable = resumableDesignUrl(url)
        if (resumable !== null && !popupsClosed.current) {
          // La fenêtre principale est sur une page Claude Design : le flux de
          // connexion est terminé, donc toute popup encore ouverte n'est plus
          // qu'un cadre vide que wry n'a pas fermé.
          popupsClosed.current = true
          void invoke('close_design_popups').catch(() => {})
        }
        if (resumable !== null && resumable !== savedResume.current) {
          // Mémorisé optimistement : un échec d'écriture ne doit pas relancer la
          // tentative à chaque sondage, ce qui martèlerait le sidecar.
          savedResume.current = resumable
          void updateSettings({ designLastUrl: resumable }).catch(() => {})
        }
      } catch {
        // URL illisible : ne rien conclure plutôt qu'alarmer à tort.
      }
    }
    void check()
    const timer = setInterval(() => void check(), URL_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void getDesignReachability(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setReachability(result)
      })
      .catch(() => {
        // Complément d'explication seulement : son échec ne change rien.
      })
    return () => controller.abort()
  }, [])

  const designUrl = reachability?.url ?? DESIGN_URL_FALLBACK
  const offline = reachability !== null && !reachability.reachable

  async function openInBrowser() {
    if (isTauriRuntime()) await openUrl(designUrl)
    else window.open(designUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="design-view">
      <header className="design-header">
        <div className="design-heading">
          <h1>Claude Design</h1>
          <p className="design-subtitle">
            Ouvert dans une fenêtre dédiée, sur ta session claude.ai.{' '}
            <HelpLink slug="design" label="Comprendre l'intégration" />
          </p>
        </div>
      </header>

      <div className="design-body">
        {offline ? (
          <section className="design-card is-warning">
            <h2>claude.ai est injoignable</h2>
            <p>
              Aucune réponse de claude.ai
              {reachability !== null && !reachability.reachable ? ` : ${reachability.message}` : ''}.
              Ni la fenêtre ni le navigateur n'iront plus loin — c'est la connexion
              réseau qu'il faut vérifier.
            </p>
          </section>
        ) : needsLogin ? (
          <section className="design-card is-warning">
            <h2>Tu n'es pas connecté</h2>
            <p>
              claude.ai a renvoyé la fenêtre vers sa page marketing, faute de
              session. Connecte-toi une fois dans la fenêtre Claude Design : elle a
              son propre magasin de cookies, et la session persistera ensuite entre
              les lancements.
            </p>
          </section>
        ) : windowState.kind === 'failed' ? (
          <section className="design-card is-warning">
            <h2>Ouverture impossible</h2>
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
              Claude Design tourne dans une fenêtre dédiée, qui rouvre sur la
              dernière page visitée. Sa taille et sa position sont mémorisées.
            </p>
          </section>
        )}

        <section className="design-card design-escape">
          <h2>Si la fenêtre affiche une erreur</h2>
          <p>
            Pupitre présente à claude.ai un user-agent Safari macOS, sans quoi la
            webview est refusée. Ce filtre appartient à Anthropic : s'il se
            resserre, la fenêtre affichera un message d'erreur de claude.ai et il
            n'y aura rien à réparer côté Pupitre. Ton navigateur, lui, continuera
            de fonctionner.
          </p>
          <div className="design-actions">
            <button
              type="button"
              className="design-action"
              onClick={() => void openWindow(resume ?? null)}
              disabled={windowState.kind === 'opening' || !isTauriRuntime()}
            >
              Rouvrir la fenêtre
            </button>
            <button type="button" className="design-action is-quiet" onClick={() => void openInBrowser()}>
              Ouvrir dans le navigateur
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
