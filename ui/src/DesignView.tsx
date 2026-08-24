import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { getDesignReachability, getSettings, updateSettings } from './api'
import { needsDesignLogin, resumableDesignUrl } from './designSession'
import {
  boundsChanged,
  isDesignPanelSuspended,
  isPlaceable,
  onDesignPanelSuspendChange,
  panelBoundsFromRect,
  type PanelBounds,
} from './designPanel'
import { HelpLink } from './HelpLink'
import type { DesignReachability } from './types'
import { hasTauriRuntime } from './transport'

/** Claude Design (claude.ai/design) n'existe que sur le web : pas d'API, pas de
 *  CLI. Pupitre l'affiche donc dans une webview enfant posée sur la zone de
 *  contenu, le rail restant visible à sa gauche. L'iframe est impossible,
 *  claude.ai renvoyant `X-Frame-Options: SAMEORIGIN`.
 *
 *  Cette vue ne rend pas claude.ai : elle réserve un emplacement, en mesure la
 *  géométrie et la transmet à Rust, qui place la webview par-dessus. Tauri ne
 *  sait pas faire ce placement seul sous Linux — la raison est mesurée dans
 *  l'en-tête de `src-tauri/src/design_panel.rs`.
 *
 *  Deux conséquences à garder en tête. La webview est une surface de l'OS : elle
 *  se dessine au-dessus du DOM, donc tout calque doit la masquer, via
 *  `useDesignPanelSuspend`. Et elle ne se charge qu'avec un user-agent qui se
 *  déclare Safari macOS, claude.ai refusant la signature de WebKitGTK ; ce filtre
 *  appartient à Anthropic et n'est pas détectable à l'avance, donc les replis
 *  fenêtre et navigateur sont permanents plutôt que conditionnels. */

const DESIGN_URL_FALLBACK = 'https://claude.ai/design/'

const URL_POLL_MS = 2_500

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type PanelState =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'open' }
  | { kind: 'failed'; message: string }

export function DesignView() {
  const [panelState, setPanelState] = useState<PanelState>({ kind: 'idle' })
  const [suspended, setSuspended] = useState(isDesignPanelSuspended)
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
  const slotRef = useRef<HTMLDivElement | null>(null)
  const sentBounds = useRef<PanelBounds | null>(null)
  /** Dernier état de masquage appliqué, pour ne réagir qu'aux transitions. */
  const wasSuspended = useRef(false)

  const openPanel = useCallback(async (resumeUrl: string | null) => {
    setPanelState({ kind: 'opening' })
    try {
      await invoke('open_design_panel', { resumeUrl })
      setPanelState({ kind: 'open' })
    } catch (reason) {
      setPanelState({ kind: 'failed', message: errorMessage(reason) })
    }
  }, [])

  /** Repli explicite, laissé à la main de l'utilisateur : le placement du panneau
   *  repose sur un réarrangement de la hiérarchie GTK, et si une montée de version
   *  de Tauri le casse, cette fenêtre reste le chemin qui marche. */
  const openWindow = useCallback(async (resumeUrl: string | null) => {
    try {
      await invoke('set_design_panel_visible', { visible: false }).catch(() => {})
      await invoke('open_design_window', { resumeUrl })
    } catch (reason) {
      setPanelState({ kind: 'failed', message: errorMessage(reason) })
    }
  }, [])

  // Reprise : rouvrir sur la dernière page visitée plutôt que sur l'accueil.
  // Lue avant la première ouverture, le panneau ne consultant cette URL qu'à sa
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
    if (resume === undefined || autoOpened.current || !hasTauriRuntime()) return
    autoOpened.current = true
    void openPanel(resume)
  }, [openPanel, resume])

  // Le panneau ne survit pas à la sortie de la vue : il se dessine au-dessus du
  // DOM, donc le laisser visible le poserait sur la vue suivante. On le masque
  // plutôt que de le fermer, ce qui garde la page chargée et rend le retour
  // instantané.
  useEffect(() => {
    if (!hasTauriRuntime()) return
    return () => {
      sentBounds.current = null
      void invoke('set_design_panel_visible', { visible: false }).catch(() => {})
    }
  }, [])

  useEffect(() => onDesignPanelSuspendChange(setSuspended), [])

  // Placement. La zone de contenu bouge pour des raisons que Rust ignore :
  // largeur de la sidebar, rail déplié au survol, redimensionnement. On observe
  // donc l'emplacement réservé plutôt que de recalculer une géométrie en Rust.
  useEffect(() => {
    const slot = slotRef.current
    if (slot === null || !hasTauriRuntime()) return
    if (panelState.kind !== 'open') return

    function place() {
      const element = slotRef.current
      if (element === null) return
      const bounds = panelBoundsFromRect(element.getBoundingClientRect())
      if (!isPlaceable(bounds)) return
      if (!boundsChanged(sentBounds.current, bounds)) return
      sentBounds.current = bounds
      void invoke('set_design_panel_bounds', bounds).catch(() => {
        // Un placement refusé ne doit pas figer la vue : le prochain
        // redimensionnement retentera, et l'utilisateur garde les replis.
        sentBounds.current = null
      })
    }

    place()
    const observer = new ResizeObserver(place)
    observer.observe(slot)
    // `ResizeObserver` ne voit que la taille. Un déplacement à taille constante,
    // comme le repli de la sidebar, ne le déclenche pas.
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [panelState.kind])

  // Masquage sur calque. On ne réagit qu'aux transitions : au montage, c'est Rust
  // qui rend le panneau visible, et renvoyer un `visible: true` ici invaliderait
  // le placement qui vient d'être transmis. Au retour d'un masquage en revanche,
  // le placement est bien réinitialisé — la zone a pu bouger pendant que le
  // panneau était caché, et GTK ne l'a pas vu.
  useEffect(() => {
    if (!hasTauriRuntime() || panelState.kind !== 'open') return
    if (suspended === wasSuspended.current) return
    wasSuspended.current = suspended
    void invoke('set_design_panel_visible', { visible: !suspended }).catch(() => {})
    if (!suspended) sentBounds.current = null
  }, [panelState.kind, suspended])

  // Détecte la redirection vers la page marketing, seul signe observable d'une
  // session absente, et mémorise la page atteinte. C'est Rust qui lit l'URL : la
  // page distante ne reçoit aucun IPC.
  useEffect(() => {
    if (!hasTauriRuntime()) return
    let stopped = false
    async function check() {
      try {
        // Le panneau d'abord, la fenêtre séparée ensuite. Ce repli n'est pas
        // décoratif : c'est précisément quand le panneau est indisponible que
        // l'utilisateur bascule sur la fenêtre, et il y attend la même détection
        // de session absente.
        const url =
          (await invoke<string | null>('design_panel_url')) ??
          (await invoke<string | null>('design_webview_url'))
        if (stopped || typeof url !== 'string') return
        setNeedsLogin(needsDesignLogin(url))
        const resumable = resumableDesignUrl(url)
        if (resumable !== null && !popupsClosed.current) {
          // Le panneau est sur une page Claude Design : le flux de connexion est
          // terminé, donc toute popup encore ouverte n'est plus qu'un cadre vide
          // que wry n'a pas fermé.
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
    if (hasTauriRuntime()) await openUrl(designUrl)
    else window.open(designUrl, '_blank', 'noopener,noreferrer')
  }

  // Le panneau couvre l'emplacement dès qu'il est posé : afficher le texte
  // dessous ne servirait qu'à le voir réapparaître au moindre masquage.
  const covered = panelState.kind === 'open' && !offline && !needsLogin

  return (
    <div className="design-view">
      <div className="design-slot" ref={slotRef} aria-hidden={covered}>
        {covered ? null : (
          <div className="design-body">
            {offline ? (
              <section className="design-card is-warning">
                <h2>claude.ai est injoignable</h2>
                <p>
                  Aucune réponse de claude.ai
                  {reachability !== null && !reachability.reachable
                    ? ` : ${reachability.message}`
                    : ''}
                  . Ni le panneau ni le navigateur n'iront plus loin — c'est la
                  connexion réseau qu'il faut vérifier.
                </p>
              </section>
            ) : needsLogin ? (
              <section className="design-card is-warning">
                <h2>Tu n'es pas connecté</h2>
                <p>
                  claude.ai a renvoyé le panneau vers sa page marketing, faute de
                  session. Connecte-toi une fois dans le panneau : il a son propre
                  magasin de cookies, et la session persistera ensuite entre les
                  lancements.
                </p>
              </section>
            ) : panelState.kind === 'failed' ? (
              <section className="design-card is-warning">
                <h2>Panneau indisponible</h2>
                <p>{panelState.message}</p>
                <p>
                  Le placement du panneau repose sur la hiérarchie GTK de la
                  fenêtre, que Tauri ne garantit pas. Si elle a changé, la fenêtre
                  séparée reste le chemin qui fonctionne.
                </p>
              </section>
            ) : !hasTauriRuntime() ? (
              <section className="design-card">
                <h2>Panneau indisponible</h2>
                <p>
                  La webview enfant n'existe que dans l'application Tauri, pas dans
                  le navigateur de développement.
                </p>
              </section>
            ) : (
              <section className="design-card is-open">
                <h2>Ouverture…</h2>
                <p>Claude Design se charge sur ta session claude.ai.</p>
              </section>
            )}
          </div>
        )}
      </div>

      <footer className="design-escape">
        <p className="design-subtitle">
          Panneau intégré, sur ta session claude.ai.{' '}
          <HelpLink slug="design" label="Comprendre l'intégration" />
        </p>
        <div className="design-actions">
          <button
            type="button"
            className="design-action is-quiet"
            onClick={() => void openWindow(resume ?? null)}
            disabled={!hasTauriRuntime()}
          >
            Ouvrir dans une fenêtre séparée
          </button>
          <button
            type="button"
            className="design-action is-quiet"
            onClick={() => void openInBrowser()}
          >
            Ouvrir dans le navigateur
          </button>
        </div>
      </footer>
    </div>
  )
}
