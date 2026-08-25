import { describe, expect, test } from 'bun:test'
import { toolPresentation } from './toolPresentation'
import type { EventBlock } from './eventBlocks'

function tool(toolName: string, input: unknown): Extract<EventBlock, { kind: 'tool' }> {
  return { kind: 'tool', id: 'tool-1', toolId: '1', toolName, input, images: [] }
}

describe('toolPresentation', () => {
  test('décrit les outils Claude avec leur cible', () => {
    expect(toolPresentation(tool('Read', { file_path: '/tmp/settings.json' }))).toEqual({
      label: 'Lecture',
      detail: 'settings.json',
    })
    expect(toolPresentation(tool('Grep', { pattern: 'permission_mode', path: '/tmp/pupitre' }))).toEqual({
      label: 'Recherche de « permission_mode »',
      detail: 'pupitre',
    })
  })

  test('décrit les commandes Codex par leur intention', () => {
    expect(toolPresentation(tool('shell', { command: 'bun test' })).label).toBe('Exécution des tests')
    expect(toolPresentation(tool('shell', { command: "rg -n 'settings' ui/src" })).label).toBe('Recherche dans les fichiers')
  })

  test('garde un fallback humain pour les commandes inconnues', () => {
    expect(toolPresentation(tool('shell', { command: './script-interne' })).label).toBe('Exécution d’une commande')
  })
})
