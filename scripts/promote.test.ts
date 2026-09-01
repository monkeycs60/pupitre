import { expect, test } from 'bun:test'
import {
  cleanEnv,
  parseVersion,
  releaseDirectoryName,
  releasesToPrune,
  selectRollbackRelease,
} from './promote'

test('retire toutes les variables Pupitre avant de lancer la stable', () => {
  expect(cleanEnv({ PATH: '/bin', PUPITRE_INSTANCE: 'dev', PUPITRE_PORT: '4821' }))
    .toEqual({ PATH: '/bin' })
})

test('nomme une release avec le SHA et un horodatage triable', () => {
  expect(releaseDirectoryName('abc1234', new Date('2026-09-01T12:34:56Z')))
    .toBe('abc1234-20260901-123456')
})

test('parse un VERSION.json valide et refuse un contrat incomplet', () => {
  expect(parseVersion('{"sha":"abc","dirty":false,"builtAt":"2026-09-01T12:00:00Z"}'))
    .toEqual({ sha: 'abc', dirty: false, builtAt: '2026-09-01T12:00:00Z' })
  expect(() => parseVersion('{"sha":3}')).toThrow(/VERSION/)
})

test('sélectionne la release immédiatement antérieure pour le rollback', () => {
  const releases = ['aaa-20260901-100000', 'bbb-20260901-110000', 'ccc-20260901-120000']
  expect(selectRollbackRelease(releases, releases[2])).toBe(releases[1])
  expect(selectRollbackRelease(releases, releases[1])).toBe(releases[0])
  expect(() => selectRollbackRelease(releases, releases[0])).toThrow(/précédente/)
})

test('purge les anciennes releases sans supprimer la courante', () => {
  expect(releasesToPrune(['a', 'b', 'c', 'd', 'e'], 'b', 3)).toEqual(['a'])
})
