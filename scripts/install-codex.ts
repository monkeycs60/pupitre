import { createHash } from 'node:crypto'
import { chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function codexAsset(platform: string, arch: string): string {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  const os = platform === 'darwin' ? 'apple-darwin' : platform === 'linux' ? 'unknown-linux-musl' : null
  if (!cpu || !os) throw new Error(`Architecture Codex non prise en charge : ${platform}/${arch}`)
  return `codex-${cpu}-${os}`
}

export async function installCodex(directory: string): Promise<void> {
  const name = codexAsset(process.platform, process.arch)
  const release = await fetch('https://api.github.com/repos/openai/codex/releases/latest', {
    headers: { 'User-Agent': 'pupitre-setup', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!release.ok) throw new Error(`Téléchargement Codex : GitHub répond ${release.status}. Réessayez plus tard.`)
  const data = await release.json() as { assets: Array<{ name: string; digest?: string; browser_download_url: string }> }
  const asset = data.assets.find((asset) => asset.name === `${name}.tar.gz`)
  if (!asset?.digest?.startsWith('sha256:') || !asset.browser_download_url.startsWith('https://github.com/openai/codex/releases/download/')) {
    throw new Error('Archive officielle Codex ou empreinte SHA-256 introuvable.')
  }
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`Archive Codex inaccessible (${response.status}).`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error('Empreinte Codex incorrecte, installation annulée.')
  const temporary = mkdtempSync(join(tmpdir(), 'pupitre-codex-'))
  try {
    const archive = join(temporary, 'codex.tar.gz')
    await Bun.write(archive, bytes)
    const extraction = Bun.spawnSync(['tar', '-xzf', archive, '-C', temporary, name])
    if (extraction.exitCode !== 0) throw new Error('Extraction de Codex impossible.')
    mkdirSync(directory, { recursive: true })
    copyFileSync(join(temporary, name), join(directory, 'codex'), constants.COPYFILE_EXCL)
    chmodSync(join(directory, 'codex'), 0o755)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
