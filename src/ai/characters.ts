// Animated characters for pedestrians and officers.
// Prefers CC0 rigged glTF characters from the asset library (loadModelWithAnimations); falls back to a
// procedural low-poly skinned humanoid (real SkinnedMesh + Skeleton + shared AnimationClips).
// Falls/lying are done rig-agnostically by tilting the root (ragdoll-lite).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as Lib from '../assets/library';

export type Role = 'idle' | 'walk' | 'run' | 'phone' | 'sit' | 'wave';
export type CharKind = 'civilian' | 'officer';

const NAVY = '#1b2233';

// ------------------------------------------------------------------------------------------------
// Procedural rig
// ------------------------------------------------------------------------------------------------

interface BoneDef { name: string; parent: string | null; pos: [number, number, number] }
const BONES: BoneDef[] = [
  { name: 'hips', parent: null, pos: [0, 0.97, 0] },
  { name: 'spine', parent: 'hips', pos: [0, 0.12, 0] },
  { name: 'chest', parent: 'spine', pos: [0, 0.2, 0] },
  { name: 'neck', parent: 'chest', pos: [0, 0.22, 0] },
  { name: 'head', parent: 'neck', pos: [0, 0.08, 0] },
  { name: 'upperArmL', parent: 'chest', pos: [-0.2, 0.17, 0] },
  { name: 'foreArmL', parent: 'upperArmL', pos: [0, -0.28, 0] },
  { name: 'handL', parent: 'foreArmL', pos: [0, -0.25, 0] },
  { name: 'upperArmR', parent: 'chest', pos: [0.2, 0.17, 0] },
  { name: 'foreArmR', parent: 'upperArmR', pos: [0, -0.28, 0] },
  { name: 'handR', parent: 'foreArmR', pos: [0, -0.25, 0] },
  { name: 'thighL', parent: 'hips', pos: [-0.1, -0.04, 0] },
  { name: 'shinL', parent: 'thighL', pos: [0, -0.44, 0] },
  { name: 'footL', parent: 'shinL', pos: [0, -0.43, 0] },
  { name: 'thighR', parent: 'hips', pos: [0.1, -0.04, 0] },
  { name: 'shinR', parent: 'thighR', pos: [0, -0.44, 0] },
  { name: 'footR', parent: 'shinR', pos: [0, -0.43, 0] },
];
const BONE_INDEX = new Map(BONES.map((b, i) => [b.name, i]));

function worldBonePos(): Map<string, THREE.Vector3> {
  const m = new Map<string, THREE.Vector3>();
  for (const b of BONES) {
    const p = new THREE.Vector3(...b.pos);
    if (b.parent) p.add(m.get(b.parent)!);
    m.set(b.name, p);
  }
  return m;
}

interface Palette { skin: string; shirt: string; pants: string; shoes: string; hair: string; cap?: string; jacket?: boolean }

const SKINS = ['#f1c7a5', '#e0ac85', '#c68863', '#9c6644', '#6f4a33', '#4a3226'];
const SHIRTS = ['#6a7f95', '#b64a3c', '#e8e4da', '#3d5a45', '#2c2f38', '#c29a3f', '#7a4f7e', '#406b8c', '#8c8c86', '#a05a2c', '#d8c9a6', '#244a6b'];
const PANTS = ['#2e3440', '#3b4a63', '#5a5048', '#1f2226', '#6b6f5c', '#46506a', '#8a7d68'];
const HAIR = ['#1c1510', '#3b2618', '#6b4a2a', '#a07a4a', '#cfc2a8', '#2a2a2a'];

/** Geometry for a humanoid with vertex colors, rigidly skinned to BONES. */
function buildBodyGeometry(p: Palette, build: number): THREE.BufferGeometry {
  const wp = worldBonePos();
  const parts: THREE.BufferGeometry[] = [];
  const col = new THREE.Color();
  const add = (geo: THREE.BufferGeometry, bone: string, at: THREE.Vector3, color: string, weights?: [string, number][]) => {
    geo = geo.index ? geo.toNonIndexed() : geo;
    geo.translate(at.x, at.y, at.z);
    const n = geo.attributes.position.count;
    const colors = new Float32Array(n * 3);
    col.set(color).convertSRGBToLinear();
    for (let i = 0; i < n; i++) { colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b; }
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const bi = BONE_INDEX.get(bone)!;
    for (let i = 0; i < n; i++) {
      if (weights) {
        // blend by vertex height between bones (for torso bending)
        const y = geo.attributes.position.getY(i);
        si[i * 4] = BONE_INDEX.get(weights[0][0])!;
        si[i * 4 + 1] = BONE_INDEX.get(weights[1][0])!;
        const y0 = weights[0][1], y1 = weights[1][1];
        const t = Math.max(0, Math.min(1, (y - y0) / (y1 - y0)));
        sw[i * 4] = 1 - t; sw[i * 4 + 1] = t;
      } else {
        si[i * 4] = bi; sw[i * 4] = 1;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    geo.deleteAttribute('uv');
    parts.push(geo);
  };
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const w = 1 + (build - 1) * 0.6;
  // legs
  for (const s of ['L', 'R']) {
    const th = wp.get('thigh' + s)!, sh = wp.get('shin' + s)!, ft = wp.get('foot' + s)!;
    add(new THREE.CylinderGeometry(0.075 * w, 0.062 * w, 0.44, 7), 'thigh' + s, v(th.x, th.y - 0.22, th.z), p.pants);
    add(new THREE.CylinderGeometry(0.058 * w, 0.048, 0.43, 7), 'shin' + s, v(sh.x, sh.y - 0.215, sh.z), p.pants);
    add(new THREE.BoxGeometry(0.1, 0.07, 0.25), 'foot' + s, v(ft.x, ft.y - 0.035 + 0.035, ft.z - 0.05), p.shoes);
  }
  // pelvis + torso (weighted spine→chest)
  const hips = wp.get('hips')!, chest = wp.get('chest')!;
  add(new THREE.BoxGeometry(0.34 * w, 0.18, 0.2 * w), 'hips', v(0, hips.y - 0.02, 0), p.pants);
  const torso = new THREE.CylinderGeometry(0.2 * w, 0.17 * w, 0.46, 8, 3);
  torso.scale(1, 1, 0.62);
  add(torso, 'spine', v(0, hips.y + 0.3, 0), p.shirt, [['spine', hips.y + 0.1], ['chest', chest.y + 0.1]]);
  // shoulders
  add(new THREE.BoxGeometry(0.44 * w, 0.1, 0.2 * w), 'chest', v(0, chest.y + 0.14, 0), p.shirt);
  // neck + head
  const head = wp.get('head')!;
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 6), 'neck', v(0, head.y - 0.04, 0), p.skin);
  const hg = new THREE.SphereGeometry(0.105, 10, 8);
  hg.scale(0.92, 1.12, 1);
  add(hg, 'head', v(0, head.y + 0.11, 0), p.skin);
  if (p.cap) {
    add(new THREE.CylinderGeometry(0.11, 0.112, 0.07, 10), 'head', v(0, head.y + 0.2, 0.0), p.cap);
    add(new THREE.BoxGeometry(0.16, 0.015, 0.1), 'head', v(0, head.y + 0.17, -0.12), p.cap);
  } else {
    const hair = new THREE.SphereGeometry(0.112, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
    hair.scale(0.95, 1.05, 1.02);
    add(hair, 'head', v(0, head.y + 0.13, 0.01), p.hair);
  }
  // arms
  const sleeve = p.jacket ? p.shirt : p.skin;
  for (const s of ['L', 'R']) {
    const ua = wp.get('upperArm' + s)!, fa = wp.get('foreArm' + s)!, hd = wp.get('hand' + s)!;
    add(new THREE.CylinderGeometry(0.056 * w, 0.048 * w, 0.29, 6), 'upperArm' + s, v(ua.x, ua.y - 0.14, ua.z), p.shirt);
    add(new THREE.CylinderGeometry(0.046, 0.04, 0.26, 6), 'foreArm' + s, v(fa.x, fa.y - 0.13, fa.z), sleeve);
    add(new THREE.BoxGeometry(0.06, 0.1, 0.035), 'hand' + s, v(hd.x, hd.y - 0.05, hd.z), p.skin);
  }
  const geo = mergeGeometries(parts, false)!;
  geo.computeBoundingSphere();
  return geo;
}

// ---- procedural clips ----------------------------------------------------------------------------

const qx = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (deg * Math.PI) / 180);
function qxyz(x: number, y: number, z: number) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler((x * Math.PI) / 180, (y * Math.PI) / 180, (z * Math.PI) / 180, 'XYZ'));
}

function quatTrack(bone: string, times: number[], quats: THREE.Quaternion[]) {
  const vals: number[] = [];
  for (const q of quats) vals.push(q.x, q.y, q.z, q.w);
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, vals);
}

/** Cyclic swing: angles sampled over one cycle at `n` keys. */
function cyc(bone: string, period: number, fn: (ph: number) => THREE.Quaternion, n = 8) {
  const times: number[] = [], qs: THREE.Quaternion[] = [];
  for (let i = 0; i <= n; i++) {
    const ph = (i / n) * Math.PI * 2;
    times.push((i / n) * period);
    qs.push(fn(ph));
  }
  return quatTrack(bone, times, qs);
}

function makeClips(): Record<string, THREE.AnimationClip> {
  const clips: Record<string, THREE.AnimationClip> = {};
  const hipsY = BONES[0].pos[1];
  const gait = (name: string, T: number, thigh: number, knee: number, arm: number, elbow: number, lean: number, bob: number) => {
    const tracks: THREE.KeyframeTrack[] = [
      cyc('thighL', T, (p) => qx(Math.sin(p) * thigh)),
      cyc('thighR', T, (p) => qx(-Math.sin(p) * thigh)),
      cyc('shinL', T, (p) => qx(-Math.max(0, Math.sin(p - 1.4)) * knee - 4)),
      cyc('shinR', T, (p) => qx(-Math.max(0, -Math.sin(p - 1.4)) * knee - 4)),
      cyc('footL', T, (p) => qx(Math.sin(p) * 10)),
      cyc('footR', T, (p) => qx(-Math.sin(p) * 10)),
      cyc('upperArmL', T, (p) => qxyz(-Math.sin(p) * arm, 0, -6)),
      cyc('upperArmR', T, (p) => qxyz(Math.sin(p) * arm, 0, 6)),
      cyc('foreArmL', T, (p) => qx(elbow + Math.max(0, -Math.sin(p)) * elbow * 0.6)),
      cyc('foreArmR', T, (p) => qx(elbow + Math.max(0, Math.sin(p)) * elbow * 0.6)),
      cyc('spine', T, (p) => qxyz(lean, Math.sin(p) * 6, 0)),
      cyc('chest', T, (p) => qxyz(0, -Math.sin(p) * 8, 0)),
    ];
    const times: number[] = [], vals: number[] = [];
    for (let i = 0; i <= 8; i++) {
      times.push((i / 8) * T);
      vals.push(0, hipsY + Math.abs(Math.cos((i / 8) * Math.PI * 2)) * bob - bob * 0.5, 0);
    }
    tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, vals));
    clips[name] = new THREE.AnimationClip(name, T, tracks);
  };
  gait('walk', 1.05, 24, 38, 18, 12, 3, 0.035);
  gait('run', 0.68, 48, 95, 42, 75, 12, 0.07);
  const idleT = 3.2;
  clips.idle = new THREE.AnimationClip('idle', idleT, [
    cyc('chest', idleT, (p) => qx(Math.sin(p) * 1.8), 6),
    cyc('upperArmL', idleT, (p) => qxyz(2 + Math.sin(p) * 1.5, 0, -5), 6),
    cyc('upperArmR', idleT, (p) => qxyz(2 + Math.sin(p) * 1.5, 0, 5), 6),
    cyc('foreArmL', idleT, () => qx(8), 2),
    cyc('foreArmR', idleT, () => qx(8), 2),
    cyc('head', idleT, (p) => qxyz(0, Math.sin(p) * 12, 0), 6),
  ]);
  clips.phone = new THREE.AnimationClip('phone', 2, [
    cyc('upperArmR', 2, (p) => qxyz(38 + Math.sin(p) * 2, 0, 28), 4),
    cyc('foreArmR', 2, () => qxyz(128, 0, 0), 2),
    cyc('handR', 2, () => qxyz(0, -60, 0), 2),
    cyc('upperArmL', 2, () => qxyz(4, 0, -6), 2),
    cyc('foreArmL', 2, () => qx(20), 2),
    cyc('head', 2, (p) => qxyz(4, 10 + Math.sin(p) * 8, 6), 4),
  ]);
  clips.sit = new THREE.AnimationClip('sit', 4, [
    new THREE.VectorKeyframeTrack('hips.position', [0, 4], [0, hipsY - 0.45, 0.05, 0, hipsY - 0.45, 0.05]),
    cyc('thighL', 4, () => qx(88), 2),
    cyc('thighR', 4, () => qx(84), 2),
    cyc('shinL', 4, () => qx(-86), 2),
    cyc('shinR', 4, () => qx(-80), 2),
    cyc('upperArmL', 4, () => qxyz(18, 0, -8), 2),
    cyc('upperArmR', 4, () => qxyz(18, 0, 8), 2),
    cyc('foreArmL', 4, () => qx(50), 2),
    cyc('foreArmR', 4, () => qx(50), 2),
    cyc('head', 4, (p) => qxyz(-4, Math.sin(p) * 20, 0), 6),
  ]);
  clips.wave = new THREE.AnimationClip('wave', 1, [
    cyc('upperArmR', 1, () => qxyz(10, 0, 150), 2),
    cyc('foreArmR', 1, (p) => qxyz(0, 0, 20 + Math.sin(p) * 25), 4),
    cyc('upperArmL', 1, () => qxyz(10, 0, -150), 2),
    cyc('foreArmL', 1, (p) => qxyz(0, 0, -20 - Math.sin(p) * 25), 4),
  ]);
  return clips;
}

// ------------------------------------------------------------------------------------------------
// Character instances
// ------------------------------------------------------------------------------------------------

export class Character {
  /** Positioned/rotated by the owner (feet at origin, faces -Z). */
  readonly root = new THREE.Group();
  /** Inner pivot for falls (tilts around the feet). */
  readonly pivot = new THREE.Group();
  mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  role: Role | null = null;
  phone: THREE.Object3D | null = null;
  /** 0 standing .. 1 lying on the ground */
  fallT = 0;
  fallTarget = 0;
  fallDir = 1;
  constructor(model: THREE.Object3D, clips: Record<string, THREE.AnimationClip>, public kind: CharKind, phoneParent: THREE.Object3D | null) {
    this.root.add(this.pivot);
    this.pivot.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    for (const [k, c] of Object.entries(clips)) this.actions.set(k, this.mixer.clipAction(c));
    if (phoneParent) {
      const ph = new THREE.Mesh(PHONE_GEO, PHONE_MAT);
      ph.position.set(0.02, -0.07, -0.03);
      ph.visible = false;
      phoneParent.add(ph);
      this.phone = ph;
    }
  }

  has(role: Role) { return this.actions.has(role); }

  play(role: Role, fade = 0.25, timeScale = 1) {
    let a = this.actions.get(role);
    if (!a && role === 'run') a = this.actions.get('walk');
    if (!a && (role === 'phone' || role === 'sit' || role === 'wave')) a = this.actions.get('idle');
    if (!a) return;
    a.timeScale = timeScale;
    if (this.current === a) { this.role = role; return; }
    a.reset();
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    if (this.current) a.crossFadeFrom(this.current, fade, false);
    this.current = a;
    this.role = role;
    if (this.phone) this.phone.visible = role === 'phone';
  }

  /** Advance animation; `dt` may be accumulated for low-rate LOD updates. */
  update(dt: number) {
    this.mixer.update(dt);
    // ragdoll-lite: tilt around the feet
    if (this.fallT !== this.fallTarget) {
      const sp = this.fallTarget > this.fallT ? 3.2 : 1.2;
      this.fallT += Math.sign(this.fallTarget - this.fallT) * Math.min(Math.abs(this.fallTarget - this.fallT), dt * sp);
      const e = this.fallTarget > 0 ? easeOutBounce(this.fallT) : this.fallT;
      this.pivot.rotation.x = -this.fallDir * e * (Math.PI / 2) * 0.97;
      this.pivot.position.y = e * 0.12;
    }
  }

  setFallen(on: boolean, backwards = true) {
    this.fallTarget = on ? 1 : 0;
    if (on) this.fallDir = backwards ? -1 : 1;
  }
}

function easeOutBounce(t: number) {
  if (t >= 1) return 1;
  const k = t * 1.08;
  return k > 1 ? 1 + (1 - k) * 0.4 * Math.sin((k - 1) * 30) : k * k;
}

const PHONE_GEO = new THREE.BoxGeometry(0.075, 0.14, 0.012);
const PHONE_MAT = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.3, metalness: 0.4, emissive: '#3a6cff', emissiveIntensity: 0.25 });

// ------------------------------------------------------------------------------------------------
// Factory (procedural or glTF)
// ------------------------------------------------------------------------------------------------

interface GltfVariant { scene: THREE.Group; clips: Record<string, THREE.AnimationClip>; tags: string[] }

export class CharacterFactory {
  private procClips = makeClips();
  private procGeos: THREE.BufferGeometry[] = [];
  private officerGeo: THREE.BufferGeometry | null = null;
  private mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  private gltf: GltfVariant[] = [];
  private gltfOfficer: GltfVariant[] = [];
  source: 'procedural' | 'gltf' = 'procedural';

  constructor(private rnd: () => number) {
    for (let i = 0; i < 14; i++) {
      const pick = <T,>(a: T[]) => a[Math.floor(this.rnd() * a.length)];
      this.procGeos.push(buildBodyGeometry({
        skin: pick(SKINS), shirt: pick(SHIRTS), pants: pick(PANTS), shoes: this.rnd() < 0.5 ? '#1a1a1a' : pick(['#e8e8e8', '#5a3b22', '#303848']),
        hair: pick(HAIR), jacket: this.rnd() < 0.45, cap: this.rnd() < 0.12 ? pick(['#9c2b23', '#1f2d4a', '#2a2a2a']) : undefined,
      }, 0.9 + this.rnd() * 0.25));
    }
    this.officerGeo = buildBodyGeometry({ skin: SKINS[1], shirt: NAVY, pants: '#161b28', shoes: '#0c0c0c', hair: HAIR[0], cap: '#11151f', jacket: true }, 1.08);
  }

  /** Try to load CC0 rigged characters from the asset library (non-fatal). */
  async loadAssets(): Promise<void> {
    const lib = Lib as any;
    if (typeof lib.loadModelWithAnimations !== 'function' || typeof lib.modelIds !== 'function') return;
    let ids: string[] = [];
    try { ids = lib.modelIds('character') ?? []; } catch { ids = []; }
    if (!ids.length) return;
    const results = await Promise.all(ids.slice(0, 8).map(async (id: string) => {
      try {
        const r = await lib.loadModelWithAnimations(id);
        if (!r || !r.clips?.walk) return null;
        const tags: string[] = lib.MODELS?.[id]?.tags ?? [];
        return { scene: r.scene, clips: r.clips, tags } as GltfVariant;
      } catch { return null; }
    }));
    for (const r of results) {
      if (!r) continue;
      if (r.tags.includes('police') || r.tags.includes('officer')) this.gltfOfficer.push(r);
      else this.gltf.push(r);
    }
    if (this.gltf.length) this.source = 'gltf';
  }

  create(kind: CharKind, seed: number): Character {
    const variants = kind === 'officer' ? (this.gltfOfficer.length ? this.gltfOfficer : this.gltf) : this.gltf;
    if (variants.length) {
      const v = variants[seed % variants.length];
      const model = cloneSkinned(v.scene);
      if (kind === 'officer' && !this.gltfOfficer.length) tintAll(model, NAVY);
      const head = findBone(model, /head/i);
      const hand = findBone(model, /(right.?hand|hand.?r\b|hand_r|r.?hand|handr)/i);
      model.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      return new Character(model, v.clips, kind, hand ?? head);
    }
    const geo = kind === 'officer' ? this.officerGeo! : this.procGeos[seed % this.procGeos.length];
    const bones: THREE.Bone[] = BONES.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      bone.position.set(...b.pos);
      return bone;
    });
    BONES.forEach((b, i) => { if (b.parent) bones[BONE_INDEX.get(b.parent)!].add(bones[i]); });
    const mesh = new THREE.SkinnedMesh(geo, this.mat);
    mesh.add(bones[0]);
    mesh.bind(new THREE.Skeleton(bones));
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    const holder = new THREE.Group();
    holder.add(mesh);
    const s = kind === 'officer' ? 1.02 : 0.93 + ((seed * 7919) % 100) / 100 * 0.14;
    holder.scale.setScalar(s);
    return new Character(holder, this.procClips, kind, bones[BONE_INDEX.get('handR')!]);
  }
}

function cloneSkinned(src: THREE.Object3D): THREE.Object3D {
  return skeletonClone(src);
}

function findBone(root: THREE.Object3D, re: RegExp): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => { if (!found && (o as THREE.Bone).isBone && re.test(o.name)) found = o; });
  return found;
}

function tintAll(root: THREE.Object3D, color: string) {
  const cache = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const fix = (mat: THREE.Material) => {
      let c = cache.get(mat);
      if (!c) {
        c = mat.clone();
        const name = mat.name.toLowerCase();
        if (!/skin|face|head|eye|hair/.test(name) && (c as THREE.MeshStandardMaterial).color) (c as THREE.MeshStandardMaterial).color.set(color);
        cache.set(mat, c);
      }
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(fix) : fix(m.material);
  });
}
