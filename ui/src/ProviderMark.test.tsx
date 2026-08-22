import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { render } = await import('@testing-library/react')
const { ProviderMark } = await import('./ProviderMark')

test('rend les marques officielles comme SVG nus, sans conteneur décoratif', () => {
  for (const provider of ['sentry', 'claude', 'codex'] as const) {
    const { container, unmount } = render(createElement(ProviderMark, { provider }))
    const mark = container.firstElementChild
    expect(mark?.tagName.toLowerCase()).toBe('svg')
    expect(mark?.classList.contains(`is-${provider}`)).toBe(true)
    expect(mark?.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100)
    unmount()
  }
})
