import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, test } from 'bun:test'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ToastHost } = await import('./ToastHost')
const { pushToast, removeToast, TOAST_LIMIT } = await import('./toasts')

test('affiche un toast cliquable puis le fait sortir après ouverture', () => {
  let opened = 0
  const { container } = render(<ToastHost />)
  act(() => { pushToast({ tone: 'ok', title: 'Tour terminé', detail: 'pupitre · Zoom', onOpen: () => { opened += 1 } }) })

  fireEvent.click(screen.getByText('Tour terminé'))
  expect(opened).toBe(1)
  expect(container.querySelector('.toast.is-leaving')).toBeTruthy()
  act(() => { for (const toast of [...container.querySelectorAll('.toast')]) removeToast(Number(toast.getAttribute('data-id'))) })
  cleanup()
})

test(`garde au plus ${TOAST_LIMIT} toasts à l’écran`, () => {
  const { container } = render(<ToastHost />)
  act(() => { for (let index = 0; index < TOAST_LIMIT + 2; index += 1) pushToast({ tone: 'info', title: `n${index}` }) })
  expect(container.querySelectorAll('.toast')).toHaveLength(TOAST_LIMIT)
  expect(screen.queryByText('n0')).toBeNull()
  cleanup()
})
