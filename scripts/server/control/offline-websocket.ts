import { join } from 'node:path'

await import(join(process.cwd(), 'test-setup.ts'))

// Sans doublure, les tests de composants se connectent au vrai sidecar du PC.
// Les tests du flux temps réel installent leur propre socket et leurs événements.
class OfflineWebSocket extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = OfflineWebSocket.CONNECTING
  close() { this.readyState = OfflineWebSocket.CLOSED }
  send() { throw new Error('Installer une doublure WebSocket pour ce test') }
}

globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket
