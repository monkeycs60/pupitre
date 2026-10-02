import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

export function stageMacBundle(bundle: string, release: string): void {
  if (!existsSync(join(bundle, 'Contents/MacOS/app')) || !existsSync(join(bundle, 'Contents/MacOS/pupitre-sidecar'))) {
    throw new Error('Bundle macOS incomplet : application ou sidecar introuvable.')
  }
  cpSync(bundle, join(release, 'Pupitre.app'), { recursive: true, verbatimSymlinks: true })
}

export function installMacLauncher(applications: string, currentLink: string): void {
  const link = join(applications, 'Pupitre.app')
  const target = join(currentLink, 'Pupitre.app')
  mkdirSync(applications, { recursive: true })
  let existing: ReturnType<typeof lstatSync> | undefined
  try { existing = lstatSync(link) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing && (!existing.isSymbolicLink() || readlinkSync(link) !== target)) {
    throw new Error(`${link} existe déjà et n’a pas été installé par Pupitre. Déplacez-le avant de réessayer.`)
  }
  if (!existing) symlinkSync(target, link)
}
