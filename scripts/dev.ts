import { join } from 'node:path'
import { devEnv, runningSidecarRefusal, type SidecarHealth } from './dev-env'

const root = join(import.meta.dir, '..')
const sidecar = process.argv.includes('--sidecar')
const watch = process.argv.includes('--watch')
const command = sidecar
  ? ['bun', 'run', '--cwd', 'sidecar', ...(watch ? ['--watch'] : []), 'src/index.ts']
  : ['bunx', '--bun', 'tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json']

const env = devEnv()

if (sidecar) {
  const health = await fetch(`http://127.0.0.1:${env.PUPITRE_PORT}/api/health`, { signal: AbortSignal.timeout(1_000) })
    .then((response) => (response.ok ? response.json() as Promise<SidecarHealth> : null))
    .catch(() => null)
  const refusal = runningSidecarRefusal(health, process.argv.includes('--force'))
  if (refusal) {
    console.error(refusal)
    process.exit(0)
  }
}

const child = Bun.spawn(command, {
  cwd: root,
  env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
const code = await child.exited
console.error(`[${new Date().toISOString()}] ${sidecar ? 'sidecar dev' : 'app dev'} arrêté (code ${code})`)
process.exit(code)
