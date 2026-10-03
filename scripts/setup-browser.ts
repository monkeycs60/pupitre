import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const browserVersion = '0.38.2'
const digests: Record<string, string> = {
  'darwin-arm64': '8168b86ab5d94be8f670992dfe4fe1445016518a864b48bda105e64142e7cbf9',
  'darwin-x64': '787cb40e086a188d0bb13ff29a99a0b2380aff3aa5e8600b8f8131a0b98ca69c',
  'linux-arm64': '690c02d952de8497bba4f8cc58b59acbf27dc27b346755869b518f4b411c7f40',
  'linux-x64': 'a54b765192db774666f0513fa8b545a298753b6f29e73bcdf4a1e78f18e7c0e1',
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

export function linkIfAbsent(target: string, destination: string): boolean {
  try {
    const current = lstatSync(destination)
    if (current.isSymbolicLink() && readlinkSync(destination) === target) return true
    console.log(`Conservé : ${destination} existe déjà ; vérifiez son fonctionnement avec @browser.`)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(target, destination)
  return true
}

export function installBrowserSkill(home: string, directory: string, skillHomes = [join(home, '.claude'), join(home, '.codex'), join(home, '.agents')]): void {
  const skill = join(directory, 'skill')
  cpSync(join(import.meta.dir, '../setup/agent-browser'), skill, { recursive: true })
  chmodSync(join(skill, 'scripts/ab'), 0o755)
  for (const root of new Set(skillHomes)) linkIfAbsent(skill, join(root, 'skills/agent-browser'))
  linkIfAbsent(join(skill, 'scripts/ab'), join(home, '.local/bin/ab'))
}

export async function installBrowser(home = homedir(), skillHomes?: string[]): Promise<string> {
  const platform = `${process.platform}-${process.arch}`
  const expected = digests[platform]
  if (!expected) throw new Error(`Agent browser : plateforme non prise en charge (${platform}).`)
  const directory = join(home, '.local/opt/pupitre-browser', `v${browserVersion}`)
  const binary = join(directory, 'agent-browser')
  if (!existsSync(binary)) {
    const response = await fetch(`https://github.com/vercel-labs/agent-browser/releases/download/v${browserVersion}/agent-browser-${platform}`, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error(`Téléchargement agent-browser : HTTP ${response.status}.`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (digest(bytes) !== expected) throw new Error('Empreinte agent-browser incorrecte ; installation annulée.')
    mkdirSync(directory, { recursive: true })
    const temporary = join(directory, `download-${crypto.randomUUID()}`)
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o755 })
    renameSync(temporary, binary)
  }
  if (digest(readFileSync(binary)) !== expected) throw new Error(`Binaire agent-browser modifié : ${binary}. Conservé sans remplacement.`)
  const version = Bun.spawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 })
  if (version.exitCode !== 0) throw new Error(`agent-browser ne démarre pas : ${version.stderr.toString()}`)
  installBrowserSkill(home, directory, skillHomes)
  console.log(version.stdout.toString().trim())
  console.log('Chrome : ouvrez chrome://inspect/#remote-debugging, activez le débogage puis acceptez la connexion. Ouvrez une nouvelle conversation pour charger le skill.')
  return binary
}

if (import.meta.main) {
  const home = homedir()
  try {
    await installBrowser(home, [process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), process.env.CODEX_HOME || join(home, '.codex'), join(home, '.agents')])
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
