// DEV ONLY: vite config for the AI harness with HMR/file-watching off (other agents edit files constantly).
import { defineConfig } from 'vite';
export default defineConfig({
  root: process.cwd(),
  server: { port: Number(process.env.PORT ?? 5206), host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
  worker: { format: 'es' },
});
