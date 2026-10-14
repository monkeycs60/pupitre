import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, render, waitFor } = await import('@testing-library/react')
const { VscodeWebHost } = await import('./VscodeWebHost')
const defaultFetch = globalThis.fetch
;(window as unknown as { happyDOM?: { setURL(url: string): void } }).happyDOM?.setURL('http://localhost:5173/')

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('garde le VS Code de chaque conversation monté et ne montre que le sien', async () => {
  const asked: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const id = String(input).match(/conversations\/([^/]+)\/vscode-web/)![1]!
    asked.push(id)
    return Response.json({ url: `/vscode-web/?folder=/w/${id}` })
  }) as unknown as typeof fetch

  const view = render(createElement(VscodeWebHost, { active: true, conversationId: 'a', onBackToConversation: () => {} }))
  await waitFor(() => expect(document.querySelectorAll('iframe')).toHaveLength(1))
  view.rerender(createElement(VscodeWebHost, { active: true, conversationId: 'b', onBackToConversation: () => {} }))
  await waitFor(() => expect(document.querySelectorAll('iframe')).toHaveLength(2))

  const frames = [...document.querySelectorAll('iframe')]
  expect(frames.map((frame) => [new URL(frame.getAttribute('src')!, 'http://localhost').searchParams.get('folder'), frame.hidden])).toEqual([['/w/a', true], ['/w/b', false]])

  view.rerender(createElement(VscodeWebHost, { active: false, conversationId: 'b', onBackToConversation: () => {} }))
  expect(document.querySelector('.vscode-web-host')!.hasAttribute('hidden')).toBe(true)
  view.rerender(createElement(VscodeWebHost, { active: true, conversationId: 'a', onBackToConversation: () => {} }))
  expect(asked).toEqual(['a', 'b'])
  expect([...document.querySelectorAll('iframe')]).toEqual(frames)
  expect(frames.map((frame) => frame.hidden)).toEqual([false, true])
})

test('revient au fil quand VS Code transmet Ctrl+1, depuis sa propre origine seulement', async () => {
  globalThis.fetch = mock(async () => Response.json({ url: '/vscode-web/?folder=/w/a' })) as unknown as typeof fetch
  let back = 0
  render(createElement(VscodeWebHost, { active: true, conversationId: 'a', onBackToConversation: () => { back += 1 } }))
  await waitFor(() => expect(document.querySelectorAll('iframe')).toHaveLength(1))

  window.dispatchEvent(new MessageEvent('message', { data: { type: 'pupitre:conversation' }, origin: 'https://ailleurs.example' }))
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'pupitre:conversation' }, origin: location.origin }))
  expect(back).toBe(1)
})
