import { defineConfig, type Plugin } from 'vite';

/**
 * ez-tree ships its bark/leaf textures as base64 data URIs inside its JS (~3 MB gzipped). At build time,
 * lift them out into real image files (cacheable, fetched only when a tree actually uses them) and
 * replace each literal with the file's URL. Dev mode is untouched.
 */
function extractEzTreeTextures(): Plugin {
  let base = '/';
  const files: { fileName: string; data: Buffer }[] = [];
  return {
    name: 'extract-ez-tree-textures',
    apply: 'build',
    configResolved(c) { base = c.base; },
    transform(code, id) {
      if (!/@dgreenheck[\\/]ez-tree[\\/]build[\\/]ez-tree\.es\.js$/.test(id)) return null;
      let n = 0;
      const out = code.replace(/(["'`])data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)\1/g, (_m, q: string, kind: string, b64: string) => {
        const fileName = `assets/eztree/tex-${n++}.${kind === 'jpeg' ? 'jpg' : 'png'}`;
        files.push({ fileName, data: Buffer.from(b64, 'base64') });
        return `${q}${base}${fileName}${q}`;
      });
      return n ? { code: out, map: null } : null;
    },
    generateBundle() {
      for (const f of files) this.emitFile({ type: 'asset', fileName: f.fileName, source: f.data });
    },
  };
}

// base is overridden by BASE env for GitHub Pages (e.g. /groundtruth/)
export default defineConfig({
  base: process.env.BASE ?? '/',
  server: { port: Number(process.env.PORT ?? 5173), host: '127.0.0.1' },
  plugins: [extractEzTreeTextures()],
  build: {
    target: 'es2022',
    // Rapier (base64 WASM, ~2.8 MB) is unavoidably large; it lives in its own lazily loaded chunk
    // (src/engine.ts boundary), never in the title-screen bundle. ez-tree's textures are extracted above.
    chunkSizeWarningLimit: 4500,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // big vendor libs in their own long-cacheable chunks, downloaded in parallel with the game code
            { name: 'ez-tree', test: /node_modules[\\/]@dgreenheck[\\/]ez-tree/, includeDependenciesRecursively: false },
            { name: 'rapier', test: /node_modules[\\/]@dimforge[\\/]rapier3d-compat/, includeDependenciesRecursively: false },
          ],
        },
      },
    },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
  worker: { format: 'es' },
});
