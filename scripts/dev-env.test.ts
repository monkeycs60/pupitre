import { expect, test } from 'bun:test'
import { devEnv } from './dev-env'

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
