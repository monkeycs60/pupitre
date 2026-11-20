import { describe, expect, test } from 'bun:test'
import { readShareLaunch, youtubeSharePrompt } from './share'

const at = (search: string, pathname = '/share') => readShareLaunch({ pathname, search })

describe('readShareLaunch', () => {
  test('ignore toute autre adresse que la cible de partage', () => {
    expect(at('?text=https://youtu.be/SiPGgGoMNYg', '/')).toBeNull()
  })

  test('lit le lien que l’app YouTube glisse dans le texte, sans son traceur', () => {
    expect(at(`?text=${encodeURIComponent('https://youtu.be/SiPGgGoMNYg?si=Ab12Cd34')}`))
      .toEqual({ youtubeUrl: 'https://youtu.be/SiPGgGoMNYg' })
  })

  test('accepte les formes longues, courtes, shorts et live, dans url ou title', () => {
    const cases = [
      `?url=${encodeURIComponent('https://www.youtube.com/watch?v=zjkBMFhNj_g&t=30s')}`,
      `?text=${encodeURIComponent('Regarde ça : https://m.youtube.com/watch?feature=share&v=zjkBMFhNj_g')}`,
      `?title=${encodeURIComponent('https://youtube.com/shorts/zjkBMFhNj_g')}`,
      `?text=${encodeURIComponent('https://www.youtube.com/live/zjkBMFhNj_g?si=x')}`,
    ]
    for (const search of cases) expect(at(search)).toEqual({ youtubeUrl: 'https://youtu.be/zjkBMFhNj_g' })
  })

  test('signale un partage sans lien YouTube exploitable', () => {
    expect(at(`?text=${encodeURIComponent('https://example.com/article')}`)).toEqual({ youtubeUrl: null })
    expect(at(`?text=${encodeURIComponent('https://youtu.be/trop-court')}`)).toEqual({ youtubeUrl: null })
    expect(at('')).toEqual({ youtubeUrl: null })
  })

  test('tolère la barre oblique finale', () => {
    expect(at(`?text=${encodeURIComponent('https://youtu.be/SiPGgGoMNYg')}`, '/share/'))
      .toEqual({ youtubeUrl: 'https://youtu.be/SiPGgGoMNYg' })
  })
})

test('le premier message invoque le skill youtube sur le lien normalisé, et rien d’autre', () => {
  expect(youtubeSharePrompt('https://youtu.be/SiPGgGoMNYg')).toBe('$youtube https://youtu.be/SiPGgGoMNYg')
})
