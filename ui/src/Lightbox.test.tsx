import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { Lightbox } = await import('./Lightbox')

afterEach(cleanup)

test('zoome, réinitialise et ferme l’aperçu', () => {
  const onClose = mock(() => undefined)
  render(createElement(Lightbox, { src: '/capture.png', alt: 'Capture', onClose }))

  fireEvent.click(screen.getByRole('button', { name: 'Zoomer' }))
  expect(screen.getByRole('button', { name: 'Rétablir la taille de l’image' }).textContent).toBe('150 %')
  fireEvent.doubleClick(screen.getByRole('img', { name: 'Capture' }))
  expect(screen.getByRole('button', { name: 'Rétablir la taille de l’image' }).textContent).toBe('100 %')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('ferme au clic hors de l’image sans fermer au clic sur l’image', () => {
  const onClose = mock(() => undefined)
  render(createElement(Lightbox, { src: '/capture.png', alt: 'Capture', onClose }))

  fireEvent.click(document.querySelector('.lightbox-viewport')!)
  expect(onClose).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('img', { name: 'Capture' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})
