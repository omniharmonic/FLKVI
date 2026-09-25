/** Import a bounded playable recipe from a regional OSM snapshot without Overpass.
 * node --experimental-strip-types tools/bulk-import-world.ts --help
 */
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileRecipe, packRecipe } from '../src/compiler/compile.ts';
import { makeProjection } from '../src/core/geo.ts';
import type { TileLoader } from '../src/compiler/terrain.ts';
import { compilerIO } from './compiler-io.ts';
import { decodePNG } from './png.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export interface BulkImportOptions {
  input: string; output: string; name?: string;
  lat?: number; lon?: number; half?: number; bounds?: [number, number, number, number];
  cell?: number; farHalf?: number; index?: string; sourceUrl?: string;
  offlineTerrain?: boolean; terrainDir?: string; allowIncomplete?: boolean;
}
function command(binary: string, args: string[]) {
  return new Promise<string>((resolveCommand, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-65536); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-65536); });
    child.on('error', error => reject(new Error(`${binary} could not start: ${error.message}. ${binary === 'osmium' ? 'Install osmium-tool (brew install osmium-tool / apt install osmium-tool), or supply an .osm XML snapshot. See docs/offline-world-import.md.' : 'Python 3 with its standard library is required.'}`)));
    child.on('close', code => code === 0 ? resolveCommand(stdout) : reject(new Error(`${binary} exited ${code}: ${stderr.trim()}`)));
  });
}
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}
function windowFor(o: BulkImportOptions) {
  let lat = o.lat, lon = o.lon, half = o.half ?? 600;
  if (o.bounds) {
    const [w, s, e, n] = o.bounds;
    if (o.lat !== undefined || o.lon !== undefined || o.half !== undefined) throw new Error('Use either --bounds or --lat/--lon/--half.');
    if (![w, s, e, n].every(Number.isFinite) || !(w >= -180 && e <= 180 && w < e && s > -85 && n < 85 && s < n)) throw new Error('Bounds must be west,south,east,north within ±85° latitude; split antimeridian regions.');
    lat = (s + n) / 2; lon = (w + e) / 2;
    const projection = makeProjection(lat, lon);
    half = Math.ceil(Math.max((e - w) * projection.mPerDegLon, (n - s) * projection.mPerDegLat) / 2);
  }
  if (lat === undefined || lon === undefined || ![lat, lon, half].every(Number.isFinite) || Math.abs(lat) >= 85 || Math.abs(lon) > 180 || half <= 0) throw new Error('Supply valid --lat and --lon with a positive --half, or --bounds.');
  const cell = o.cell ?? 4, farHalf = o.farHalf ?? 0;
  if (!Number.isFinite(cell) || cell < 1 || !Number.isFinite(farHalf) || farHalf < 0) throw new Error('--cell must be at least 1m and --far-half nonnegative.');
  if (Math.ceil((half + 60) * 2 / cell + 1) ** 2 > 2_000_000 || farHalf > 20000) throw new Error('Terrain budget exceeded. Subdivide the region or increase --cell; --far-half must be ≤20000.');
  const projection = makeProjection(lat, lon), margin = half + 120;
  const nw = projection.toLatLon(-margin, -margin), se = projection.toLatLon(margin, margin);
  const bbox: [number, number, number, number] = [nw.lon, se.lat, se.lon, nw.lat];
  if (nw.lon < -180 || se.lon > 180 || nw.lat >= 85 || se.lat <= -85) throw new Error('Compiler window crosses supported coordinate bounds; subdivide it.');
  return { lat, lon, half, cell, farHalf, bbox };
}
async function atomicJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.partial`;
  try { await writeFile(pending, JSON.stringify(value)); await rename(pending, path); }
  finally { await rm(pending, { force: true }); }
}
export async function importBulkRecipe(options: BulkImportOptions, overrides: { tiles?: TileLoader; log?: (message: string) => void } = {}) {
  const o = { ...options, input: resolve(options.input), output: resolve(options.output) };
  const w = windowFor(o), log = overrides.log ?? console.log;
  if ([o.output, `${o.output}.source.json`, o.index && resolve(o.index)].includes(o.input) || (o.index && [o.output, `${o.output}.source.json`].includes(resolve(o.index)))) throw new Error('Input, output, provenance, and index must be distinct files.');
  const work = await mkdtemp(join(tmpdir(), 'flk-bulk-'));
  try {
    let xml = o.input;
    if (/\.pbf$/i.test(xml)) {
      xml = join(work, 'region.osm');
      log('Streaming regional PBF to local XML (disk-backed selection follows)…');
      await command('osmium', ['cat', o.input, '--output', xml]);
    } else if (!/\.osm(?:\.(?:gz|bz2))?$/i.test(xml)) throw new Error('Input must be an .osm, .osm.gz, .osm.bz2, or .osm.pbf snapshot.');
    log('Indexing local OSM and resolving complete feature references…');
    const selection = join(work, 'selection.json');
    const args = [join(root, 'tools/osm-extract.py'), '--input', xml, '--index', o.index ? resolve(o.index) : join(work, 'index.sqlite'), `--bounds=${w.bbox.join(',')}`, '--output', selection];
    if (o.allowIncomplete) args.push('--allow-incomplete');
    const summary = JSON.parse(await command('python3', args));
    if ((await stat(selection)).size > 128 * 1024 * 1024) throw new Error('Selected OSM features exceed the 128MiB compile budget. Subdivide the input extract/window.');
    const osm = JSON.parse(await readFile(selection, 'utf8'));
    const tileDir = resolve(o.terrainDir ?? join(root, 'node_modules/.cache/groundtruth/tiles'));
    const localTiles: TileLoader = async (z, x, y) => {
      const path = join(tileDir, `${z}-${x}-${y}.png`);
      try { return decodePNG(new Uint8Array(await readFile(path))); }
      catch (error) { throw new Error(`Offline terrain tile unavailable/invalid: ${path}. Populate the Terrarium cache first or omit --offline-terrain. ${error}`); }
    };
    log(`Compiling ${summary.counts.nodes} nodes, ${summary.counts.ways} ways, ${summary.counts.relations} relations; no Overpass requests.`);
    const recipe = await compileRecipe({ lat: w.lat, lon: w.lon, half: w.half, cell: w.cell, farHalf: w.farHalf, name: o.name ?? 'Offline region', lean: false }, {
      overpass: async () => osm, tiles: overrides.tiles ?? (o.offlineTerrain ? localTiles : compilerIO.tiles), log,
    });
    const provenance = { version: 1, importer: 'FLK VI offline regional OSM', createdAt: new Date().toISOString(), source: { file: o.input, sha256: await hashFile(o.input), url: o.sourceUrl ?? null }, window: w, counts: summary.counts, missingReferences: summary.missingReferences, terrain: o.offlineTerrain ? 'local Terrarium cache' : 'cached/network Terrarium', attribution: ['Map data © OpenStreetMap contributors (ODbL 1.0)', 'https://www.openstreetmap.org/copyright'], indexReused: summary.indexReused };
    await atomicJSON(o.output, packRecipe(recipe));
    await atomicJSON(`${o.output}.source.json`, provenance);
    log(`Wrote ${o.output}`);
    return { recipe, provenance };
  } finally { await rm(work, { recursive: true, force: true }); }
}
const help = `Offline regional OSM → compiled FLK VI recipe (no Overpass)\n\nnode --experimental-strip-types tools/bulk-import-world.ts \\\n  --input region.osm.pbf --lat 18.341 --lon -64.932 --half 1120 \\\n  --name "St Thomas" --output /tmp/st-thomas.json\n\nWindow: --lat N --lon N [--half METERS], or --bounds west,south,east,north\nOptions: --cell 4 --far-half 0 --index cache.sqlite --source-url URL\n         --offline-terrain --terrain-dir DIR --allow-incomplete\nPBF requires osmium-tool. XML requires Python 3 only. Terrain uses cached/public\nTerrarium tiles unless --offline-terrain. See docs/offline-world-import.md.`;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log(help);
  else try {
    const parsed: Record<string, unknown> = {};
    const flags: Record<string, string> = { '--offline-terrain': 'offlineTerrain', '--allow-incomplete': 'allowIncomplete' };
    const keys: Record<string, string> = { '--input':'input','--output':'output','--name':'name','--lat':'lat','--lon':'lon','--half':'half','--bounds':'bounds','--cell':'cell','--far-half':'farHalf','--index':'index','--source-url':'sourceUrl','--terrain-dir':'terrainDir' };
    for (let i=0; i<args.length; i++) {
      const flag = args[i];
      if (flags[flag]) { parsed[flags[flag]] = true; continue; }
      const key = keys[flag], value = args[++i];
      if (!key || value === undefined || value.startsWith('--')) throw new Error(`Unknown option or missing value: ${flag}`);
      parsed[key] = key === 'bounds' ? value.split(',').map(Number) : ['lat','lon','half','cell','farHalf'].includes(key) ? Number(value) : value;
    }
    if (!parsed.input || !parsed.output) throw new Error('--input and --output required. Use --help.');
    if (parsed.bounds && (parsed.bounds as number[]).length !== 4) throw new Error('--bounds needs four comma-separated coordinates.');
    await importBulkRecipe(parsed as unknown as BulkImportOptions);
  } catch (error) { console.error(`Bulk import failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
