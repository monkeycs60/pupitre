import { homedir } from 'node:os'
import { join } from 'node:path'

export function devEnv(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): NodeJS.ProcessEnv {
  if (env.PUPITRE_INSTANCE === 'stable') {
    throw new Error('PUPITRE_INSTANCE=stable interdit pour un script de développement')
  }
  return {
    ...env,
    PUPITRE_INSTANCE: 'dev',
    PUPITRE_PORT: '4821',
    PUPITRE_DATA_DIR: join(home, '.local/share/pupitre-dev'),
  }
}
