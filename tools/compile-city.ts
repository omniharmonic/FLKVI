// Bake showcase cities into public/recipes/<id>.json.
// Usage: node --experimental-strip-types tools/compile-city.ts [id ...|all]
//        node --experimental-strip-types tools/compile-city.ts --lat 40.01 --lon -105.27 --id custom --name "Somewhere"
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRecipe, packRecipe } from '../src/compiler/compile.ts';
import { BAKED_CITIES } from '../src/compiler/cities.ts';
import { compilerIO } from './compiler-io.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
async function bake(id: string, lat: number, lon: number, name: string, half?: number, terrainDenoise?: { sigma: number; open?: number }) {
  console.log(`\n=== ${id}: ${name} (${lat}, ${lon})`);
  let last = '';
  const r = await compileRecipe({ lat, lon, name, half, terrainDenoise }, { ...compilerIO, log: (m) => console.log('  ', m) }, (s) => { if (s !== last) { console.log('  ·', s); last = s; } });
  const out = join(root, 'public', 'recipes', `${id}.json`);
  mkdirSync(dirname(out), { recursive: true });
  const json = JSON.stringify(packRecipe(r));
  writeFileSync(out, json);
  console.log(`  wrote ${out} (${(json.length / 1e6).toFixed(2)} MB): ${r.roads.length} roads, ${r.graph.nodes.length}/${r.graph.edges.length} graph, ${r.buildings.length} buildings, ${r.areas.length} areas, ${r.trees.length} trees, ${r.props.length} props, ${r.cameras.length} cameras`);
}

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (flag('--lat')) {
  await bake(flag('--id') ?? 'custom', +flag('--lat')!, +flag('--lon')!, flag('--name') ?? 'Custom', flag('--half') ? +flag('--half')! : undefined);
} else {
  const ids = args.length === 0 || args.includes('all') ? BAKED_CITIES.map((c) => c.id) : args;
  for (const id of ids) {
    const c = BAKED_CITIES.find((x) => x.id === id);
    if (!c) { console.error(`unknown city ${id}`); continue; }
    try { await bake(c.id, c.lat, c.lon, c.name, undefined, c.terrainDenoise); }
    catch (e) { console.error(`  FAILED ${id}:`, e); process.exitCode = 1; }
  }
}
