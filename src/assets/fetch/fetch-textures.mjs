#!/usr/bin/env node
// OWNER: assets agent. Dev-time script: downloads CC0 PBR texture sets into public/assets/textures/<id>/.
// Usage: node src/assets/fetch/fetch-textures.mjs [id ...]   (no args = all)
// Sources: Poly Haven (CC0) and ambientCG (CC0). Requires macOS `sips` and `unzip`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const OUT = path.join(ROOT, 'public/assets/textures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tex-'));
const UA = { 'User-Agent': 'groundtruth-asset-fetch/1.0' };

// id: [source, sourceId, res ('2k'|'1k'), opts]
// opts.gray: desaturate color map (so tint controls hue); opts.decal: keep opacity map
export const SETS = {
  'asphalt': ['acg', 'Asphalt025C', '2k'],
  'asphalt-worn': ['acg', 'Asphalt026C', '2k'],
  'asphalt-patched': ['ph', 'asphalt_02', '2k'],
  'concrete-sidewalk': ['ph', 'concrete_pavement_02', '2k'],
  'concrete': ['ph', 'concrete_floor_worn_001', '2k'],
  'curb': ['ph', 'concrete_floor_02', '1k'],
  'grass': ['acg', 'Grass004', '1k'],
  'grass-dry': ['ph', 'leafy_grass', '1k'],
  'dirt': ['ph', 'dirt', '1k'],
  'gravel': ['ph', 'gravel', '1k'],
  'leaves-ground': ['ph', 'forest_leaves_02', '1k'],
  'forest-floor': ['ph', 'forest_floor', '1k'],
  'alpine-rock': ['ph', 'rocky_terrain_02', '1k'],
  'desert-sand': ['ph', 'red_sand', '1k'],
  'coastal-sand': ['ph', 'coast_sand_01', '1k'],
  'snow': ['ph', 'snow_02', '1k'],
  'brick-red': ['ph', 'red_brick', '2k'],
  'brick-brown': ['ph', 'brick_wall_10', '2k'],
  'brick-tan': ['ph', 'brick_wall_003', '2k'],
  'brick-painted': ['ph', 'painted_worn_brick', '2k'],
  'brick-white': ['ph', 'whitewashed_brick', '2k'],
  'brick-old': ['ph', 'brick_wall_001', '1k'],
  'cmu-block': ['ph', 'concrete_block_wall', '1k', { gray: true }],
  'concrete-precast': ['ph', 'concrete_wall_004', '1k'],
  'stucco': ['ph', 'white_stucco', '2k'],
  'plaster': ['ph', 'plastered_wall', '2k'],
  'adobe': ['ph', 'clay_plaster', '1k'],
  'lap-siding': ['ph', 'exterior_wall_cladding_03', '2k'],
  'board-batten': ['ph', 'white_planks_clean', '1k'],
  'stone': ['ph', 'stone_wall', '1k'],
  'sandstone': ['ph', 'sandstone_blocks_08', '1k'],
  'metal-panel': ['ph', 'corrugated_iron_02', '1k'],
  'corrugated-metal': ['ph', 'worn_corrugated_iron', '1k'],
  'metal-shutter': ['ph', 'painted_metal_shutter', '1k'],
  'wood-shingle': ['ph', 'roof_tiles_14', '1k'],
  'roof-asphalt-shingle': ['ph', 'grey_roof_01', '2k'],
  'roof-clay-tile': ['ph', 'clay_roof_tiles_02', '1k'],
  'roof-standing-seam': ['ph', 'box_profile_metal_sheet', '1k', { gray: true }],
  'roof-slate': ['ph', 'roof_slates_02', '1k'],
  'roof-membrane': ['ph', 'painted_concrete', '1k', { gray: true }],
  'roof-gravel': ['ph', 'bicolour_gravel', '1k'],
  'tiles-terracotta': ['ph', 'terracotta_floor_tiles', '1k'],
  'paving': ['ph', 'concrete_pavers', '1k'],
  'cobble': ['ph', 'cobblestone_01', '1k'],
  'wood-planks': ['ph', 'raw_plank_wall', '1k'],
  'rust-metal': ['ph', 'rusty_metal_sheet', '1k'],
  'painted-metal': ['ph', 'blue_metal_plate', '1k', { gray: true }],
  'bark': ['ph', 'bark_brown_02', '1k'],
  // decals (ambientCG, with opacity)
  'decal-leak-1': ['acg', 'Leaking006', '1k', { decal: true }],
  'decal-leak-2': ['acg', 'Leaking004', '1k', { decal: true }],
  'decal-cracks': ['acg', 'AsphaltDamage001', '1k', { decal: true }],
  'decal-manhole': ['acg', 'ManholeCover005', '1k', { decal: true }],
  'decal-manhole-2': ['acg', 'ManholeCover009', '1k', { decal: true }],
  'decal-graffiti': ['acg', 'GraffitiSet001', '1k', { decal: true }],
  'decal-gum': ['acg', 'ChewingGum001', '1k', { decal: true }],
};

async function get(url, dest) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow' });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      return true;
    } catch (e) { if (i === 2) { console.warn('  fail', url, e.message); return false; } }
  }
}

function toJpg(src, dest, maxPx, gray = false) {
  const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85'];
  if (maxPx) args.push('-Z', String(maxPx));
  execFileSync('sips', [...args, src, '--out', dest], { stdio: 'ignore' });
  if (gray) {
    // desaturate + normalize brightness so tint drives the hue (ffmpeg available on dev box)
    const tmp = dest + '.g.jpg';
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', dest, '-vf', 'hue=s=0,eq=brightness=0.12:contrast=0.9', '-q:v', '3', tmp]);
    fs.renameSync(tmp, dest);
  }
}

const info = {};
async function doPH(id, src, res, opts) {
  const files = await (await fetch(`https://api.polyhaven.com/files/${src}`, { headers: UA })).json();
  const meta = await (await fetch(`https://api.polyhaven.com/info/${src}`, { headers: UA })).json();
  const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
  const want = { color: 'Diffuse', normal: 'nor_gl', rough: 'Rough', ao: 'AO' };
  for (const [k, m] of Object.entries(want)) {
    const r = k === 'color' || k === 'normal' ? res : '1k';
    const url = files[m]?.[r]?.jpg?.url ?? files[m]?.[r]?.png?.url;
    if (!url) { console.warn(`  ${id}: no ${m}`); continue; }
    const tmp = path.join(TMP, `${id}_${k}${path.extname(url)}`);
    if (await get(url, tmp)) toJpg(tmp, path.join(dir, `${k}.jpg`), 0, k === 'color' && opts.gray);
  }
  const dims = meta.dimensions ?? [2000, 2000];
  info[id] = { source: 'polyhaven', sourceId: src, url: `https://polyhaven.com/a/${src}`, author: Object.keys(meta.authors ?? {}).join(', '), sizeM: +(dims[0] / 1000).toFixed(2), res };
}

async function doACG(id, src, res, opts) {
  const R = res.toUpperCase();
  const zip = path.join(TMP, `${src}.zip`);
  if (!(await get(`https://ambientcg.com/get?file=${src}_${R}-JPG.zip`, zip))) return;
  const ex = path.join(TMP, src); fs.mkdirSync(ex, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', ex]);
  const list = fs.readdirSync(ex);
  const find = (s) => list.find((f) => f.includes(`_${s}.`) && /\.(jpg|png)$/i.test(f));
  const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
  const map = { color: 'Color', normal: 'NormalGL', rough: 'Roughness', ao: 'AmbientOcclusion', opacity: 'Opacity' };
  for (const [k, s] of Object.entries(map)) {
    const f = find(s); if (!f) continue;
    if (k === 'opacity' && !opts.decal) continue;
    toJpg(path.join(ex, f), path.join(dir, `${k}.jpg`), k === 'color' || k === 'normal' ? 0 : 1024, k === 'color' && opts.gray);
  }
  const meta = await (await fetch(`https://ambientcg.com/api/v2/full_json?id=${src}&include=dimensionsData`, { headers: UA })).json();
  const a = meta.foundAssets?.[0] ?? {};
  info[id] = { source: 'ambientcg', sourceId: src, url: `https://ambientcg.com/a/${src}`, author: 'ambientCG (Lennart Demes)', sizeM: a.dimensionX ? a.dimensionX / 100 : null, res };
}

const only = process.argv.slice(2);
const ids = Object.keys(SETS).filter((k) => !only.length || only.includes(k));
const queue = [...ids];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const id = queue.shift();
    const [src, sid, res, opts = {}] = SETS[id];
    try { await (src === 'ph' ? doPH : doACG)(id, sid, res, opts); console.log('ok', id, sid); }
    catch (e) { console.warn('ERR', id, e.message); }
  }
}));
const infoPath = path.join(ROOT, 'src/assets/fetch/texture-sources.json');
const prev = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : {};
fs.writeFileSync(infoPath, JSON.stringify({ ...prev, ...info }, null, 1));
fs.rmSync(TMP, { recursive: true, force: true });
