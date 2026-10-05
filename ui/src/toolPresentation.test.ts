import { describe, expect, test } from 'bun:test'
import { toolGroupSummary, toolPresentation } from './toolPresentation'
import type { EventBlock } from './eventBlocks'

function tool(toolName: string, input: unknown): Extract<EventBlock, { kind: 'tool' }> {
  return { kind: 'tool', id: 'tool-1', toolId: '1', toolName, input, images: [] }
}

describe('toolPresentation', () => {
  test('décrit les outils Claude avec leur cible', () => {
    expect(toolPresentation(tool('Read', { file_path: '/repo/ui/src/settings.json' }))).toEqual({
      label: 'Lecture',
      detail: 'src/settings.json',
      category: 'read',
    })
    expect(toolPresentation(tool('Grep', { pattern: 'permission_mode', path: '/tmp/pupitre' }))).toEqual({
      label: 'Recherche',
      detail: 'permission_mode dans pupitre',
      category: 'search',
    })
  })

  test('reprend la description d’une commande Claude et montre la commande', () => {
    expect(toolPresentation(tool('Bash', { command: 'grep -rn "theme" src | head', description: 'Find theme usages' }))).toEqual({
      label: 'Find theme usages',
      detail: 'grep -rn "theme" src | head',
      category: 'search',
    })
  })

  test('montre la commande Codex sans son enveloppe shell', () => {
    expect(toolPresentation(tool('shell', { command: "/bin/bash -lc 'rg -n settings ui/src'" }))).toEqual({
      label: 'Recherche',
      detail: 'rg -n settings ui/src',
      category: 'search',
    })
    expect(toolPresentation(tool('shell', { command: 'bun test' })).label).toBe('Tests')
  })

  test('garde la commande en détail pour les commandes inconnues', () => {
    expect(toolPresentation(tool('shell', { command: './script-interne' }))).toEqual({
      label: 'Commande',
      detail: './script-interne',
      category: 'command',
    })
  })

  test('résume un groupe par nature d’action', () => {
    expect(toolGroupSummary([
      tool('Read', { file_path: '/a' }),
      tool('Grep', { pattern: 'x' }),
      tool('Read', { file_path: '/b' }),
    ])).toBe('2 lectures · 1 recherche')
  })
})
