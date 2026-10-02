import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = process.argv[2]
if (!executable) throw new Error('Usage : bun run scripts/smoke-desktop.ts /chemin/vers/app')
const origin = 'http://127.0.0.1:4821'
try {
  await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })
  throw new Error('Le port 4821 est déjà utilisé ; smoke test annulé.')
} catch (error) {
  if (error instanceof Error && error.message.includes('déjà utilisé')) throw error
}

const directory = mkdtempSync(join(tmpdir(), 'pupitre-desktop-smoke-'))
const child = Bun.spawn([resolve(executable)], {
  env: { ...process.env, PUPITRE_INSTANCE: 'dev', PUPITRE_PORT: '4821', PUPITRE_DATA_DIR: directory, PUPITRE_BACKGROUND_JOBS: 'off' },
  stdout: 'inherit', stderr: 'inherit',
})
try {
  let ready = false
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null) throw new Error(`Application arrêtée prématurément (${child.exitCode}).`)
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) })
      const health = await response.json() as { ok?: boolean; instance?: string; frontendAt?: string | null }
      if (health.ok && health.instance === 'dev' && health.frontendAt) { ready = true; break }
    } catch {}
    await Bun.sleep(1_000)
  }
  if (!ready) throw new Error('La fenêtre native ne rejoint pas le backend après 90 secondes.')
  console.log('La fenêtre native a démarré et rejoint son backend avec des données vierges.')
} finally {
  child.kill('SIGTERM')
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!exited) { child.kill('SIGKILL'); await child.exited }
  rmSync(directory, { recursive: true, force: true })
}
try {
  await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })
} catch {
  console.log('Le backend s’arrête avec la fenêtre native.')
  process.exit(0)
}
throw new Error('Le backend est resté actif après la fermeture de l’application.')
