export function projectInitials(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  if (!cleaned) return '··'
  const parts = cleaned.split(/\s+/)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return cleaned.slice(0, 2).toUpperCase()
}

/**
 * Chemin d'un projet tel qu'on l'écrit dans l'interface : le dossier personnel
 * devient `~`. Le front n'a pas accès au HOME du système ; la forme
 * `/home/<compte>` ou `/Users/<compte>` est reconnue sur le chemin lui-même.
 */
export function shortenHomePath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')
}
