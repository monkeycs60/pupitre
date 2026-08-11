/** Logique du panneau Claude Design intégré, sans React ni Tauri, pour être
 *  testable seule.
 *
 *  Le panneau est une webview enfant posée par Rust au-dessus de la zone de
 *  contenu. Le placement vient d'ici : le frontend mesure l'emplacement qu'il
 *  réserve dans le DOM et le transmet, parce que la zone bouge pour des raisons
 *  que Rust ne connaît pas — largeur de la sidebar, rail déplié au survol,
 *  redimensionnement de la fenêtre.
 *
 *  Voir `src-tauri/src/design_panel.rs` pour la partie GTK et pour la raison
 *  pour laquelle Tauri ne peut pas faire ce placement lui-même. */

export type PanelBounds = {
  x: number
  y: number
  width: number
  height: number
}

/** Convertit un rectangle DOM en bornes entières.
 *
 *  Les pixels CSS et les unités GTK sont tous deux logiques : il n'y a aucune
 *  correction d'échelle à appliquer, et en introduire une a déjà été une fausse
 *  piste. On arrondit les bords plutôt que la largeur, sans quoi un panneau posé
 *  sur un bord non entier déborde d'un pixel sur la sidebar. */
export function panelBoundsFromRect(rect: {
  left: number
  top: number
  right: number
  bottom: number
}): PanelBounds {
  const x = Math.round(rect.left)
  const y = Math.round(rect.top)
  return {
    x,
    y,
    width: Math.max(1, Math.round(rect.right) - x),
    height: Math.max(1, Math.round(rect.bottom) - y),
  }
}

/** Le placement a-t-il réellement bougé ?
 *
 *  Un `ResizeObserver` se déclenche aussi quand rien de significatif n'a changé.
 *  Chaque appel traverse l'IPC puis une dépêche sur le thread principal de GTK :
 *  les laisser passer tous ferait payer au panneau chaque frame d'animation du
 *  rail. */
export function boundsChanged(previous: PanelBounds | null, next: PanelBounds): boolean {
  if (previous === null) return true
  return (
    previous.x !== next.x ||
    previous.y !== next.y ||
    previous.width !== next.width ||
    previous.height !== next.height
  )
}

/** Un placement dégénéré ne doit pas être envoyé : la vue est masquée, en cours
 *  de montage, ou repliée. WebKit se comporte mal à taille nulle, et Rust
 *  planchérait la valeur sans que cela veuille dire quoi que ce soit. */
export function isPlaceable(bounds: PanelBounds): boolean {
  return bounds.width > 1 && bounds.height > 1
}

type SuspendListener = (suspended: boolean) => void

let suspendCount = 0
const listeners = new Set<SuspendListener>()

/** Demande le masquage du panneau, et rend la fonction qui le relâche.
 *
 *  Le comptage est indispensable : une webview est une surface de l'OS, elle se
 *  dessine au-dessus du DOM. Deux calques superposés — la palette puis une
 *  modale — relâcheraient sinon le masquage dès la fermeture du premier, et le
 *  panneau réapparaîtrait par-dessus le second.
 *
 *  La fonction rendue est idempotente : la rappeler ne décompte qu'une fois, ce
 *  qui protège du double appel d'un `useEffect` remonté. */
export function suspendDesignPanel(): () => void {
  suspendCount += 1
  if (suspendCount === 1) notify()
  let released = false
  return () => {
    if (released) return
    released = true
    suspendCount -= 1
    if (suspendCount === 0) notify()
  }
}

export function isDesignPanelSuspended(): boolean {
  return suspendCount > 0
}

export function onDesignPanelSuspendChange(listener: SuspendListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(): void {
  const suspended = suspendCount > 0
  for (const listener of listeners) listener(suspended)
}

/** Réservé aux tests : le compteur est un état de module, et un test qui laisse
 *  un masquage pendant fausserait le suivant. */
export function resetDesignPanelSuspend(): void {
  suspendCount = 0
  listeners.clear()
}
