// Per-vehicle scene graph built from a shared CarModel (geometries + materials are shared).
import * as THREE from 'three';
import type { CarModel } from './carModels';
import { mats, paintMaterial, beamMaterial, PLATE_CELLS } from './materials';
import { nearGeometry, createBodyMaterial, createLampMaterial, setBodyPaint, LAMP } from './unified';

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
  /** Release the per-car materials. */
  dispose(): void;
  readonly far: boolean;
  setFar(f: boolean): void;
}

export function paintFor(model: CarModel, color: string) {
  const c = model.livery === 'plain' ? color : '#ffffff';
  return paintMaterial(c, model.paintMap, model.id);
}

/**
 * Near visual = 4 draws (see unified.ts): body (opaque + glass groups), misc opaque parts (cabin,
 * trim, chrome, grille, plate, drivers), lamps. Wheels are drawn by the manager's WheelBatch.
 */
export function createVehicleVisual(model: CarModel, color: string, seed: number): VehicleVisual {
  const root = new THREE.Group();
  root.name = `vehicle-${model.id}`;
  const chassis = new THREE.Group();
  root.add(chassis);
  const near = nearGeometry(model);
  const variant = seed % Math.min(3, model.drivers.length);
  const bodyMat = createBodyMaterial(model, model.livery === 'plain' ? color : '#ffffff', seed % PLATE_CELLS, variant);
  const lampMat = createLampMaterial(model);
  const bodyMesh = new THREE.Mesh(near.body, [bodyMat, mats.glass]);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  const misc = new THREE.Mesh(near.misc, bodyMat);
  misc.receiveShadow = true;
  const lamps = new THREE.Mesh(near.lamps, lampMat);
  chassis.add(bodyMesh, misc, lamps);
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
  const paint = paintFor(model, color);
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
  const I = lampMat.lampI, On = lampMat.lampOn;
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
    setDriver(on: boolean) { bodyMat.carUniforms.uDriver.value = on ? variant + 1 : 0; },
    setLights(s) {
      beam.visible = !!s.beam && s.head && !isFar;
      const blink = ((s.t + phase) % 0.7) < 0.36;
      const sg = s.signal ?? 0;
      const l = (sg === -1 || sg === 2) && blink, r = (sg === 1 || sg === 2) && blink;
      On[LAMP.sigL] = +l; I[LAMP.sigL] = l ? mats.amberOn.emissiveIntensity : 0;
      On[LAMP.sigR] = +r; I[LAMP.sigR] = r ? mats.amberOn.emissiveIntensity : 0;
      let head = s.head;
      I[LAMP.tail] = s.brake ? mats.tailBrake.emissiveIntensity : s.head ? mats.tailRun.emissiveIntensity : 0;
      On[LAMP.rev] = +s.reverse; I[LAMP.rev] = s.reverse ? mats.revOn.emissiveIntensity : 0;
      if (model.lightbar) {
        if (s.siren) {
          const st = strobe(s.t + phase);
          On[LAMP.red] = +st.red; I[LAMP.red] = st.red ? mats.redOn.emissiveIntensity : mats.redOff.emissiveIntensity;
          On[LAMP.blue] = +st.blue; I[LAMP.blue] = st.blue ? mats.blueOn.emissiveIntensity : mats.blueOff.emissiveIntensity;
          // Wig-wag: headlights alternate with the bar.
          if (!s.head || st.wig) head = st.wig;
        } else {
          On[LAMP.red] = On[LAMP.blue] = 0;
          I[LAMP.red] = mats.redOff.emissiveIntensity; I[LAMP.blue] = mats.blueOff.emissiveIntensity;
        }
      }
      I[LAMP.head] = head ? mats.headOn.emissiveIntensity : 0;
      if (model.destSign) I[LAMP.sign] = mats.amberOn.emissiveIntensity * 0.3;
      farHead.material = head ? mats.headOn : mats.headOff;
      farTail.material = s.brake ? mats.tailBrake : s.head ? mats.tailRun : mats.tailOff;
    },
    setPaint(c: string) {
      const col = model.livery === 'plain' ? c : '#ffffff';
      setBodyPaint(bodyMat, col);
      (farBody.material as THREE.Material[])[0] = paintFor(model, c);
    },
    dispose() { bodyMat.dispose(); lampMat.dispose(); },
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

let _beam: THREE.BufferGeometry | null = null;
function beamGeo() {
  if (_beam) return _beam;
  const g = new THREE.PlaneGeometry(7, 16);
  g.rotateX(-Math.PI / 2); // lies flat; canvas top (v=1) now at −Z (ahead)
  g.translate(0, 0, -8);
  _beam = g;
  return g;
}
