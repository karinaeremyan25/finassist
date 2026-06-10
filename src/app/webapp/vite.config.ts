import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mini App is served as static assets under a relative base so it can live
// behind any path. Dev proxy forwards /api → backend (config.WEBAPP_PORT = 8080).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
