import { openUrl } from '@tauri-apps/plugin-opener'
import type { MouseEvent, ReactNode } from 'react'
import { hasTauriRuntime } from './transport'

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
  if (hasTauriRuntime()) await openUrl(url)
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
    if (!hasTauriRuntime()) return
    event.preventDefault()
    // Un refus du plugin — adresse hors liste blanche — redonnerait le « il ne
    // se passe rien » qu'on corrige ici. On le laisse au moins traçable.
    openExternal(href).catch((reason: unknown) => {
      console.error(`[lien] ouverture refusée pour ${href}`, reason)
    })
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
