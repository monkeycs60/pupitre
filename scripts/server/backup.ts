import { Database } from 'bun:sqlite'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()
const source = join(home, '.local/share/pupitre')
const destination = join(home, 'backups')
mkdirSync(destination, { recursive: true, mode: 0o700 })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const snapshot = join(destination, `pupitre-${stamp}.sqlite`)
const db = new Database(join(source, 'pupitre.db'), { readonly: true })
db.run('VACUUM INTO ?', [snapshot])
db.close()
const archive = `${snapshot}.tar.gz`
const result = Bun.spawnSync(['tar', '-czf', archive, '-C', destination, snapshot.split('/').pop()!, '-C', source, 'documents', 'media'], { stderr: 'pipe' })
if (result.exitCode !== 0) throw new Error(result.stderr.toString())
rmSync(snapshot)
const archives = readdirSync(destination).filter(name => /^pupitre-.*\.sqlite\.tar\.gz$/.test(name)).sort().reverse()
for (const name of archives.slice(14)) rmSync(join(destination, name))
console.log(`Pupitre sauvegardé : ${archive}`)
