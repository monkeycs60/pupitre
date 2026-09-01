interface PupitreRuntime {
  instance?: 'stable' | 'dev'
  port?: number
}

function runtime(): PupitreRuntime {
  return (typeof window !== 'undefined'
    && (window as typeof window & { __PUPITRE__?: PupitreRuntime }).__PUPITRE__) || {}
}

export function sidecarPort(): number {
  const port = runtime().port
  return Number.isInteger(port) ? port as number : 4820
}

const httpOrigin = () => `http://127.0.0.1:${sidecarPort()}`
const wsOrigin = () => `ws://127.0.0.1:${sidecarPort()}`

interface LocationLike {
  protocol: string
  host: string
}

export function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export function httpUrl(path: string, protocol = location.protocol): string {
  return protocol === 'tauri:' ? `${httpOrigin()}${path}` : path
}

export function mediaUrl(name: string, protocol = location.protocol): string {
  return httpUrl(`/media/${encodeURIComponent(name)}`, protocol)
}

export function htmlDocumentContentUrl(
  id: string,
  token: string,
  protocol = location.protocol,
): string {
  return httpUrl(
    `/api/documents/${encodeURIComponent(id)}/content?token=${encodeURIComponent(token)}`,
    protocol,
  )
}

export const documentContentUrl = htmlDocumentContentUrl
export const documentExternalUrl = htmlDocumentExternalUrl

export function documentThumbnailUrl(id: string, sha256?: string): string {
  const version = sha256 ? `?v=${encodeURIComponent(sha256.slice(0, 12))}` : ''
  return httpUrl(`/api/documents/${encodeURIComponent(id)}/thumbnail${version}`)
}

export function htmlDocumentExternalUrl(
  id: string,
  token: string,
  protocol = location.protocol,
  tauriRuntime = hasTauriRuntime(),
): string {
  // En développement Tauri, l'iframe passe par le proxy Vite avec une URL
  // relative. Le navigateur système exige au contraire une URL HTTP absolue.
  return htmlDocumentContentUrl(id, token, tauriRuntime ? 'tauri:' : protocol)
}

export function webSocketUrl(
  path: string,
  current: LocationLike = location,
  tauriRuntime = hasTauriRuntime(),
): string {
  // En dev, la WebView Tauri est servie par Vite en http: mais peut joindre le
  // sidecar directement. Éviter le proxy WS supprime ses EPIPE au montage HMR.
  if (current.protocol === 'tauri:' || tauriRuntime) return `${wsOrigin()}${path}`
  const scheme = current.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${current.host}${path}`
}
