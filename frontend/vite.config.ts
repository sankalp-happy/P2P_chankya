import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The team backend (repo-root api.py, `uvicorn api:app --port 8000`) serves /api/*; proxied unchanged.
// VITE_API_MODE=mock disables all backend calls.
// ngrok tunnels for sharing the demo (Vite rejects unknown Host headers otherwise).
const TUNNEL_HOSTS = ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
    allowedHosts: TUNNEL_HOSTS,
  },
  preview: {
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
    allowedHosts: TUNNEL_HOSTS,
  },
});
