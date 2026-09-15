import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import type { GitBranchOption, GitWorkspaceSelection } from './types'
if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { BranchAutocomplete } = await import('./BranchAutocomplete')
afterEach(cleanup)

test('filtre les branches et sélectionne au clavier sans soumettre le formulaire', () => {
  let submitted = false
  function Form() {
    const [value, setValue] = useState('')
    const [selected, setSelected] = useState<GitWorkspaceSelection[]>([])
    const toggle = (branch: GitBranchOption) => {
      setValue(branch.name)
      setSelected([{ branch: branch.name, repositoryPath: branch.repositoryPath, repositoryLabel: branch.repositoryLabel }])
    }
    return createElement('form', { onSubmit: (event) => { event.preventDefault(); submitted = true } },
      createElement(BranchAutocomplete, { value, onChange: setValue, branches: [
        { name: 'master', fullName: 'refs/heads/master', sha: 'a', current: true, remote: false, repositoryPath: '/mono', repositoryLabel: 'mono' },
        { name: 'feature/search', fullName: 'refs/heads/feature/search', sha: 'b', current: false, remote: false, repositoryPath: '/mono/apps/web', repositoryLabel: 'apps/web' },
      ], selected, onToggle: toggle, disabled: false }))
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
  expect(screen.getByRole('listbox')).toBeTruthy()
  expect(submitted).toBe(false)
})

test('affiche le dépôt et permet de sélectionner plusieurs worktrees', () => {
  const chosen: GitBranchOption[] = []
  const branches: GitBranchOption[] = [
    { name: 'feature/TECH-25008', fullName: 'refs/heads/feature/TECH-25008', sha: 'a', current: true, remote: false, repositoryPath: '/mono/apps/hapigator', repositoryLabel: 'apps/hapigator' },
    { name: 'feature/TECH-25008', fullName: 'refs/heads/feature/TECH-25008', sha: 'b', current: true, remote: false, repositoryPath: '/mono/apps/reactor', repositoryLabel: 'apps/reactor' },
  ]
  render(createElement(BranchAutocomplete, {
    value: '25008',
    onChange: () => {},
    onToggle: (branch) => { chosen.push(branch) },
    selected: [{ branch: 'feature/TECH-25008', repositoryPath: '/mono/apps/hapigator', repositoryLabel: 'apps/hapigator' }],
    branches,
    disabled: false,
  }))

  fireEvent.focus(screen.getByRole('combobox'))
  expect(screen.getAllByRole('option')).toHaveLength(2)
  expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getAllByRole('option')[1]!)
  expect(chosen).toEqual([branches[1]])
})
