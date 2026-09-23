// OWNER: compiler agent. Web Worker entry: live-compiles a recipe off the main thread.
import { compileRecipe, type CompileOptions } from './compile.ts';
import { fetchOverpass } from './osm.ts';
import { browserTileLoader } from './terrain.ts';

self.onmessage = async (ev: MessageEvent<{ opts: CompileOptions }>) => {
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    const t0 = Date.now();
    const recipe = await compileRecipe(ev.data.opts, {
      overpass: (q, onBytes) => fetchOverpass(q, { onStatus: (s) => post({ type: 'status', text: s }), onBytes, timeoutMs: 90_000, hedgeMs: 15_000 }),
      tiles: browserTileLoader(),
      log: (m) => post({ type: 'log', text: m }),
    }, (stage, f) => post({ type: 'progress', stage, f }));
    post({ type: 'log', text: `live compile total ${Date.now() - t0} ms` });
    post({ type: 'done', recipe });
  } catch (e) {
    post({ type: 'error', message: (e as Error)?.message ?? String(e) });
  }
};
