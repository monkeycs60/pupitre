import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexAsset, installCodex } from './install-codex'

async function fixture(corruptCompanion: boolean, check: (directory: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'pupitre-install-test-'))
  const originalFetch = globalThis.fetch
  try {
    const main = codexAsset(process.platform, process.arch)
    const names = [main, main.replace(/^codex-/, 'codex-code-mode-host-')]
    const archives = new Map<string, Buffer>()
    const assets = names.map((name, index) => {
      writeFileSync(join(root, name), `#!/bin/sh\necho ${name}\n`)
      const archive = join(root, `${name}.tar.gz`)
      const result = Bun.spawnSync(['tar', '-czf', archive, '-C', root, name])
      expect(result.exitCode).toBe(0)
      const bytes = readFileSync(archive)
      const url = `https://github.com/openai/codex/releases/download/test/${name}.tar.gz`
      archives.set(url, bytes)
      return {
        name: `${name}.tar.gz`, browser_download_url: url,
        digest: `sha256:${corruptCompanion && index === 1 ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')}`,
      }
    })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'https://api.github.com/repos/openai/codex/releases/latest') return Response.json({ assets })
      const archive = archives.get(url)
      return archive ? new Response(archive) : new Response(null, { status: 404 })
    }) as typeof fetch
    await check(join(root, 'bin'))
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
}

test('installe Codex et son moteur de commandes exécutables de la même release', async () => {
  await fixture(false, async (directory) => {
    await installCodex(directory)
    for (const name of ['codex', 'codex-code-mode-host']) {
      expect(statSync(join(directory, name)).mode & 0o111).toBe(0o111)
      expect(Bun.spawnSync([join(directory, name)]).exitCode).toBe(0)
    }
  })
})

test('un compagnon corrompu annule aussi l’installation du CLI principal', async () => {
  await fixture(true, async (directory) => {
    await expect(installCodex(directory)).rejects.toThrow('Empreinte Codex incorrecte')
    expect(existsSync(join(directory, 'codex'))).toBe(false)
    expect(existsSync(join(directory, 'codex-code-mode-host'))).toBe(false)
  })
})
