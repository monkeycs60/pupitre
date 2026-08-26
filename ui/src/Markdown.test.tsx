import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Markdown, { taskChoices } from './Markdown'
import { TaskSelectionContext, TaskToggleContext } from './taskToggle'

afterEach(cleanup)

describe('Markdown code blocks', () => {
  test('copie le contenu brut depuis le bouton en haut du bloc', async () => {
    const writeText = mock(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    render(<Markdown>{'```text\nNotice à recopier\n```'}</Markdown>)
    fireEvent.click(screen.getByRole('button', { name: 'Copier le bloc' }))

    await screen.findByRole('button', { name: 'Copié' })
    expect(writeText).toHaveBeenCalledWith('Notice à recopier')
  })
})

describe('Markdown images', () => {
  test('sert les images importées par la route média du sidecar', () => {
    render(<Markdown>{'![Capture](/media/capture.png)'}</Markdown>)

    expect(screen.getByRole('img', { name: 'Capture' }).getAttribute('src')).toBe('/media/capture.png')
  })
})

describe('Markdown actions', () => {
  test('réserve OU en majuscules aux choix des TODO', () => {
    expect(taskChoices('Je le fais OU tu le fais', 'do-this')).toEqual(['Je le fais', 'tu le fais'])
    expect(taskChoices('Je le fais ou tu le fais', 'do-this')).toEqual([])
    expect(taskChoices('Piste A OU piste B', 'follow-up')).toEqual([])
  })

  test('affiche les alternatives comme boutons et remonte le choix', () => {
    const toggle = mock(() => {})
    render(
      <TaskToggleContext.Provider value={toggle}>
        <TaskSelectionContext.Provider value={[]}>
          <Markdown scope="message-42">{'TODO\n\n1. Je committe OU tu le fais'}</Markdown>
        </TaskSelectionContext.Provider>
      </TaskToggleContext.Provider>,
    )

    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'tu le fais' }))
    expect(toggle).toHaveBeenCalledWith({
      scope: 'message-42',
      index: 1,
      kind: 'do-this',
      label: 'Je committe OU tu le fais\nRéponse choisie : tu le fais',
    }, true)
  })
})
