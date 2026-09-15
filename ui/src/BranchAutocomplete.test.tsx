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
      createElement(BranchAutocomplete, { value, onChange: setValue, branches: [
        { name: 'master', fullName: 'refs/heads/master', sha: 'a', current: true, remote: false, repositoryPath: '/mono', repositoryLabel: 'mono' },
        { name: 'feature/search', fullName: 'refs/heads/feature/search', sha: 'b', current: false, remote: false, repositoryPath: '/mono/apps/web', repositoryLabel: 'apps/web' },
      ], disabled: false }))
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

test('affiche le dépôt et le renvoie avec la branche choisie', () => {
  let chosen: [string, string | null] | null = null
  render(createElement(BranchAutocomplete, {
    value: '25008',
    onChange: (branch, repositoryPath) => { chosen = [branch, repositoryPath] },
    branches: [{ name: 'feature/TECH-25008', fullName: 'refs/heads/feature/TECH-25008', sha: 'a', current: true, remote: false, repositoryPath: '/mono/apps/hapigator', repositoryLabel: 'apps/hapigator' }],
    disabled: false,
  }))

  fireEvent.focus(screen.getByRole('combobox'))
  expect(screen.getByText('apps/hapigator')).toBeTruthy()
  fireEvent.click(screen.getByRole('option'))
  expect(chosen).toEqual(['feature/TECH-25008', '/mono/apps/hapigator'])
})
