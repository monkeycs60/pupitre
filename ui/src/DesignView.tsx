import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { getDesignReachability } from './api'
import { needsDesignLogin } from './designSession'
import type { DesignReachability } from './types'

/** Claude Design (claude.ai/design) n'existe que sur le web : pas d'API, pas de
 *  CLI. Pupitre l'embarque dans une webview enfant dockée sur la zone de contenu
 *  de la fenêtre principale — l'iframe est exclue, claude.ai envoyant
 *  `X-Frame-Options: SAMEORIGIN`.
 *
 *  Deux contraintes dictent la structure de ce composant :
 *
 *  1. Une webview est une surface de l'OS, dessinée AU-DESSUS du DOM. Tout ce
 *     que l'utilisateur doit pouvoir lire — titre, bannière, boutons — vit donc
 *     hors du rectangle réservé, et la webview est masquée dès qu'un overlay de
 *     l'application s'ouvre (`suspended`).
 *  2. La fenêtre ne se charge qu'avec un user-agent qui se déclare Safari macOS,
 *     claude.ai refusant la signature de WebKitGTK. Ce filtre appartient à
 *     Anthropic et n'est pas détectable avant l'ouverture : le repli navigateur
 *     est donc permanent plutôt que conditionnel. */

const DESIGN_URL_FALLBACK = 'https://claude.ai/design/'

const URL_POLL_MS = 2_500

interface DesignViewProps {
  /** Vrai quand un overlay de l'application est ouvert (palette Ctrl+K…).
   *  La webview doit alors disparaître, sinon elle le recouvre. */
  suspended?: boolean
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function DesignView({ suspended = false }: DesignViewProps) {
  const dockRef = useRef<HTMLDivElement | null>(null)
  const [dockError, setDockError] = useState<string | null>(null)
  const [needsLogin, setNeedsLogin] = useState(false)
  const [reachability, setReachability] = useState<DesignReachability | null>(null)

  const syncDock = useCallback(async () => {
    const element = dockRef.current
    if (element === null || !isTauriRuntime()) return
    const rect = element.getBoundingClientRect()
    try {
      await invoke('dock_design_webview', {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })
      setDockError(null)
    } catch (reason) {
      setDockError(errorMessage(reason))
    }
  }, [])

  const hideDock = useCallback(async () => {
    if (!isTauriRuntime()) return
    try {
      await invoke('hide_design_webview')
    } catch {
      // Masquer une webview absente n'est pas une erreur à remonter.
    }
  }, [])

  // Docke et suit la géométrie. Le ResizeObserver couvre le redimensionnement de
  // la fenêtre comme les changements de mise en page (largeur de sidebar…), que
  // l'événement `resize` seul manquerait.
  useEffect(() => {
    if (suspended) {
      void hideDock()
      return
    }
    void syncDock()
    const element = dockRef.current
    const observer = element === null ? null : new ResizeObserver(() => void syncDock())
    if (element !== null) observer?.observe(element)
    // La même référence de fonction pour l'ajout et le retrait : deux fermetures
    // distinctes laisseraient l'écouteur attaché après démontage.
    const handleResize = () => void syncDock()
    window.addEventListener('resize', handleResize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [hideDock, suspended, syncDock])

  // La webview survit à la sortie de la vue : la recréer rechargerait claude.ai
  // et ferait perdre le travail en cours. On la masque seulement.
  useEffect(() => () => void hideDock(), [hideDock])

  // Détecte la redirection vers la page marketing, seul signe observable d'une
  // session absente. C'est Rust qui lit l'URL : la page ne reçoit aucun IPC.
  useEffect(() => {
    if (!isTauriRuntime() || suspended) return
    let stopped = false
    async function check() {
      try {
        const url = await invoke<string | null>('design_webview_url')
        if (stopped || typeof url !== 'string') return
        setNeedsLogin(needsDesignLogin(url))
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
  }, [suspended])

  useEffect(() => {
    const controller = new AbortController()
    void getDesignReachability(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setReachability(result)
      })
      .catch(() => {
        // Complément d'explication seulement : son échec ne change rien au dock.
      })
    return () => controller.abort()
  }, [])

  const designUrl = reachability?.url ?? DESIGN_URL_FALLBACK

  async function openInBrowser() {
    if (isTauriRuntime()) await openUrl(designUrl)
    else window.open(designUrl, '_blank', 'noopener,noreferrer')
  }

  async function detachWindow() {
    await hideDock()
    try {
      await invoke('open_design_window')
    } catch (reason) {
      setDockError(errorMessage(reason))
    }
  }

  const offline = reachability !== null && !reachability.reachable

  return (
    <div className="design-view">
      <header className="design-header">
        <div className="design-heading">
          <h1>Claude Design</h1>
          <p className="design-subtitle">Intégré à la fenêtre, sur ta session claude.ai.</p>
        </div>
        <div className="design-actions">
          <button
            type="button"
            className="design-action is-quiet"
            onClick={() => void detachWindow()}
            disabled={!isTauriRuntime()}
          >
            Détacher dans une fenêtre
          </button>
          <button type="button" className="design-action is-quiet" onClick={() => void openInBrowser()}>
            Ouvrir dans le navigateur
          </button>
        </div>
      </header>

      {offline ? (
        <p className="design-banner is-warning">
          claude.ai est injoignable
          {reachability !== null && !reachability.reachable ? ` (${reachability.message})` : ''}.
          Vérifie ta connexion : ni la webview ni le navigateur n'iront plus loin.
        </p>
      ) : needsLogin ? (
        <p className="design-banner is-warning">
          Tu n'es pas connecté : claude.ai a renvoyé la webview vers sa page
          marketing. Connecte-toi une fois dans le panneau ci-dessous, la session
          persistera ensuite entre les lancements.
        </p>
      ) : dockError !== null ? (
        <p className="design-banner is-warning">
          Intégration impossible : {dockError}. Utilise « Détacher dans une
          fenêtre » ou le navigateur.
        </p>
      ) : !isTauriRuntime() ? (
        <p className="design-banner">
          La webview intégrée n'existe que dans l'application Tauri, pas dans le
          navigateur de développement.
        </p>
      ) : null}

      {/* Rectangle réservé : la webview native est positionnée exactement dessus,
          et le recouvre donc entièrement. Rien de lisible ne doit vivre ici. */}
      <div className="design-dock" ref={dockRef} aria-hidden="true" />
    </div>
  )
}
