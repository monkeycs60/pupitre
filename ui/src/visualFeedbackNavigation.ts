import { webSocketUrl } from './transport'

export interface VisualFeedbackNavigation {
  projectId: string
  conversationId: string
}

export function navigationEventFromMessage(raw: string): VisualFeedbackNavigation | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return value.type === 'open-conversation'
      && typeof value.projectId === 'string'
      && typeof value.conversationId === 'string'
      ? { projectId: value.projectId, conversationId: value.conversationId }
      : null
  } catch {
    return null
  }
}

export function subscribeVisualFeedbackNavigation(onNavigate: (target: VisualFeedbackNavigation) => void): () => void {
  let closed = false
  let socket: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  const connect = () => {
    if (closed) return
    socket = new WebSocket(webSocketUrl('/ws?channel=navigation'))
    socket.addEventListener('message', (event) => {
      const target = navigationEventFromMessage(String(event.data))
      if (target) onNavigate(target)
    })
    socket.addEventListener('close', () => {
      if (!closed) retry = setTimeout(connect, 1_500)
    })
  }
  connect()
  return () => {
    closed = true
    if (retry) clearTimeout(retry)
    socket?.close()
  }
}
