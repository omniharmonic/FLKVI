#!/usr/bin/env node
// OWNER: assets agent. Recompresses downloaded texture sets (once; marker file .opt) and writes
// src/assets/texture-manifest.json (sizeM, maps, res, avg color) consumed by manifest.ts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const DIR = path.join(ROOT, 'public/assets/textures');
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/assets/fetch/texture-sources.json'), 'utf8'));

// sizeM overrides where the source has no physical dimensions (estimated from features).
const SIZE_OVERRIDE = {
  'concrete-sidewalk': 6, // source is 1.8 m with 4x4 joints; 6 m gives US-standard 1.5 m (5 ft) panels
  'asphalt': 3, 'asphalt-worn': 3, 'asphalt-patched': 3, 'grass': 1.4,
  'decal-leak-1': 2, 'decal-leak-2': 2, 'decal-gum': 1, 'decal-manhole-2': 0.9, 'decal-manhole': 0.8,
  'decal-graffiti': 2.4, // atlas of 4x4 tags, each ~0.6 m
  'decal-puddle': 2.5, 'decal-oil': 1.5, 'decal-paint-splat': 0.6,
};
const KEEP_2K_NORMAL = new Set(['brick-red', 'brick-brown', 'brick-tan']);
const TINTABLE = new Set(['cmu-block', 'roof-standing-seam', 'roof-membrane', 'painted-metal', 'lap-siding', 'board-batten', 'stucco', 'brick-painted', 'brick-white', 'plaster']);

const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const width = (f) => +execFileSync('sips', ['-g', 'pixelWidth', f]).toString().match(/pixelWidth: (\d+)/)[1];

const out = {};
for (const id of fs.readdirSync(DIR).sort()) {
  const d = path.join(DIR, id);
  if (!fs.statSync(d).isDirectory()) continue;
  const maps = ['color', 'normal', 'rough', 'ao', 'opacity'].filter((k) => fs.existsSync(path.join(d, `${k}.jpg`)));
  if (!maps.includes('color')) continue;
  if (!fs.existsSync(path.join(d, '.opt'))) {
    for (const k of maps) {
      const f = path.join(d, `${k}.jpg`), t = f + '.tmp.jpg';
      const w = width(f);
      let vf = 'null';
      if (k === 'normal' && w > 1024 && !KEEP_2K_NORMAL.has(id)) vf = 'scale=1024:-1:flags=lanczos';
      if ((k === 'rough' || k === 'ao' || k === 'opacity') && w > 1024) vf = 'scale=1024:-1:flags=lanczos';
      if (k !== 'color' && k !== 'normal') vf += ',format=gray';
      ff('-i', f, '-vf', vf, '-q:v', k === 'normal' ? '5' : '4', t);
      if (fs.statSync(t).size < fs.statSync(f).size || vf !== 'null') fs.renameSync(t, f); else fs.rmSync(t);
    }
    fs.writeFileSync(path.join(d, '.opt'), '1');
  }
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path.join(d, 'color.jpg'), '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const avg = '#' + [...raw.subarray(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('');
  const src = sources[id] ?? {};
  out[id] = {
    sizeM: SIZE_OVERRIDE[id] ?? src.sizeM ?? 2,
    maps, res: width(path.join(d, 'color.jpg')), avg,
    ...(maps.includes('opacity') ? { decal: true } : {}),
    ...(TINTABLE.has(id) ? { tintable: true } : {}),
  };
}
fs.writeFileSync(path.join(ROOT, 'src/assets/texture-manifest.json'), JSON.stringify(out, null, 1));
console.log(Object.keys(out).length, 'sets');
