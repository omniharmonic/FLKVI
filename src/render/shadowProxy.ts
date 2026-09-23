// Shadow-only proxies (perf). A proxy is a cheap single-material stand-in (e.g. an instanced
// low-poly car hull) that is drawn ONLY into the sun's cascaded shadow map, so the detailed
// multi-material meshes it stands in for can set castShadow = false.
//
// Mechanism: proxies stay invisible; WebGLRenderer builds the main render list first, then calls
// SunLightShadow.updateMatrices right before drawing the shadow casters. We wrap that call to
// reveal the proxies for the shadow pass only, and hide them again in scene.onAfterRender, so
// they never enter the colour/depth passes.
//
//   registerShadowProxy(g, obj)   obj (and its subtree) is drawn in the sun shadow pass only
//                                 (castShadow flags of its meshes are left to the caller)
//   unregisterShadowProxy(g, obj)
import * as THREE from 'three';
import type { Game } from '../core/game';

interface ProxyState { set: Set<THREE.Object3D> }
const STATE = new WeakMap<Game, ProxyState>();

function install(g: Game): ProxyState | null {
  let st = STATE.get(g);
  if (st) return st;
  const sun = (g.sky as any)?.sunLight ?? (g.sky as any)?.sun;
  const shadow = sun?.shadow;
  if (!shadow || typeof shadow.updateMatrices !== 'function') return null;
  const set = new Set<THREE.Object3D>();
  st = { set };
  STATE.set(g, st);
  const orig = shadow.updateMatrices.bind(shadow);
  shadow.updateMatrices = (light: THREE.Light, cam?: THREE.Camera) => {
    orig(light, cam);
    for (const o of set) o.visible = true;
  };
  const prevAfter = g.scene.onAfterRender;
  g.scene.onAfterRender = function (this: THREE.Scene, ...args: Parameters<THREE.Scene['onAfterRender']>) {
    for (const o of set) o.visible = false;
    prevAfter.apply(this, args);
  } as THREE.Scene['onAfterRender'];
  return st;
}

export function registerShadowProxy(g: Game, obj: THREE.Object3D): boolean {
  const st = install(g);
  obj.visible = false;
  if (!st) return false;
  st.set.add(obj);
  return true;
}

export function unregisterShadowProxy(g: Game, obj: THREE.Object3D) {
  STATE.get(g)?.set.delete(obj);
  obj.visible = false;
}

// ------------------------------------------------------------------------------------------------
// Shadow distance for static chunk meshes: a registered mesh casts sun shadows only while its
// bounding sphere is within `dist` meters of the camera (curbs, fences, hedges... far-cascade
// shadows of small geometry are sub-texel anyway). Checked 4x per second.
//   registerShadowDistance(g, mesh, dist)

interface DistEntry { mesh: THREE.Object3D; dist: number; c: THREE.Vector3; r: number }
const DIST = new WeakMap<Game, DistEntry[]>();

export function registerShadowDistance(g: Game, mesh: THREE.Mesh, dist: number) {
  let list = DIST.get(g);
  if (!list) {
    const l: DistEntry[] = (list = []);
    DIST.set(g, l);
    let t = 0;
    g.addSystem({
      name: 'render-shadow-distance',
      order: 905,
      update: (dt) => {
        t -= dt;
        if (t > 0) return;
        t = 0.25;
        const p = g.camera.position;
        for (const e of l) {
          const d = Math.max(0, Math.hypot(e.c.x - p.x, e.c.y - p.y, e.c.z - p.z) - e.r);
          e.mesh.castShadow = d < e.dist;
        }
      },
    });
  }
  const geo = mesh.geometry;
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  mesh.updateWorldMatrix(true, false);
  const s = geo.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld);
  list.push({ mesh, dist, c: s.center, r: s.radius });
}

// ------------------------------------------------------------------------------------------------
// Near-instance shadows for city-wide static InstancedMeshes (street furniture): the source stops
// casting, and a shadow-only copy holds just the instances within `dist` of the camera (re-picked
// when the camera has moved 8 m). Same geometry + material, so the shadow shape is unchanged.
//   registerInstancedShadowLod(g, im, dist)

interface InstEntry { src: THREE.InstancedMesh; proxy: THREE.InstancedMesh; dist: number }
const INST = new WeakMap<Game, { list: InstEntry[]; root: THREE.Group }>();

export function registerInstancedShadowLod(g: Game, im: THREE.InstancedMesh, dist: number): boolean {
  let st = INST.get(g);
  if (!st) {
    const root = new THREE.Group();
    root.name = 'instanced-shadow-lod';
    g.scene.add(root);
    if (!registerShadowProxy(g, root)) { g.scene.remove(root); return false; }
    const s = (st = { list: [] as InstEntry[], root });
    INST.set(g, s);
    const last = { x: 1e9, z: 1e9 };
    g.addSystem({
      name: 'render-instanced-shadow-lod',
      order: 906,
      update: () => {
        const p = g.camera.position;
        if ((p.x - last.x) ** 2 + (p.z - last.z) ** 2 < 64) return;
        last.x = p.x; last.z = p.z;
        for (const e of s.list) refreshInst(e, p.x, p.z);
      },
    });
  }
  im.updateWorldMatrix(true, false);
  const proxy = new THREE.InstancedMesh(im.geometry, im.material, im.count);
  proxy.name = `${im.name}:shadow`;
  proxy.matrixAutoUpdate = false;
  proxy.matrix.copy(im.matrixWorld);
  proxy.count = 0;
  proxy.castShadow = true;
  proxy.receiveShadow = false;
  st.root.add(proxy);
  im.castShadow = false;
  const e = { src: im, proxy, dist };
  st.list.push(e);
  refreshInst(e, g.camera.position.x, g.camera.position.z);
  return true;
}

function refreshInst(e: InstEntry, cx: number, cz: number) {
  const src = e.src.instanceMatrix.array as Float32Array;
  const dst = e.proxy.instanceMatrix.array as Float32Array;
  const w = e.src.matrixWorld.elements;
  const d2 = e.dist * e.dist;
  let n = 0;
  for (let i = 0, N = e.src.count; i < N; i++) {
    const o = i * 16;
    // instance origin in world space (source parent transform is usually identity)
    const lx = src[o + 12], ly = src[o + 13], lz = src[o + 14];
    const x = w[0] * lx + w[4] * ly + w[8] * lz + w[12];
    const z = w[2] * lx + w[6] * ly + w[10] * lz + w[14];
    if ((x - cx) ** 2 + (z - cz) ** 2 > d2) continue;
    for (let k = 0; k < 16; k++) dst[n * 16 + k] = src[o + k];
    n++;
  }
  e.proxy.count = n;
  e.proxy.instanceMatrix.needsUpdate = true;
  e.proxy.boundingSphere = null;
  if (n) e.proxy.computeBoundingSphere();
}

// ------------------------------------------------------------------------------------------------
// Per-cascade casters. The sun has 2 cascades (0 = near, ~0..130 m; 1 = far, to shadowFar).
// setShadowCascades(g, obj, mask) limits every mesh under obj to the cascades in `mask`
// (bit 0 = near, bit 1 = far): e.g. detailed geometry only in the near cascade while a simpler
// stand-in covers the far one. Skipped draws are rejected by an empty drawRange before any GPU work.

const _savedCount = new WeakMap<THREE.BufferGeometry, number>();

export function setShadowCascades(g: Game, obj: THREE.Object3D, mask: number) {
  const sun = (g.sky as any)?.sunLight ?? (g.sky as any)?.sun;
  const shadow = sun?.shadow;
  if (!shadow || typeof shadow.getCamera !== 'function') return;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.userData.shadowCascades = mask;
    if (m.userData.shadowCascadeHook) return;
    m.userData.shadowCascadeHook = true;
    const before = m.onBeforeShadow, after = m.onAfterShadow;
    m.onBeforeShadow = function (r, ob, cam, shadowCam, geo, dm, grp) {
      const k = (this.userData.shadowCascades as number) ?? 3;
      const i = shadowCam === shadow.getCamera(0) ? 0 : shadowCam === shadow.getCamera(1) ? 1 : -1;
      if (i >= 0 && !(k & (1 << i))) {
        if (!_savedCount.has(geo)) _savedCount.set(geo, geo.drawRange.count);
        geo.drawRange.count = -1;
      }
      before.call(this, r, ob, cam, shadowCam, geo, dm, grp);
    };
    m.onAfterShadow = function (r, ob, cam, shadowCam, geo, dm, grp) {
      const c = _savedCount.get(geo);
      if (c !== undefined) { geo.drawRange.count = c; _savedCount.delete(geo); }
      after.call(this, r, ob, cam, shadowCam, geo, dm, grp);
    };
  });
}
