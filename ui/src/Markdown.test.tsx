import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Markdown from './Markdown'

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
