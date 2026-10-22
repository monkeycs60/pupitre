import { describe, expect, test } from 'bun:test'
import { toggleAction, withTaskActions } from './taskDraft'
import { DEFAULT_ACTION_FORMAT } from './actionHeadings'
import type { TaskAction } from './taskToggle'

function action(scope: string, label: string): TaskAction {
  return { scope, label, index: 1, kind: 'follow-up' }
}

describe('toggleAction', () => {
  test('distingue deux actions de même rang provenant de messages différents', () => {
    const first = action('message-1', 'Première piste')
    const second = action('message-2', 'Deuxième piste')

    expect(toggleAction([first], second, true)).toEqual([first, second])
    expect(toggleAction([first, second], second, false)).toEqual([first])
  })
})

describe('withTaskActions', () => {
  const first: TaskAction = { scope: 'm', index: 1, label: 'Relancer les tests', kind: 'do-this' }
  const second: TaskAction = { scope: 'm', index: 2, label: 'Committer', kind: 'do-this' }
  const idea: TaskAction = { scope: 'm', index: 1, label: 'Ajouter un raccourci', kind: 'follow-up' }

  test('garde la note écrite après une action quand une autre case est cochée', () => {
    const draft = `${withTaskActions('Intro', [first])} mais seulement l'UI\net la sidecar aussi`

    expect(withTaskActions(draft, [first, second, idea])).toBe([
      'Intro',
      '',
      'Exécute les actions 1 et 2 du bloc DO THIS :',
      "1) Relancer les tests mais seulement l'UI",
      'et la sidecar aussi',
      '2) Committer',
      '',
      'Réalise la piste 1 du bloc FOLLOW-UP :',
      '1) Ajouter un raccourci',
    ].join('\n'))
  })

  test('retire la note avec la case décochée', () => {
    const draft = withTaskActions('', [first, second]).replace('2) Committer', '2) Committer en squash')

    expect(withTaskActions(draft, [first])).toBe(
      "Exécute l'action 1 du bloc DO THIS :\n1) Relancer les tests",
    )
    expect(withTaskActions(draft, [second])).toBe(
      "Exécute l'action 2 du bloc DO THIS :\n2) Committer en squash",
    )
  })

  test('recompose un brouillon restauré qui porte l\'ancien verbe Explore', () => {
    const restored = 'Note\n\nExplore la piste 1 du bloc FOLLOW-UP :\n1) Ajouter un raccourci en priorité'

    expect(withTaskActions(restored, [idea])).toBe(
      'Note\n\nRéalise la piste 1 du bloc FOLLOW-UP :\n1) Ajouter un raccourci en priorité',
    )
  })
})
