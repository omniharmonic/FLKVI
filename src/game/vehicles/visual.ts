// Per-vehicle scene graph built from a shared CarModel (geometries + materials are shared).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarModel } from './carModels';
import { mats, paintMaterial, plateMaterial, beamMaterial, PLATE_CELLS } from './materials';

export interface VehicleVisual {
  root: THREE.Group;
  /** Holds the body; can be tilted for visual roll/pitch on kinematic cars. */
  chassis: THREE.Group;
  bodyMesh: THREE.Mesh;
  /** Steering pivots (FL, FR, RL, RR); child 0 = spinning wheel mesh. */
  wheels: THREE.Group[];
  /** signal: −1 left, 1 right, 2 hazards, 0 off. */
  setLights(s: { head: boolean; brake: boolean; reverse: boolean; siren: boolean; t: number; signal?: number; beam?: boolean }): void;
  /** Show/hide the seated driver figure. */
  setDriver(on: boolean): void;
  setPaint(color: string): void;
  readonly far: boolean;
  setFar(f: boolean): void;
}

let taxiMat: THREE.MeshStandardMaterial | null = null;
function taxiSignMaterial() {
  if (taxiMat) return taxiMat;
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const x = cv.getContext('2d')!;
  x.fillStyle = '#f7e9a8'; x.fillRect(0, 0, 256, 128);
  x.fillStyle = '#1a1a1a'; x.font = 'bold 72px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('TAXI', 128, 68);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  taxiMat = new THREE.MeshStandardMaterial({ map: t, emissive: 0xfff2b0, emissiveMap: t, emissiveIntensity: 0.4, roughness: 0.4 });
  return taxiMat;
}

const plateGeoCache = new Map<string, THREE.BufferGeometry>();
function plateGeo(model: CarModel, cell: number) {
  const key = `${model.id}-${cell}`;
  let g = plateGeoCache.get(key);
  if (!g) {
    g = model.plate.clone();
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const cx = (cell % 4) * 0.25, cy = Math.floor(cell / 4) * 0.25;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + cx, uv.getY(i) - cy);
    plateGeoCache.set(key, g);
  }
  return g;
}

export function paintFor(model: CarModel, color: string) {
  const c = model.livery === 'police' ? '#ffffff' : model.livery === 'taxi' ? '#ffffff' : color;
  return paintMaterial(c, model.paintMap, model.id);
}

export function createVehicleVisual(model: CarModel, color: string, seed: number): VehicleVisual {
  const root = new THREE.Group();
  root.name = `vehicle-${model.id}`;
  const chassis = new THREE.Group();
  root.add(chassis);
  const paint = paintFor(model, color);
  const bodyMesh = new THREE.Mesh(model.body, [paint, mats.glass, mats.dark, mats.trim]);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  chassis.add(bodyMesh);
  const add = (geo: THREE.BufferGeometry | null | undefined, mat: THREE.Material | THREE.Material[], shadow = false) => {
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = false;
    chassis.add(m);
    return m;
  };
  const paintParts = add(model.paintParts, paint)!;
  add(model.trim, mats.trim, true);
  add(model.chrome, mats.chrome);
  add(model.grille, mats.grille);
  const head = add(model.head, mats.headOff)!;
  const tail = add(model.tail, mats.tailOff)!;
  const rev = add(model.reverse, mats.revOff)!;
  // Cabin: interior shell alone, or interior + seated driver merged (one draw either way).
  const cabinGeo = [model.interior, cabinWithDriver(model, seed % model.drivers.length)];
  const cabin = add(model.interior, mats.interior)!;
  const sigMats: THREE.Material[] = [mats.amber, mats.amber];
  add(model.signals, sigMats);
  add(plateGeo(model, seed % PLATE_CELLS), plateMaterial());
  let red: THREE.Mesh | null = null, blue: THREE.Mesh | null = null;
  if (model.lightbar) {
    add(model.lightbar.base, mats.trim);
    red = add(model.lightbar.red, mats.redOff);
    blue = add(model.lightbar.blue, mats.blueOff);
  }
  if (model.taxiSign) add(model.taxiSign, taxiSignMaterial());
  const wheels: THREE.Group[] = [];
  const wheelMats = [mats.tire, mats.rim, mats.rimDark];
  model.wheelPos.forEach((p, i) => {
    const pivot = new THREE.Group();
    pivot.position.copy(p);
    const w = new THREE.Mesh(model.wheel, wheelMats);
    w.castShadow = true;
    if (i % 2 === 0) w.rotation.y = Math.PI; // left wheels: outer face toward −X
    const spin = new THREE.Group();
    spin.add(w);
    pivot.add(spin);
    root.add(pivot);
    wheels.push(pivot);
  });
  // Far LOD
  const far = new THREE.Group();
  far.visible = false;
  const farBody = new THREE.Mesh(model.lod.body, [paint, mats.glassFar, mats.dark, mats.trim]);
  farBody.castShadow = true;
  const farWheels = new THREE.Mesh(model.lod.wheels, [mats.tire, mats.rim]);
  const farHead = new THREE.Mesh(model.lod.head, mats.headOff);
  const farTail = new THREE.Mesh(model.lod.tail, mats.tailOff);
  far.add(farBody, farWheels, farHead, farTail);
  root.add(far);
  // Headlight ground pool (night only): flat additive quad ahead of the bumper, in the unpitched root.
  const beam = new THREE.Mesh(beamGeo(), beamMaterial());
  beam.position.set(0, 0.04, -model.L / 2 - 0.2);
  beam.visible = false;
  beam.renderOrder = 2;
  root.add(beam);
  let isFar = false;
  const phase = (seed % 7) * 0.13;
  return {
    root, chassis, bodyMesh, wheels,
    get far() { return isFar; },
    setFar(f: boolean) {
      if (f === isFar) return;
      isFar = f;
      far.visible = f;
      chassis.visible = !f;
      for (const w of wheels) w.visible = !f;
    },
    setDriver(on: boolean) { const g = cabinGeo[on ? 1 : 0]; if (cabin.geometry !== g) cabin.geometry = g; },
    setLights(s) {
      beam.visible = !!s.beam && s.head && !isFar;
      const blink = ((s.t + phase) % 0.7) < 0.36;
      const sg = s.signal ?? 0;
      sigMats[0] = (sg === -1 || sg === 2) && blink ? mats.amberOn : mats.amber;
      sigMats[1] = (sg === 1 || sg === 2) && blink ? mats.amberOn : mats.amber;
      head.material = s.head ? mats.headOn : mats.headOff;
      tail.material = s.brake ? mats.tailBrake : s.head ? mats.tailRun : mats.tailOff;
      farHead.material = head.material as THREE.MeshPhysicalMaterial;
      farTail.material = tail.material as THREE.MeshPhysicalMaterial;
      rev.material = s.reverse ? mats.revOn : mats.revOff;
      if (red && blue) {
        if (s.siren) {
          const st = strobe(s.t + phase);
          red.material = st.red ? mats.redOn : mats.redOff;
          blue.material = st.blue ? mats.blueOn : mats.blueOff;
          // Wig-wag: headlights alternate with the bar.
          if (!s.head || st.wig) head.material = st.wig ? mats.headOn : mats.headOff;
        } else { red.material = mats.redOff; blue.material = mats.blueOff; }
      }
    },
    setPaint(c: string) {
      const p = paintFor(model, c);
      (bodyMesh.material as THREE.Material[])[0] = p;
      (farBody.material as THREE.Material[])[0] = p;
      paintParts.material = p;
    },
  };
}

/**
 * Police light-bar pattern (0.9 s cycle): red side quad-flashes, then blue side quad-flashes, with a
 * short all-on burst; the headlights wig-wag on the half-beat. Shared by the lamp materials and the
 * real strobe lights cast on surroundings (manager).
 */
export function strobe(t: number) {
  const c = ((t % 0.9) + 0.9) % 0.9;
  const half = c < 0.45;
  const k = (c % 0.45) / 0.45; // 0..1 within a side
  const pulse = Math.floor(k * 8) % 2 === 0 && k < 0.78; // 4 quick flashes
  const burst = c > 0.84;
  return { red: (half && pulse) || burst, blue: (!half && pulse) || burst, wig: Math.floor(c / 0.225) % 2 === 1 };
}

const cabinCache = new Map<string, THREE.BufferGeometry>();
function cabinWithDriver(model: CarModel, variant: number) {
  const key = `${model.id}:${variant}`;
  let g = cabinCache.get(key);
  if (!g) { g = mergeGeometries([model.interior, model.drivers[variant]], false)!; cabinCache.set(key, g); }
  return g;
}

let _beam: THREE.BufferGeometry | null = null;
function beamGeo() {
  if (_beam) return _beam;
  const g = new THREE.PlaneGeometry(7, 16);
  g.rotateX(-Math.PI / 2); // lies flat; canvas top (v=1) now at −Z (ahead)
  g.translate(0, 0, -8);
  _beam = g;
  return g;
}
