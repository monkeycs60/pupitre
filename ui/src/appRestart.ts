import { invoke } from '@tauri-apps/api/core'
import { hasTauriRuntime, httpUrl } from './transport'

export function isAppRestartShortcut(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>): boolean {
  return !event.altKey
    && (event.ctrlKey || event.metaKey)
    && event.shiftKey
    && event.key.toLowerCase() === 'r'
}

async function waitForSidecar(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 700))
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(httpUrl('/api/health'), { cache: 'no-store' })
      if (response.ok) return
    } catch {
      // Le trou de connexion est attendu entre l'ancien et le nouveau process.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250))
  }
  throw new Error('Le sidecar ne répond pas après son redémarrage.')
}

export async function restartApp(): Promise<void> {
  if (!hasTauriRuntime()) {
    window.location.reload()
    return
  }
  await invoke('restart_sidecar')
  await waitForSidecar()
  window.location.reload()
}
