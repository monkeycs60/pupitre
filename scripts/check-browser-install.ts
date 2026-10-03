import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBrowser } from './setup-browser'

const home = mkdtempSync(join(tmpdir(), 'pupitre-browser-install-'))
try {
  const binary = await installBrowser(home)
  const help = Bun.spawnSync([binary, '--help'], { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 })
  if (help.exitCode !== 0 || !help.stdout.toString().includes('--auto-connect') || !help.stdout.toString().includes('--pin-tab')) {
    throw new Error('Le binaire ne propose pas les options attendues.')
  }
  await installBrowser(home)
  console.log('Installation native et réinstallation vérifiées dans un dossier temporaire.')
} finally { rmSync(home, { recursive: true, force: true }) }
