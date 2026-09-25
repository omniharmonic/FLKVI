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
  markDamage(local: THREE.Vector3, severity: number): void;
  /** Bounded spring motion of loose bodywork after an impact. */
  updateImpact(dt: number): void;
  headlightIntegrity(side: number): number;
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
  const lampMat = createLampMaterial(model, bodyMat.carUniforms.uDamage);
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
  let damageIndex = 0;
  let damagedGlass: THREE.MeshPhysicalMaterial | null = null;
  const glassDamage = {value:0};
  const glassImpact = {value:new THREE.Vector2()};
  const phase = (seed % 7) * 0.13;
  const recoil = new THREE.Vector3(), recoilVelocity = new THREE.Vector3();
  const headlightIntegrity = (side: number) => {
    const p = model.headlightPos[side];
    let damage = 0;
    for (const d of bodyMat.carUniforms.uDamage.value) {
      const distance = Math.hypot(p.x - d.x, p.y - d.y, p.z - d.z);
      damage = Math.max(damage, d.w * Math.max(0, 1 - distance / 1.15));
    }
    return 1 - THREE.MathUtils.smoothstep(damage, 0.3, 0.85);
  };
  const I = lampMat.lampI, On = lampMat.lampOn;
  return {
    root, chassis, bodyMesh, wheels,
    get far() { return isFar; },
    headlightIntegrity,
    updateImpact(dt) {
      if (dt <= 0 || recoil.lengthSq() + recoilVelocity.lengthSq() < 1e-8) return;
      // Substep the visual spring at low frame rates; it must never destabilize physics.
      const steps = Math.max(1, Math.ceil(Math.min(dt, 0.1) / 0.016));
      const h = Math.min(dt, 0.1) / steps;
      for (let i = 0; i < steps; i++) {
        recoilVelocity.addScaledVector(recoil, -110 * h).multiplyScalar(Math.exp(-16 * h));
        recoil.addScaledVector(recoilVelocity, h).clampLength(0, 0.07);
      }
      if (recoil.lengthSq() + recoilVelocity.lengthSq() < 1e-8) recoil.set(0, 0, 0);
      chassis.position.copy(recoil);
    },
    markDamage(p, severity) {
      bodyMat.carUniforms.uDamage.value[damageIndex++ % 4].set(p.x,p.y,p.z,Math.min(1,severity*4));
      const direction = new THREE.Vector3(p.x, 0, p.z).normalize();
      recoilVelocity.addScaledVector(direction, -severity * 3.2).clampLength(0, 1.1);
      // Bumpers, grille and lamps must follow the crushed body instead of staying
      // pristine and floating in front of it. Clone only the struck vehicle.
      for (const mesh of [misc, lamps, farBody]) {
        if (!mesh.userData.dentable) { mesh.geometry = mesh.geometry.clone(); mesh.userData.dentable = true; }
        deformTrim(mesh.geometry, p, direction, severity, mesh === misc);
      }
      if(severity<.12)return;
      glassDamage.value=Math.min(1,glassDamage.value+severity*1.3);
      glassImpact.value.set(p.x*2+p.z,1.8);
      if(!damagedGlass){
        damagedGlass=mats.glass.clone();
        const baseCompile=mats.glass.onBeforeCompile;
        damagedGlass.onBeforeCompile=(sh,renderer)=>{
          baseCompile.call(damagedGlass!,sh,renderer);
          sh.uniforms.uGlassDamage=glassDamage;sh.uniforms.uGlassImpact=glassImpact;
          sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 vCrack;')
            .replace('#include <begin_vertex>','#include <begin_vertex>\nvCrack=vec2(position.x*2.0+position.z,position.y*2.0);');
          sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 vCrack;uniform float uGlassDamage;uniform vec2 uGlassImpact;')
            .replace('#include <color_fragment>',`#include <color_fragment>
              vec2 cp=vCrack-uGlassImpact;float cr=length(cp);float ca=atan(cp.y,cp.x);
              float rays=1.0-smoothstep(.015,.05,abs(sin(ca*11.0+sin(cr*19.0)*.24)));
              float rings=1.0-smoothstep(.016,.055,abs(sin(cr*20.0+sin(ca*7.0)*.7)));
              float crack=max(rays,rings*.65)*(1.0-smoothstep(.4,uGlassDamage*4.0+.6,cr))*uGlassDamage;
              diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.55,.66,.68),crack*.85);
              diffuseColor.a=max(diffuseColor.a,crack*.8);`);
        };
        damagedGlass.customProgramCacheKey=()=> 'flk-cracked-auto-glass-v1';
        (bodyMesh.material as THREE.Material[])[1]=damagedGlass;
      }
      damagedGlass.roughness=.03+glassDamage.value*.25;
    },
    setFar(f: boolean) {
      if (f === isFar) return;
      isFar = f;
      far.visible = f;
      chassis.visible = !f;
      for (const w of wheels) w.visible = !f;
    },
    setDriver(on: boolean) { bodyMat.carUniforms.uDriver.value = on ? variant + 1 : 0; },
    setLights(s) {
      beam.visible = !!s.beam && s.head && !isFar && headlightIntegrity(0) + headlightIntegrity(1) > 0.1;
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
    dispose() {
      for (const mesh of [bodyMesh, misc, lamps, farBody]) if (mesh.userData.dentable) mesh.geometry.dispose();
      bodyMat.dispose(); lampMat.dispose(); damagedGlass?.dispose();
    },
  };
}

function deformTrim(geometry: THREE.BufferGeometry, contact: THREE.Vector3, direction: THREE.Vector3, depth: number, keepInterior: boolean) {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const tex = geometry.getAttribute('aTex');
  const radius = 0.9 + depth * 2;
  for (let i = 0; i < pos.count; i++) {
    // Interior upholstery and seated occupants are not part of the external crumple zone.
    if (keepInterior && tex && (tex.getX(i) > 4.5 || tex.getX(i) > 2.5 && tex.getX(i) < 3.5)) continue;
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const d = Math.hypot(x - contact.x, (y - contact.y) * 0.8, z - contact.z);
    if (d >= radius) continue;
    const amount = (1 - d / radius) ** 2 * depth;
    pos.setXYZ(i, x - direction.x * amount, y - amount * 0.15, z - direction.z * amount);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
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
