import { createLogger, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const sidecarPort = process.env.PUPITRE_PORT ?? '4820'
const sidecarHttp = `http://localhost:${sidecarPort}`
const sidecarWs = `ws://localhost:${sidecarPort}`
const sidecarStartupGraceMs = 15_000
const viteStartedAt = Date.now()

// En mode Tauri, Vite est prêt avant la compilation puis le lancement du
// sidecar. Les premiers appels de la WebView peuvent donc rencontrer
// ECONNREFUSED ; ce n'est pas une erreur applicative et Vite la réessaie déjà
// côté client. On masque uniquement cette course initiale, pas les erreurs
// proxy qui surviennent après le démarrage.
const logger = createLogger()
const logError = logger.error.bind(logger)
logger.error = (message, options) => {
  const duringSidecarStartup = Date.now() - viteStartedAt < sidecarStartupGraceMs
  const isConnectionRefused = message.includes('proxy error')
    && message.includes('ECONNREFUSED')
  if (duringSidecarStartup && isConnectionRefused) return
  logError(message, options)
}

// https://vite.dev/config/
export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  server: {
    proxy: {
      '/api': sidecarHttp,
      '/media': sidecarHttp,
      '/ws': { target: sidecarWs, ws: true },
    },
  },
})
