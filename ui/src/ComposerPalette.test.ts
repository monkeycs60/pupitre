import { describe, expect, test } from 'bun:test'
import { paletteTrigger, rankSkills } from './ComposerPalette'
import type { SkillSummary } from './types'

function skill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: crypto.randomUUID(),
    name: 'skill',
    invocation: 'skill',
    description: '',
    triggers: [],
    provider: 'claude',
    provenance: 'claude-global',
    path: '/tmp/skill.md',
    project_id: null,
    modified_at: '2026-01-01',
    indexed_at: '2026-01-01',
    favorite: false,
    ...overrides,
  }
}

describe('paletteTrigger', () => {
  test('un $ en cours de frappe ouvre les skills avec la requête', () => {
    expect(paletteTrigger('corrige $vat', 12)).toEqual({ mode: 'skills', anchor: 8, query: 'vat' })
  })

  test('le / ne déclenche les actions qu’en tête de message', () => {
    expect(paletteTrigger('/res', 4)).toEqual({ mode: 'actions', anchor: 0, query: 'res' })
    expect(paletteTrigger('voir /res', 9)).toBeNull()
  })

  test('un token clos par une espace ne déclenche plus rien', () => {
    expect(paletteTrigger('$vat-regulation lance', 21)).toBeNull()
  })

  test('le curseur au milieu du message regarde le token à sa gauche', () => {
    expect(paletteTrigger('$va suite', 3)).toEqual({ mode: 'skills', anchor: 0, query: 'va' })
  })
})

describe('rankSkills', () => {
  test('favoris puis projet puis globaux, ordre alphabétique ensuite', () => {
    const ranked = rankSkills([
      skill({ invocation: 'zeta' }),
      skill({ invocation: 'alpha' }),
      skill({ invocation: 'projet', project_id: 'p1', provenance: 'claude-project' }),
      skill({ invocation: 'fav', favorite: true }),
      skill({ invocation: 'autre-projet', project_id: 'p2', provenance: 'claude-project' }),
    ], 'p1')
    expect(ranked.map((item) => item.invocation)).toEqual(['fav', 'projet', 'alpha', 'zeta'])
  })
})
