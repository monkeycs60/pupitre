import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const sidecarPort = process.env.PUPITRE_PORT ?? '4820'
const sidecarHttp = `http://localhost:${sidecarPort}`
const sidecarWs = `ws://localhost:${sidecarPort}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': sidecarHttp,
      '/media': sidecarHttp,
      '/ws': { target: sidecarWs, ws: true },
    },
  },
})
