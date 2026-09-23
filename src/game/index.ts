// OWNER: gameplay agent. Player character, camera controller, vehicles (VehiclesAPI), enter/exit/carjack.
import * as THREE from 'three';
import type { Game } from '../core/game';
import { VehicleSystem } from './vehicles/manager';
import { Player } from './player';
import { CameraRig } from './camera';
import { Character } from './character';

export { VehicleSystem } from './vehicles/manager';
export type { Vehicle } from './vehicles/vehicle';
export { CAR_MODEL_IDS } from './vehicles/carModels';

export async function setupGameplay(g: Game): Promise<void> {
  const charLoad = Character.preload();
  if (!g.world) createFallbackGround(g);
  const vehicles = new VehicleSystem(g);
  g.vehicles = vehicles;
  const player = new Player(g, vehicles);
  g.player = player;
  await charLoad;
  await player.init();
  const cam = new CameraRig(g, player, vehicles);
  player.camera = cam;
  g.addSystem(player);
  g.addSystem(vehicles);
  g.addSystem(cam);
  // Debug hooks (dev harness / console).
  (g as any).__gameplay = { player, vehicles, cam };
  (g as any).__enter = (id: string) => {
    const v = vehicles.vehicles.get(id);
    if (!v) return;
    const door = v.model.driverDoor.clone().applyMatrix4(v.object.matrixWorld);
    player.respawn([door.x, door.z], v.heading);
    (player as any).seat(v, { veh: v, t: 0, phase: 'door', stolen: true, carjack: false });
  };
}

/** Dev-only: flat ground + a few obstacles when the world module hasn't been built. */
function createFallbackGround(g: Game) {
  const R = g.rapier;
  const body = g.physics.createRigidBody(R.RigidBodyDesc.fixed());
  // Tiled ground (one huge cuboid makes the character controller sink due to precision issues).
  for (let i = -12; i < 12; i++) for (let j = -12; j < 12; j++) {
    g.physics.createCollider(R.ColliderDesc.cuboid(25, 0.5, 25).setTranslation(i * 50 + 25, -0.5, j * 50 + 25).setFriction(1), body);
  }
  const grp = new THREE.Group();
  grp.name = 'gameplay-fallback-ground';
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const x = cv.getContext('2d')!;
  x.fillStyle = '#4a4b4e'; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4000; i++) { x.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},0.05)`; x.fillRect(Math.random() * 256, Math.random() * 256, 2, 2); }
  x.strokeStyle = '#d8d2b0'; x.lineWidth = 3; x.beginPath(); x.moveTo(128, 0); x.lineTo(128, 256); x.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(120, 120);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;
  grp.add(plane);
  const mat = new THREE.MeshStandardMaterial({ color: 0xb59a84, roughness: 0.85 });
  const boxes: [number, number, number, number, number, number][] = [
    [-30, 6, -40, 12, 12, 16], [25, 4, -50, 14, 8, 10], [-20, 3, 20, 8, 6, 30], [30, 8, 10, 10, 16, 10],
  ];
  for (const [bx, by, bz, sx, sy, sz] of boxes) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(bx, by, bz);
    m.castShadow = m.receiveShadow = true;
    grp.add(m);
    g.physics.createCollider(R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setTranslation(bx, by, bz), body);
  }
  // Ramp + curbs
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 12), mat);
  ramp.position.set(0, 1.0, -70);
  ramp.rotation.x = 0.28;
  ramp.castShadow = ramp.receiveShadow = true;
  grp.add(ramp);
  const q = new THREE.Quaternion().setFromEuler(ramp.rotation);
  g.physics.createCollider(R.ColliderDesc.cuboid(3, 0.2, 6).setTranslation(0, 1.0, -70).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }), body);
  for (let i = 0; i < 6; i++) {
    const h = 0.15 * (i + 1);
    const step = new THREE.Mesh(new THREE.BoxGeometry(3, h, 0.4), mat);
    step.position.set(-10, h / 2, 5 + i * 0.4);
    step.receiveShadow = true;
    grp.add(step);
    g.physics.createCollider(R.ColliderDesc.cuboid(1.5, h / 2, 0.2).setTranslation(-10, h / 2, 5 + i * 0.4), body);
  }
  g.scene.add(grp);
}
