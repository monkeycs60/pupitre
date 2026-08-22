import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { render } = await import('@testing-library/react')
const { ProviderMark } = await import('./ProviderMark')

test('rend les marques officielles comme SVG nus, sans conteneur décoratif', () => {
  for (const provider of ['sentry', 'claude', 'codex', 'grok'] as const) {
    const { container, unmount } = render(createElement(ProviderMark, { provider }))
    const mark = container.firstElementChild
    expect(mark?.tagName.toLowerCase()).toBe('svg')
    expect(mark?.classList.contains(`is-${provider}`)).toBe(true)
    expect(mark?.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100)
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
