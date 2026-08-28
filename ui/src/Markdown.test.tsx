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

  test('affiche une capture de réponse comme une vignette agrandissable', () => {
    const onImageOpen = mock(() => {})
    render(<Markdown onImageOpen={onImageOpen}>{'![Écran vérifié](/media/capture.png)'}</Markdown>)

    fireEvent.click(screen.getByRole('button', { name: 'Agrandir écran vérifié' }))

    expect(onImageOpen).toHaveBeenCalledWith('/media/capture.png', 'Écran vérifié')
  })
})

describe('Markdown actions', () => {
  test('réserve OU en majuscules aux choix des TODO', () => {
    expect(taskChoices('Qui réalise le commit : je le fais OU tu le fais', 'do-this')).toEqual({
      prompt: 'Qui réalise le commit',
      choices: ['je le fais', 'tu le fais'],
    })
    expect(taskChoices('Je le fais ou tu le fais', 'do-this')).toBeNull()
    expect(taskChoices('Piste A OU piste B', 'follow-up')).toBeNull()
  })

  test('nettoie le préfixe Choisis des anciennes réponses sans question séparée', () => {
    expect(taskChoices('Choisis Section A OU Section B', 'do-this')).toEqual({
      prompt: null,
      choices: ['Section A', 'Section B'],
    })
  })

  test('affiche les alternatives comme boutons et remonte le choix', () => {
    const toggle = mock(() => {})
    render(
      <TaskToggleContext.Provider value={toggle}>
        <TaskSelectionContext.Provider value={[]}>
          <Markdown scope="message-42">{'TODO\n\n1. Qui réalise le commit : je committe OU tu le fais'}</Markdown>
        </TaskSelectionContext.Provider>
      </TaskToggleContext.Provider>,
    )

    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText('Qui réalise le commit')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'tu le fais' }))
    expect(toggle).toHaveBeenCalledWith({
      scope: 'message-42',
      index: 1,
      kind: 'do-this',
      label: 'Réponse à « Qui réalise le commit » : tu le fais',
    }, true)
  })
})
