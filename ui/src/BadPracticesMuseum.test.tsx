import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react')
const { BadPracticesMuseum } = await import('./BadPracticesMuseum')

afterEach(cleanup)

test('garde samples, shame et le journal global cohérents après des clics rapprochés et un remontage', () => {
  const view = render(createElement(BadPracticesMuseum))

  fireEvent.click(screen.getByRole('button', { name: 'Tout ouvrir' }))
  fireEvent.change(screen.getByLabelText('Nom du prochain responsable'), {
    target: { value: 'La release manager' },
  })

  const addButton = screen.getByRole('button', { name: 'Ajouter une dette' })
  act(() => {
    addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  expect(screen.getByLabelText('14 points de honte')).toBeTruthy()
  expect(screen.getByText('Incident #2 enregistré pour La release manager.')).toBeTruthy()
  expect(screen.getByText('Échantillons suspects : 5 · journal global : 2')).toBeTruthy()

  view.unmount()
  render(createElement(BadPracticesMuseum))
  fireEvent.click(screen.getByRole('button', { name: 'Tout ouvrir' }))

  expect(screen.getByLabelText('12 points de honte')).toBeTruthy()
  expect(screen.getByText('Échantillons suspects : 3 · journal global : 0')).toBeTruthy()
})

test('pilote le message de chaque musée avec son propre état React', () => {
  render(createElement('div', null, createElement(BadPracticesMuseum), createElement(BadPracticesMuseum)))

  const museums = screen.getAllByRole('region', { name: 'Musée des mauvaises pratiques' })
  const firstMuseum = museums[0]!
  const secondMuseum = museums[1]!

  fireEvent.click(within(secondMuseum).getByRole('button', { name: 'Tout ouvrir' }))
  fireEvent.click(within(secondMuseum).getByRole('button', { name: 'Peindre derrière React' }))

  expect(within(firstMuseum).getByText('Aucun incident déclaré.')).toBeTruthy()
  expect(within(secondMuseum).getByText(/^Le DOM a parlé à .+\.$/)).toBeTruthy()
})
