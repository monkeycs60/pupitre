import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const binaryDirectory = join(root, 'src-tauri', 'binaries')
const rust = Bun.spawnSync(['rustc', '-vV'])
if (rust.exitCode !== 0) {
  throw new Error(`rustc -vV a échoué : ${rust.stderr.toString()}`)
}

const targetTriple = rust.stdout.toString().match(/^host: (\S+)$/m)?.[1]
if (!targetTriple) throw new Error('target triple Rust introuvable')

mkdirSync(binaryDirectory, { recursive: true })
const extension = process.platform === 'win32' ? '.exe' : ''
const output = join(binaryDirectory, `pupitre-sidecar-${targetTriple}${extension}`)
const build = Bun.spawn(
  [
    'bun',
    'build',
    '--compile',
    '--minify',
    '--outfile',
    output,
    join(root, 'sidecar', 'src', 'index.ts'),
  ],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' },
)

const exitCode = await build.exited
if (exitCode !== 0) throw new Error(`compilation du sidecar échouée (${exitCode})`)
console.log(`Sidecar compilé : ${output}`)
