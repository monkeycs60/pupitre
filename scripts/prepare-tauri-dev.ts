import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { devDesktopEntry } from './dev-env'

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
  devDesktopEntry(root, Bun.which('bun') ?? process.execPath),
)

console.log(`Lanceur de développement Pupitre enregistré : ${desktopFile}`)
