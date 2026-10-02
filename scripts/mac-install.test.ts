import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installMacLauncher, stageMacBundle } from './mac-install'

test('le bundle installé reste autonome après suppression des artefacts de build', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pupitre-mac-bundle-'))
  try {
    const bundle = join(directory, 'build/Pupitre.app')
    const release = join(directory, 'release')
    mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true })
    writeFileSync(join(bundle, 'Contents/MacOS/app'), 'application')
    expect(() => stageMacBundle(bundle, release)).toThrow(/incomplet/)
    writeFileSync(join(bundle, 'Contents/MacOS/pupitre-sidecar'), 'backend')
    symlinkSync('pupitre-sidecar', join(bundle, 'Contents/MacOS/backend-link'))
    stageMacBundle(bundle, release)
    rmSync(join(directory, 'build'), { recursive: true })
    expect(readFileSync(join(release, 'Pupitre.app/Contents/MacOS/backend-link'), 'utf8')).toBe('backend')
    installMacLauncher(join(directory, 'Applications'), release)
    installMacLauncher(join(directory, 'Applications'), release)
    expect(existsSync(join(directory, 'Applications/Pupitre.app/Contents/MacOS/app'))).toBe(true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('une autre application ou un lien tiers ne sont jamais écrasés', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pupitre-mac-existing-'))
  try {
    const link = join(directory, 'Pupitre.app')
    mkdirSync(link)
    writeFileSync(join(link, 'personal'), 'preserve')
    expect(() => installMacLauncher(directory, '/new')).toThrow(/existe déjà/)
    expect(readFileSync(join(link, 'personal'), 'utf8')).toBe('preserve')
    rmSync(link, { recursive: true })
    symlinkSync('/unrelated', link)
    expect(() => installMacLauncher(directory, '/new')).toThrow(/existe déjà/)
    expect(readlinkSync(link)).toBe('/unrelated')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
