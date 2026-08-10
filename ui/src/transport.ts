const SIDECAR_HTTP_ORIGIN = 'http://127.0.0.1:4820'
const SIDECAR_WS_ORIGIN = 'ws://127.0.0.1:4820'

interface LocationLike {
  protocol: string
  host: string
}

function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export function httpUrl(path: string, protocol = location.protocol): string {
  return protocol === 'tauri:' ? `${SIDECAR_HTTP_ORIGIN}${path}` : path
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
  if (current.protocol === 'tauri:' || tauriRuntime) return `${SIDECAR_WS_ORIGIN}${path}`
  const scheme = current.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${current.host}${path}`
}
