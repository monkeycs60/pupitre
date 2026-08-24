import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ConversationInstruction } = await import('./ConversationInstruction')

afterEach(cleanup)

test('affiche le snapshot injecté dans un dialogue en lecture seule', () => {
  render(createElement(ConversationInstruction, { instruction: 'Préserver la rétrocompatibilité.' }))

  fireEvent.click(screen.getByRole('button', { name: 'Instruction injectée' }))

  expect(screen.getByRole('dialog', { name: 'Instruction injectée' })).toBeTruthy()
  expect(screen.getByText('Préserver la rétrocompatibilité.')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
})
