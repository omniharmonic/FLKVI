// Safe "is this car-sized box clear?" test. Rapier's world scene queries (intersectionsWithShape…)
// panic ("unreachable") when a collider was removed since the last physics step — which happens
// constantly here (parked-car promotion, AI despawns). This tests candidate colliders one by one with
// Collider.intersectsShape (pure shape math, no world BVH) from a cached grid of static colliders.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Game } from '../../core/game';
import type { CarModel } from './carModels';
import { groundY } from '../util';

const CELL = 16;

export class OverlapChecker {
  private grid = new Map<number, number[]>();
  /** World-space trimeshes (buildings, landmarks): their translation says nothing about their extent. */
  private global: number[] = [];
  private builtAt = -1e9;
  private q = new THREE.Quaternion();
  private yAxis = new THREE.Vector3(0, 1, 0);

  /**
   * @param skip colliders never tested (parked-slot colliders, characters…)
   * @param dynamic moving colliders to test too (live vehicles)
   * @param signature cheap number that changes when static colliders are added/removed (triggers a rebuild)
   */
  constructor(private g: Game, private skip: (c: RAPIER_NS.Collider) => boolean, private dynamic: () => RAPIER_NS.Collider[], private signature: () => number) {}
  private sig = NaN;

  private key(ix: number, iz: number) { return (ix + 4096) * 8192 + (iz + 4096); }

  /** (Re)build the static candidate grid; cheap enough to redo every ~20 s (new props / landmarks). */
  private build() {
    const W = this.g.physics, R = this.g.rapier;
    this.grid.clear();
    this.global = [];
    W.colliders.forEach((c) => {
      const p = c.parent();
      if (!p || !p.isFixed() || c.isSensor() || this.skip(c)) return;
      const t = c.shapeType();
      if (t === R.ShapeType.HeightField) return; // terrain: cars rest on it, never "inside" it
      if (t === R.ShapeType.TriMesh || t === R.ShapeType.Polyline) { this.global.push(c.handle); return; }
      const tr = c.translation();
      const k = this.key(Math.floor(tr.x / CELL), Math.floor(tr.z / CELL));
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(c.handle);
    });
    this.builtAt = this.g.elapsed;
    this.sig = this.signature();
  }

  /** True if an oriented box (half extents h, centre p, yaw heading) overlaps any solid collider. */
  boxHits(h: { x: number; y: number; z: number }, p: { x: number; y: number; z: number }, heading: number, extraSkip?: (c: RAPIER_NS.Collider) => boolean): boolean {
    if (this.g.elapsed - this.builtAt > 20 || this.signature() !== this.sig) this.build();
    const W = this.g.physics, R = this.g.rapier;
    const shape = new R.Cuboid(h.x, h.y, h.z);
    this.q.setFromAxisAngle(this.yAxis, -heading);
    const rot = { x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w };
    const test = (c: RAPIER_NS.Collider | undefined) => !!c && !c.isSensor() && !this.skip(c) && !extraSkip?.(c) && c.intersectsShape(shape, p, rot);
    for (const hd of this.global) if (test(W.getCollider(hd))) return true;
    const r = Math.hypot(h.x, h.z) + 6;
    for (let ix = Math.floor((p.x - r) / CELL); ix <= Math.floor((p.x + r) / CELL); ix++) {
      for (let iz = Math.floor((p.z - r) / CELL); iz <= Math.floor((p.z + r) / CELL); iz++) {
        const l = this.grid.get(this.key(ix, iz));
        if (l) for (const hd of l) if (test(W.getCollider(hd))) return true;
      }
    }
    for (const c of this.dynamic()) if (W.getCollider(c.handle) && test(c)) return true;
    return false;
  }

  /**
   * Nearest clear pose for a car near (x, z): tests the hull from 0.25 m above its floor (curbs and
   * slopes don't count) up to the roof, at the given spot and a ring of nudges. Null if none is clear.
   */
  clearSpot(m: CarModel, x: number, z: number, heading: number, extraSkip?: (c: RAPIER_NS.Collider) => boolean, y?: number, maxNudges = NUDGES.length): [number, number] | null {
    const y0 = m.colCenter.y - m.colHalf.y + 0.25, y1 = Math.max(y0 + 0.2, m.roofY - 0.05);
    const half = { x: m.colHalf.x - 0.08, y: (y1 - y0) / 2, z: m.colHalf.z - 0.08 };
    const fx = Math.sin(heading), fz = -Math.cos(heading), rx = -fz, rz = fx;
    for (const [a, b] of NUDGES.slice(0, maxNudges)) {
      const px = x + rx * a + fx * b, pz = z + rz * a + fz * b;
      const gy = a === 0 && b === 0 && y !== undefined ? y : groundY(this.g, px, pz);
      if (!this.boxHits(half, { x: px, y: gy + (y0 + y1) / 2, z: pz }, heading, extraSkip)) return [px, pz];
    }
    return null;
  }
}

const NUDGES: [number, number][] = [[0, 0], [0, 0.6], [0, -0.6], [0.5, 0], [-0.5, 0], [0, 1.4], [0, -1.4], [0.5, 1], [0.5, -1], [-0.5, 1], [-0.5, -1],
  [0, 2.4], [0, -2.4], [-2.2, 0], [2.2, 0], [-2.2, -3], [2.2, -3], [0, -6], [0, 6]];
