// Bake showcase cities into public/recipes/<id>.json.
// Usage: node --experimental-strip-types tools/compile-city.ts [id ...|all]
//        node --experimental-strip-types tools/compile-city.ts --lat 40.01 --lon -105.27 --id custom --name "Somewhere"
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fetchOverpass } from '../src/compiler/osm.ts';
import { TERRARIUM_URL, type DecodedTile } from '../src/compiler/terrain.ts';
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

export const compilerIO = { overpass: overpassCached, tiles: nodeTile };
