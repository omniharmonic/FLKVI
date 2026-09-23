#!/usr/bin/env node
// OWNER: assets agent. Downloads CC0 Poly Haven prop models (glTF 1k) into public/assets/models/props/<id>/.
// Usage: node src/assets/fetch/fetch-models.mjs [id ...]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const OUT = path.join(ROOT, 'public/assets/models/props');
const UA = { 'User-Agent': 'groundtruth-asset-fetch/1.0' };

// our id → Poly Haven id
export const PROPS = {
  'prop-hydrant': 'fire_hydrant',
  'prop-trash-can': 'metal_trash_can',
  'prop-trash-bag': 'trashbag',
  'prop-jersey-barrier': 'concrete_road_barrier',
  'prop-jersey-barrier-2': 'concrete_road_barrier_02',
  'prop-street-lamp-1': 'street_lamp_01',
  'prop-street-lamp-2': 'street_lamp_02',
  'prop-bench': 'modular_street_seating',
  'prop-utility-box-1': 'utility_box_01',
  'prop-utility-box-2': 'utility_box_02',
  'prop-security-camera-1': 'security_camera_01',
  'prop-security-camera-2': 'security_camera_02',
  'prop-security-light': 'security_light',
  'prop-spray-can': 'spray_paint_bottles_02',
  'prop-cardboard-box': 'cardboard_box_01',
  'prop-wet-floor-sign': 'WetFloorSign_01',
  'prop-covered-car': 'covered_car',
  'prop-barrel': 'Barrel_01',
  'prop-plastic-crate': 'plastic_crate_01',
  'prop-generator': 'portable_generator',
  'prop-planter': 'planter_box_01',
  'prop-potted-plant': 'potted_plant_02',
  'prop-shrub-1': 'shrub_01',
  'prop-shrub-2': 'shrub_02',
  'prop-bolt-cutters': 'bolt_cutters_01',
  'prop-handsaw': 'handsaw_wood',
  'prop-manhole': 'water_manhole_cover',
  'prop-chainlink-fence': 'modular_chainlink_fence',
};

async function get(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

const info = {};
const only = process.argv.slice(2);
const queue = Object.keys(PROPS).filter((k) => !only.length || only.includes(k));
await Promise.all(Array.from({ length: 5 }, async () => {
  while (queue.length) {
    const id = queue.shift(); const src = PROPS[id];
    try {
      const files = await (await fetch(`https://api.polyhaven.com/files/${src}`, { headers: UA })).json();
      const meta = await (await fetch(`https://api.polyhaven.com/info/${src}`, { headers: UA })).json();
      const g = files.gltf['1k'].gltf;
      const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
      const gl = JSON.parse((await get(g.url)).toString());
      // Keep only images actually referenced by the base materials (drop KHR_materials_variants extras).
      for (const [rel, f] of Object.entries(g.include)) {
        const dest = path.join(dir, rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, await get(f.url));
      }
      fs.writeFileSync(path.join(dir, 'model.gltf'), JSON.stringify(gl));
      info[id] = { sourceId: src, url: `https://polyhaven.com/a/${src}`, author: Object.keys(meta.authors ?? {}).join(', '), polycount: meta.polycount, dimensionsMm: meta.dimensions };
      console.log('ok', id, meta.polycount);
    } catch (e) { console.warn('ERR', id, e.message); }
  }
}));
const infoPath = path.join(ROOT, 'src/assets/fetch/model-sources.json');
const prev = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : {};
fs.writeFileSync(infoPath, JSON.stringify({ ...prev, ...info }, null, 1));
