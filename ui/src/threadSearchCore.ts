/**
 * Recherche dans le fil : collecte des occurrences comme des Ranges DOM,
 * surlignés ensuite via l'API CSS Custom Highlight. Les Ranges meurent à
 * chaque re-rendu React du fil : ils se recalculent, jamais ne se stockent.
 */

/** Deux caractères minimum : à un seul, tout le fil s'allume. */
export const SEARCH_MIN_LENGTH = 2

export function collectMatches(root: Node, query: string): Range[] {
  const needle = query.trim().toLowerCase()
  if (needle.length < SEARCH_MIN_LENGTH) return []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    // Une occurrence dans une carte outil repliée serait surlignée dans le
    // vide : on ne cherche que ce qui se voit.
    if ((node.parentElement?.closest('details:not([open])') ?? null) !== null) continue
    const text = (node.textContent ?? '').toLowerCase()
    let from = 0
    while (true) {
      const index = text.indexOf(needle, from)
      if (index === -1) break
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + needle.length)
      ranges.push(range)
      from = index + needle.length
    }
  }
  return ranges
}

const ALL_HIGHLIGHT = 'pupitre-search'
const CURRENT_HIGHLIGHT = 'pupitre-search-current'

interface HighlightRegistryLike {
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => void
}

function highlightRegistry(): HighlightRegistryLike | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return null
  return (CSS as unknown as { highlights: HighlightRegistryLike }).highlights
}

type HighlightConstructor = new (...ranges: Range[]) => unknown

function highlightConstructor(): HighlightConstructor | null {
  const candidate = (globalThis as Record<string, unknown>)['Highlight']
  return typeof candidate === 'function' ? candidate as HighlightConstructor : null
}

/** Peint toutes les occurrences, la courante à part. Sans l'API (vieux
 *  WebKit, happy-dom), la navigation au défilement reste fonctionnelle. */
export function paintMatches(ranges: Range[], currentIndex: number): void {
  const registry = highlightRegistry()
  const Highlight = highlightConstructor()
  if (registry === null || Highlight === null) return
  const others = ranges.filter((_, index) => index !== currentIndex)
  if (others.length === 0) registry.delete(ALL_HIGHLIGHT)
  else registry.set(ALL_HIGHLIGHT, new Highlight(...others))
  const current = ranges[currentIndex]
  if (current === undefined) registry.delete(CURRENT_HIGHLIGHT)
  else registry.set(CURRENT_HIGHLIGHT, new Highlight(current))
}

export function clearMatches(): void {
  const registry = highlightRegistry()
  if (registry === null) return
  registry.delete(ALL_HIGHLIGHT)
  registry.delete(CURRENT_HIGHLIGHT)
}

/** Centre le viewport sur l'occurrence, sans dépendre de scrollIntoView qui
 *  viserait le paragraphe entier. */
export function scrollToMatch(viewport: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect()
  const viewportRect = viewport.getBoundingClientRect()
  viewport.scrollTop += rect.top - viewportRect.top - viewport.clientHeight / 2
}
