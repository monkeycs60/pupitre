import { expect, test } from 'bun:test'
import {
  cleanEnv,
  parseVersion,
  releaseDirectoryName,
  releasesToPrune,
  selectRollbackRelease,
  terminateProcessGroup,
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
  const releases = ['fff-20260901-100000', '111-20260901-110000', 'aaa-20260901-120000']
  expect(selectRollbackRelease(releases, releases[2])).toBe(releases[1])
  expect(selectRollbackRelease(releases, releases[1])).toBe(releases[0])
  expect(() => selectRollbackRelease(releases, releases[0])).toThrow(/précédente/)
})

test('purge les anciennes releases sans supprimer la courante', () => {
  const releases = [
    'fff-20260901-100000',
    '111-20260901-110000',
    'eee-20260901-120000',
    '222-20260901-130000',
    'ddd-20260901-140000',
  ]
  expect(releasesToPrune(releases, releases[1], 3)).toEqual([releases[0]])
})

test('arrête aussi les processus WebKit descendants avant une relance', async () => {
  const processGroup = Bun.spawn(['bash', '-c', 'sleep 60 >/dev/null & echo $!; exec 1>&-; wait'], {
    detached: true,
    stdout: 'pipe',
  })
  const childPid = Number((await new Response(processGroup.stdout).text()).trim())

  await terminateProcessGroup(processGroup.pid, { timeoutMs: 2_000 })

  expect(() => process.kill(processGroup.pid, 0)).toThrow()
  expect(() => process.kill(childPid, 0)).toThrow()
})
