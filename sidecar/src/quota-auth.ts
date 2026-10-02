import type { Provider } from './events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function macAuthScript(command: string[], statusPath: string, path: string): string {
  return `#!/bin/bash\nexport PATH=${shellQuote(path)}\nfinish() { code=$?; printf "%s" "$code" > ${shellQuote(statusPath)}; }\ntrap finish EXIT\n${command.map(shellQuote).join(' ')}\n`
}

async function authenticateOnMac(command: string[]): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pupitre-login-'))
  const script = join(directory, 'login.command')
  const status = join(directory, 'status')
  writeFileSync(script, macAuthScript(command, status, process.env.PATH ?? ''), { mode: 0o700 })
  try {
    const child = Bun.spawn(['/usr/bin/open', '-a', 'Terminal', script], { stdout: 'ignore', stderr: 'pipe' })
    if (await child.exited !== 0) {
      throw new Error((await new Response(child.stderr).text()).trim() || 'Impossible d’ouvrir Terminal.')
    }
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      let code: string | undefined
      try { code = readFileSync(status, 'utf8').trim() } catch {}
      if (code !== undefined && /^\d+$/.test(code)) {
        if (code !== '0') throw new Error(`Connexion interrompue ou échouée (${code}).`)
        return
      }
      await Bun.sleep(500)
    }
    throw new Error('Connexion non terminée après 15 minutes. Réessayez depuis Terminal.')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function quotaAuthCommand(
  provider: Provider,
  env: Record<string, string | undefined> = process.env,
): string[] {
  switch (provider) {
    case 'claude':
      return [env.PUPITRE_CLAUDE_BIN ?? 'claude', 'auth', 'login']
    case 'codex':
      return [env.PUPITRE_CODEX_BIN ?? 'codex', 'login']
    case 'grok':
      return [env.PUPITRE_GROK_BIN ?? 'grok', 'login', '--oauth']
    case 'reasonix':
      return [env.PUPITRE_REASONIX_BIN ?? 'reasonix', 'setup']
  }
}

export async function authenticateQuotaProvider(provider: Provider): Promise<void> {
  if (process.platform === 'darwin') return authenticateOnMac(quotaAuthCommand(provider))
  if (process.platform !== 'linux') {
    throw new Error('La reconnexion intégrée est disponible sous Linux et macOS.')
  }
  const terminal = Bun.which('x-terminal-emulator')
    ?? Bun.which('gnome-terminal')
    ?? Bun.which('konsole')
  if (terminal === null) throw new Error('Aucun terminal graphique compatible trouvé.')

  const command = quotaAuthCommand(provider)
  const terminalName = terminal.split('/').pop()
  const args = terminalName === 'gnome-terminal'
    ? ['--wait', '--', ...command]
    : terminalName === 'konsole'
      ? ['--nofork', '-e', ...command]
      : ['-e', ...command]
  const child = Bun.spawn([terminal, ...args], { stdout: 'ignore', stderr: 'pipe' })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    const detail = await new Response(child.stderr).text()
    throw new Error(detail.trim() || `La connexion ${provider} a échoué.`)
  }
}
