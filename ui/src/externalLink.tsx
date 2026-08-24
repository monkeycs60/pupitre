import { openUrl } from '@tauri-apps/plugin-opener'
import type { MouseEvent, ReactNode } from 'react'

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

/**
 * Ouvre une adresse hors de l'application.
 *
 * Dans la fenêtre Tauri, `target="_blank"` ne fait **rien** : wry ne branche le
 * signal `create` de WebKit que si la fenêtre a un gestionnaire `on_new_window`,
 * et la fenêtre principale est déclarée dans `tauri.conf.json`, donc sans
 * gestionnaire. Le clic est alors avalé en silence. Il faut passer par le
 * plugin `opener`, qui délègue au navigateur du système — et dont la liste
 * blanche vit dans `src-tauri/capabilities/default.json`.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauriRuntime()) await openUrl(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Un lien externe qui reste une vraie ancre : le clic milieu, le survol et le
 * menu contextuel gardent leur sens dans le navigateur de développement, et
 * seule la fenêtre Tauri intercepte pour déléguer au système.
 */
export function ExternalLink({
  href,
  className,
  title,
  ariaLabel,
  children,
}: {
  href: string
  className?: string
  title?: string
  ariaLabel?: string
  children: ReactNode
}) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!isTauriRuntime()) return
    event.preventDefault()
    void openExternal(href)
  }

  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={ariaLabel}
      onClick={handleClick}
    >
      {children}
    </a>
  )
}
