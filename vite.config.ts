import { defineConfig } from 'vite';

// base is overridden by BASE env for GitHub Pages (e.g. /groundtruth/)
export default defineConfig({
  base: process.env.BASE ?? '/',
  server: { port: Number(process.env.PORT ?? 5173), host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
  worker: { format: 'es' },
});
