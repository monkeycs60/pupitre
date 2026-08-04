import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4820',
      '/media': 'http://localhost:4820',
      '/ws': { target: 'ws://localhost:4820', ws: true },
    },
  },
})
