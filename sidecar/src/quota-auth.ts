import type { Provider } from './events'

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
  }
}

export async function authenticateQuotaProvider(provider: Provider): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('La reconnexion intégrée est actuellement disponible sous Linux.')
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
