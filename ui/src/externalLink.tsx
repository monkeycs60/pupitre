import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import type { MouseEvent, ReactNode } from 'react'
import { getMediaPath } from './api'
import { absoluteSidecarUrl, hasTauriRuntime } from './transport'

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
  if (hasTauriRuntime()) await openUrl(absoluteSidecarUrl(url))
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export async function openStoredMedia(name: string): Promise<void> {
  try {
    const { path } = await getMediaPath(name)
    if (hasTauriRuntime()) {
      await openPath(path)
      return
    }
    window.open(fileUrl(path), '_blank', 'noopener,noreferrer')
  } catch {
    await openExternal(`/media/${encodeURIComponent(name)}`)
  }
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Les réponses peuvent pointer vers un fichier créé localement. Un chemin
 * absolu doit être distingué des routes internes, sinon le renderer le traite
 * comme une navigation vers une nouvelle route Pupitre.
 */
export function localFilePath(href: string): string | null {
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href)
      if (url.protocol !== 'file:' || url.hostname !== '') return null
      return decodePath(url.pathname)
    } catch {
      return null
    }
  }
  if (/^\/(?:home|tmp|Users|private|mnt)\//i.test(href)) return decodePath(href)
  if (/^[A-Za-z]:[\\/]/.test(href)) return decodePath(href)
  return null
}

function fileUrl(path: string): string {
  if (/^file:\/\//i.test(path)) return path
  return `file://${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

function shouldRevealInFileManager(path: string): boolean {
  return !/\.(?:html?|xhtml)$/i.test(path.split(/[?#]/, 1)[0] ?? path)
}

export async function openLocalFile(path: string): Promise<void> {
  if (hasTauriRuntime()) {
    if (shouldRevealInFileManager(path)) await revealItemInDir(path)
    else await openPath(path)
    return
  }
  window.open(fileUrl(path), '_blank', 'noopener,noreferrer')
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
  onClick,
  children,
}: {
  href: string
  className?: string
  title?: string
  ariaLabel?: string
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
  children: ReactNode
}) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented) return
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

export function DownloadLink({
  href,
  filename,
  className,
  title,
  ariaLabel,
  children,
}: {
  href: string
  filename: string
  className?: string
  title?: string
  ariaLabel?: string
  children: ReactNode
}) {
  return (
    <a
      className={className}
      href={href}
      download={filename}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </a>
  )
}

export function LocalFileLink({
  path,
  className,
  title,
  ariaLabel,
  children,
}: {
  path: string
  className?: string
  title?: string
  ariaLabel?: string
  children: ReactNode
}) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!hasTauriRuntime()) return
    event.preventDefault()
    openLocalFile(path).catch((reason: unknown) => {
      console.error(`[lien] ouverture refusée pour ${path}`, reason)
    })
  }

  return (
    <a
      className={className}
      href={fileUrl(path)}
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
