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

  const group = container.querySelector('details')
  expect(screen.getByText('2 actions effectuées')).toBeTruthy()
  expect(group?.open).toBe(false)
  expect(container.querySelectorAll('.tool-activity')).toHaveLength(2)
  cleanup()
})

test('garde le groupe ouvert tant qu’une action est en cours', () => {
  const { container } = render(<EventStream {...callbacks} blocks={[
    { kind: 'tool', id: 'a', toolId: 'a', toolName: 'Read', input: { file_path: '/tmp/a.ts' }, images: [] },
  ]} />)

  expect(screen.getByText('1 action en cours')).toBeTruthy()
  expect(container.querySelector('details')?.open).toBe(true)
  cleanup()
})
