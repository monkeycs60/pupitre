import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { VisualFeedbackSettings } = await import('./VisualFeedbackSettings')

afterEach(cleanup)

test('génère et affiche le jeton une seule fois pour le copier', async () => {
  const rotate = mock(async () => ({ token: 'pairing-secret' }))
  render(createElement(VisualFeedbackSettings, { initialPaired: false, rotate }))
  expect(screen.getByText('non appairée')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Générer un jeton' }))
  expect(await screen.findByDisplayValue('pairing-secret')).toBeTruthy()
  expect(rotate).toHaveBeenCalledTimes(1)
});
