import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { BranchAutocomplete } = await import('./BranchAutocomplete')
afterEach(cleanup)

test('filtre les branches et sélectionne au clavier sans soumettre le formulaire', () => {
  let submitted = false
  function Form() {
    const [value, setValue] = useState('')
    return createElement('form', { onSubmit: (event) => { event.preventDefault(); submitted = true } },
      createElement(BranchAutocomplete, { value, onChange: setValue, branches: ['master', 'feature/search'], disabled: false }))
  }
  render(createElement(Form))
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: 'MAS' } })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option').id)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect((input as HTMLInputElement).value).toBe('master')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(submitted).toBe(false)
})
