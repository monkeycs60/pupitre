import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rien ne signale qu'un composant supprimé laisse ses styles derrière lui :
 * la refonte « calque Git » a ainsi laissé 1202 lignes que plus aucun
 * sélecteur ne pouvait atteindre. Ce test remplace la vigilance.
 */

const SRC = join(import.meta.dir)
const STYLES = join(SRC, 'styles')

function sources(): string {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'styles') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) files.push(readFileSync(path, 'utf8'))
    }
  }
  walk(SRC)
  return files.join('\n')
}

test('aucune classe CSS déclarée n’est devenue inatteignable', () => {
  const src = sources()
  // `is-${status}`, `severity-${flag.severity}` … : le préfixe seul est écrit
  // dans les sources, donc toute classe qui le porte reste atteignable.
  const dynamic = [...new Set([...src.matchAll(/([a-z][a-z0-9-]*-)\$\{/g)].map((m) => m[1]!))]

  const declared = new Set<string>()
  for (const sheet of readdirSync(STYLES).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(join(STYLES, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of css.matchAll(/\.([a-z][a-z0-9-]{2,})/g)) declared.add(match[1]!)
  }

  const unreachable = [...declared]
    .filter((name) => !src.includes(name))
    .filter((name) => !dynamic.some((prefix) => name.startsWith(prefix)))
    .sort()

  expect(unreachable).toEqual([])
})
