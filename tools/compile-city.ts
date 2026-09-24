// Bake showcase cities into public/recipes/<id>.json.
// Usage: node --experimental-strip-types tools/compile-city.ts [id ...|all]
//        node --experimental-strip-types tools/compile-city.ts --lat 40.01 --lon -105.27 --id custom --name "Somewhere"
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compileRecipe, packRecipe } from '../src/compiler/compile.ts';
import { fetchOverpass } from '../src/compiler/osm.ts';
import { TERRARIUM_URL, type DecodedTile } from '../src/compiler/terrain.ts';
import { BAKED_CITIES } from '../src/compiler/cities.ts';
import { decodePNG } from './png.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'node_modules', '.cache', 'groundtruth');
mkdirSync(join(cacheDir, 'tiles'), { recursive: true });
mkdirSync(join(cacheDir, 'osm'), { recursive: true });
const UA = 'GroundtruthWorldCompiler/0.1 (github.com/omniharmonic/groundtruth; open-source game)';

async function nodeTile(z: number, x: number, y: number): Promise<DecodedTile> {
  const f = join(cacheDir, 'tiles', `${z}-${x}-${y}.png`);
  let buf: Uint8Array;
  if (existsSync(f)) buf = readFileSync(f);
  else {
    const url = TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`tile ${url}: ${res.status}`);
    buf = new Uint8Array(await res.arrayBuffer());
    writeFileSync(f, buf);
  }
  return decodePNG(buf);
}

async function overpassCached(q: string) {
  const h = createHash('sha1').update(q).digest('hex').slice(0, 16);
  const f = join(cacheDir, 'osm', `${h}.json`);
  if (existsSync(f) && !process.env.NO_CACHE) return JSON.parse(readFileSync(f, 'utf8'));
  const j = await fetchOverpass(q, { userAgent: UA, onStatus: (s) => console.log('  ', s) });
  writeFileSync(f, JSON.stringify(j));
  return j;
}

async function bake(id: string, lat: number, lon: number, name: string, half?: number, terrainDenoise?: { sigma: number; open?: number }) {
  console.log(`\n=== ${id}: ${name} (${lat}, ${lon})`);
  let last = '';
  const r = await compileRecipe({ lat, lon, name, half, terrainDenoise }, { overpass: overpassCached, tiles: nodeTile, log: (m) => console.log('  ', m) }, (s) => { if (s !== last) { console.log('  ·', s); last = s; } });
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
