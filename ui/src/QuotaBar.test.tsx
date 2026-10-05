import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterEach, expect, mock, test } from 'bun:test'
import type { QuotaSnapshot } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { QuotaBar, QuotaStatus } = await import('./QuotaBar')

afterEach(cleanup)

function staleSnapshot(): QuotaSnapshot {
  return {
    claude: {
      provider: 'claude',
      windows: [{ label: 'seven_day', usedPercent: 37, resetsAt: null, windowDurationMins: 10_080 }],
      updatedAt: '2026-08-22T15:44:37.047Z',
    },
    codex: null,
    grok: null,
  }
}

test('signale un quota périmé et permet de relancer sa relève', async () => {
  const snapshot = staleSnapshot()
  render(<QuotaStatus snapshot={snapshot} onRefresh={async () => snapshot} />)

  expect(screen.getByTitle(/^Données périmées · dernier relevé/).textContent).toBe('37 %')
  expect(screen.getByRole('meter').getAttribute('aria-label')).toContain('dernier relevé périmé')
  expect(screen.getByText('37 % au dernier relevé')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser les quotas' }))

  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Actualiser les quotas' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

test('un clic sur une jauge périmée lance la reconnexion du provider', async () => {
  const authenticate = mock(async () => staleSnapshot())
  render(
    <QuotaStatus
      snapshot={staleSnapshot()}
      onRefresh={async () => staleSnapshot()}
      onAuthenticate={authenticate}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: /Reconnecter Claude/ }))

  await waitFor(() => expect(authenticate).toHaveBeenCalledWith('claude'))
})

test('n’affiche que les providers choisis dans les réglages', () => {
  render(<QuotaStatus snapshot={staleSnapshot()} providers={['codex', 'grok']} onRefresh={async () => staleSnapshot()} />)

  const names = [...document.querySelectorAll('.quota-status-provider')].map((node) => node.textContent)
  expect(names).toEqual(['Codex', 'Grok'])
})

test('le panneau Quotas n’affiche que les providers retenus dans les réglages', () => {
  const { container } = render(<QuotaBar snapshot={staleSnapshot()} providers={['claude', 'codex']} />)

  const names = [...container.querySelectorAll('.quota-provider-name')].map((node) => node.textContent ?? '')
  expect(names).toHaveLength(2)
  expect(names.some((name) => name.includes('Grok'))).toBe(false)
  expect(names.some((name) => name.includes('OpenCode'))).toBe(false)
})
