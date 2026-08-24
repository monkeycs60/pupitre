import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { collectMatches } = await import('./threadSearchCore')

function root(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  return container
}

test('collecte toutes les occurrences, insensible à la casse', () => {
  const container = root('<p>Pour rappel, le Rappel du rappel.</p><p>Sans lien.</p>')
  const matches = collectMatches(container, 'rappel')
  expect(matches).toHaveLength(3)
  expect(matches.map((range) => range.toString())).toEqual(['rappel', 'Rappel', 'rappel'])
})

test('ignore les occurrences des cartes outil repliées', () => {
  const container = root(
    '<details><summary>outil</summary><pre>rappel caché</pre></details>'
    + '<details open><pre>rappel visible</pre></details>',
  )
  expect(collectMatches(container, 'rappel')).toHaveLength(1)
})

test('en dessous de deux caractères, rien ne s’allume', () => {
  const container = root('<p>aaaa</p>')
  expect(collectMatches(container, 'a')).toHaveLength(0)
  expect(collectMatches(container, '  ')).toHaveLength(0)
})

test('les occurrences successives d’un même nœud texte sont toutes trouvées', () => {
  const container = root('<p>abab</p>')
  const matches = collectMatches(container, 'ab')
  expect(matches).toHaveLength(2)
})
