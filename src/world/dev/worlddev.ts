// DEV ONLY harness for the world module: open /src/world/dev/worlddev.html
// Params: ?recipe=boulder (loads public/recipes/boulder.json, else synthetic) &cam=x,y,z,tx,ty,tz &night=0..1 &t=hours
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Game } from '../../core/game';
import type { Recipe } from '../../core/types';
import { buildWorld } from '../index';
import { syntheticRecipe } from './synthetic';
import { unpackRecipe } from '../../compiler/compile';

const q = new URLSearchParams(location.search);

async function main() {
  await RAPIER.init();
  let recipe: Recipe;
  const rname = q.get('recipe');
  if (rname) {
    const res = await fetch(`${import.meta.env.BASE_URL}recipes/${rname}.json`);
    recipe = unpackRecipe(await res.json());
  } else recipe = syntheticRecipe();
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
  renderer.toneMappingExposure = 0.85;
  container.appendChild(renderer.domElement);
  g.renderer = renderer;
  g.camera.far = 20000;
  g.camera.updateProjectionMatrix();

  const hours = Number(q.get('t') ?? 15);
  const night = Number(q.get('night') ?? (hours < 6 || hours > 20 ? 1 : 0));
  const sunEl = night > 0.5 ? -0.3 : Math.max(0.05, Math.sin(((hours - 6) / 12) * Math.PI) * 1.0);
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
  Object.assign(sky2.material.uniforms.turbidity, { value: 3 });
  envScene.add(sky2);
  const env = pmrem.fromScene(envScene as any, 0.02).texture;
  g.scene.environment = env;
  g.scene.environmentIntensity = night > 0.5 ? 0.05 : 0.55;
  if (night > 0.5) { g.scene.background = new THREE.Color('#05070d'); sky.visible = false; }
  g.scene.fog = new THREE.FogExp2(night > 0.5 ? 0x05070d : 0xb8c8d8, night > 0.5 ? 0.0012 : 0.00022);

  const sun = new THREE.DirectionalLight(0xfff1dd, night > 0.5 ? 0.05 : 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -160; sc.right = 160; sc.top = 160; sc.bottom = -160; sc.near = 1; sc.far = 1200;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
  g.scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x6b5a45, night > 0.5 ? 0.02 : 0.25);
  g.scene.add(hemi);
  (g as any).sky = { time: hours, timeScale: 0, sunDirection: sunDir, nightFactor: night, sun };

  const hud = document.getElementById('hud')!;
  const t0 = performance.now();
  await buildWorld(g, (s, f) => { hud.textContent = `${s} ${(f * 100).toFixed(0)}%`; });
  const buildMs = performance.now() - t0;
  g.world.setNightFactor(night);

  // Dev-only fallback boxes when the buildings module is still a stub.
  const bgroup = g.scene.getObjectByName('buildings');
  if (!bgroup || bgroup.children.length === 0) {
    const geos: THREE.BufferGeometry[] = [];
    for (const b of recipe.buildings) {
      const shape = new THREE.Shape(b.footprint.map((p) => new THREE.Vector2(p[0], -p[1])));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: b.height + 2, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, b.baseY - 2, 0);
      geos.push(geo.toNonIndexed());
    }
    if (geos.length) {
      const { mergeGeometries } = await import('three/examples/jsm/utils/BufferGeometryUtils.js');
      const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: '#b59a84', roughness: 0.85 }));
      m.castShadow = m.receiveShadow = true;
      g.scene.add(m);
    }
  }

  const cam = g.camera;
  const cp = (q.get('cam') ?? '').split(',').map(Number);
  const sp = recipe.spawn;
  if (cp.length === 6 && cp.every((v) => !isNaN(v))) {
    cam.position.set(cp[0], cp[1], cp[2]);
  } else cam.position.set(sp.p[0] + 30, sp.y + 25, sp.p[1] + 50);
  const controls = new OrbitControls(cam, renderer.domElement);
  if (cp.length === 6 && cp.every((v) => !isNaN(v))) controls.target.set(cp[3], cp[4], cp[5]);
  else controls.target.set(sp.p[0], sp.y + 2, sp.p[1]);
  // Relative heights: cam y given as height above ground if ?rel
  if (q.has('rel')) {
    cam.position.y += g.world.groundAt(cam.position.x, cam.position.z);
    controls.target.y += g.world.groundAt(controls.target.x, controls.target.z);
  }
  controls.update();
  const keys = new Set<string>();
  addEventListener('keydown', (e) => keys.add(e.code));
  addEventListener('keyup', (e) => keys.delete(e.code));

  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); });
  let frames = 0, acc = 0;
  g.addSystem({
    name: 'devcam', update(dt) {
      const v = new THREE.Vector3();
      const fwd = new THREE.Vector3().subVectors(controls.target, cam.position).setY(0).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
      if (keys.has('KeyW')) v.add(fwd); if (keys.has('KeyS')) v.sub(fwd);
      if (keys.has('KeyD')) v.add(right); if (keys.has('KeyA')) v.sub(right);
      if (v.lengthSq()) { v.normalize().multiplyScalar(dt * (keys.has('ShiftLeft') ? 80 : 20)); cam.position.add(v); controls.target.add(v); }
      controls.update();
      sun.position.copy(controls.target).addScaledVector(sunDir, 500);
      sun.target.position.copy(controls.target);
      frames++; acc += dt;
      if (acc > 0.5) {
        const info = renderer.info.render;
        hud.textContent = `build ${buildMs.toFixed(0)}ms  fps ${(frames / acc).toFixed(0)}  calls ${info.calls}  tris ${(info.triangles / 1000).toFixed(0)}k  cam ${cam.position.x.toFixed(0)},${cam.position.y.toFixed(0)},${cam.position.z.toFixed(0)}`;
        (window as any).__stats = { calls: info.calls, tris: info.triangles, fps: frames / acc, buildMs };
        frames = 0; acc = 0;
      }
    },
  });
  g.start();
}
main().catch((e) => { console.error(e); document.getElementById('hud')!.textContent = String(e.stack ?? e); });
