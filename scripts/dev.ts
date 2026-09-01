import { join } from 'node:path'
import { devEnv } from './dev-env'

const root = join(import.meta.dir, '..')
const sidecar = process.argv.includes('--sidecar')
const watch = process.argv.includes('--watch')
const command = sidecar
  ? ['bun', 'run', '--cwd', 'sidecar', ...(watch ? ['--watch'] : []), 'src/index.ts']
  : ['bunx', 'tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json']

const child = Bun.spawn(command, {
  cwd: root,
  env: devEnv(),
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(await child.exited)
