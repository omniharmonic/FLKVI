// Procedural, unbranded surveillance hardware at real-world scale (meters).
// Each camera model is split into groups so one InstancedMesh per (model, group, material) can serve all cameras:
//   base  — ground frame (footing, stump, trailer...). Never moves.
//   post  — the part that topples when cut. Frame origin = cut point (postOrigin in base frame).
//   head  — camera head, pivot in post frame; yaws with the sweep.
//   panel — solar panel, pivot in post frame; yawed per instance to face true south.
// Models face -Z (heading 0) and are rotated by -heading about Y per instance.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CameraType } from '../core/types';
import { Parts, T, box, cyl, jaggedBox, jaggedCyl, cableGeo, type Part } from './geom';
import { mats } from './materials';

export type GroupKey = 'base' | 'post' | 'head' | 'panel';

export interface ColliderSpec { half: [number, number, number]; center: [number, number, number] }

export interface ModelDef {
  id: string;
  type: CameraType;
  groups: Record<GroupKey, Part[]>;
  /** Post frame origin in base frame (the cut point). */
  postOrigin: THREE.Vector3;
  /** Head pivot in post frame. */
  headPivot: THREE.Vector3;
  panelPivot: THREE.Vector3 | null;
  /** Lens position and forward direction in head frame (for perception + cone). */
  eye: THREE.Vector3;
  eyeDir: THREE.Vector3;
  /** Extra lens directions for multi-camera heads (cluster/tower), head frame. */
  extraDirs: THREE.Vector3[];
  /** Every lens (position + look direction) in head frame; lenses[0] is the main eye. */
  lenses: { p: THREE.Vector3; d: THREE.Vector3 }[];
  postColliders: ColliderSpec[];
  baseColliders: ColliderSpec[];
  /** Cross-section half width of the post at the cut (for the hot cut ring). */
  cutRadius: number;
  roundPost: boolean;
  /** Where the player stands to work (base frame, xz) — the post base. */
  workPoint: THREE.Vector3;
}

const DEG = Math.PI / 180;
const cache = new Map<string, ModelDef>();

export function getModel(type: CameraType, variant: number, height: number, opts: { fallbackMast?: boolean; armOffset?: number } = {}): ModelDef {
  const h = Math.round(height * 2) / 2;
  const arm = opts.armOffset !== undefined ? Math.round(opts.armOffset * 4) / 4 : undefined;
  const id = `${type}-${variant}-${h}${opts.fallbackMast ? '-mast' : ''}${arm !== undefined ? `-arm${arm}` : ''}`;
  let m = cache.get(id);
  if (!m) {
    m = type === 'pole' ? buildPole(variant % 3, h, id)
      : type === 'ptz' ? buildPTZ(variant % 2, h, id)
      : type === 'cluster' ? (arm !== undefined ? buildMastCluster(arm, id) : buildCluster(h, !!opts.fallbackMast, id))
      : buildTower(h, id);
    cache.set(id, m);
  }
  return m;
}

/** Lens pos/dir in head frame for a boxCamera placed in frame (x,y,z, tilt, yaw) whose local lens point is e. */
function lensAt(e: THREE.Vector3, x: number, y: number, z: number, tiltDeg: number, yawDeg: number, outerTiltDeg = 0) {
  const eu = new THREE.Euler(-tiltDeg * DEG, yawDeg * DEG, 0, 'YXZ');
  const outer = new THREE.Euler(-outerTiltDeg * DEG, 0, 0);
  const p = e.clone().applyEuler(eu).add(new THREE.Vector3(x, y, z)).applyEuler(outer);
  const d = new THREE.Vector3(0, 0, -1).applyEuler(eu).applyEuler(outer);
  return { p, d };
}

function dirFromTilt(tiltDeg: number, yawDeg = 0) {
  return new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(-tiltDeg * DEG, yawDeg * DEG, 0, 'YXZ'));
}

// ---------------------------------------------------------------- shared sub-assemblies

function footing(p: Parts, r: number, plate: number, bolts = 4) {
  const M = mats();
  p.add(cyl(r, r * 1.04, 0.42, 20), M.concrete, T(0, -0.09, 0), 'box', 0.6);
  // chamfered top edge
  p.add(cyl(r - 0.02, r, 0.02, 20), M.concrete, T(0, 0.13, 0), 'box', 0.6);
  p.add(box(plate, 0.02, plate), M.galvanizedDark, T(0, 0.15, 0));
  const o = plate / 2 - 0.035;
  for (let i = 0; i < bolts; i++) {
    const a = (i / bolts) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * o * Math.SQRT2, z = Math.sin(a) * o * Math.SQRT2;
    p.add(cyl(0.011, 0.011, 0.07, 8), M.steelDark, T(x, 0.19, z));
    p.add(cyl(0.021, 0.021, 0.022, 6), M.galvanizedDark, T(x, 0.172, z));
    p.add(cyl(0.026, 0.026, 0.004, 12), M.galvanizedDark, T(x, 0.162, z));
  }
}

/** Box camera with sunshade, tilted down. Adds to current frame (camera pivot at origin, hanging below). */
function boxCamera(p: Parts, opts: { w?: number; h?: number; len?: number; housing?: THREE.Material; dark?: boolean } = {}) {
  const M = mats();
  const w = opts.w ?? 0.12, h = opts.h ?? 0.11, len = opts.len ?? 0.32;
  const housing = opts.housing ?? M.plasticWhite;
  const cy = -0.03 - h / 2;
  // swivel mount
  p.add(cyl(0.018, 0.022, 0.035, 12), M.plasticGrey, T(0, -0.0175, 0));
  p.add(box(0.05, 0.012, 0.08), M.plasticGrey, T(0, -0.035, 0.02));
  // housing
  p.add(new RoundedBoxGeometry(w, h, len, 3, 0.014), housing, T(0, cy, -len * 0.28), 'box', 0.5);
  // sunshade with side lips (overhangs the front)
  const sl = len * 1.18;
  p.add(new RoundedBoxGeometry(w + 0.03, 0.007, sl, 2, 0.003), housing, T(0, cy + h / 2 + 0.008, -len * 0.28 - (sl - len) / 2 - 0.01), 'box', 0.5);
  for (const s of [-1, 1]) p.add(box(0.004, 0.028, sl * 0.92), housing, T(s * (w / 2 + 0.013), cy + h / 2 - 0.005, -len * 0.28 - (sl - len) / 2 - 0.01));
  // front bezel + glass window + lens barrel behind glass
  const fz = -len * 0.28 - len / 2;
  p.add(box(w - 0.012, h - 0.012, 0.01), M.plasticDark, T(0, cy, fz - 0.002));
  p.add(cyl(0.029, 0.029, 0.012, 24), M.steelDark, T(0, cy + 0.008, fz - 0.009, Math.PI / 2));
  p.add(cyl(0.022, 0.022, 0.004, 24), M.lensGlass, T(0, cy + 0.008, fz - 0.016, Math.PI / 2));
  p.add(cyl(0.013, 0.013, 0.002, 20), M.lensCoating, T(0, cy + 0.008, fz - 0.0185, Math.PI / 2));
  // IR illuminator ring
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    p.add(new THREE.SphereGeometry(0.0055, 6, 4), M.ir, T(Math.cos(a) * 0.041, cy + 0.008 + Math.sin(a) * 0.036, fz - 0.009));
  }
  // status LED
  p.add(new THREE.SphereGeometry(0.0045, 8, 6), M.led, T(w / 2 - 0.018, cy - h / 2 + 0.016, fz - 0.009));
  // rear cable gland
  p.add(cyl(0.012, 0.014, 0.03, 10), M.rubber, T(0, cy - 0.02, -len * 0.28 + len / 2 + 0.012, Math.PI / 2));
  return new THREE.Vector3(0, cy + 0.008, fz - 0.02);
}

/** Solar panel assembly in panel frame: stub mast + tilt bracket + framed panel facing +Z tilted. */
function solarPanel(p: Parts, pw: number, pd: number, tiltDeg: number, stub = 0.2) {
  const M = mats();
  p.add(cyl(0.022, 0.022, stub, 12), M.galvanized, T(0, stub / 2, 0));
  p.add(box(0.08, 0.05, 0.06), M.galvanizedDark, T(0, stub + 0.02, 0));
  p.push(T(0, stub + 0.05, 0, tiltDeg * DEG));
  p.add(box(pw, 0.035, pd), M.aluminum, T(0, 0, 0));
  const face = new THREE.PlaneGeometry(pw - 0.03, pd - 0.03);
  p.add(face, M.solar, T(0, 0.0181, 0, -Math.PI / 2), 'keep');
  // rear cross rails
  p.add(box(pw * 0.9, 0.02, 0.03), M.aluminum, T(0, -0.027, -pd * 0.25));
  p.add(box(pw * 0.9, 0.02, 0.03), M.aluminum, T(0, -0.027, pd * 0.25));
  // junction box
  p.add(box(0.08, 0.02, 0.05), M.plasticDark, T(0, -0.03, 0));
  p.pop();
}

function strapBands(p: Parts, y: number, zFront: number, zBack: number, halfW: number) {
  const M = mats();
  const d = zBack - zFront;
  for (const dy of [-0.13, 0.13]) {
    p.add(box(halfW * 2 + 0.008, 0.022, 0.003), M.strap, T(0, y + dy, zFront - 0.0015));
    p.add(box(halfW * 2 + 0.008, 0.022, 0.003), M.strap, T(0, y + dy, zBack + 0.0015));
    for (const s of [-1, 1]) p.add(box(0.003, 0.022, d + 0.006), M.strap, T(s * (halfW + 0.0015), y + dy, zFront + d / 2));
    // buckle
    p.add(box(0.03, 0.03, 0.012), M.strap, T(halfW + 0.006, y + dy, zFront + d * 0.3));
  }
}

function batteryBox(p: Parts, y: number, zPost: number, bw: number, bh: number, bd: number, housing: THREE.Material) {
  const M = mats();
  const z = zPost + bd / 2 + 0.004;
  p.add(new RoundedBoxGeometry(bw, bh, bd, 3, 0.012), housing, T(0, y, z), 'box', 0.5);
  // lid seam + drip lip
  p.add(box(bw + 0.012, 0.012, bd + 0.012), housing, T(0, y + bh / 2 - 0.05, z));
  // vents
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) p.add(box(0.004, 0.006, bd * 0.6), M.plasticDark, T(s * (bw / 2 + 0.001), y - bh * 0.25 + i * 0.018, z));
  // latch + hasp
  p.add(box(0.03, 0.04, 0.012), M.steelDark, T(0, y + bh * 0.1, z + bd / 2 + 0.004));
  p.add(cyl(0.007, 0.007, 0.02, 8), M.steelDark, T(0, y + bh * 0.1 - 0.03, z + bd / 2 + 0.008, Math.PI / 2));
  // cellular antenna
  p.add(cyl(0.014, 0.018, 0.02, 10), M.rubber, T(bw * 0.3, y + bh / 2 + 0.01, z));
  p.add(cyl(0.006, 0.009, 0.16, 8), M.rubber, T(bw * 0.3, y + bh / 2 + 0.1, z));
  // bottom conduit gland
  p.add(cyl(0.013, 0.013, 0.03, 10), M.rubber, T(-bw * 0.25, y - bh / 2 - 0.012, z));
  return new THREE.Vector3(-bw * 0.25, y - bh / 2 - 0.02, z);
}

// ---------------------------------------------------------------- pole camera (3 variants)

function buildPole(v: number, H: number, id: string): ModelDef {
  const M = mats();
  const cutH = 0.55;
  const L = H - cutH;
  const round = v === 1;
  const hw = round ? 0.057 : 0.05; // post half-width
  const base = new Parts(), post = new Parts(), head = new Parts(), panel = new Parts();
  const seed = v * 97 + Math.round(H * 10);

  footing(base, 0.27, 0.27);
  if (round) base.add(jaggedCyl(hw * 0.97, cutH - 0.16 + 0.03, seed), M.galvanized, T(0, 0.16, 0));
  else base.add(jaggedBox(hw * 2 * 0.97, cutH - 0.16 + 0.03, seed), M.galvanized, T(0, 0.16, 0));
  // weld bead ring at base plate
  base.add(round ? cyl(hw + 0.006, hw + 0.006, 0.012, 18) : box(hw * 2 + 0.012, 0.012, hw * 2 + 0.012), M.galvanizedDark, T(0, 0.166, 0));

  // --- post
  if (round) {
    post.add(cyl(hw, hw, L, 20), M.galvanized, T(0, L / 2, 0));
    post.add(new THREE.SphereGeometry(hw * 1.05, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.galvanizedDark, T(0, L, 0, 0, 0, 0, 1, 0.45, 1));
  } else {
    post.add(box(hw * 2, L, hw * 2), M.galvanized, T(0, L / 2, 0));
    post.add(box(hw * 2 + 0.012, 0.012, hw * 2 + 0.012), M.galvanizedDark, T(0, L + 0.006, 0));
  }
  // hand-hole cover on the back
  post.add(box(0.055, 0.15, 0.006), M.galvanizedDark, T(0, 0.42, hw + 0.003));
  for (const dy of [-0.06, 0.06]) post.add(cyl(0.006, 0.006, 0.006, 6), M.steelDark, T(0, 0.42 + dy, hw + 0.007, Math.PI / 2));
  // identification tag (blank aluminum)
  post.add(box(0.05, 0.03, 0.002), M.aluminum, T(0, 1.5, -hw - 0.001));

  // battery / electronics box strapped to the back of the post (out of reach)
  const bY = (v === 1 ? 2.25 : 2.45) - cutH;
  const [bw, bh, bd] = v === 1 ? [0.34, 0.5, 0.2] : v === 2 ? [0.3, 0.44, 0.18] : [0.3, 0.4, 0.17];
  const housing = v === 1 ? M.plasticGrey : M.plasticWhite;
  const gland = batteryBox(post, bY, hw, bw, bh, bd, housing);
  strapBands(post, bY, -hw, hw + bd + 0.004, Math.max(hw, bw / 2));

  // mount arm + camera head
  const armY = L - 0.14;
  const armLen = v === 1 ? 0.3 : 0.34;
  if (round) {
    post.add(cyl(hw + 0.012, hw + 0.012, 0.09, 18), M.galvanizedDark, T(0, armY, 0));
    post.add(cyl(0.02, 0.02, armLen, 12), M.galvanized, T(0, armY, -hw - armLen / 2, Math.PI / 2));
  } else {
    post.add(box(hw * 2 + 0.024, 0.09, hw * 2 + 0.024), M.galvanizedDark, T(0, armY, 0));
    post.add(box(0.045, 0.045, armLen), M.galvanized, T(0, armY, -hw - armLen / 2));
  }
  const pivot = new THREE.Vector3(0, armY - 0.025, -hw - armLen + 0.03);
  post.add(box(0.06, 0.01, 0.06), M.galvanizedDark, T(pivot.x, pivot.y + 0.002, pivot.z));

  const tilt = 13 + v * 2;
  let eye: THREE.Vector3;
  const extra: THREE.Vector3[] = [];
  const lenses: { p: THREE.Vector3; d: THREE.Vector3 }[] = [];
  head.push(T(0, 0, 0, -tilt * DEG));
  if (v === 1) {
    // bullet camera with half-shell sunshield on a ball joint
    head.add(new THREE.SphereGeometry(0.026, 12, 8), M.plasticGrey, T(0, -0.02, 0));
    head.add(cyl(0.012, 0.012, 0.05, 10), M.plasticGrey, T(0, -0.045, 0));
    const cy = -0.11, len = 0.3;
    head.add(cyl(0.052, 0.052, len, 24), M.plasticGrey, T(0, cy, -0.06, Math.PI / 2), 'box', 0.5);
    head.add(cyl(0.066, 0.066, len * 1.2, 24, true, Math.PI / 2, Math.PI), M.plasticGrey, T(0, cy, -0.085, Math.PI / 2), 'box', 0.5);
    head.add(box(0.03, 0.03, 0.04), M.plasticGrey, T(0, cy + 0.06, -0.02));
    const fz = -0.06 - len / 2;
    head.add(cyl(0.05, 0.05, 0.012, 24), M.plasticDark, T(0, cy, fz - 0.004, Math.PI / 2));
    head.add(cyl(0.025, 0.025, 0.006, 24), M.lensGlass, T(0, cy + 0.01, fz - 0.012, Math.PI / 2));
    head.add(cyl(0.014, 0.014, 0.002, 20), M.lensCoating, T(0, cy + 0.01, fz - 0.0155, Math.PI / 2));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      head.add(new THREE.SphereGeometry(0.0055, 6, 4), M.ir, T(Math.cos(a) * 0.036, cy + 0.01 + Math.sin(a) * 0.03, fz - 0.011));
    }
    head.add(new THREE.SphereGeometry(0.0045, 8, 6), M.led, T(0.03, cy - 0.034, fz - 0.011));
    eye = new THREE.Vector3(0, cy, fz - 0.02);
  } else if (v === 2) {
    // dual: plate camera + overview camera on a T-bar, with a separate rectangular IR illuminator
    head.add(box(0.46, 0.035, 0.035), M.galvanizedDark, T(0, -0.02, 0));
    head.push(T(-0.17, -0.04, 0, 0, 5 * DEG));
    eye = boxCamera(head, { w: 0.11, h: 0.1, len: 0.3 });
    head.pop();
    lenses.push(lensAt(eye, -0.17, -0.04, 0, 0, 5, tilt));
    head.push(T(0.17, -0.04, 0, 0, -8 * DEG));
    const e2 = boxCamera(head, { w: 0.1, h: 0.09, len: 0.26, housing: M.plasticGrey });
    head.pop();
    lenses.push(lensAt(e2, 0.17, -0.04, 0, 0, -8, tilt));
    // IR panel
    head.add(new RoundedBoxGeometry(0.1, 0.07, 0.08, 2, 0.008), M.plasticDark, T(0, -0.085, -0.05));
    for (let i = 0; i < 12; i++) head.add(new THREE.SphereGeometry(0.006, 6, 4), M.ir, T(-0.035 + (i % 6) * 0.014, -0.1 + Math.floor(i / 6) * 0.025, -0.091));
    eye = eye.clone().add(new THREE.Vector3(-0.17, -0.04, 0));
    extra.push(dirFromTilt(0, -8));
  } else {
    eye = boxCamera(head);
  }
  head.pop();
  // cable from electronics box up the back of the post into the camera
  const cablePts = [
    gland,
    new THREE.Vector3(gland.x, gland.y - 0.08, gland.z - 0.05),
    new THREE.Vector3(-hw * 0.6, gland.y - 0.02, hw + 0.012),
    new THREE.Vector3(-hw * 0.6, (gland.y + armY) * 0.5, hw + 0.012),
    new THREE.Vector3(-hw * 0.6, armY + 0.06, hw + 0.012),
    new THREE.Vector3(-hw - 0.01, armY + 0.05, -hw - 0.02),
    new THREE.Vector3(-0.03, armY + 0.01, pivot.z + 0.1),
    new THREE.Vector3(-0.02, pivot.y - 0.02, pivot.z + 0.12),
  ];
  post.add(cableGeo(cablePts, 0.0065), M.cable);
  // cable ties
  for (const y of [0.3, 0.55, 0.8]) {
    const yy = gland.y + (armY - gland.y) * y;
    if (round) post.add(cyl(hw + 0.004, hw + 0.004, 0.008, 18), M.rubber, T(0, yy, 0));
    else post.add(box(hw * 2 + 0.008, 0.008, hw * 2 + 0.008), M.rubber, T(0, yy, 0));
  }

  // solar panel on top
  const [pw, pd, pt] = v === 1 ? [0.7, 0.52, 35] : v === 2 ? [0.52, 0.42, 45] : [0.56, 0.44, 40];
  solarPanel(panel, pw, pd, pt, v === 2 ? 0.28 : 0.2);

  const pivotPanel = new THREE.Vector3(0, L + 0.012, 0);
  if (!lenses.length) lenses.push({ p: eye.clone().applyEuler(new THREE.Euler(-tilt * DEG, 0, 0)), d: dirFromTilt(tilt) });
  return {
    id, type: 'pole',
    groups: { base: base.merged(), post: post.merged(), head: head.merged(), panel: panel.merged() },
    postOrigin: new THREE.Vector3(0, cutH, 0),
    headPivot: pivot,
    panelPivot: pivotPanel,
    eye: eye.clone().applyEuler(new THREE.Euler(-tilt * DEG, 0, 0)),
    eyeDir: dirFromTilt(tilt),
    extraDirs: extra.map((d) => d.applyEuler(new THREE.Euler(-tilt * DEG, 0, 0))),
    lenses,
    postColliders: [
      { half: [hw, L / 2, hw], center: [0, L / 2, 0] },
      { half: [bw / 2, bh / 2, bd / 2], center: [0, bY, hw + bd / 2] },
      { half: [0.1, 0.1, 0.25], center: [0, armY - 0.05, -hw - armLen / 2] },
      { half: [pw / 2, 0.08, pd / 2], center: [0, L + 0.3, 0] },
    ],
    baseColliders: [{ half: [0.14, 0.08, 0.14], center: [0, 0.08, 0] }, { half: [hw, (cutH - 0.16) / 2, hw], center: [0, 0.16 + (cutH - 0.16) / 2, 0] }],
    cutRadius: hw,
    roundPost: round,
    workPoint: new THREE.Vector3(0, 0, 0),
  };
}

// ---------------------------------------------------------------- PTZ dome on a pole with an arm

function domeHousing(p: Parts, withIR = true) {
  const M = mats();
  p.add(cyl(0.045, 0.045, 0.2, 16), M.plasticWhite, T(0, 0.15, 0));
  p.add(cyl(0.06, 0.05, 0.03, 16), M.plasticWhite, T(0, 0.065, 0));
  p.add(cyl(0.13, 0.13, 0.1, 32), M.plasticWhite, T(0, 0.0, 0), 'box', 0.5);
  p.add(new THREE.SphereGeometry(0.14, 32, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.plasticWhite, T(0, 0.04, 0, 0, 0, 0, 1, 0.32, 1), 'box', 0.5);
  p.add(cyl(0.128, 0.128, 0.018, 32), M.plasticDark, T(0, -0.058, 0));
  if (withIR) for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    p.add(box(0.022, 0.008, 0.012), M.ir, T(Math.cos(a) * 0.121, -0.068, Math.sin(a) * 0.121, 0, -a));
  }
  p.add(new THREE.SphereGeometry(0.004, 8, 6), M.led, T(0.0, -0.05, -0.13));
  p.add(new THREE.SphereGeometry(0.115, 32, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M.smokedDome, T(0, -0.065, 0), 'keep');
}

function ptzInner(p: Parts, tiltDeg: number) {
  const M = mats();
  // yoke
  for (const s of [-1, 1]) p.add(box(0.008, 0.08, 0.04), M.plasticDark, T(s * 0.075, -0.03, 0));
  p.push(T(0, -0.07, 0, -tiltDeg * DEG));
  p.add(new THREE.SphereGeometry(0.068, 20, 14), M.plasticDark, T(0, 0, 0));
  p.add(cyl(0.032, 0.036, 0.04, 20), M.steelDark, T(0, 0, -0.062, Math.PI / 2));
  p.add(cyl(0.026, 0.026, 0.004, 20), M.lensGlass, T(0, 0, -0.083, Math.PI / 2));
  p.add(cyl(0.015, 0.015, 0.002, 20), M.lensCoating, T(0, 0, -0.0855, Math.PI / 2));
  p.pop();
}

function buildPTZ(v: number, H: number, id: string): ModelDef {
  const M = mats();
  const cutH = 0.6;
  const L = H - cutH;
  const rb = 0.09, rt = 0.065;
  const base = new Parts(), post = new Parts(), head = new Parts(), panel = new Parts();
  footing(base, 0.36, 0.36);
  base.add(jaggedCyl(rb * 0.97, cutH - 0.16 + 0.03, 7 + v), M.galvanized, T(0, 0.16, 0));
  base.add(cyl(rb + 0.02, rb + 0.03, 0.05, 20), M.galvanizedDark, T(0, 0.185, 0));

  const rAt = (y: number) => rb + (rt - rb) * ((y + cutH) / H);
  post.add(cyl(rt, rAt(0), L, 24), M.galvanized, T(0, L / 2, 0), 'box', 1);
  post.add(new THREE.SphereGeometry(rt * 1.1, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.galvanizedDark, T(0, L, 0, 0, 0, 0, 1, 0.5, 1));
  post.add(box(0.06, 0.18, 0.006), M.galvanizedDark, T(0, 0.35, rAt(0.35) + 0.002));
  // junction / power box
  const jy = 2.9 - cutH;
  post.add(new RoundedBoxGeometry(0.26, 0.34, 0.14, 2, 0.01), M.plasticGrey, T(0, jy, rAt(jy) + 0.074), 'box', 0.5);
  strapBands(post, jy, -rAt(jy), rAt(jy) + 0.144, Math.max(rAt(jy), 0.13));
  post.add(cableGeo([
    new THREE.Vector3(0.06, jy + 0.17, rAt(jy) + 0.07), new THREE.Vector3(0.06, jy + 0.3, rAt(jy) + 0.02),
    new THREE.Vector3(0.05, L * 0.8, rAt(L * 0.8) + 0.01), new THREE.Vector3(0.0, L - 0.3, rAt(L - 0.3) + 0.01),
  ], 0.008), M.cable);

  // side arm (v0: long arm with gusset brace, v1: short pole-top gooseneck)
  const armY = v === 0 ? L - 0.3 : L - 0.08, armLen = v === 0 ? 0.8 : 0.42;
  post.add(cyl(rAt(armY) + 0.015, rAt(armY) + 0.015, 0.14, 20), M.galvanizedDark, T(0, armY, 0));
  post.add(cyl(0.035, 0.035, armLen, 14), M.galvanized, T(0, armY, -armLen / 2, Math.PI / 2));
  if (v === 0) {
    const br = new THREE.Vector3(0, armY - 0.45, -rAt(armY - 0.45)), bt = new THREE.Vector3(0, armY - 0.02, -armLen * 0.6);
    const mid = br.clone().add(bt).multiplyScalar(0.5), len = br.distanceTo(bt);
    post.add(cyl(0.018, 0.018, len, 10), M.galvanized, T(mid.x, mid.y, mid.z, Math.atan2(bt.z - br.z, bt.y - br.y)));
  }
  post.add(cyl(0.04, 0.04, 0.03, 14), M.galvanizedDark, T(0, armY - 0.02, -armLen, 0));
  const pivot = new THREE.Vector3(0, armY - 0.27, -armLen);
  post.push(T(pivot.x, pivot.y, pivot.z));
  domeHousing(post);
  post.pop();
  const tilt = 22;
  ptzInner(head, tilt);

  const eyeLocal = new THREE.Vector3(0, -0.07, -0.08);
  return {
    id, type: 'ptz',
    groups: { base: base.merged(), post: post.merged(), head: head.merged(), panel: [] },
    postOrigin: new THREE.Vector3(0, cutH, 0),
    headPivot: pivot,
    panelPivot: null,
    eye: eyeLocal,
    eyeDir: dirFromTilt(tilt),
    extraDirs: [],
    lenses: [{ p: new THREE.Vector3(0, -0.065, 0), d: new THREE.Vector3(0, -0.6, -0.8).normalize() }],
    postColliders: [
      { half: [rb, L / 2, rb], center: [0, L / 2, 0] },
      { half: [0.16, 0.2, armLen / 2 + 0.1], center: [0, armY - 0.15, -armLen / 2] },
    ],
    baseColliders: [{ half: [0.2, 0.09, 0.2], center: [0, 0.09, 0] }, { half: [rb, (cutH - 0.16) / 2, rb], center: [0, 0.16 + (cutH - 0.16) / 2, 0] }],
    cutRadius: rAt(0),
    roundPost: true,
    workPoint: new THREE.Vector3(0, 0, 0),
  };
}

// ---------------------------------------------------------------- cluster on a signal mast arm

function buildCluster(H: number, fallbackPole: boolean, id: string): ModelDef {
  // Mounted on the traffic-signal pole at the camera position: band clamp just under the mast arm,
  // a short outrigger arm toward the junction and a rail with three cameras (left / center / right).
  const M = mats();
  const base = new Parts(), head = new Parts();
  const mountY = H > 5.5 ? H - 0.9 : H - 0.35;
  const poleR = 0.16;
  if (fallbackPole) {
    footing(base, 0.42, 0.44, 6);
    base.add(cyl(0.11, 0.17, H + 0.6, 28), M.galvanized, T(0, (H + 0.6) / 2 + 0.16, 0), 'box', 1);
    base.add(new THREE.SphereGeometry(0.12, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.galvanizedDark, T(0, H + 0.76, 0, 0, 0, 0, 1, 0.5, 1));
    base.add(box(0.1, 0.25, 0.006), M.galvanizedDark, T(0, 0.55, 0.17));
  }
  // band clamp
  for (const dy of [-0.12, 0.12]) base.add(cyl(poleR + 0.025, poleR + 0.025, 0.05, 24), M.galvanizedDark, T(0, mountY + dy, 0));
  base.add(box(0.14, 0.36, 0.06), M.galvanizedDark, T(0, mountY, -poleR - 0.03));
  const armLen = 1.0;
  base.add(box(0.06, 0.06, armLen), M.galvanized, T(0, mountY, -poleR - armLen / 2));
  // diagonal strut
  {
    const a = new THREE.Vector3(0, mountY - 0.45, -poleR - 0.02), b2 = new THREE.Vector3(0, mountY - 0.03, -poleR - armLen * 0.65);
    const mid = a.clone().add(b2).multiplyScalar(0.5);
    base.add(cyl(0.015, 0.015, a.distanceTo(b2), 8), M.galvanized, T(mid.x, mid.y, mid.z, Math.atan2(b2.z - a.z, b2.y - a.y)));
    base.add(box(0.12, 0.08, 0.04), M.galvanizedDark, T(0, mountY - 0.45, -poleR - 0.02));
  }
  const pz = -poleR - armLen + 0.05;
  base.add(box(0.95, 0.05, 0.05), M.galvanized, T(0, mountY - 0.06, pz));
  base.add(box(0.06, 0.06, 0.06), M.galvanizedDark, T(0, mountY - 0.03, pz));
  // junction box on the pole + cable run
  base.add(new RoundedBoxGeometry(0.24, 0.3, 0.12, 2, 0.01), M.plasticGrey, T(0, mountY - 0.75, -poleR - 0.065), 'box', 0.5);
  base.add(cableGeo([
    new THREE.Vector3(0.05, mountY - 0.6, -poleR - 0.07), new THREE.Vector3(0.06, mountY - 0.3, -poleR - 0.01),
    new THREE.Vector3(0.04, mountY + 0.04, -poleR - 0.1), new THREE.Vector3(0.03, mountY + 0.04, pz + 0.3), new THREE.Vector3(0.1, mountY - 0.05, pz + 0.03),
  ], 0.007), M.cable);

  const tilt = 20;
  const dirs: THREE.Vector3[] = [];
  const lenses: { p: THREE.Vector3; d: THREE.Vector3 }[] = [];
  let eye = new THREE.Vector3();
  for (const [x, yaw] of [[0, 0], [-0.36, 32], [0.36, -32]] as const) {
    head.push(T(x, -0.03, 0, -tilt * DEG, yaw * DEG));
    const e = boxCamera(head, { w: 0.1, h: 0.09, len: 0.26, housing: x === 0 ? M.plasticWhite : M.plasticGrey });
    head.pop();
    lenses.push(lensAt(e, x, -0.03, 0, tilt, yaw));
    if (x === 0) eye = e.applyEuler(new THREE.Euler(-tilt * DEG, 0, 0)).add(new THREE.Vector3(0, -0.03, 0));
    else dirs.push(dirFromTilt(tilt, yaw));
  }
  return {
    id, type: 'cluster',
    groups: { base: base.merged(), post: [], head: head.merged(), panel: [] },
    postOrigin: new THREE.Vector3(0, 0, 0),
    headPivot: new THREE.Vector3(0, mountY - 0.085, pz),
    panelPivot: null,
    eye, eyeDir: dirFromTilt(tilt), extraDirs: dirs, lenses,
    postColliders: [],
    baseColliders: fallbackPole ? [{ half: [0.17, (H + 0.6) / 2, 0.17], center: [0, (H + 0.6) / 2, 0] }] : [],
    cutRadius: poleR,
    roundPost: true,
    workPoint: new THREE.Vector3(0, 0, 0),
  };
}

/** World mast-arm height (src/world/props.ts kitMastArm: arm axis at y = 6.6). */
export const MAST_ARM_Y = 6.6;

/**
 * Cluster hung from a real traffic-signal mast arm (world props). Frame: origin on the ground under the
 * mount point, the arm runs along local +X (away from the pole, which stands at local (-arm, 0, 0)),
 * cameras look -Z (back across the junction at approaching traffic). The player works from the pole base.
 */
function buildMastCluster(arm: number, id: string): ModelDef {
  const M = mats();
  const base = new Parts(), head = new Parts();
  const ay = MAST_ARM_Y, ar = 0.1;
  // saddle clamps around the arm
  for (const dx of [-0.12, 0.12]) base.add(cyl(ar + 0.02, ar + 0.02, 0.05, 18), M.galvanizedDark, T(dx, ay, 0, 0, 0, Math.PI / 2));
  base.add(box(0.3, 0.06, 0.08), M.galvanizedDark, T(0, ay - ar - 0.03, 0));
  // drop rod + rail
  const railY = ay - 0.62;
  base.add(box(0.05, ay - ar - railY, 0.05), M.galvanized, T(0, (ay - ar + railY) / 2, 0));
  base.add(box(0.95, 0.05, 0.05), M.galvanized, T(0, railY, 0));
  base.add(new RoundedBoxGeometry(0.22, 0.26, 0.12, 2, 0.01), M.plasticGrey, T(0, railY + 0.22, 0.07), 'box', 0.5);
  // cable run along the underside of the arm back to the pole
  base.add(cableGeo([
    new THREE.Vector3(0.04, railY + 0.1, 0.05), new THREE.Vector3(0.05, ay - ar - 0.02, 0.06),
    new THREE.Vector3(-arm * 0.5, ay - ar - 0.03, 0.05), new THREE.Vector3(-arm + 0.2, ay - ar - 0.02, 0.04),
    new THREE.Vector3(-arm + 0.17, ay - 0.9, 0.03),
  ], 0.008), M.cable);
  const tilt = 20;
  const dirs: THREE.Vector3[] = [];
  const lenses: { p: THREE.Vector3; d: THREE.Vector3 }[] = [];
  let eye = new THREE.Vector3();
  for (const [x, yaw] of [[0, 0], [-0.36, 32], [0.36, -32]] as const) {
    head.push(T(x, -0.03, 0, -tilt * DEG, yaw * DEG));
    const e = boxCamera(head, { w: 0.1, h: 0.09, len: 0.26, housing: x === 0 ? M.plasticWhite : M.plasticGrey });
    head.pop();
    lenses.push(lensAt(e, x, -0.03, 0, tilt, yaw));
    if (x === 0) eye = e.applyEuler(new THREE.Euler(-tilt * DEG, 0, 0)).add(new THREE.Vector3(0, -0.03, 0));
    else dirs.push(dirFromTilt(tilt, yaw));
  }
  return {
    id, type: 'cluster',
    groups: { base: base.merged(), post: [], head: head.merged(), panel: [] },
    postOrigin: new THREE.Vector3(0, 0, 0),
    headPivot: new THREE.Vector3(0, railY - 0.025, 0),
    panelPivot: null,
    eye, eyeDir: dirFromTilt(tilt), extraDirs: dirs, lenses,
    postColliders: [], baseColliders: [],
    cutRadius: 0.16, roundPost: true,
    // stand at the signal pole (on the sidewalk), not in the traffic lane under the arm
    workPoint: new THREE.Vector3(-arm + 0.55, 0, 0),
  };
}

// ---------------------------------------------------------------- tower trailer

function buildTower(H: number, id: string): ModelDef {
  const M = mats();
  const base = new Parts(), post = new Parts(), head = new Parts();
  const deckY = 0.62;
  // frame rails and cross members
  for (const x of [-0.8, 0.8]) base.add(box(0.1, 0.14, 3.7), M.steelDark, T(x, deckY - 0.07, 0.1));
  for (const z of [-1.5, 0, 1.6]) base.add(box(1.7, 0.1, 0.08), M.steelDark, T(0, deckY - 0.07, z));
  // enclosure (battery/generator)
  base.add(new RoundedBoxGeometry(1.75, 0.95, 2.3, 2, 0.03), M.paintWhite, T(0, deckY + 0.475, 0.55), 'box', 1);
  for (const s of [-1, 1]) {
    base.add(box(0.005, 0.8, 1.0), M.paintWhite, T(s * 0.878, deckY + 0.45, 0.3));
    base.add(box(0.012, 0.04, 0.12), M.steelDark, T(s * 0.885, deckY + 0.5, 0.75));
    for (let i = 0; i < 6; i++) base.add(box(0.006, 0.02, 0.5), M.plasticDark, T(s * 0.878, deckY + 0.25 + i * 0.05, 1.3));
  }
  base.add(box(1.75, 0.04, 1.2), M.steelDark, T(0, deckY + 0.02, -1.0)); // front deck plate
  // wheels + fenders
  for (const s of [-1, 1]) {
    base.add(new THREE.TorusGeometry(0.28, 0.085, 12, 28), M.rubber, T(s * 1.0, 0.36, 0.15, 0, Math.PI / 2));
    base.add(cyl(0.22, 0.22, 0.17, 24), M.rubber, T(s * 1.0, 0.36, 0.15, 0, 0, Math.PI / 2));
    base.add(cyl(0.17, 0.17, 0.18, 20), M.steelDark, T(s * 1.0, 0.36, 0.15, 0, 0, Math.PI / 2));
    base.add(cyl(0.06, 0.06, 0.2, 10), M.galvanized, T(s * 1.02, 0.36, 0.15, 0, 0, Math.PI / 2));
    base.add(cyl(0.44, 0.44, 0.26, 20, true, 0, Math.PI), M.paintWhite, T(s * 1.0, 0.36, 0.15, 0, 0, Math.PI / 2));
  }
  // tongue A-frame + coupler + jack
  for (const s of [-1, 1]) {
    const a = new THREE.Vector3(s * 0.8, deckY - 0.08, -1.5), b = new THREE.Vector3(0, deckY - 0.08, -2.9);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    base.add(box(0.08, 0.1, a.distanceTo(b)), M.steelDark, T(mid.x, mid.y, mid.z, 0, Math.atan2(a.x - b.x, a.z - b.z)));
  }
  base.add(box(0.12, 0.1, 0.35), M.steelDark, T(0, deckY - 0.06, -3.05));
  base.add(new THREE.SphereGeometry(0.06, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.steelDark, T(0, deckY - 0.06, -3.15, Math.PI));
  base.add(cyl(0.035, 0.035, 0.75, 12), M.steelDark, T(0.15, 0.4, -2.5));
  base.add(box(0.2, 0.03, 0.2), M.steelDark, T(0.15, 0.03, -2.5));
  // outriggers with screw jacks and pads
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const ang = Math.atan2(x, z);
    const sx = x * 0.8, sz = z < 0 ? -1.4 : 1.6;
    const ex = sx + Math.sin(ang) * 1.1, ez = sz + Math.cos(ang) * 1.1;
    base.add(box(0.09, 0.09, 1.2), M.paintYellow, T((sx + ex) / 2, deckY - 0.02, (sz + ez) / 2, 0, ang));
    base.add(cyl(0.03, 0.03, deckY + 0.1, 10), M.galvanized, T(ex, deckY / 2, ez));
    base.add(cyl(0.05, 0.05, 0.12, 10), M.paintYellow, T(ex, deckY + 0.02, ez));
    base.add(box(0.3, 0.035, 0.3), M.steelDark, T(ex, 0.018, ez));
    base.add(box(0.02, 0.18, 0.02), M.steelDark, T(ex, deckY + 0.15, ez));
  }
  // solar array: center + two wings
  const topY = deckY + 0.95;
  for (const [x, rz] of [[0, 0], [-1.25, 22], [1.25, -22]] as const) {
    base.add(box(0.05, 0.3, 0.05), M.aluminum, T(x * 0.55, topY + 0.15, 0.55));
    base.push(T(x, topY + 0.34 + Math.abs(x) * 0.12, 0.55, 18 * DEG, 0, rz * DEG));
    base.add(box(1.08, 0.04, 1.62), M.aluminum, T(0, 0, 0));
    base.add(new THREE.PlaneGeometry(1.04, 1.58), M.solar, T(0, 0.021, 0, -Math.PI / 2), 'keep');
    base.pop();
  }
  // mast base socket
  const mz = -0.9;
  base.add(box(0.36, 0.5, 0.36), M.steelDark, T(0, deckY + 0.25, mz));
  base.add(jaggedCyl(0.095, 1.62 - deckY - 0.5 + 0.03, 55), M.galvanized, T(0, deckY + 0.5, mz));
  // hand winch
  base.add(cyl(0.08, 0.08, 0.14, 16), M.steelDark, T(0.24, deckY + 0.4, mz, 0, 0, Math.PI / 2));
  base.add(box(0.02, 0.2, 0.02), M.steelDark, T(0.33, deckY + 0.47, mz));

  const cutH = 1.62;
  const L = H - cutH;
  // telescoping mast sections with collars
  const s1 = L * 0.4, s2 = L * 0.36;
  post.add(cyl(0.1, 0.1, s1, 24), M.galvanized, T(0, s1 / 2, 0));
  post.add(cyl(0.115, 0.115, 0.08, 24), M.steelDark, T(0, s1 - 0.04, 0));
  post.add(cyl(0.08, 0.08, s2 + 0.2, 24), M.galvanized, T(0, s1 + s2 / 2 - 0.1, 0));
  post.add(cyl(0.095, 0.095, 0.07, 24), M.steelDark, T(0, s1 + s2 - 0.035, 0));
  const s3 = L - s1 - s2;
  post.add(cyl(0.062, 0.062, s3 + 0.2, 24), M.galvanized, T(0, s1 + s2 + s3 / 2 - 0.1, 0));
  // coiled cable down the mast
  const cp: THREE.Vector3[] = [];
  for (let i = 0; i <= 40; i++) { const t = i / 40, y = 0.1 + t * (L - 0.3), a = t * Math.PI * 6; cp.push(new THREE.Vector3(Math.cos(a) * 0.14, y, Math.sin(a) * 0.14)); }
  post.add(cableGeo(cp, 0.008), M.cable);
  // head platform
  post.add(box(0.56, 0.04, 0.56), M.galvanizedDark, T(0, L, 0));
  post.add(new RoundedBoxGeometry(0.3, 0.22, 0.3, 2, 0.02), M.paintWhite, T(0, L + 0.13, 0), 'box', 0.5);
  // strobe light on top
  post.add(cyl(0.05, 0.055, 0.03, 16), M.plasticDark, T(0, L + 0.255, 0));
  post.add(cyl(0.042, 0.045, 0.1, 16), M.strobe, T(0, L + 0.32, 0));
  post.add(new THREE.SphereGeometry(0.042, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.strobe, T(0, L + 0.37, 0));
  post.add(cyl(0.006, 0.008, 0.45, 8), M.rubber, T(0.2, L + 0.26, 0.2));
  // PTZ dome under the platform
  post.push(T(0, L - 0.26, 0));
  domeHousing(post);
  post.pop();
  // three fixed box cameras for 360°
  const tilt = 20;
  const dirs: THREE.Vector3[] = [];
  const lenses: { p: THREE.Vector3; d: THREE.Vector3 }[] = [];
  let eye = new THREE.Vector3();
  for (const yaw of [0, 120, 240]) {
    const a = yaw * DEG;
    head.push(T(-Math.sin(a) * 0.27, 0, -Math.cos(a) * 0.27, -tilt * DEG, a));
    const e = boxCamera(head, { w: 0.11, h: 0.1, len: 0.28 });
    head.pop();
    lenses.push(lensAt(e, -Math.sin(a) * 0.27, 0, -Math.cos(a) * 0.27, tilt, yaw));
    if (yaw === 0) eye = e.applyEuler(new THREE.Euler(-tilt * DEG, 0, 0)).add(new THREE.Vector3(0, 0, -0.27));
    else dirs.push(dirFromTilt(tilt, yaw));
  }
  return {
    id, type: 'tower',
    groups: { base: base.merged(), post: post.merged(), head: head.merged(), panel: [] },
    postOrigin: new THREE.Vector3(0, cutH, mz),
    headPivot: new THREE.Vector3(0, L - 0.02, 0),
    panelPivot: null,
    eye, eyeDir: dirFromTilt(tilt), extraDirs: dirs, lenses,
    postColliders: [
      { half: [0.1, L / 2, 0.1], center: [0, L / 2, 0] },
      { half: [0.35, 0.25, 0.35], center: [0, L, 0] },
    ],
    baseColliders: [{ half: [0.9, 0.55, 1.9], center: [0, deckY + 0.3, 0.1] }],
    cutRadius: 0.1,
    roundPost: true,
    workPoint: new THREE.Vector3(0, 0, mz - 0.6),
  };
}
