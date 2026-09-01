import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export interface ReleaseVersion { sha: string; dirty: boolean; builtAt: string }
interface PromotionOptions {
  json: boolean
  timeoutMinutes: number
  force: boolean
  skipBuild: boolean
  rollback: boolean
  stableOrigin: string
}
interface Health {
  ok: true
  instance: 'stable' | 'dev'
  port: number
  appPid: number
  build?: { sha: string; source: 'build' | 'git' } | null
}
interface Activity { busy: boolean; [key: string]: boolean | number }

const root = join(import.meta.dir, '..')
const installRoot = join(homedir(), '.local/opt/pupitre')
const releasesDir = join(installRoot, 'releases')
const currentLink = join(installRoot, 'current')

export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('PUPITRE_')))
}

export function releaseDirectoryName(sha: string, date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${sha}-${stamp}`
}

export function parseVersion(raw: string): ReleaseVersion {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) throw new Error('VERSION.json invalide')
  const version = value as Partial<ReleaseVersion>
  if (typeof version.sha !== 'string' || typeof version.dirty !== 'boolean' || typeof version.builtAt !== 'string') {
    throw new Error('VERSION.json invalide')
  }
  return { sha: version.sha, dirty: version.dirty, builtAt: version.builtAt }
}

export function selectRollbackRelease(releases: string[], current: string): string {
  const ordered = [...releases].sort(compareReleaseDates)
  const index = ordered.indexOf(current)
  if (index <= 0) throw new Error('Aucune release précédente disponible')
  return ordered[index - 1]
}

export function releasesToPrune(releases: string[], current: string, keep = 3): string[] {
  const ordered = [...releases].sort(compareReleaseDates)
  const retained = new Set(ordered.slice(-keep))
  retained.add(current)
  return ordered.filter((release) => !retained.has(release))
}

function compareReleaseDates(left: string, right: string): number {
  const timestamp = (value: string) => value.match(/(\d{8}-\d{6})$/)?.[1] ?? ''
  return timestamp(left).localeCompare(timestamp(right)) || left.localeCompare(right)
}

function parseOptions(args: string[]): PromotionOptions {
  const valueAfter = (flag: string) => {
    const index = args.indexOf(flag)
    return index < 0 ? undefined : args[index + 1]
  }
  const timeout = Number(valueAfter('--timeout') ?? '30')
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout doit être un nombre positif')
  return {
    json: args.includes('--json'),
    timeoutMinutes: timeout,
    force: args.includes('--force'),
    skipBuild: args.includes('--skip-build'),
    rollback: args.includes('--rollback'),
    stableOrigin: valueAfter('--stable-origin') ?? 'http://127.0.0.1:4820',
  }
}

function reporter(json: boolean) {
  return (step: string, status: 'running' | 'done' | 'failed', message: string, extra = {}) => {
    const event = { step, status, message, at: new Date().toISOString(), ...extra }
    console.log(json ? JSON.stringify(event) : `[${step}] ${message}`)
  }
}

function gitOutput(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim())
  return result.stdout.toString().trim()
}

async function fetchJson<T>(url: string, timeout = 1_000): Promise<T | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (!response.ok) return null
    return await response.json() as T
  } catch {
    return null
  }
}

async function runCommand(command: string[], step: string): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`${step} a échoué (${code})`)
}

function availableReleases(): string[] {
  if (!existsSync(releasesDir)) return []
  return readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function currentReleaseName(): string | null {
  if (!existsSync(currentLink)) return null
  try {
    return basename(realpathSync(currentLink))
  } catch {
    return basename(readlinkSync(currentLink))
  }
}

function stageRelease(version: ReleaseVersion): string {
  const release = join(releasesDir, releaseDirectoryName(version.sha))
  mkdirSync(release, { recursive: false })
  const appSource = join(root, 'src-tauri', 'target', 'release', 'app')
  const sidecarSource = readdirSync(join(root, 'src-tauri', 'binaries'))
    .find((name) => name.startsWith('pupitre-sidecar-'))
  if (!existsSync(appSource) || !sidecarSource) throw new Error('Artefacts de release introuvables')
  copyFileSync(appSource, join(release, 'app'))
  copyFileSync(join(root, 'src-tauri', 'binaries', sidecarSource), join(release, 'pupitre-sidecar'))
  chmodSync(join(release, 'app'), 0o755)
  chmodSync(join(release, 'pupitre-sidecar'), 0o755)
  writeFileSync(join(release, 'VERSION.json'), `${JSON.stringify(version, null, 2)}\n`)
  return release
}

async function drainStable(
  options: PromotionOptions,
  report: ReturnType<typeof reporter>,
): Promise<void> {
  if (options.force) {
    report('drain', 'done', 'attente ignorée (--force)')
    return
  }
  const currentHealth = await fetchJson<Health>(`${options.stableOrigin}/api/health`)
  if (!currentHealth) {
    report('drain', 'done', 'instance stable non lancée')
    return
  }
  if (!validStableHealth(currentHealth, options.stableOrigin)) {
    throw new Error('Le port stable ne présente pas une instance stable valide.')
  }
  const deadline = Date.now() + options.timeoutMinutes * 60_000
  let previous = ''
  let consecutiveFailures = 0
  while (Date.now() < deadline) {
    const activity = await fetchJson<Activity>(`${options.stableOrigin}/api/activity`)
    if (!activity) {
      consecutiveFailures += 1
      if (consecutiveFailures >= 3) throw new Error('activité de la stable inaccessible pendant le drain')
      await Bun.sleep(2_000)
      continue
    }
    consecutiveFailures = 0
    if (!activity.busy) {
      report('drain', 'done', 'instance stable inactive')
      return
    }
    const serialized = JSON.stringify(activity)
    if (serialized !== previous) {
      report('drain', 'running', 'activité en cours dans la stable', { activity })
      previous = serialized
    }
    await Bun.sleep(2_000)
  }
  throw new Error(`la stable est encore active après ${options.timeoutMinutes} min`)
}

function validStableHealth(health: Health | null, origin: string): health is Health {
  const expectedPort = Number(new URL(origin).port || (origin.startsWith('https:') ? 443 : 80))
  return health?.ok === true && health.instance === 'stable' && health.port === expectedPort
}

async function stopStable(origin: string, required: boolean, force = false): Promise<void> {
  const health = await fetchJson<Health>(`${origin}/api/health`)
  if (!health) {
    if (required) throw new Error('La santé de la stable est inaccessible avant la bascule.')
    return
  }
  if (!validStableHealth(health, origin)) throw new Error('Le processus sur le port stable n’est pas une instance stable valide.')
  if (!force) {
    const activity = await fetchJson<Activity>(`${origin}/api/activity`)
    if (!activity) throw new Error('L’activité de la stable est inaccessible juste avant son arrêt.')
    if (activity.busy) throw new Error('La stable a repris une activité avant son arrêt ; promotion annulée.')
  }
  if (!Number.isInteger(health.appPid) || health.appPid <= 1) {
    throw new Error('La stable doit être fermée manuellement : son appPid est indisponible.')
  }
  process.kill(health.appPid, 'SIGTERM')
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    let alive = true
    try { process.kill(health.appPid, 0) } catch { alive = false }
    if (!alive && !(await fetchJson<Health>(`${origin}/api/health`))) return
    await Bun.sleep(250)
  }
  try { process.kill(health.appPid, 'SIGKILL') } catch {}
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await fetchJson<Health>(`${origin}/api/health`))) return
    await Bun.sleep(250)
  }
  throw new Error('La stable ne s’est pas arrêtée après SIGKILL.')
}

function activateRelease(release: string): void {
  mkdirSync(installRoot, { recursive: true })
  const temporary = `${currentLink}.tmp`
  rmSync(temporary, { force: true })
  symlinkSync(release, temporary)
  renameSync(temporary, currentLink)
}

function writeDesktopFile(): void {
  const applications = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'applications')
  mkdirSync(applications, { recursive: true })
  copyFileSync(join(root, 'src-tauri', 'icons', 'icon.png'), join(installRoot, 'icon.png'))
  writeFileSync(join(applications, 'fr.clementserizay.pupitre.desktop'), `[Desktop Entry]
Type=Application
Name=Pupitre
Exec=${join(currentLink, 'app')}
Icon=${join(installRoot, 'icon.png')}
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=fr.clementserizay.pupitre
X-GNOME-WMClass=fr.clementserizay.pupitre
`)
}

function launchStable(): number {
  const child = Bun.spawn([join(currentLink, 'app')], {
    cwd: installRoot,
    env: cleanEnv(process.env),
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  child.unref()
  return child.pid
}

async function verifyStable(origin: string, sha: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const health = await fetchJson<Health>(`${origin}/api/health`)
    if (health?.build?.sha === sha && health.build.source === 'build') return
    await Bun.sleep(1_000)
  }
  throw new Error(`la stable ne répond pas avec le build ${sha}`)
}

function pruneReleases(current: string): void {
  for (const release of releasesToPrune(availableReleases(), current)) {
    rmSync(join(releasesDir, release), { recursive: true, force: true })
  }
}

async function promote(options: PromotionOptions): Promise<void> {
  const report = reporter(options.json)
  if (process.env.PUPITRE_INSTANCE === 'stable') throw new Error('Une promotion ne peut pas partir de la stable.')
  const stableHealth = await fetchJson<Health>(`${options.stableOrigin}/api/health`)
  if (stableHealth && !validStableHealth(stableHealth, options.stableOrigin)) {
    throw new Error('Le port stable ne présente pas une instance stable valide.')
  }

  if (options.rollback) {
    const current = currentReleaseName()
    if (!current) throw new Error('Aucune release courante à restaurer')
    const targetName = selectRollbackRelease(availableReleases(), current)
    const target = join(releasesDir, targetName)
    const version = parseVersion(readFileSync(join(target, 'VERSION.json'), 'utf8'))
    report('drain', 'running', 'attente de la stable avant rollback')
    await drainStable(options, report)
    report('switch', 'running', `rollback vers ${version.sha}`)
    await stopStable(options.stableOrigin, false, options.force)
    activateRelease(target)
    let launchedPid: number | null = null
    try {
      report('switch', 'done', `release ${targetName} activée`)
      launchedPid = launchStable()
      report('launch', 'done', 'stable relancée')
      await verifyStable(options.stableOrigin, version.sha)
    } catch (error) {
      const runningHealth = await fetchJson<Health>(`${options.stableOrigin}/api/health`)
      if (runningHealth) await stopStable(options.stableOrigin, false, true)
      else if (launchedPid !== null) {
        try { process.kill(launchedPid, 'SIGTERM') } catch {}
        await Bun.sleep(500)
      }
      const previousPath = join(releasesDir, current)
      const previousVersion = parseVersion(readFileSync(join(previousPath, 'VERSION.json'), 'utf8'))
      activateRelease(previousPath)
      launchStable()
      await verifyStable(options.stableOrigin, previousVersion.sha)
      throw new Error(`rollback vers ${version.sha} annulé, stable restaurée : ${error instanceof Error ? error.message : String(error)}`)
    }
    report('verify', 'done', `stable vérifiée sur ${version.sha}`)
    return
  }

  report('preflight', 'running', 'lecture de la version courante')
  const sha = gitOutput('rev-parse', '--short', 'HEAD')
  const dirty = gitOutput('status', '--porcelain').length > 0
  const version = { sha, dirty, builtAt: new Date().toISOString() }
  report('preflight', 'done', `${sha}${dirty ? ' (arbre modifié)' : ''}`, { sha })

  if (!options.skipBuild) {
    report('build', 'running', 'construction des binaires release')
    await runCommand(['bunx', 'tauri', 'build', '--no-bundle'], 'build')
    report('build', 'done', 'binaires construits')
  } else {
    report('build', 'done', 'artefacts existants réutilisés')
  }

  report('stage', 'running', 'installation de la release')
  mkdirSync(releasesDir, { recursive: true })
  const release = stageRelease(version)
  report('stage', 'done', basename(release))
  report('drain', 'running', 'attente de la stable')
  await drainStable(options, report)
  report('switch', 'running', 'bascule vers la nouvelle release')
  await stopStable(options.stableOrigin, false, options.force)
  const previousRelease = currentReleaseName()
  activateRelease(release)
  let launchedPid: number | null = null
  try {
    writeDesktopFile()
    report('switch', 'done', `${sha} activé`)
    launchedPid = launchStable()
    report('launch', 'done', 'stable relancée')
    await verifyStable(options.stableOrigin, sha)
    report('verify', 'done', `stable vérifiée sur ${sha}`)
  } catch (error) {
    if (!previousRelease) {
      rmSync(currentLink, { force: true })
      throw error
    }
    report('rollback', 'running', `restauration automatique de ${previousRelease}`)
    const runningHealth = await fetchJson<Health>(`${options.stableOrigin}/api/health`)
    if (runningHealth) await stopStable(options.stableOrigin, false, true)
    else if (launchedPid !== null) {
      try { process.kill(launchedPid, 'SIGTERM') } catch {}
      await Bun.sleep(500)
    }
    const previousPath = join(releasesDir, previousRelease)
    const previousVersion = parseVersion(readFileSync(join(previousPath, 'VERSION.json'), 'utf8'))
    activateRelease(previousPath)
    launchStable()
    await verifyStable(options.stableOrigin, previousVersion.sha)
    report('rollback', 'done', `stable restaurée sur ${previousVersion.sha}`)
    throw new Error(`promotion de ${sha} annulée, stable restaurée : ${error instanceof Error ? error.message : String(error)}`)
  }
  pruneReleases(basename(release))
  report('prune', 'done', 'trois dernières releases conservées')
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2))
  try {
    await promote(options)
  } catch (error) {
    reporter(options.json)('promotion', 'failed', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
