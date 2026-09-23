// OWNER: compiler agent. Web Worker entry: live-compiles a recipe off the main thread.
import { compileRecipe, type CompileOptions } from './compile.ts';
import { fetchOverpass } from './osm.ts';
import { browserTileLoader } from './terrain.ts';

self.onmessage = async (ev: MessageEvent<{ opts: CompileOptions }>) => {
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    const recipe = await compileRecipe(ev.data.opts, {
      overpass: (q) => fetchOverpass(q, { onStatus: (s) => post({ type: 'status', text: s }) }),
      tiles: browserTileLoader(),
      log: (m) => post({ type: 'log', text: m }),
    }, (stage, f) => post({ type: 'progress', stage, f }));
    post({ type: 'done', recipe });
  } catch (e) {
    post({ type: 'error', message: (e as Error)?.message ?? String(e) });
  }
};
