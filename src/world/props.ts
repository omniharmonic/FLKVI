// Street furniture: procedural instanced kits, traffic signals with live state, streetlights + night light pool.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Recipe, RecipeProp, Vec2 } from '../core/types';
import { signalAxis, signalState } from '../core/signals';
import { rng } from '../core/geo';
import type { RoadNetwork, Junction } from './roads';
import { stopSignTexture, lightPoolTexture, manholeTexture, chainLinkTexture, procSet } from './textures';
import { Grid, cumLen, sampleAt, polyNormals } from './util';

type Part = { geo: THREE.BufferGeometry; mat: string };

// ---------------------------------------------------------------- materials
function makeMaterials() {
  const std = (color: THREE.ColorRepresentation, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  const hedge = procSet('hedge');
  const hedgeMap = hedge.map.clone(); hedgeMap.repeat.set(1 / hedge.sizeM, 1 / hedge.sizeM); hedgeMap.needsUpdate = true;
  const hedgeN = hedge.normalMap!.clone(); hedgeN.repeat.copy(hedgeMap.repeat); hedgeN.needsUpdate = true;
  const chain = chainLinkTexture().clone(); chain.repeat.set(1 / 0.06, 1 / 0.06); chain.needsUpdate = true;
  const conc = procSet('concrete');
  const concMap = conc.map.clone(); concMap.repeat.set(0.5, 0.5); concMap.needsUpdate = true;
  const M: Record<string, THREE.Material> = {
    galv: std(0x80868b, 0.5, 0.6),
    dark: std(0x26292b, 0.5, 0.55),
    green: std(0x24382c, 0.55, 0.4),
    wood: std(0x5a4632, 0.92, 0),
    concrete: std(0xb8b2a8, 0.9, 0, { map: concMap }),
    red: std(0xa51c16, 0.45, 0.2),
    yellow: std(0xc9a227, 0.5, 0.2),
    alu: std(0xb9bcbf, 0.4, 0.8),
    stopFace: std(0xffffff, 0.45, 0, { map: stopSignTexture() }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xc8dcdc, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false }),
    blue: std(0x1d3c78, 0.45, 0.3),
    black: std(0x121314, 0.7, 0.1),
    soil: std(0x3b2c20, 1, 0),
    hedge: std(0xffffff, 0.95, 0, { map: hedgeMap, normalMap: hedgeN }),
    chain: std(0xb0b4b8, 0.5, 0.7, { alphaMap: chain, alphaTest: 0.5, side: THREE.DoubleSide, transparent: false }),
    signalHousing: std(0x1a1c1d, 0.6, 0.3),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff2dc, emissive: new THREE.Color(0xffd9a8), emissiveIntensity: 0, roughness: 0.3 }),
    manhole: std(0xffffff, 0.6, 0.4, { map: manholeTexture(), transparent: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: false }),
    lens: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
  };
  for (const [k, m] of Object.entries(M)) m.name = 'prop-' + k;
  return M;
}

// ---------------------------------------------------------------- geometry kits (local: base at origin, "front" = +Z)
const cyl = (rt: number, rb: number, h: number, seg = 10, y = 0, x = 0, z = 0) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.translate(x, y + h / 2, z); return g; };
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y + h / 2, z); return g; };
const sph = (r: number, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, seg = 12) => { const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg / 2)); g.scale(sx, sy, sz); g.translate(x, y, z); return g; };

function kitStreetlight(): Part[] {
  // Cobra-head: 9 m tapered pole, arm along +X reaching 2.4 m, head at the tip.
  const pole = cyl(0.075, 0.13, 8.6, 8);
  const base = cyl(0.2, 0.22, 0.5, 8);
  const arm = new THREE.CylinderGeometry(0.045, 0.055, 2.5, 6); arm.rotateZ(Math.PI / 2 - 0.12); arm.translate(1.25, 8.75, 0);
  const head = sph(1, 0.42, 0.13, 0.22, 2.55, 8.83, 0, 10);
  const lens = sph(1, 0.3, 0.05, 0.16, 2.6, 8.73, 0, 8);
  return [{ geo: mergeGeometries([pole, base, arm]), mat: 'galv' }, { geo: head, mat: 'galv' }, { geo: lens, mat: 'lamp' }];
}
export const LAMP_OFFSET = new THREE.Vector3(2.6, 8.68, 0);

function kitSignalPole(): Part[] {
  const pole = cyl(0.14, 0.18, 7.2, 12);
  const base = cyl(0.32, 0.36, 0.6, 12);
  const cap = sph(0.15, 1, 1, 1, 0, 7.2, 0);
  return [{ geo: mergeGeometries([pole, base, cap]), mat: 'dark' }];
}
function kitMastArm(): Part[] {
  // unit length along +X, scaled per instance
  const a = new THREE.CylinderGeometry(0.07, 0.11, 1, 8); a.rotateZ(Math.PI / 2); a.translate(0.5, 6.6, 0);
  return [{ geo: a, mat: 'dark' }];
}
function kitSignalHead(): Part[] {
  const housing = box(0.36, 1.05, 0.26, 0, -0.52, 0);
  const plate = box(0.62, 1.3, 0.02, 0, -0.65, -0.14);
  const visors: THREE.BufferGeometry[] = [];
  for (const y of [0.34, 0, -0.34]) { const v = new THREE.CylinderGeometry(0.15, 0.15, 0.22, 10, 1, true, -Math.PI / 2, Math.PI); v.rotateX(Math.PI / 2); v.translate(0, y - 0.52 + 0.02, 0.23); visors.push(v); }
  return [{ geo: mergeGeometries([housing, ...visors]), mat: 'signalHousing' }, { geo: plate, mat: 'black' }];
}
function lensGeo(y: number) { const g = new THREE.CircleGeometry(0.12, 16); g.translate(0, y - 0.52, 0.132); return g; }

function kitStopSign(): Part[] {
  const post = box(0.06, 2.4, 0.06, 0, 0, 0);
  const face = new THREE.CircleGeometry(0.38, 8); face.rotateZ(Math.PI / 8); face.translate(0, 2.3, 0.035);
  const back = new THREE.CircleGeometry(0.38, 8); back.rotateZ(Math.PI / 8); back.rotateY(Math.PI); back.translate(0, 2.3, 0.03);
  return [{ geo: post, mat: 'galv' }, { geo: face, mat: 'stopFace' }, { geo: back, mat: 'alu' }];
}
function kitHydrant(): Part[] {
  const body = cyl(0.13, 0.14, 0.62, 12, 0.08);
  const base = cyl(0.19, 0.2, 0.1, 12);
  const top = sph(0.14, 1, 0.7, 1, 0, 0.72);
  const nut = cyl(0.03, 0.04, 0.08, 6, 0.8);
  const nozzle = new THREE.CylinderGeometry(0.06, 0.06, 0.38, 10); nozzle.rotateZ(Math.PI / 2); nozzle.translate(0, 0.5, 0);
  const front = new THREE.CylinderGeometry(0.075, 0.075, 0.2, 10); front.rotateX(Math.PI / 2); front.translate(0, 0.45, 0.14);
  return [{ geo: mergeGeometries([body, base, nozzle, front]), mat: 'red' }, { geo: mergeGeometries([top, nut]), mat: 'yellow' }];
}
function kitBench(): Part[] {
  const slats: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) slats.push(box(1.8, 0.035, 0.09, 0, 0.44, -0.2 + i * 0.11));
  for (let i = 0; i < 3; i++) { const b = box(1.8, 0.09, 0.03, 0, 0.55 + i * 0.12, -0.27); slats.push(b); }
  const legs: THREE.BufferGeometry[] = [];
  for (const x of [-0.75, 0.75]) { legs.push(box(0.05, 0.44, 0.5, x, 0, 0)); legs.push(box(0.05, 0.4, 0.04, x, 0.47, -0.27)); legs.push(box(0.05, 0.04, 0.45, x, 0.62, 0)); }
  return [{ geo: mergeGeometries(slats), mat: 'wood' }, { geo: mergeGeometries(legs), mat: 'dark' }];
}
function kitTrash(): Part[] {
  const shell = cyl(0.3, 0.28, 0.95, 16);
  const lid = cyl(0.33, 0.33, 0.06, 16, 0.95);
  const top = sph(0.3, 1, 0.35, 1, 0, 1.0);
  return [{ geo: mergeGeometries([shell, lid]), mat: 'green' }, { geo: top, mat: 'black' }];
}
function kitBusStop(): Part[] {
  const frame: THREE.BufferGeometry[] = [];
  for (const x of [-1.9, 1.9]) for (const z of [-0.7, 0.55]) frame.push(box(0.07, 2.45, 0.07, x, 0, z));
  const roof = box(4.2, 0.1, 1.7, 0, 2.45, -0.05);
  const bench = box(2.2, 0.06, 0.35, 0, 0.45, -0.45);
  const glassBack = box(3.8, 2.0, 0.02, 0, 0.25, -0.72);
  const glassSides = [box(0.02, 2.0, 1.1, -1.92, 0.25, -0.15), box(0.02, 2.0, 1.1, 1.92, 0.25, -0.15)];
  const ad = box(1.2, 1.6, 0.08, 1.2, 0.5, -0.72);
  return [{ geo: mergeGeometries([...frame, roof, bench]), mat: 'dark' }, { geo: mergeGeometries([glassBack, ...glassSides]), mat: 'glass' }, { geo: ad, mat: 'alu' }];
}
function kitBikeRack(): Part[] {
  const loops: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) { const t = new THREE.TorusGeometry(0.4, 0.025, 4, 10, Math.PI); t.translate(0, 0.45, 0); t.scale(1, 1.4, 1); t.translate(-0.8 + i * 0.8, 0, 0); t.rotateY(0); loops.push(t); }
  for (const g of loops) { const p = g.getAttribute('position'); for (let i = 0; i < p.count; i++) p.setY(i, Math.max(0, p.getY(i))); }
  return [{ geo: mergeGeometries(loops.map((l) => { const c = l.clone(); c.rotateY(Math.PI / 2); return c; })), mat: 'galv' }];
}
function kitBollard(): Part[] { return [{ geo: mergeGeometries([cyl(0.1, 0.11, 0.95, 12), sph(0.1, 1, 0.5, 1, 0, 0.95)]), mat: 'dark' }]; }
// Wooden distribution pole: 11 m, crossarm (local X, across the street line) 0.45 m below the top,
// three pin insulators, two diagonal braces. Local +Z runs along the wire line.
const POLE_H = 11, ARM_Y = POLE_H - 0.45;
function kitUtilityPole(): Part[] {
  const pole = cyl(0.12, 0.17, POLE_H, 10);
  const cross = box(2.44, 0.1, 0.09, 0, ARM_Y, 0);
  const braces: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) { const b = new THREE.BoxGeometry(0.05, 0.85, 0.04); b.rotateZ(s * 0.95); b.translate(s * 0.34, ARM_Y - 0.25, 0.07); braces.push(b); }
  const ins: THREE.BufferGeometry[] = [];
  for (const x of [-1.05, 0.28, 1.05]) ins.push(cyl(0.035, 0.05, 0.2, 6, ARM_Y + 0.1, x));
  return [{ geo: mergeGeometries([pole, cross]), mat: 'wood' }, { geo: mergeGeometries(braces), mat: 'galv' }, { geo: mergeGeometries(ins), mat: 'concrete' }];
}
/** Conductor attachment points (local x, y) on the crossarm insulators. */
export const WIRE_ATTACH = [[-1.05, ARM_Y + 0.3], [0.28, ARM_Y + 0.3], [1.05, ARM_Y + 0.3]];
function kitPoleTransformer(): Part[] {
  // pole-mount can transformer on the -Z face, below the crossarm
  const can = cyl(0.28, 0.28, 1.0, 14, ARM_Y - 2.4, 0, -0.42);
  const lid = sph(0.28, 1, 0.3, 1, 0, ARM_Y - 1.4, -0.42, 12);
  const bracket = box(0.1, 0.5, 0.2, 0, ARM_Y - 2.1, -0.16);
  const bush = cyl(0.04, 0.05, 0.22, 6, ARM_Y - 1.36, 0, -0.42);
  return [{ geo: mergeGeometries([can, lid]), mat: 'galv' }, { geo: mergeGeometries([bracket, bush]), mat: 'dark' }];
}
/** Residential street-light arm bolted to the pole (local +X toward the street). */
function kitPoleLamp(): Part[] {
  const arm = new THREE.CylinderGeometry(0.035, 0.045, 1.9, 6); arm.rotateZ(Math.PI / 2 - 0.15); arm.translate(0.95, POLE_LAMP_Y, 0);
  const head = sph(1, 0.34, 0.11, 0.18, 1.95, POLE_LAMP_Y + 0.14, 0, 10);
  const lens = sph(1, 0.24, 0.04, 0.13, 2.0, POLE_LAMP_Y + 0.06, 0, 8);
  return [{ geo: arm, mat: 'galv' }, { geo: head, mat: 'galv' }, { geo: lens, mat: 'lamp' }];
}
const POLE_LAMP_Y = 7.6;
const POLE_LAMP_OFFSET = new THREE.Vector3(2.0, POLE_LAMP_Y + 0.02, 0);
function kitMailbox(): Part[] {
  const body = box(0.46, 0.75, 0.5, 0, 0.35, 0);
  const top = new THREE.CylinderGeometry(0.23, 0.23, 0.5, 16, 1, false, 0, Math.PI); top.rotateX(Math.PI / 2); top.rotateZ(Math.PI / 2); top.translate(0, 1.1, 0);
  const legs = [box(0.05, 0.35, 0.05, -0.18, 0, -0.2), box(0.05, 0.35, 0.05, 0.18, 0, -0.2), box(0.05, 0.35, 0.05, -0.18, 0, 0.2), box(0.05, 0.35, 0.05, 0.18, 0, 0.2)];
  return [{ geo: mergeGeometries([body, top]), mat: 'blue' }, { geo: mergeGeometries(legs), mat: 'dark' }];
}
function kitNewsBox(): Part[] { return [{ geo: box(0.5, 1.0, 0.45, 0, 0.1, 0), mat: 'red' }, { geo: box(0.4, 0.3, 0.02, 0, 0.7, 0.23), mat: 'glass' }, { geo: mergeGeometries([box(0.04, 0.1, 0.04, -0.2, 0, 0), box(0.04, 0.1, 0.04, 0.2, 0, 0)]), mat: 'dark' }]; }
function kitMeter(): Part[] { return [{ geo: cyl(0.04, 0.04, 1.1, 8), mat: 'dark' }, { geo: box(0.2, 0.3, 0.14, 0, 1.1, 0), mat: 'galv' }, { geo: box(0.14, 0.1, 0.01, 0, 1.25, 0.075), mat: 'glass' }]; }
function kitPlanter(): Part[] {
  return [
    { geo: mergeGeometries([box(1.2, 0.55, 1.2, 0, 0, 0)]), mat: 'concrete' },
    { geo: box(1.05, 0.02, 1.05, 0, 0.52, 0), mat: 'soil' },
    { geo: mergeGeometries([sph(0.35, 1, 0.8, 1, -0.2, 0.75, -0.1, 8), sph(0.3, 1, 0.9, 1, 0.22, 0.8, 0.15, 8), sph(0.28, 1, 0.8, 1, 0.1, 0.7, -0.28, 8)]), mat: 'hedge' },
  ];
}

// ---------------------------------------------------------------- instancing
class KitInstances {
  meshes: THREE.InstancedMesh[] = [];
  mats: THREE.Matrix4[] = [];
  constructor(public name: string, public parts: Part[], public castShadow = true) {}
  add(m: THREE.Matrix4) { this.mats.push(m.clone()); }
  build(group: THREE.Group, M: Record<string, THREE.Material>) {
    if (!this.mats.length) return;
    // merge parts by material
    const byMat = new Map<string, THREE.BufferGeometry[]>();
    for (const p of this.parts) { const g = p.geo.index ? p.geo : p.geo; (byMat.get(p.mat) ?? byMat.set(p.mat, []).get(p.mat)!).push(g); }
    for (const [mat, geos] of byMat) {
      const geo = geos.length > 1 ? mergeGeometries(geos.map((g) => (g.index ? g : g))) : geos[0];
      const im = new THREE.InstancedMesh(geo, M[mat], this.mats.length);
      this.mats.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = this.castShadow && mat !== 'glass' && mat !== 'manhole';
      im.receiveShadow = true;
      im.name = `prop_${this.name}_${mat}`;
      im.computeBoundingSphere();
      group.add(im);
      this.meshes.push(im);
    }
  }
}

export interface PropCollider { kind: 'cyl'; x: number; y: number; z: number; r: number; h: number }
export interface PropBox { kind: 'box'; x: number; y: number; z: number; hx: number; hy: number; hz: number; rot: number }

export class PropSystem {
  group = new THREE.Group();
  M = makeMaterials();
  colliders: (PropCollider | PropBox)[] = [];
  lamps: THREE.Vector3[] = [];
  /** Traffic-signal poles with their mast arm (arm dir unit x/z, length m, arm height y+6.6). Read by surveillance to mount clusters. */
  masts: { x: number; y: number; z: number; dx: number; dz: number; len: number }[] = [];
  private lampGrid = new Grid<number>(60);
  private heads: { node: number; axis: number; bearing: number; idx: number }[] = [];
  private lensMeshes: THREE.InstancedMesh[] = [];
  private lights: THREE.SpotLight[] = [];
  private poolMat!: THREE.MeshBasicMaterial;
  private night = 0;
  private lightTick = 0;

  constructor(private recipe: Recipe, private roads: RoadNetwork, private groundAt: (x: number, z: number) => number, private inBuilding: (x: number, z: number) => boolean) {
    this.group.name = 'props';
  }

  /** Yaw so that local +Z faces direction (dx,dz). */
  private yawFace(dx: number, dz: number) { return Math.atan2(dx, dz); }
  private mat(x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1) {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(sx, sy, sz));
  }
  /** Direction from p toward the nearest road centerline (or null). */
  private towardRoad(p: Vec2, maxD = 25): Vec2 | null {
    const h = this.roads.nearestChain(p, maxD);
    if (!h) return null;
    const q = sampleAt(h.c.pts, h.c.L, h.s);
    const dx = q.x - p[0], dz = q.z - p[1], l = Math.hypot(dx, dz);
    if (l < 0.01) return null;
    return [dx / l, dz / l];
  }

  build() {
    const R = this.recipe, M = this.M;
    const kits: Record<string, KitInstances> = {
      streetlight: new KitInstances('streetlight', kitStreetlight()),
      signalPole: new KitInstances('signalPole', kitSignalPole()),
      mastArm: new KitInstances('mastArm', kitMastArm()),
      signalHead: new KitInstances('signalHead', kitSignalHead()),
      stop: new KitInstances('stop', kitStopSign()),
      hydrant: new KitInstances('hydrant', kitHydrant()),
      bench: new KitInstances('bench', kitBench()),
      trash: new KitInstances('trash', kitTrash()),
      busStop: new KitInstances('busStop', kitBusStop()),
      bikeRack: new KitInstances('bikeRack', kitBikeRack()),
      bollard: new KitInstances('bollard', kitBollard()),
      utility: new KitInstances('utility', kitUtilityPole()),
      utilityXf: new KitInstances('utilityXf', kitPoleTransformer()),
      utilityLamp: new KitInstances('utilityLamp', kitPoleLamp()),
      mailbox: new KitInstances('mailbox', kitMailbox()),
      news: new KitInstances('news', kitNewsBox()),
      meter: new KitInstances('meter', kitMeter()),
      planter: new KitInstances('planter', kitPlanter()),
    };
    const hedges: RecipeProp[] = [], fences: RecipeProp[] = [], manholes: Vec2[] = [], poles: THREE.Vector3[] = [];
    const lights: { p: Vec2; dir: Vec2 }[] = [];
    const stopProps: RecipeProp[] = [];
    const R0 = rng(1234);
    // recipe rot is a compass heading (0 = faces -Z, clockwise) → kit yaw (local +Z toward (sin, cos)): yaw = π − rot
    const rotYaw = (rot: number) => Math.PI - rot;
    const rotDir = (rot: number): Vec2 => [Math.sin(rot), -Math.cos(rot)];
    const faceRoad = (p: Vec2, rot: number) => { const d = this.towardRoad(p, 18); return d ? this.yawFace(d[0], d[1]) : rotYaw(rot); };

    const sp = R.spawn.p;
    for (const pr of R.props) {
      const [x, z] = pr.p;
      if (pr.type !== 'fence' && pr.type !== 'hedge' && Math.hypot(x - sp[0], z - sp[1]) < 3) continue;
      const y = this.groundAt(x, z);
      switch (pr.type) {
        case 'streetlight': { const d = this.towardRoad(pr.p, 25) ?? rotDir(pr.rot); lights.push({ p: pr.p, dir: d }); break; }
        case 'stop-sign': stopProps.push(pr); break;
        case 'hydrant': kits.hydrant.add(this.mat(x, y, z, R0() * 6.28)); this.colliders.push({ kind: 'cyl', x, y, z, r: 0.18, h: 0.8 }); break;
        case 'bench': { const yaw = faceRoad(pr.p, pr.rot); kits.bench.add(this.mat(x, y, z, yaw)); this.colliders.push({ kind: 'box', x, y, z, hx: 0.9, hy: 0.4, hz: 0.3, rot: yaw }); break; }
        case 'trash-can': kits.trash.add(this.mat(x, y, z, R0() * 6.28)); this.colliders.push({ kind: 'cyl', x, y, z, r: 0.32, h: 1 }); break;
        case 'bus-stop': { const yaw = faceRoad(pr.p, pr.rot); kits.busStop.add(this.mat(x, y, z, yaw)); this.colliders.push({ kind: 'box', x, y, z, hx: 2.0, hy: 1.3, hz: 0.1, rot: yaw }); break; }
        case 'bike-rack': { const d = this.towardRoad(pr.p, 18); const yaw = d ? this.yawFace(d[0], d[1]) + Math.PI / 2 : rotYaw(pr.rot); kits.bikeRack.add(this.mat(x, y, z, yaw)); break; }
        case 'bollard': kits.bollard.add(this.mat(x, y, z, 0)); this.colliders.push({ kind: 'cyl', x, y, z, r: 0.12, h: 1 }); break;
        case 'utility-pole': poles.push(new THREE.Vector3(x, y, z)); this.colliders.push({ kind: 'cyl', x, y, z, r: 0.17, h: 11 }); break;
        case 'mailbox': kits.mailbox.add(this.mat(x, y, z, faceRoad(pr.p, pr.rot))); break;
        case 'newspaper-box': kits.news.add(this.mat(x, y, z, faceRoad(pr.p, pr.rot))); break;
        case 'parking-meter': kits.meter.add(this.mat(x, y, z, faceRoad(pr.p, pr.rot))); break;
        case 'planter': kits.planter.add(this.mat(x, y, z, R0() * 6.28)); this.colliders.push({ kind: 'box', x, y, z, hx: 0.6, hy: 0.3, hz: 0.6, rot: 0 }); break;
        case 'manhole': break; // road decals (decals.ts)
        case 'hedge': hedges.push(pr); break;
        case 'fence': fences.push(pr); break;
        case 'traffic-signal': break; // generated from junction data (see below)
        default: break; // parked-car (gameplay), crosswalk (roads), shrub (trees)
      }
    }

    // --- streetlights: augment sparse data along major streets
    const lightGrid = new Grid<Vec2>(30);
    for (const l of lights) lightGrid.add(l.p[0], l.p[1], l.p);
    const near = (p: Vec2, r: number) => { let f = false; lightGrid.query(p[0], p[1], r, (q) => { if (Math.hypot(q[0] - p[0], q[1] - p[1]) < r) f = true; }); return f; };
    const b = R.bounds;
    for (const c of this.roads.chains) {
      if (c.cls === 'service' || c.bridge && c.s === 0) continue;
      const spacing = c.cls === 'residential' || c.cls === 'unclassified' || c.cls === 'living_street' ? 48 : 36;
      const s0 = c.trim[0] + 6, s1 = c.len - c.trim[1] - 6;
      let side = c.idx % 2 ? 1 : -1;
      const twoSided = c.w >= 7;
      for (let s = s0 + ((c.idx * 13) % spacing) * 0.3; s < s1; s += spacing / (twoSided ? 2 : 1)) {
        const q = sampleAt(c.pts, c.L, s);
        const nx = -q.dz, nz = q.dx;
        const off = c.w + (c.s > 0 ? Math.min(0.6, c.s * 0.25) : 1.2);
        const p: Vec2 = [q.x + nx * off * side, q.z + nz * off * side];
        side = twoSided ? -side : side;
        if (p[0] < b.minX + 5 || p[0] > b.maxX - 5 || p[1] < b.minZ + 5 || p[1] > b.maxZ - 5) continue;
        if (near(p, spacing * 0.4) || this.inBuilding(p[0], p[1]) || Math.hypot(p[0] - sp[0], p[1] - sp[1]) < 3) continue;
        lights.push({ p, dir: [q.x - p[0], q.z - p[1]].map((v) => v / off) as Vec2 });
        lightGrid.add(p[0], p[1], p);
      }
    }
    for (const l of lights) {
      const [x, z] = l.p, y = this.groundAt(x, z);
      const yaw = Math.atan2(-l.dir[1], l.dir[0]); // local +X → dir
      const m = this.mat(x, y, z, yaw);
      kits.streetlight.add(m);
      const lp = LAMP_OFFSET.clone().applyMatrix4(m);
      this.lampGrid.add(lp.x, lp.z, this.lamps.length);
      this.lamps.push(lp);
      this.colliders.push({ kind: 'cyl', x, y, z, r: 0.14, h: 8.6 });
    }

    // --- traffic signals at signalized junctions
    const graph = R.graph;
    const lensGeos = [lensGeo(0.34), lensGeo(0), lensGeo(-0.34)];
    const headMats: THREE.Matrix4[] = [];
    const signalJ: Junction[] = [];
    for (const J of this.roads.junctions.values()) {
      if (!J.signal || J.arms.length < 3 || J.graphNode < 0 || !graph.nodes[J.graphNode]) continue;
      signalJ.push(J);
      const axis = signalAxis(graph, J.graphNode);
      for (const A of J.arms) {
        const c = A.chain;
        if (c.oneway && A.atStart) continue; // traffic leaves the junction on this arm
        const tx = -A.u[0], tz = -A.u[1]; // travel direction of approaching traffic
        const rx = -tz, rz = tx; // right of travel
        // far-side corner: across the junction, right of travel
        const far = Math.max(...J.arms.map((a) => a.trim)) * 0.8 + 1.5;
        const off = A.w + (A.s > 0 ? Math.min(1.2, A.s * 0.4) : 1.0);
        const px = J.p[0] + tx * far + rx * off, pz = J.p[1] + tz * far + rz * off;
        if (this.inBuilding(px, pz)) continue;
        const py = this.groundAt(px, pz);
        kits.signalPole.add(this.mat(px, py, pz, 0));
        this.colliders.push({ kind: 'cyl', x: px, y: py, z: pz, r: 0.2, h: 7.2 });
        // mast arm extends toward -right (over the approach lanes)
        const lanesIn = c.oneway ? c.lanes : Math.max(1, Math.floor(c.lanes / 2));
        const laneW = c.oneway ? (A.w * 2) / c.lanes : A.w / lanesIn;
        const firstLaneOff = c.oneway ? -A.w + laneW / 2 : laneW / 2; // lateral offset of lane centers relative to centerline (right positive)
        const armLen = off - firstLaneOff + 0.6;
        const armYaw = Math.atan2(rz, -rx); // local +X → (-rx,-rz)
        kits.mastArm.add(this.mat(px, py, pz, armYaw, Math.max(2, armLen), 1, 1));
        this.masts.push({ x: px, y: py, z: pz, dx: -rx, dz: -rz, len: Math.max(2, armLen) });
        const headYaw = this.yawFace(A.u[0], A.u[1]);
        const bearing = Math.atan2(tz, tx);
        for (let k = 0; k < lanesIn; k++) {
          const lo = firstLaneOff + k * laneW; // right-positive offset from centerline
          const along = off - lo; // distance from pole along arm
          if (along > armLen + 0.1) continue;
          const hx = px - rx * along, hz = pz - rz * along;
          const m = this.mat(hx, py + 6.5, hz, headYaw);
          kits.signalHead.add(m);
          headMats.push(m);
          this.heads.push({ node: J.graphNode, axis, bearing, idx: this.heads.length });
        }
      }
    }
    if (headMats.length) {
      lensGeos.forEach((lg) => {
        const im = new THREE.InstancedMesh(lg, this.M.lens, headMats.length);
        headMats.forEach((m, i) => im.setMatrixAt(i, m));
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(headMats.length * 3), 3);
        im.instanceColor.setUsage(THREE.DynamicDrawUsage);
        im.name = 'signal_lens';
        im.computeBoundingSphere();
        this.group.add(im);
        this.lensMeshes.push(im);
      });
    }

    // --- stop signs: recipe props, or generated at stop-controlled junctions
    const stopPts: Vec2[] = [];
    const placeStop = (p: Vec2, faceDir: Vec2) => {
      const y = this.groundAt(p[0], p[1]);
      kits.stop.add(this.mat(p[0], y, p[1], this.yawFace(faceDir[0], faceDir[1])));
      this.colliders.push({ kind: 'cyl', x: p[0], y, z: p[1], r: 0.05, h: 2.4 });
      stopPts.push(p);
    };
    // compiler stop signs carry the exact approach heading (sign faces oncoming traffic on its leg)
    for (const sp of stopProps) placeStop(sp.p, rotDir(sp.rot));
    for (const J of this.roads.junctions.values()) {
      if (!J.stop || J.signal || J.arms.length < 3) continue;
      for (const A of J.arms) {
        const c = A.chain;
        if (c.oneway && A.atStart) continue;
        const tx = -A.u[0], tz = -A.u[1], rx = -tz, rz = tx;
        const p: Vec2 = [A.o[0] + A.u[0] * (A.trim + 0.8) + rx * (A.w + 0.5), A.o[1] + A.u[1] * (A.trim + 0.8) + rz * (A.w + 0.5)];
        if (stopPts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 10) || this.inBuilding(p[0], p[1])) continue;
        placeStop(p, A.u);
      }
    }

    // utility poles are oriented from their wire runs (and may carry a lamp arm) → place before building kits
    this.buildWires(poles, kits);
    for (const k of Object.values(kits)) k.build(this.group, M);
    // perf: city-wide instanced furniture draws only the instances near the camera (small props
    // vanish below a pixel long before 150 m; lamps/signals stay out to ~450 m for the night skyline)
    for (const k of Object.values(kits)) {
      const dist = /^(streetlight|signalPole|mastArm|signalHead|utility|utilityXf|utilityLamp)$/.test(k.name) ? 450 : k.name === 'busStop' ? 240 : 160;
      for (const im of k.meshes) {
        const n = im.count, src = im.instanceMatrix.array as Float32Array;
        const all = src.slice(0, n * 16), xs = new Float32Array(n), zs = new Float32Array(n);
        for (let i = 0; i < n; i++) { xs[i] = all[i * 16 + 12]; zs[i] = all[i * 16 + 14]; }
        this.culled.push({ im, all, xs, zs, n, d2: dist * dist });
      }
    }

    this.buildManholes(manholes);
    this.buildHedges(hedges);
    this.buildFences(fences);
    this.buildNightLights();
  }

  private buildManholes(pts: Vec2[]) {
    if (!pts.length) return;
    const g = new THREE.CircleGeometry(0.4, 20); g.rotateX(-Math.PI / 2);
    const im = new THREE.InstancedMesh(g, this.M.manhole, pts.length);
    pts.forEach((p, i) => im.setMatrixAt(i, this.mat(p[0], this.groundAt(p[0], p[1]) + 0.014, p[1], i)));
    im.receiveShadow = true; im.name = 'manholes'; im.renderOrder = 2;
    im.computeBoundingSphere();
    this.group.add(im);
  }

  private buildHedges(hs: RecipeProp[]) {
    const geos: THREE.BufferGeometry[] = [];
    for (const h of hs) {
      const line = h.line && h.line.length >= 2 ? h.line : null;
      if (!line) continue;
      const L = cumLen(line);
      const n = polyNormals(line);
      const H = 1.1 + (h.variant % 3) * 0.2, W = 0.45;
      const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
      line.forEach((p, i) => {
        const y = this.groundAt(p[0], p[1]);
        const [nx, nz] = n[i];
        const ring = [[-W, 0, -1, 0], [-W * 1.1, H * 0.85, -0.8, 0.5], [0, H, 0, 1], [W * 1.1, H * 0.85, 0.8, 0.5], [W, 0, 1, 0]];
        ring.forEach(([o, hh, an, ay], k) => {
          pos.push(p[0] + nx * o, y + hh, p[1] + nz * o);
          const l = Math.hypot(an, ay) || 1; nor.push((nx * an) / l, ay / l, (nz * an) / l);
          uv.push(L[i], k * H * 0.5);
        });
      });
      for (let i = 0; i + 1 < line.length; i++) for (let k = 0; k < 4; k++) {
        const a = i * 5 + k, b2 = a + 1, c = a + 5, d = c + 1;
        idx.push(a, c, b2, b2, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      geos.push(g);
    }
    if (!geos.length) return;
    const hm = (this.M.hedge as THREE.MeshStandardMaterial).clone(); hm.side = THREE.DoubleSide;
    const m = new THREE.Mesh(mergeGeometries(geos), hm);
    m.castShadow = m.receiveShadow = true; m.name = 'hedges';
    this.group.add(m);
  }

  private buildFences(fs: RecipeProp[]) {
    const panels: THREE.BufferGeometry[] = [], posts: THREE.BufferGeometry[] = [];
    for (const f of fs) {
      const line = f.line && f.line.length >= 2 ? f.line : null;
      if (!line) continue;
      const H = 1.8;
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i], b = line[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / 3));
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n;
          const x0 = a[0] + (b[0] - a[0]) * t0, z0 = a[1] + (b[1] - a[1]) * t0, x1 = a[0] + (b[0] - a[0]) * t1, z1 = a[1] + (b[1] - a[1]) * t1;
          const y0 = this.groundAt(x0, z0), y1 = this.groundAt(x1, z1);
          const g = new THREE.BufferGeometry();
          const l = Math.hypot(x1 - x0, z1 - z0);
          const nx = -(z1 - z0) / l, nz = (x1 - x0) / l;
          g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y0 + 0.05, z0, x1, y1 + 0.05, z1, x1, y1 + H, z1, x0, y0 + H, z0], 3));
          g.setAttribute('normal', new THREE.Float32BufferAttribute([nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz], 3));
          g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, l, 0, l, H, 0, H], 2));
          g.setIndex([0, 1, 2, 0, 2, 3]);
          panels.push(g);
          const p = cyl(0.03, 0.03, H + 0.05, 6, y0, x0, z0);
          posts.push(p);
          const rail = new THREE.CylinderGeometry(0.02, 0.02, l, 5); rail.rotateZ(Math.PI / 2); rail.rotateY(-Math.atan2(z1 - z0, x1 - x0)); rail.translate((x0 + x1) / 2, (y0 + y1) / 2 + H, (z0 + z1) / 2);
          posts.push(rail);
        }
      }
    }
    if (panels.length) { const m = new THREE.Mesh(mergeGeometries(panels), this.M.chain); m.name = 'fences'; m.castShadow = true; this.group.add(m); }
    if (posts.length) { const m = new THREE.Mesh(mergeGeometries(posts), this.M.galv); m.name = 'fence_posts'; m.castShadow = true; this.group.add(m); }
  }

  /**
   * Utility poles + overhead conductors. Each pole is assigned to its street run (nearest road chain + side);
   * wires only join consecutive poles of the same run, ≤ MAX_SPAN apart, with no building footprint under the
   * span. Poles away from any street link to their nearest clear neighbour. Crossarms sit across the run.
   */
  private buildWires(poles: THREE.Vector3[], kits: Record<string, KitInstances>) {
    if (!poles.length) return;
    const MAX_SPAN = 45, FREE_SPAN = 38;
    const RES = /^(residential|unclassified|living_street)$/;
    const info = poles.map((p) => {
      const h = this.roads.nearestChain([p.x, p.z], 30);
      if (!h) return { key: '', s: 0, t: null as Vec2 | null, toRoad: null as Vec2 | null, resid: false };
      const q = sampleAt(h.c.pts, h.c.L, h.s);
      const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
      return { key: `${h.c.idx}:${Math.sign(h.off) || 1}`, s: h.s, t: [q.dx, q.dz] as Vec2, toRoad: [dx / l, dz / l] as Vec2, resid: RES.test(h.c.cls) };
    });
    // span must stay clear of buildings (wires at ~10.8 m: any footprint under them reads as clipping)
    const clear = (a: THREE.Vector3, b: THREE.Vector3) => {
      const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(L / 1.5);
      for (let k = 1; k < n; k++) { const t = k / n; if (this.inBuilding(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false; }
      return true;
    };
    const span = (a: number, b: number) => Math.hypot(poles[a].x - poles[b].x, poles[a].z - poles[b].z);
    const pairs: [number, number][] = [];
    const degree = new Array(poles.length).fill(0);
    const runs = new Map<string, number[]>();
    info.forEach((f, i) => { if (f.key) (runs.get(f.key) ?? runs.set(f.key, []).get(f.key)!).push(i); });
    for (const ids of runs.values()) {
      ids.sort((a, b) => info[a].s - info[b].s);
      for (let k = 0; k + 1 < ids.length; k++) {
        const a = ids[k], b = ids[k + 1], d = span(a, b);
        if (d < 4 || d > MAX_SPAN || !clear(poles[a], poles[b])) continue;
        pairs.push([a, b]); degree[a]++; degree[b]++;
      }
    }
    // off-street poles (alleys/back lots without a mapped road): nearest clear neighbour, ≤ 2 links
    const linked = new Set(pairs.map(([a, b]) => `${a}_${b}`));
    info.forEach((f, i) => {
      if (f.key) return;
      const cand = poles.map((_, j) => ({ j, d: j === i ? Infinity : span(i, j) })).filter((c) => c.d > 4 && c.d < FREE_SPAN).sort((a, b) => a.d - b.d);
      for (const c of cand) {
        if (degree[i] >= 2) break;
        if (degree[c.j] >= 2) continue;
        const k = i < c.j ? `${i}_${c.j}` : `${c.j}_${i}`;
        if (linked.has(k) || !clear(poles[i], poles[c.j])) continue;
        linked.add(k); pairs.push([i, c.j]); degree[i]++; degree[c.j]++;
      }
    });
    // crossarm orientation: local +Z along the wire line (street tangent), consistently signed per run
    const dirs = poles.map((_, i) => new THREE.Vector2(...(info[i].t ?? [0, 0])).multiplyScalar(0.01));
    for (const [a, b] of pairs) {
      const d = new THREE.Vector2(poles[b].x - poles[a].x, poles[b].z - poles[a].z).normalize();
      for (const i of [a, b]) { if (dirs[i].dot(d) < 0) dirs[i].sub(d); else dirs[i].add(d); }
    }
    const yaws = dirs.map((d) => (d.lengthSq() < 1e-8 ? 0 : Math.atan2(d.x, d.y)));
    const H = (i: number) => { let h = (i * 2654435761) >>> 0; h ^= h >>> 15; return (h % 1000) / 1000; };
    poles.forEach((p, i) => {
      kits.utility.add(this.mat(p.x, p.y, p.z, yaws[i]));
      // pole-top transformer on roughly one pole in four that carries wires
      if (degree[i] > 0 && H(i) < 0.27) kits.utilityXf.add(this.mat(p.x, p.y, p.z, yaws[i]));
      // residential: cobra-head arm bolted to some poles where no dedicated streetlight is close
      const f = info[i];
      if (f.resid && f.toRoad && H(i + 7919) < 0.5) {
        let lit = false;
        this.lampGrid.query(p.x, p.z, 22, (k) => { if (Math.hypot(this.lamps[k].x - p.x, this.lamps[k].z - p.z) < 22) lit = true; });
        if (!lit) {
          const m = this.mat(p.x, p.y, p.z, Math.atan2(-f.toRoad[1], f.toRoad[0]));
          kits.utilityLamp.add(m);
          const lp = POLE_LAMP_OFFSET.clone().applyMatrix4(m);
          this.lampGrid.add(lp.x, lp.z, this.lamps.length);
          this.lamps.push(lp);
        }
      }
    });
    const pts: number[] = [];
    const att = (i: number, k: number) => {
      const p = poles[i], [ax, ay] = WIRE_ATTACH[k], yaw = yaws[i];
      return new THREE.Vector3(p.x + Math.cos(yaw) * ax, p.y + ay, p.z - Math.sin(yaw) * ax);
    };
    for (const [a, b] of pairs) {
      // pair conductors by lateral order so they never cross, even if the two crossarms face opposite ways
      const A = [0, 1, 2].map((k) => att(a, k)), B = [0, 1, 2].map((k) => att(b, k));
      const straight = A[0].distanceTo(B[0]) + A[2].distanceTo(B[2]) <= A[0].distanceTo(B[2]) + A[2].distanceTo(B[0]);
      const mapK = straight ? [0, 1, 2] : [2, 1, 0];
      for (let k = 0; k < 3; k++) {
        const P0 = A[k], P1 = B[mapK[k]];
        const L = P0.distanceTo(P1), sag = L * 0.015 + 0.04; // ~1.5 % of span
        const N = Math.max(4, Math.ceil(L / 4));
        for (let s = 0; s < N; s++) {
          const t0 = s / N, t1 = (s + 1) / N;
          const p0 = P0.clone().lerp(P1, t0), p1 = P0.clone().lerp(P1, t1);
          p0.y -= sag * 4 * t0 * (1 - t0); p1.y -= sag * 4 * t1 * (1 - t1);
          pts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        }
      }
    }
    if (!pts.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.computeBoundingSphere();
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.85 }));
    lines.name = 'wires';
    this.group.add(lines);
  }

  private buildNightLights() {
    // pooled real lights
    for (let i = 0; i < 16; i++) {
      const l = new THREE.SpotLight(0xffd9a8, 0, 42, 1.15, 0.65, 1.6);
      l.castShadow = false;
      l.position.set(0, -1000, 0);
      l.target.position.set(0, -1010, 0);
      this.group.add(l, l.target);
      this.lights.push(l);
    }
    // fake ground pools under every lamp
    if (!this.lamps.length) return;
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    this.poolMat = new THREE.MeshBasicMaterial({ map: lightPoolTexture(), color: 0xffc98a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, fog: true });
    const im = new THREE.InstancedMesh(g, this.poolMat, this.lamps.length);
    this.lamps.forEach((p, i) => im.setMatrixAt(i, this.mat(p.x, this.groundAt(p.x, p.z) + 0.03, p.z, 0, 17, 1, 17)));
    im.name = 'light_pools'; im.renderOrder = 3; im.visible = false;
    im.computeBoundingSphere();
    this.group.add(im);
    this.pools = im;
  }
  private pools: THREE.InstancedMesh | null = null;

  setNightFactor(f: number) {
    this.night = f;
    const lamp = this.M.lamp as THREE.MeshStandardMaterial;
    lamp.emissiveIntensity = f * 18;
    if (this.poolMat) this.poolMat.opacity = f * 0.045; // look-dev: additive radiance, matched to the real spot pools
    if (this.pools) this.pools.visible = f > 0.02;
  }

  private tmpCol = new THREE.Color();
  private culled: { im: THREE.InstancedMesh; all: Float32Array; xs: Float32Array; zs: Float32Array; n: number; d2: number }[] = [];
  private cullAt = { x: 1e9, z: 1e9 };
  /** Keep only instances within their draw distance (re-picked after the camera moved 12 m). */
  private cullInstances(camera: THREE.Camera) {
    const cx = camera.position.x, cz = camera.position.z;
    if ((cx - this.cullAt.x) ** 2 + (cz - this.cullAt.z) ** 2 < 144) return;
    this.cullAt.x = cx; this.cullAt.z = cz;
    for (const e of this.culled) {
      const dst = e.im.instanceMatrix.array as Float32Array;
      let k = 0;
      for (let i = 0; i < e.n; i++) {
        const dx = e.xs[i] - cx, dz = e.zs[i] - cz;
        if (dx * dx + dz * dz > e.d2) continue;
        dst.set(e.all.subarray(i * 16, i * 16 + 16), k * 16);
        k++;
      }
      e.im.count = k;
      e.im.instanceMatrix.clearUpdateRanges();
      e.im.instanceMatrix.addUpdateRange(0, Math.max(16, k * 16));
      e.im.instanceMatrix.needsUpdate = true;
    }
  }
  update(t: number, camera: THREE.Camera) {
    this.cullInstances(camera);
    // signal lenses
    if (this.heads.length && this.lensMeshes.length === 3) {
      const [rm, ym, gm] = this.lensMeshes;
      const ra = rm.instanceColor!.array as Float32Array, ya = ym.instanceColor!.array as Float32Array, ga = gm.instanceColor!.array as Float32Array;
      const on = 6, off = 0.06;
      for (const h of this.heads) {
        const st = signalState(h.node, h.axis, h.bearing, t);
        const i = h.idx * 3;
        ra[i] = st === 'red' ? on : off * 1.5; ra[i + 1] = st === 'red' ? on * 0.05 : off * 0.1; ra[i + 2] = st === 'red' ? on * 0.03 : off * 0.1;
        ya[i] = st === 'yellow' ? on : off * 1.4; ya[i + 1] = st === 'yellow' ? on * 0.55 : off; ya[i + 2] = st === 'yellow' ? 0 : off * 0.1;
        ga[i] = st === 'green' ? on * 0.05 : off * 0.1; ga[i + 1] = st === 'green' ? on : off * 1.2; ga[i + 2] = st === 'green' ? on * 0.55 : off * 0.8;
      }
      rm.instanceColor!.needsUpdate = ym.instanceColor!.needsUpdate = gm.instanceColor!.needsUpdate = true;
    }
    // light pool reassignment
    if (++this.lightTick % 4 !== 0) return;
    const on = this.night > 0.02;
    if (!on) { for (const l of this.lights) l.intensity = 0; return; }
    const cp = camera.position;
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    const cand: { i: number; s: number }[] = [];
    this.lampGrid.query(cp.x, cp.z, 160, (i) => {
      const p = this.lamps[i];
      const dx = p.x - cp.x, dz = p.z - cp.z, d = Math.hypot(dx, dz);
      if (d > 160) return;
      const facing = (dx * fwd.x + dz * fwd.z) / (d || 1);
      cand.push({ i, s: d - facing * 25 });
    });
    cand.sort((a, b) => a.s - b.s);
    this.lights.forEach((l, k) => {
      const c = cand[k];
      if (!c) { l.intensity = 0; return; }
      const p = this.lamps[c.i];
      l.position.copy(p);
      l.target.position.set(p.x, p.y - 10, p.z);
      l.target.updateMatrixWorld();
      l.intensity = this.night * 26; // look-dev: ~0.8 lux-equivalent under the lamp at night exposure (was 380: blown out)
    });
  }
}
