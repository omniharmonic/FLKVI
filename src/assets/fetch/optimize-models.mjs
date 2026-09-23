#!/usr/bin/env node
// OWNER: assets agent. Shrinks downloaded Poly Haven prop glTFs: deletes texture files only used by
// KHR_materials_variants alternates, drops the variant extension, and re-encodes textures to <=MAX px JPG.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const DIR = path.join(ROOT, 'public/assets/models/props');
const BIG = new Set(['prop-security-camera-1', 'prop-security-camera-2', 'prop-hydrant', 'prop-spray-can', 'prop-covered-car']);

for (const id of fs.readdirSync(DIR)) {
  const d = path.join(DIR, id); const f = path.join(d, 'model.gltf');
  if (!fs.existsSync(f)) continue;
  const g = JSON.parse(fs.readFileSync(f, 'utf8'));
  const usedMat = new Set();
  for (const m of g.meshes ?? []) for (const p of m.primitives) { if (p.material !== undefined) usedMat.add(p.material); delete p.extensions?.KHR_materials_variants; }
  delete g.extensions?.KHR_materials_variants;
  if (g.extensionsUsed) g.extensionsUsed = g.extensionsUsed.filter((e) => e !== 'KHR_materials_variants');
  const usedTex = new Set();
  const walk = (o) => { if (o && typeof o === 'object') { if (typeof o.index === 'number' && ('texCoord' in o || Object.keys(o).length <= 3)) usedTex.add(o.index); for (const v of Object.values(o)) walk(v); } };
  [...usedMat].forEach((i) => walk(g.materials[i]));
  const usedImg = new Set([...usedTex].map((t) => g.textures[t].source));
  const max = BIG.has(id) ? 1024 : 512;
  g.images.forEach((im, i) => {
    const p = path.join(d, decodeURIComponent(im.uri));
    if (!fs.existsSync(p)) return;
    if (!usedImg.has(i)) { fs.rmSync(p); return; }
    const t = p + '.tmp.jpg';
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', p, '-vf', `scale='min(${max},iw)':-1:flags=lanczos`, '-q:v', '4', t]);
    fs.renameSync(t, p);
  });
  fs.writeFileSync(f, JSON.stringify(g));
  const size = execFileSync('du', ['-sh', d]).toString().split('\t')[0];
  console.log(id, 'imgs', usedImg.size, '/', g.images.length, size);
}
