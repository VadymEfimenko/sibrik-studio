import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_PROXY_TARGET || `http://127.0.0.1:${process.env.PORT || 3000}`;

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    watch: { usePolling: process.env.CHOKIDAR_USEPOLLING === 'true', interval: 300 },
    proxy: {
      '/api': { target: apiTarget },
      '/media': { target: apiTarget },
    },
  },
});
