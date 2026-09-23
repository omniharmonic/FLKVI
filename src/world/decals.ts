// Road wear decals: cracks, oil stains, utility-cut patches, manhole covers. All instanced flat quads.
import * as THREE from 'three';
import { decalMaterial, textureSet } from '../assets/library';
import { rng } from '../core/geo';
import type { RoadNetwork, Chain } from './roads';
import { sampleAt } from './util';
import { surfaceMaterial } from './materials';

interface Inst { x: number; y: number; z: number; yaw: number; sx: number; sz: number; grade: number }

export function buildRoadDecals(roads: RoadNetwork, extraManholes: [number, number][], groundAt: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'road_decals';
  const sets: Record<string, Inst[]> = { cracks: [], oil: [], patch: [], manhole: [] };
  const R = rng(4242);
  for (const c of roads.chains) {
    if (c.internal || c.bridge) continue;
    const s0 = c.trim[0] + 1, s1 = c.len - c.trim[1] - 1;
    if (s1 - s0 < 4) continue;
    const major = c.cls !== 'service' && c.cls !== 'living_street';
    const laneW = c.oneway ? (c.w * 2) / c.lanes : c.w / Math.max(1, Math.floor(c.lanes / 2));
    const put = (key: string, s: number, off: number, sx: number, sz: number, yawJ = Math.PI * 2) => {
      const q = sampleAt(c.pts, c.L, s, c.ys);
      const nx = -q.dz, nz = q.dx;
      const x = q.x + nx * off, z = q.z + nz * off;
      // grade along the road
      const q2 = sampleAt(c.pts, c.L, Math.min(c.len, s + 1), c.ys);
      const grade = Math.atan2(q2.y - q.y, 1);
      sets[key].push({ x, y: q.y, z, yaw: Math.atan2(-q.dz, q.dx) + (yawJ ? (R() - 0.5) * yawJ : 0), sx, sz, grade });
    };
    // cracks: sparse, anywhere
    for (let s = s0 + R() * 12; s < s1; s += 9 + R() * 22) if (R() < 0.55) put('cracks', s, (R() * 2 - 1) * (c.w - 1), 1.4 + R() * 1.6, 1.4 + R() * 1.6);
    // oil: lane centers, denser near stop lines
    const lanesOff: number[] = [];
    if (c.oneway) for (let k = 0; k < c.lanes; k++) lanesOff.push(-c.w + laneW * (k + 0.5));
    else for (let k = 0; k < Math.max(1, Math.floor(c.lanes / 2)); k++) lanesOff.push(laneW * (k + 0.5), -laneW * (k + 0.5));
    for (const lo of lanesOff) {
      for (let s = s0 + R() * 10; s < s1; s += 7 + R() * 16) if (R() < 0.45) put('oil', s, lo + (R() - 0.5) * 0.6, 0.6 + R() * 0.9, 0.9 + R() * 1.3, 0.6);
      for (const e of [0, 1]) if (c.stopCtl[e]) for (let k = 0; k < 3; k++) {
        const d = (c.cross[e] ? 6 : 2.5) + 2 + k * 4.5 + R() * 2;
        const s = e === 0 ? c.trim[0] + d : c.len - c.trim[1] - d;
        if (s > s0 && s < s1) put('oil', s, lo + (R() - 0.5) * 0.3, 0.9 + R() * 0.6, 1.2 + R() * 0.8, 0.4);
      }
    }
    // utility-cut patches
    if (major) for (let s = s0 + R() * 30; s < s1 - 3; s += 25 + R() * 45) if (R() < 0.5) {
      const w = 1.2 + R() * 2.2, l = 1.5 + R() * 3.5;
      put('patch', s, (R() * 2 - 1) * Math.max(0, c.w - w / 2 - 0.3), l, w, 0);
    }
    // manholes
    if (major) for (let s = s0 + 10 + R() * 30; s < s1 - 2; s += 45 + R() * 45) put('manhole', s, lanesOff.length ? lanesOff[Math.floor(R() * lanesOff.length)] * 0.6 : 0, 0.82, 0.82, Math.PI * 2);
  }
  for (const [x, z] of extraManholes) sets.manhole.push({ x, y: groundAt(x, z), z, yaw: R() * 6.28, sx: 0.82, sz: 0.82, grade: 0 });

  const quad = new THREE.PlaneGeometry(1, 1);
  quad.rotateX(-Math.PI / 2);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  const mats: Record<string, THREE.Material | null> = {
    cracks: textureSet('decal-cracks') ? decalMaterial('decal-cracks', { opacity: 0.85 }) : null,
    oil: textureSet('decal-oil') ? decalMaterial('decal-oil', { opacity: 0.55, roughness: 0.35 }) : null,
    manhole: textureSet('decal-manhole') ? decalMaterial('decal-manhole', { roughness: 0.5 }) : null,
    patch: surfaceMaterial('asphalt-patched', { fallback: 'asphalt', tint: new THREE.Color(0.45, 0.45, 0.45), polygonOffset: -2, patch: { worldUv: true } }),
  };
  const lift: Record<string, number> = { cracks: 0.007, oil: 0.008, manhole: 0.009, patch: 0.004 };
  for (const [key, list] of Object.entries(sets)) {
    const mat = mats[key];
    if (!mat || !list.length) continue;
    const im = new THREE.InstancedMesh(quad, mat, list.length);
    list.forEach((d, i) => {
      e.set(0, d.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      // tilt with grade about the road's lateral axis
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), d.grade);
      q.multiply(tilt);
      pos.set(d.x, d.y + lift[key], d.z);
      sc.set(d.sx, 1, d.sz);
      im.setMatrixAt(i, m4.compose(pos, q, sc));
    });
    im.name = 'decal_' + key;
    im.receiveShadow = true;
    im.renderOrder = key === 'patch' ? 0 : 1;
    im.computeBoundingSphere();
    group.add(im);
  }
  return group;
}
export type { Chain };
