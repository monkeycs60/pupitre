import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Une couleur littérale hors de tokens.css ne change pas avec le thème : en
 * Clair, un blanc translucide de survol devient invisible. Les littéraux
 * restants sont des identités (couleurs de projet, aperçus de documents
 * blancs, diff Git) ; ce plafond par feuille empêche d'en ajouter.
 */
const LITERAL_COLORS_CEILING: Record<string, number> = {
  'cards.css': 20,
  'chat.css': 6,
  'code.css': 11,
  'composer.css': 3,
  'design.css': 1,
  'progress.css': 1,
  'project-todos.css': 1,
  'settings.css': 18,
  'shell.css': 11,
  'sidebar.css': 2,
}

const STYLES = join(import.meta.dir, 'styles')

test('aucune nouvelle couleur littérale hors des tokens de thème', () => {
  const over: string[] = []
  for (const sheet of readdirSync(STYLES).filter((name) => name.endsWith('.css') && name !== 'tokens.css')) {
    const css = readFileSync(join(STYLES, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const count = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)?.length ?? 0
    const ceiling = LITERAL_COLORS_CEILING[sheet] ?? 0
    if (count > ceiling) over.push(`${sheet} : ${count} couleurs littérales (plafond ${ceiling}) — passer par un token de tokens.css`)
  }
  expect(over).toEqual([])
})
