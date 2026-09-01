import { homedir } from 'node:os'
import { join } from 'node:path'

export function devDesktopEntry(root: string, bunPath: string): string {
  return `[Desktop Entry]
Type=Application
Name=Pupitre (dev)
Comment=Espace de travail pour agents IA
Exec=${bunPath} run --cwd ${root} dev
Path=${root}
Icon=${join(root, 'src-tauri', 'icons', 'icon.png')}
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=fr.clementserizay.pupitre.dev
X-GNOME-WMClass=fr.clementserizay.pupitre.dev
`
}

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
