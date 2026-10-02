import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installCodex } from './install-codex'

const root = join(import.meta.dir, '..')

export function setupPath(home: string, path: string): string {
  return [...new Set([join(home, '.local/bin'), join(home, '.bun/bin'), join(home, '.cargo/bin'), '/opt/homebrew/bin', '/usr/local/bin', ...path.split(':')])].filter(Boolean).join(':')
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command[0]} ${command[1] ?? ''} a échoué (${code}). Relancez le setup après correction.`)
}

function authenticated(provider: 'claude' | 'codex'): boolean {
  try {
    return Bun.spawnSync(provider === 'claude' ? ['claude', 'auth', 'status'] : ['codex', 'login', 'status'],
      { stdout: 'ignore', stderr: 'ignore', timeout: 15_000 }).exitCode === 0
  } catch { return false }
}

async function setup(args: string[]): Promise<void> {
  const check = args.includes('--check')
  const unknown = args.filter((arg) => !['--check', '--skip-auth'].includes(arg))
  if (unknown.length) throw new Error(`Options inconnues : ${unknown.join(', ')}`)
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Linux et macOS uniquement.')
  process.env.PATH = setupPath(homedir(), process.env.PATH ?? '')
  if (check) {
    let missing = false
    for (const tool of ['git', 'bun', 'cargo', 'rustc', 'claude', 'codex']) {
      const path = Bun.which(tool)
      console.log(`${path ? 'OK' : 'MANQUANT'} — ${tool}${path ? ` : ${path}` : ''}`)
      if (!path) missing = true
    }
    for (const provider of ['claude', 'codex'] as const) {
      const ready = authenticated(provider)
      console.log(`${ready ? 'OK' : 'À CONNECTER'} — ${provider}`)
      if (!ready) missing = true
    }
    process.exitCode = missing ? 1 : 0
    return
  }
  if (process.env.PUPITRE_INSTANCE === 'stable') throw new Error('Lancez le setup hors de la stable.')
  if (existsSync(join(homedir(), '.local/opt/pupitre/current'))) {
    throw new Error('Pupitre est déjà installé. Utilisez bun run doctor pour le diagnostic ; bun run promote pour une mise à jour explicite.')
  }
  const [major, minor] = Bun.version.split('.').map(Number)
  if (major! < 1 || (major === 1 && minor! < 3)) throw new Error('Bun 1.3 minimum requis. Lancez bun upgrade puis relancez le setup.')
  for (const tool of ['git', 'cargo', 'rustc']) {
    if (!Bun.which(tool)) throw new Error(`${tool} manque. Lancez bash scripts/setup.sh.`)
  }
  if (!Bun.which('claude')) {
    await run(['bash', '-c', 'set -euo pipefail; installer=$(mktemp); trap \'rm -f "$installer"\' EXIT; curl -fsSL https://claude.ai/install.sh -o "$installer"; bash "$installer"'])
  }
  if (!Bun.which('codex')) await installCodex(join(homedir(), '.local/bin'))
  for (const provider of ['claude', 'codex'] as const) {
    await run([provider, '--version'])
    if (!args.includes('--skip-auth') && !authenticated(provider)) {
      console.log(`Connexion ${provider} : terminez la connexion dans votre navigateur avec votre compte.`)
      await run(provider === 'claude' ? ['claude', 'auth', 'login'] : ['codex', 'login'])
      if (!authenticated(provider)) throw new Error(`La connexion ${provider} reste à terminer.`)
    }
  }
  const config = join(homedir(), '.config/pupitre')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'path'), process.env.PATH!, { mode: 0o600 })
  await run(['bun', 'run', 'scripts/promote.ts'])
  console.log(process.platform === 'darwin'
    ? 'Pupitre est installé dans ~/Applications/Pupitre.app. Ajoutez-le au Dock pour les prochains lancements.'
    : 'Pupitre est installé. Retrouvez-le dans le menu des applications.')
}

if (import.meta.main) {
  try { await setup(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
