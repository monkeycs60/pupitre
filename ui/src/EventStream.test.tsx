import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, test } from 'bun:test'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { EventStream } = await import('./EventStream')

const callbacks = { onImageOpen: () => {}, onImageLoad: () => {} }

test('replie les actions consécutives lorsque leur exécution est terminée', () => {
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Read', input: { file_path: '/tmp/a.ts' }, output: 'ok', images: [] },
    { kind: 'tool', id: 'b', toolId: 'b', toolName: 'Grep', input: { pattern: 'route' }, output: 'ok', images: [] },
  ]} />)

  const group = container.querySelector('.tool-activity-group')
  expect(screen.getByText('2 actions effectuées')).toBeTruthy()
  expect(group?.classList.contains('is-open')).toBe(false)
  expect(container.querySelectorAll('.tool-activity')).toHaveLength(2)
  cleanup()
})

test('garde le groupe ouvert tant qu’une action est en cours', () => {
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Read', input: { file_path: '/tmp/a.ts' }, images: [] },
  ]} />)

  expect(screen.getByText('1 action en cours')).toBeTruthy()
  expect(container.querySelector('.tool-activity-group')?.classList.contains('is-open')).toBe(true)
  cleanup()
})

test('signale une tâche de fond entre deux groupes d’actions sans les fusionner', () => {
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Read', input: { file_path: '/tmp/a.ts' }, output: 'ok', images: [] },
    {
      kind: 'background-task',
      id: 'background-task-2',
      tasks: [{ status: 'completed', summary: 'Background command "Wait for recette results" completed (exit code 0)' }],
    },
    { kind: 'tool', id: 'b', toolId: 'b', toolName: 'Grep', input: { pattern: 'route' }, output: 'ok', images: [] },
  ]} />)

  expect(screen.getByText('Tâche de fond terminée')).toBeTruthy()
  expect(screen.getByText('Wait for recette results')).toBeTruthy()
  expect(container.querySelectorAll('.tool-activity-group')).toHaveLength(2)
  cleanup()
})

test('résume plusieurs tâches de fond sur une seule ligne', () => {
  const { container } = render(<EventStream {...callbacks} blocks={[
    {
      kind: 'background-task',
      id: 'background-task-1',
      tasks: [
        { status: 'stopped', summary: 'Background command "Wait for probe" was stopped' },
        { status: 'stopped', summary: 'Background command "Wait for recette" was stopped' },
        { status: 'stopped', summary: 'Monitor "fin de la mesure" stopped' },
      ],
    },
  ]} />)

  expect(container.querySelectorAll('.background-task-notice')).toHaveLength(1)
  expect(screen.getByText('3 tâches de fond arrêtées')).toBeTruthy()
  expect(screen.getByText('Wait for probe · Wait for recette · fin de la mesure')).toBeTruthy()
  cleanup()
})

test('annonce des statuts différents sans en choisir un', () => {
  render(<EventStream {...callbacks} blocks={[
    {
      kind: 'background-task',
      id: 'background-task-1',
      tasks: [
        { status: 'completed', summary: 'Background command "a" completed (exit code 0)' },
        { status: 'failed', summary: 'Background command "b" failed (exit code 1)' },
      ],
    },
  ]} />)

  expect(screen.getByText('2 tâches de fond signalées')).toBeTruthy()
  cleanup()
})

test('étiquette le pied d’un tour ouvert par l’agent', () => {
  render(<EventStream {...callbacks} blocks={[
    { kind: 'turn-footer', id: 'turn-footer-1-5', status: { type: 'status', state: 'done' }, origin: 'background-task' },
  ]} />)

  expect(screen.getByText('Réaction à une tâche de fond')).toBeTruthy()
  cleanup()
})

test('referme le groupe en fin d’exécution sans le remonter, et respecte un dépliage manuel', async () => {
  const { fireEvent } = await import('@testing-library/react')
  const running = [{ kind: 'tool' as const, id: 'a', toolId: 'a', toolName: 'Read', input: { file_path: '/tmp/a.ts' }, images: [] }]
  const { container, rerender } = render(<EventStream {...callbacks} blocks={running} />)
  const group = container.querySelector('.tool-activity-group')

  rerender(<EventStream {...callbacks} blocks={[{ ...running[0], output: 'ok' }]} />)
  expect(container.querySelector('.tool-activity-group')).toBe(group)
  expect(group?.classList.contains('is-open')).toBe(false)
  expect(container.querySelector('.tool-activity.is-fresh')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /1 action effectuée/ }))
  expect(group?.classList.contains('is-open')).toBe(true)
  expect(group?.classList.contains('is-auto')).toBe(false)
  cleanup()
})

test('signale une action en échec dans la ligne et dans le résumé du groupe', () => {
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Bash', input: { command: 'bun test' }, output: 'Exit code 1', isError: true, images: [] },
    { kind: 'tool', id: 'b', toolId: 'b', toolName: 'Read', input: { file_path: '/tmp/a.ts' }, output: 'ok', images: [] },
  ]} />)

  expect(container.querySelectorAll('.tool-activity.is-error')).toHaveLength(1)
  expect(container.querySelector('.tool-activity.is-error')?.textContent).toContain('en échec')
  expect(container.querySelectorAll('.tool-activity-pips i.is-error')).toHaveLength(1)
  expect(screen.getByText('1 en échec')).toBeTruthy()
  cleanup()
})
