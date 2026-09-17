import { expect, test } from 'bun:test'
import { projectGlyphIndex } from './projectGlyphIndex'

test('attribue des glyphes stables et distincts aux projets courants', () => {
  const projects = ['pupitre', 'affilae-mono', 'recall-people-2026']
  const glyphs = projects.map(projectGlyphIndex)

  expect(new Set(glyphs).size).toBe(projects.length)
  expect(projects.map(projectGlyphIndex)).toEqual(glyphs)
})
