// DEV ONLY harness for the gameplay module: open /src/game/dev/gamedev.html
// Params:
//   ?show=cars          showroom of all procedural car models (orbit camera)
//   ?world=synthetic|<recipe>  build the real world module (else a flat test ground)
//   ?night=1  ?t=hours  ?drive=<model>  (start inside a car)  ?traffic=n (kinematic AI cars on a loop)
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Game } from '../../core/game';
import type { Recipe, RecipeProp } from '../../core/types';
import { CAR_MODEL_IDS, getCarModel } from '../vehicles/carModels';
import { createVehicleVisual } from '../vehicles/visual';
import { CAR_COLORS } from '../vehicles/materials';

const q = new URLSearchParams(location.search);
const hud = document.getElementById('hud')!;

function flatRecipe(): Recipe {
  const props: RecipeProp[] = [];
  for (let i = 0; i < 14; i++) props.push({ type: 'parked-car', p: [-6 + (i % 2) * 12, -20 - Math.floor(i / 2) * 6.5], y: 0, rot: (i % 2) ? Math.PI : 0, variant: i });
  for (let i = 0; i < 40; i++) props.push({ type: 'parked-car', p: [40 + (i % 8) * 3, 30 + Math.floor(i / 8) * 7], y: 0, rot: Math.PI / 2 * 0, variant: i * 7 });
  return {
    version: 1, name: 'flat', origin: { lat: 40, lon: -105 }, bounds: { minX: -500, minZ: -500, maxX: 500, maxZ: 500 },
    region: 'mountain-west', climate: 'arid', tier: 'B',
    terrain: { cols: 2, rows: 2, originX: -500, originZ: -500, cellSize: 1000, heights: [0, 0, 0, 0] },
    roads: [], graph: { nodes: [], edges: [] }, buildings: [], areas: [], trees: [], props, cameras: [],
    spawn: { p: [0, 0], y: 0, heading: 0 }, attribution: [],
  };
}

async function main() {
  await RAPIER.init();
  const worldParam = q.get('world');
  let recipe: Recipe;
  if (worldParam && worldParam !== 'synthetic') {
    recipe = await (await fetch(`${import.meta.env.BASE_URL}recipes/${worldParam}.json`)).json();
  } else if (worldParam === 'synthetic') {
    const { syntheticRecipe } = await import('../../world/dev/synthetic');
    recipe = syntheticRecipe();
  } else recipe = flatRecipe();
  const container = document.getElementById('app')!;
  const g = new Game(recipe, container);
  (window as any).game = g;
  g.rapier = RAPIER;
  g.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  g.renderer = renderer;
  g.camera.far = 20000;
  g.camera.updateProjectionMatrix();

  const hours = Number(q.get('t') ?? 15);
  const night = Number(q.get('night') ?? (hours < 6 || hours > 20 ? 1 : 0));
  const sunEl = night > 0.5 ? -0.3 : Math.max(0.05, Math.sin(((hours - 6) / 12) * Math.PI));
  const sunDir = new THREE.Vector3(Math.cos(sunEl) * 0.6, Math.sin(sunEl), Math.cos(sunEl) * 0.8).normalize();
  const sky = new Sky();
  sky.scale.setScalar(15000);
  const su = sky.material.uniforms;
  su.turbidity.value = 3; su.rayleigh.value = 1.2; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.8;
  su.sunPosition.value.copy(sunDir);
  g.scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const sky2 = new Sky(); sky2.scale.setScalar(1000); sky2.material.uniforms.sunPosition.value.copy(sunDir);
  envScene.add(sky2);
  // a ground-ish lower hemisphere so reflections have a horizon
  const gnd = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4a4540, side: THREE.BackSide }));
  envScene.add(gnd);
  g.scene.environment = pmrem.fromScene(envScene as any, 0.02).texture;
  g.scene.environmentIntensity = night > 0.5 ? 0.06 : Number(q.get('env') ?? 0.55);
  renderer.toneMappingExposure = Number(q.get('exp') ?? 0.85);
  if (night > 0.5) { g.scene.background = new THREE.Color('#05070d'); sky.visible = false; }
  g.scene.fog = new THREE.FogExp2(night > 0.5 ? 0x05070d : 0xb8c8d8, night > 0.5 ? 0.0015 : 0.0003);
  const sun = new THREE.DirectionalLight(0xfff1dd, night > 0.5 ? 0.04 : 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.03;
  g.scene.add(sun, sun.target);
  g.scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x6b5a45, night > 0.5 ? 0.03 : 0.35));
  (g as any).sky = { time: hours, timeScale: 0, sunDirection: sunDir, nightFactor: night, sun };
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); g.camera.aspect = innerWidth / innerHeight; g.camera.updateProjectionMatrix(); });

  if (worldParam) {
    const { buildWorld } = await import('../../world');
    await buildWorld(g, (s, f) => { hud.textContent = `${s} ${(f * 100).toFixed(0)}%`; });
    g.world?.setNightFactor?.(night);
  }

  if (q.get('show') === 'cars') return showroom(g, sun);

  const { setupGameplay } = await import('../index');
  await setupGameplay(g);
  const trafficN = Number(q.get('traffic') ?? 0);
  if (trafficN > 0) {
    const cars = [] as any[];
    for (let i = 0; i < trafficN; i++) cars.push(g.vehicles.spawn({ kind: i % 4 === 3 ? 'police' : 'civilian', p: [0, 0], heading: 0, physics: false }));
    g.addSystem({
      name: 'devtraffic', update(dt) {
        cars.forEach((v, i) => {
          if ((v as any).physicsMode === 'dynamic') return;
          const R = 45, a = g.elapsed * 0.25 + (i / cars.length) * Math.PI * 2;
          v.position.set(Math.cos(a) * R + 60, 0, Math.sin(a) * R - 60);
          v.heading = Math.atan2(-Math.sin(a), -Math.cos(a)) ; // tangent (ccw)
          v.heading = Math.atan2(-Math.sin(a) * 1, Math.cos(a) * -1);
          const dx = -Math.sin(a), dz = Math.cos(a);
          v.heading = Math.atan2(dx, -dz);
          v.speed = R * 0.25;
          v.siren = v.kind === 'police';
        });
      },
    });
  }
  const drive = q.get('drive');
  if (drive) {
    const v = g.vehicles.spawn({ kind: 'civilian', p: [3, 4], heading: 0, model: drive, physics: true });
    (g as any).__enter?.(v.id);
  }
  // Sun follows the player
  g.addSystem({
    name: 'devsun', order: 100, lateUpdate() {
      const p = g.player?.position ?? new THREE.Vector3();
      sun.position.copy(p).addScaledVector(sunDir, 150);
      sun.target.position.copy(p);
    },
  });
  let frames = 0, acc = 0;
  g.addSystem({
    name: 'devhud', order: 200, update(dt) {
      frames++; acc += dt;
      if (acc > 0.5) {
        const info = renderer.info.render;
        const p = g.player.position;
        const vid = g.player.vehicleId;
        const v = vid ? g.vehicles.get(vid) : null;
        hud.textContent = `fps ${(frames / acc).toFixed(0)} calls ${info.calls} tris ${(info.triangles / 1000).toFixed(0)}k\n` +
          `player ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} h ${g.player.heading.toFixed(2)} ${vid ?? 'on foot'}\n` +
          (v ? `speed ${(v.speed * 3.6).toFixed(0)} km/h` : '');
        frames = 0; acc = 0;
      }
    },
  });
  g.start();
}

function showroom(g: Game, sun: THREE.DirectionalLight) {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x55565a, roughness: 0.85 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  g.scene.add(ground);
  const only = q.get('model');
  const ids = only ? [only as any] : CAR_MODEL_IDS;
  let info = '';
  ids.forEach((id, i) => {
    const m = getCarModel(id);
    const vis = createVehicleVisual(m, CAR_COLORS[(i * 5) % CAR_COLORS.length], i);
    const col = i % 5, row = Math.floor(i / 5);
    if (ids.length > 1) vis.root.position.set((col - 2) * 3.2, 0, row * 7);
    vis.root.rotation.y = Number(q.get('rot') ?? 0.6);
    g.scene.add(vis.root);
    if (q.has('lights')) { vis.setLights({ head: true, brake: true, reverse: false, siren: true, t: 0.3 }); }
    info += `${id}: ${Math.round(m.tris)} tris\n`;
  });
  hud.textContent = info;
  const cam = g.camera;
  const cp = (q.get('cam') ?? '').split(',').map(Number);
  const controls = new OrbitControls(cam, g.renderer.domElement);
  if (cp.length === 6 && cp.every((v) => !isNaN(v))) { cam.position.set(cp[0], cp[1], cp[2]); controls.target.set(cp[3], cp[4], cp[5]); }
  else { cam.position.set(9, 4, -9); controls.target.set(0, 0.6, 3); }
  controls.update();
  sun.position.set(30, 60, 20); sun.target.position.set(0, 0, 0);
  g.addSystem({ name: 'orbit', update() { controls.update(); } });
  g.start();
}

main().catch((e) => { console.error(e); hud.textContent = String(e.stack ?? e); });
