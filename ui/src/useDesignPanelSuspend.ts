import { useEffect } from 'react'
import { suspendDesignPanel } from './designPanel'

/** Masque le panneau Claude Design tant que le calque appelant est ouvert.
 *
 *  À appeler depuis tout ce qui se dessine par-dessus la zone de contenu :
 *  palette, modales, lightbox. Le panneau est une webview, donc une surface de
 *  l'OS, et elle se dessine au-dessus du DOM quoi qu'en dise le `z-index`. Sans
 *  cet appel, un calque ouvert depuis la vue Design s'afficherait derrière elle.
 *
 *  Le masquage est compté, donc deux calques superposés se comportent
 *  correctement : le panneau ne revient qu'à la fermeture du dernier. */
export function useDesignPanelSuspend(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return suspendDesignPanel()
  }, [active])
}
