import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { StreamBlock } from './groupEvents'
import { HighlightedEventsContext, highlightedBlockEvents } from './highlightedEvents'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { EventStream } = await import('./EventStream')

afterEach(cleanup)

const user = (id: number): StreamBlock => ({ kind: 'user', id: `user-${id}`, text: `question ${id}`, images: [], attachments: [] })
const say = (id: number): StreamBlock => ({ kind: 'assistant', id: `assistant-${id}`, text: `message ${id}`, streaming: false })
const tool = (id: number): StreamBlock => ({ kind: 'tool', id: `tool-${id}`, toolId: `t${id}`, toolName: 'Bash', input: { command: 'ls' }, output: 'ok', isError: false } as StreamBlock)
const footer = (id: number): StreamBlock => ({ kind: 'turn-footer', id: `footer-${id}`, status: { state: 'done' } } as StreamBlock)

// Deux tours terminés : les messages 11 et 21 sont repliés, 13 et 23 sont les réponses finales.
const blocks = [user(10), say(11), tool(12), say(13), footer(14), user(20), say(21), tool(22), say(23), footer(24)]

function stream(highlighted: number[]) {
  return createElement(HighlightedEventsContext.Provider, { value: new Set(highlighted) }, createElement(EventStream, { blocks, onImageOpen: () => {}, onImageLoad: () => {} }))
}

const groups = (root: Element) => [...root.querySelectorAll<HTMLElement>('.turn-work')]
const shown = (root: Element, id: number) => root.querySelector(`[data-event-id="${id}"]`) !== null

test('le groupe qui contient un passage surligné se déplie, sans toucher aux autres', () => {
  const view = render(stream([]))
  expect(groups(view.container).map((group) => group.classList.contains('is-open'))).toEqual([false, false])
  expect(shown(view.container, 21)).toBe(false)

  view.rerender(stream([21]))
  expect(groups(view.container).map((group) => group.classList.contains('is-open'))).toEqual([false, true])
  expect(groups(view.container)[1]!.classList.contains('is-revealed')).toBe(true)
  expect(groups(view.container)[1]!.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
  expect(shown(view.container, 21)).toBe(true)
  expect(shown(view.container, 11)).toBe(false)
})

test('un passage surligné dès l’ouverture du fil déplie son groupe au premier rendu', () => {
  const view = render(stream([11]))
  expect(groups(view.container)[0]!.classList.contains('is-open')).toBe(true)
  expect(shown(view.container, 11)).toBe(true)
})

test('une réponse finale déjà visible ne déplie rien', () => {
  const view = render(stream([13, 20]))
  expect(groups(view.container).map((group) => group.classList.contains('is-open'))).toEqual([false, false])
})

test('le groupe replié à la main le reste, jusqu’à un autre surlignage', () => {
  const view = render(stream([21]))
  fireEvent.click(groups(view.container)[1]!.querySelector('button')!)
  expect(groups(view.container)[1]!.classList.contains('is-open')).toBe(false)

  view.rerender(stream([21]))
  expect(groups(view.container)[1]!.classList.contains('is-open')).toBe(false)

  view.rerender(stream([]))
  expect(groups(view.container)[1]!.classList.contains('is-revealed')).toBe(false)
  view.rerender(stream([21]))
  expect(groups(view.container)[1]!.classList.contains('is-open')).toBe(true)
})

test('un événement se rattache au message qui l’affiche, même diffusé par morceaux', () => {
  expect([...highlightedBlockEvents(blocks, [11, 15, 23])]).toEqual([11, 13, 23])
  expect([...highlightedBlockEvents(blocks, [5])]).toEqual([])
  expect([...highlightedBlockEvents(blocks, [])]).toEqual([])
})
