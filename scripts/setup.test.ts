import { expect, test } from 'bun:test'
import { codexAsset } from './install-codex'
import { setupPath } from './setup'

test('sélectionne un binaire Codex natif et refuse les architectures inconnues', () => {
  expect(codexAsset('darwin', 'arm64')).toBe('codex-aarch64-apple-darwin')
  expect(codexAsset('darwin', 'x64')).toBe('codex-x86_64-apple-darwin')
  expect(codexAsset('linux', 'x64')).toBe('codex-x86_64-unknown-linux-musl')
  expect(() => codexAsset('darwin', 'ia32')).toThrow(/Architecture/)
})

test('conserve les runtimes personnalisés sans injecter le répertoire courant dans PATH', () => {
  const path = setupPath('/Users/Marie Martin', '/custom/node/bin::/usr/bin:/usr/bin:')
  expect(path.split(':')).toContain('/Users/Marie Martin/.local/bin')
  expect(path.split(':')).toContain('/custom/node/bin')
  expect(path.split(':').filter((part) => part === '/usr/bin')).toHaveLength(1)
  expect(path.split(':')).not.toContain('')
})
