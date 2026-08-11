import { afterEach, expect, test } from 'bun:test'
import {
  boundsChanged,
  isDesignPanelSuspended,
  isPlaceable,
  onDesignPanelSuspendChange,
  panelBoundsFromRect,
  resetDesignPanelSuspend,
  suspendDesignPanel,
} from './designPanel'

afterEach(() => {
  resetDesignPanelSuspend()
})

test('arrondit les bords et non les dimensions', () => {
  // Une zone de contenu posée sur un bord non entier est le cas normal : la
  // sidebar est redimensionnable. Arrondir la largeur ferait déborder le panneau
  // d'un pixel sur elle, ce qui se voit.
  const bounds = panelBoundsFromRect({ left: 351.6, top: 38.2, right: 1279.4, bottom: 760.8 })
  expect(bounds).toEqual({ x: 352, y: 38, width: 927, height: 723 })
})

test('ne rend jamais une dimension nulle', () => {
  // WebKit se comporte mal à taille nulle.
  const bounds = panelBoundsFromRect({ left: 10, top: 10, right: 10, bottom: 10 })
  expect(bounds.width).toBe(1)
  expect(bounds.height).toBe(1)
})

test('refuse de placer un emplacement dégénéré', () => {
  // Vue masquée ou pas encore montée : il n'y a rien à placer, et envoyer ces
  // valeurs poserait le panneau dans un coin.
  expect(isPlaceable({ x: 0, y: 0, width: 1, height: 1 })).toBe(false)
  expect(isPlaceable({ x: 352, y: 38, width: 928, height: 722 })).toBe(true)
})

test('ne signale un changement que sur une géométrie réellement différente', () => {
  const bounds = { x: 352, y: 38, width: 928, height: 722 }
  expect(boundsChanged(null, bounds)).toBe(true)
  expect(boundsChanged(bounds, { ...bounds })).toBe(false)
  expect(boundsChanged(bounds, { ...bounds, x: 353 })).toBe(true)
  expect(boundsChanged(bounds, { ...bounds, height: 721 })).toBe(true)
})

test('le masquage se compte, pour survivre à deux calques superposés', () => {
  const changes: boolean[] = []
  onDesignPanelSuspendChange((suspended) => changes.push(suspended))

  const releasePalette = suspendDesignPanel()
  const releaseModal = suspendDesignPanel()
  expect(isDesignPanelSuspended()).toBe(true)

  // Fermer le premier calque ne doit pas faire réapparaître le panneau par-dessus
  // le second : la webview est une surface de l'OS, elle passerait devant.
  releasePalette()
  expect(isDesignPanelSuspended()).toBe(true)

  releaseModal()
  expect(isDesignPanelSuspended()).toBe(false)
  // Une notification à l'entrée, une à la sortie, rien entre les deux.
  expect(changes).toEqual([true, false])
})

test('relâcher deux fois le même masquage ne décompte qu’une fois', () => {
  // Un `useEffect` remonté peut appeler le nettoyage deux fois ; sans cette
  // garde, le compteur passerait sous zéro et le masquage suivant serait ignoré.
  const release = suspendDesignPanel()
  const other = suspendDesignPanel()
  release()
  release()
  expect(isDesignPanelSuspended()).toBe(true)
  other()
  expect(isDesignPanelSuspended()).toBe(false)
})
