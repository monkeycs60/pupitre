import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'linux') process.exit(0)

const root = join(import.meta.dir, '..')
const applicationsDirectory = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
  'applications',
)
const desktopFile = join(applicationsDirectory, 'fr.clementserizay.pupitre.dev.desktop')

mkdirSync(applicationsDirectory, { recursive: true })
writeFileSync(
  desktopFile,
  `[Desktop Entry]
Type=Application
Name=Pupitre (dev)
Comment=Espace de travail pour agents IA
Exec=env PUPITRE_INSTANCE=dev ${join(root, 'src-tauri', 'target', 'debug', 'app')}
Icon=${join(root, 'src-tauri', 'icons', 'icon.png')}
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=fr.clementserizay.pupitre.dev
X-GNOME-WMClass=fr.clementserizay.pupitre.dev
`,
)

console.log(`Lanceur de développement Pupitre enregistré : ${desktopFile}`)
