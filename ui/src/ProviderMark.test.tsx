import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { render } = await import('@testing-library/react')
const { ProviderMark } = await import('./ProviderMark')

test('rend les marques officielles comme SVG nus, sans conteneur décoratif', () => {
  for (const provider of ['sentry', 'claude', 'codex', 'grok', 'reasonix'] as const) {
    const { container, unmount } = render(createElement(ProviderMark, { provider }))
    const mark = container.firstElementChild
    expect(mark?.tagName.toLowerCase()).toBe('svg')
    expect(mark?.classList.contains(`is-${provider}`)).toBe(true)
    expect(mark?.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(40)
    // Un acronyme en <text> n'est pas une marque : aucune ne doit en porter.
    expect(mark?.querySelector('text')).toBeNull()
    unmount()
  }
})

test('utilise le corail officiel Anthropic pour Claude', async () => {
  const tokens = await Bun.file(new URL('./styles/tokens.css', import.meta.url)).text()
  expect(tokens).toContain('--prov-claude: #d97757;')
})

test('utilise le monogramme Grok officiel sans conteneur', () => {
  const { container, unmount } = render(createElement(ProviderMark, { provider: 'grok' }))
  const mark = container.firstElementChild
  expect(mark?.getAttribute('viewBox')).toBe('0 0 34 33')
  expect(mark?.querySelector('path')?.getAttribute('d')).toContain('M13.2371 21.0407L24.3186 12.8506')
  expect(mark?.querySelectorAll('path')).toHaveLength(2)
  unmount()
})

test('utilise le logo OpenCode officiel pour l’abonnement OpenCode Go', () => {
  const { container, unmount } = render(createElement(ProviderMark, { provider: 'reasonix' }))
  const mark = container.firstElementChild
  // Cadré au plus près du tracé du logo officiel : ni rogné, ni flottant.
  expect(mark?.getAttribute('viewBox')).toBe('128 96 256 320')
  expect(mark?.getAttribute('aria-label')).toBe('OpenCode Go (Reasonix)')
  const paths = mark?.querySelectorAll('path')
  expect(paths).toHaveLength(2)
  // Cadre creusé à la règle pair-impair, puis carré intérieur.
  expect(paths?.[0].getAttribute('d')).toBe('M384 416H128V96H384V416ZM320 160H192V352H320V160Z')
  expect(paths?.[0].getAttribute('fill-rule')).toBe('evenodd')
  expect(paths?.[1].getAttribute('d')).toBe('M320 224V352H192V224H320Z')
  unmount()
})
