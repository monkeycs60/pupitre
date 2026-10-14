import { expect, test } from 'bun:test'
import { devDesktopEntry, devEnv, runningSidecarRefusal } from './dev-env'

test('fixe le port et les données de l’instance dev', () => {
  expect(devEnv({ PATH: '/bin' }, '/home/test')).toEqual({
    PATH: '/bin',
    PUPITRE_INSTANCE: 'dev',
    PUPITRE_PORT: '4821',
    PUPITRE_DATA_DIR: '/home/test/.local/share/pupitre-dev',
  })
})

test('refuse de détourner un environnement stable explicite', () => {
  expect(() => devEnv({ PUPITRE_INSTANCE: 'stable' }, '/home/test')).toThrow(/stable/)
})

test('le lanceur dev démarre toute la chaîne de développement', () => {
  const entry = devDesktopEntry('/workspace/pupitre', '/home/test/.bun/bin/bun')

  expect(entry).toContain('Name=Pupitre (dev)')
  expect(entry).toContain('Exec=/home/test/.bun/bin/bun run --cwd /workspace/pupitre dev')
  expect(entry).not.toContain('target/debug/app')
})

test('refuse de remplacer un sidecar dev sain et à jour, sauf avec --force', () => {
  const healthy = { ok: true, instance: 'dev', pid: 42, staleSources: 0 }
  expect(runningSidecarRefusal(healthy, false)).toContain('pid 42')
  expect(runningSidecarRefusal(healthy, true)).toBeNull()
})

test('relance un sidecar dev absent, périmé ou qui n’est pas une instance dev', () => {
  expect(runningSidecarRefusal(null, false)).toBeNull()
  expect(runningSidecarRefusal({ ok: true, instance: 'dev', pid: 42, staleSources: 3 }, false)).toBeNull()
  expect(runningSidecarRefusal({ ok: true, instance: 'stable', pid: 42, staleSources: 0 }, false)).toBeNull()
})
