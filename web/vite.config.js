import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The app always talks to its own origin so that the same build works behind a
// tunnel or a LAN host. During dev the API lives on :3001, so proxy it there.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
      '/videos': 'http://localhost:3001',
    },
  },
})
