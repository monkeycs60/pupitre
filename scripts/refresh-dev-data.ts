import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

async function devSidecarRunning(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:4821/api/health', {
      signal: AbortSignal.timeout(700),
    })
    return response.ok
  } catch {
    return false
  }
}

function sqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

if (await devSidecarRunning()) {
  throw new Error('Arrête le sidecar dev sur le port 4821 avant de rafraîchir ses données.')
}

const stableDir = join(homedir(), '.local/share/pupitre')
const devDir = join(homedir(), '.local/share/pupitre-dev')
const stableDb = join(stableDir, 'pupitre.db')
const devDb = join(devDir, 'pupitre.db')
if (!existsSync(stableDb)) throw new Error(`Base stable introuvable : ${stableDb}`)
mkdirSync(devDir, { recursive: true })
rmSync(devDb, { force: true })

const db = new Database(stableDb, { readonly: true })
try {
  db.exec(`VACUUM INTO ${sqliteLiteral(devDb)}`)
} finally {
  db.close()
}

for (const directory of ['media', 'documents', 'html-documents']) {
  const source = join(stableDir, directory)
  if (!existsSync(source)) continue
  mkdirSync(join(devDir, directory), { recursive: true })
  const copy = Bun.spawnSync(['rsync', '-a', '--delete', `${source}/`, `${join(devDir, directory)}/`])
  if (copy.exitCode !== 0) throw new Error(`Copie de ${directory} échouée : ${copy.stderr.toString()}`)
}

console.log(`Données dev rafraîchies depuis ${stableDir}`)
