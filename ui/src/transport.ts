const SIDECAR_HTTP_ORIGIN = 'http://127.0.0.1:4820'
const SIDECAR_WS_ORIGIN = 'ws://127.0.0.1:4820'

interface LocationLike {
  protocol: string
  host: string
}

export function httpUrl(path: string, protocol = location.protocol): string {
  return protocol === 'tauri:' ? `${SIDECAR_HTTP_ORIGIN}${path}` : path
}

export function mediaUrl(name: string, protocol = location.protocol): string {
  return httpUrl(`/media/${encodeURIComponent(name)}`, protocol)
}

export function webSocketUrl(
  path: string,
  current: LocationLike = location,
): string {
  if (current.protocol === 'tauri:') return `${SIDECAR_WS_ORIGIN}${path}`
  const scheme = current.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${current.host}${path}`
}
