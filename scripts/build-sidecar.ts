import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const gitSha = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: root })
if (gitSha.exitCode !== 0) throw new Error(`git rev-parse a échoué : ${gitSha.stderr.toString()}`)
const sha = gitSha.stdout.toString().trim()
const gitStatus = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root })
if (gitStatus.exitCode !== 0) throw new Error(`git status a échoué : ${gitStatus.stderr.toString()}`)
const dirty = gitStatus.stdout.length > 0
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
    '--define',
    `process.env.PUPITRE_BUILD_SHA=${JSON.stringify(sha)}`,
    '--define',
    `process.env.PUPITRE_BUILD_DIRTY=${JSON.stringify(dirty ? '1' : '0')}`,
    '--outfile',
    output,
    join(root, 'sidecar', 'src', 'index.ts'),
  ],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' },
)

const exitCode = await build.exited
if (exitCode !== 0) throw new Error(`compilation du sidecar échouée (${exitCode})`)
console.log(`Sidecar compilé : ${output}`)
