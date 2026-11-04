import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The app always talks to its own origin so that the same build works behind a
// tunnel or a LAN host. During dev the API lives on :3001, so proxy it there.
// NOTE: every static dir the backend mounts in server/src/index.js must be
// mirrored here, or dev mode will serve index.html instead of the asset
// (images show as broken). Keep this list in sync with those mounts.
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['236963.xyz'],
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
      '/videos': 'http://localhost:3001',
      '/notes-images': 'http://localhost:3001',
    },
  },
})
