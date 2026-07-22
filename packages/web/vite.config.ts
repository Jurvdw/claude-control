import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dev server proxies API + socket to the backend so the web app can use
// same-origin relative URLs and cookies work without CORS headaches.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:4000',
      '/servers': 'http://localhost:4000',
      '/api-keys': 'http://localhost:4000',
      '/provider': 'http://localhost:4000',
      '/invites': 'http://localhost:4000',
      '/agent-templates': 'http://localhost:4000',
      '/tools': 'http://localhost:4000',
      '/notifications': 'http://localhost:4000',
      '/usage': 'http://localhost:4000',
      '/files': 'http://localhost:4000',
      '/webhooks': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
  build: { outDir: 'dist' },
  test: {
    environment: 'node',
  },
});
