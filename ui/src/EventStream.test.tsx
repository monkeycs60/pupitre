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
  expect(screen.getByText('1 lecture · 1 recherche')).toBeTruthy()
  expect(group?.classList.contains('is-open')).toBe(false)
  expect(container.querySelectorAll('.tool-activity')).toHaveLength(2)
  cleanup()
})

test('montre une action isolée sans groupe repliable', () => {
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Read', input: { file_path: '/repo/src/a.ts', offset: 10, limit: 20 }, output: 'ok', images: [] },
  ]} />)

  expect(container.querySelector('.tool-activity-group')).toBeNull()
  expect(container.querySelector('.tool-activity-summary')).toBeNull()
  expect(container.querySelector('.tool-activity')?.textContent).toBe('Lecturesrc/a.ts L10-29')
  cleanup()
})

test('garde le groupe ouvert tant qu’une action est en cours', () => {
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Read', input: { file_path: '/tmp/a.ts' }, output: 'ok', images: [] },
    { kind: 'tool' as const, id: 'b', toolId: 'b', toolName: 'Grep', input: { pattern: 'route' }, images: [] },
  ]} />)

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
  expect(container.querySelectorAll('.tool-activity-solo')).toHaveLength(2)
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
  const running = [
    { kind: 'tool' as const, id: 'a', toolId: 'a', toolName: 'Read', input: { file_path: '/tmp/a.ts' }, output: 'ok', images: [] },
    { kind: 'tool' as const, id: 'b', toolId: 'b', toolName: 'Grep', input: { pattern: 'route' }, images: [] },
  ]
  const { container, rerender } = render(<EventStream {...callbacks} blocks={running} />)
  const group = container.querySelector('.tool-activity-group')
  expect(group?.classList.contains('is-open')).toBe(true)

  rerender(<EventStream {...callbacks} blocks={[running[0], { ...running[1], output: 'ok' }]} />)
  expect(container.querySelector('.tool-activity-group')).toBe(group)
  expect(group?.classList.contains('is-open')).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: /1 lecture · 1 recherche/ }))
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
  expect(container.querySelector('.tool-activity.is-error')?.textContent).toContain('échec')
  expect(container.querySelectorAll('.tool-activity.is-done')).toHaveLength(1)
  expect(container.querySelector('.tool-activity.is-done svg')).toBeNull()
  expect(screen.getByText('1 en échec')).toBeTruthy()
  cleanup()
})

test('garde ouvert un groupe dont une action a échoué pendant le tour en cours, même instantanément', () => {
  const user = { kind: 'user' as const, id: 'u', text: 'lance les tests', images: [], attachments: [] }
  const failed = { kind: 'tool' as const, id: 'a', toolId: 'a', toolName: 'Bash', input: { command: 'ls /x' }, output: 'No such file', isError: true, images: [] }
  const read = { kind: 'tool' as const, id: 'b', toolId: 'b', toolName: 'Read', input: { file_path: '/tmp/a.ts' }, output: 'ok', images: [] }
  const footer = (state: 'running' | 'done') => ({ kind: 'turn-footer' as const, id: 'f', status: { type: 'status' as const, state } })

  const { container, rerender } = render(<EventStream {...callbacks} blocks={[user, failed, read, footer('running')]} />)
  expect(container.querySelector('.tool-activity-group')?.classList.contains('is-open')).toBe(true)
  rerender(<EventStream {...callbacks} blocks={[user, failed, read, footer('done')]} />)
  expect(container.querySelector('.tool-activity-group')?.classList.contains('is-open')).toBe(true)
  cleanup()

  const history = render(<EventStream {...callbacks} blocks={[user, failed, read, footer('done')]} />)
  expect(history.container.querySelector('.tool-activity-group')?.classList.contains('is-open')).toBe(false)
  cleanup()
})

test('un clic sur une action terminée déplie la fin de sa sortie, puis le reste à la demande', async () => {
  const { fireEvent } = await import('@testing-library/react')
  const output = Array.from({ length: 25 }, (_, index) => `ligne ${index + 1}`).join('\n')
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Bash', input: { command: 'bun test' }, output: `\x1b[32m${output}\x1b[0m\n\n`, images: [] },
  ]} />)

  expect(container.querySelector('.tool-output')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Tests/ }))
  const pre = () => container.querySelector('.tool-output pre')?.textContent ?? ''
  expect(pre().split('\n')).toHaveLength(20)
  expect(pre().startsWith('ligne 6\n')).toBe(true)
  expect(pre().endsWith('ligne 25')).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: '5 lignes précédentes' }))
  expect(pre().split('\n')).toHaveLength(25)
  expect(pre()).not.toContain('\x1b')
  cleanup()
})

test('une action sans sortie ni résultat reste une ligne inerte', () => {
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Bash', input: { command: 'true' }, output: '  ', images: [] },
    { kind: 'tool', id: 'b', toolId: 'b', toolName: 'Bash', input: { command: 'sleep 9' }, images: [] },
  ]} />)

  expect(container.querySelectorAll('button.tool-activity')).toHaveLength(0)
  cleanup()
})

test('une modification se déplie en diff, et une lecture d’image en image sans JSON', async () => {
  const { fireEvent } = await import('@testing-library/react')
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'const a = 1', new_string: 'const a = 22' }, output: 'The file has been updated successfully.', images: [] },
    { kind: 'tool', id: 'b', toolId: 'b', toolName: 'Read', input: { file_path: '/repo/shot.png' }, output: '[{"type":"image","source":"[image importée]"}]', images: ['shot.png'] },
  ]} />)

  fireEvent.click(screen.getByRole('button', { name: /Modification/ }))
  expect([...container.querySelectorAll('.tool-diff-row')].map((line) => line.textContent)).toEqual(['−const a = 1', '+const a = 22'])
  expect(container.querySelector('.tool-diff-stats')?.textContent).toBe('+1−1')
  expect([...container.querySelectorAll('.tool-diff-word')].map((mark) => mark.textContent)).toEqual(['1', '22'])
  expect(container.textContent).not.toContain('updated successfully')

  fireEvent.click(screen.getByRole('button', { name: /^Lecture/ }))
  expect(container.querySelectorAll('.tool-output-images img')).toHaveLength(1)
  expect(container.textContent).not.toContain('"type":"image"')
  cleanup()
})
