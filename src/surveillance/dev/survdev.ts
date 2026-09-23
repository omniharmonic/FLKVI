// Surveillance dev harness: /src/surveillance/dev/survdev.html?survdev
// A flat street with every camera model/variant, real render pipeline (sky, bloom, AO), Rapier physics,
// a stand-in player (WASD, relative to the view), and debug hooks on window.survdev for screenshots.
// Params: hour=<0-24> · view=<camId> · cones=1 · player=x,z
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Game } from '../../core/game';
import { hashString } from '../../core/geo';
import type { RecipeCamera, Vec2 } from '../../core/types';
import { setupRendering, setRain } from '../../render';
import { preloadLibrary } from '../../assets/library';
import { setupSurveillance, startNewRun, type Surveillance } from '../index';

const Q = new URLSearchParams(location.search);

function idFor(prefix: string, variant: number, mod: number) {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}${i}`; if (hashString(id) % mod === variant) return id; }
  return prefix;
}

function canvasTex(size: number, draw: (c: CanvasRenderingContext2D) => void, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}
function noiseFill(c: CanvasRenderingContext2D, s: number, base: number[], amp: number) {
  const img = c.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const n = (Math.random() - 0.5) * amp + (Math.random() < 0.01 ? -30 : 0);
    img.data[i * 4] = base[0] + n; img.data[i * 4 + 1] = base[1] + n; img.data[i * 4 + 2] = base[2] + n; img.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}

async function main() {
  await RAPIER.init();
  const cams: RecipeCamera[] = [];
  const mk = (id: string, type: RecipeCamera['type'], x: number, z: number, h: number, extra: Partial<RecipeCamera> = {}) =>
    cams.push({ id, type, p: [x, z], y: 0, heading: 0, poleHeight: h, cuttable: type !== 'cluster', fovDeg: 40, rangeM: 55, plateReader: type === 'pole', mapped: true, ...extra });
  mk(idFor('pole-a', 0, 3), 'pole', -24, 0, 4.6);
  mk(idFor('pole-b', 1, 3), 'pole', -16, 0, 4.4);
  mk(idFor('pole-c', 2, 3), 'pole', -8, 0, 5.0);
  mk(idFor('ptz-a', 0, 3), 'ptz', 0, 0, 6.5, { fovDeg: 70, rangeM: 45, sweep: { amplitudeDeg: 60, periodS: 10 } });
  mk(idFor('ptz-b', 1, 3), 'ptz', 8, 0, 7, { fovDeg: 70, rangeM: 45, sweep: { amplitudeDeg: 45, periodS: 12 } });
  mk('cluster-a', 'cluster', 18, 0, 6.8, { fovDeg: 60, rangeM: 40, cuttable: false });
  mk('tower-a', 'tower', 34, 6, 8.0, { fovDeg: 360, rangeM: 60 });
  mk('pole-watch', 'pole', -16, -30, 4.6, { heading: Math.PI, mapped: false }); // looks back south at the row (coverage)

  const recipe: any = {
    version: 1, name: 'survdev', origin: { lat: 40.0176, lon: -105.2797 },
    bounds: { minX: -300, minZ: -300, maxX: 300, maxZ: 300 }, region: 'mountain-west', climate: 'arid', tier: 'A',
    terrain: { cols: 2, rows: 2, originX: -300, originZ: -300, cellSize: 600, heights: [0, 0, 0, 0] },
    spawn: { p: [-20, 6], y: 0, heading: 0 },
    roads: [{ id: 'r1', cls: 'secondary', pts: [[-200, -8], [200, -8]], ys: [0, 0], width: 11, lanes: 2, oneway: false, sidewalk: 3, maxSpeed: 13, surface: 'asphalt', nodes: [1, 2], name: 'Pearl Street' }],
    graph: { nodes: [
      { id: 0, p: [-200, -8], y: 0 }, { id: 1, p: [0, -8], y: 0, signal: true }, { id: 2, p: [200, -8], y: 0 }, { id: 3, p: [0, -200], y: 0 }, { id: 4, p: [0, 200], y: 0 },
      { id: 5, p: [-190, -180], y: 0, signal: true }, { id: 6, p: [190, -180], y: 0, signal: true },
    ], edges: [
      { from: 0, to: 1, roadId: 'r1', length: 200, lanes: 2, speed: 13, cls: 'secondary' }, { from: 1, to: 2, roadId: 'r1', length: 200, lanes: 2, speed: 13, cls: 'secondary' },
      { from: 1, to: 3, roadId: 'r1', length: 192, lanes: 2, speed: 13, cls: 'secondary' }, { from: 1, to: 4, roadId: 'r1', length: 208, lanes: 2, speed: 13, cls: 'secondary' },
      { from: 5, to: 0, roadId: 'r1', length: 200, lanes: 2, speed: 13, cls: 'secondary' }, { from: 6, to: 2, roadId: 'r1', length: 200, lanes: 2, speed: 13, cls: 'secondary' },
    ] },
    buildings: [], areas: [], trees: [], props: [], cameras: cams, attribution: [],
  };
  const container = document.getElementById('app')!;
  const g = new Game(recipe, container);
  (window as any).game = g;
  g.rapier = RAPIER;
  g.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  g.physics.createCollider(RAPIER.ColliderDesc.cuboid(300, 0.5, 300).setTranslation(0, -0.5, 0));
  g.camera.near = 0.05;
  g.camera.far = 3000;
  await setupRendering(g, { dev: true });
  if (g.sky) { g.sky.time = Number(Q.get('hour') ?? 15.5); g.sky.timeScale = 0; }
  setRain(g, Q.has('rain'));

  // ground: asphalt road + concrete sidewalk + dirt verge
  const asphalt = canvasTex(512, (c) => noiseFill(c, 512, [58, 58, 60], 26));
  asphalt.repeat.set(100, 3);
  const aRough = canvasTex(256, (c) => noiseFill(c, 256, [225, 225, 225], 50), false);
  aRough.repeat.set(200, 6);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(400, 11).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: asphalt, roughnessMap: aRough, roughness: 1 }));
  road.position.set(0, 0.0, -8);
  road.receiveShadow = true;
  const line = new THREE.Mesh(new THREE.PlaneGeometry(400, 0.12).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#d9b43a', roughness: 0.7 }));
  line.position.set(0, 0.005, -8);
  const walkTex = canvasTex(256, (c) => { noiseFill(c, 256, [170, 168, 160], 18); c.strokeStyle = 'rgba(60,60,60,.5)'; c.lineWidth = 2; c.strokeRect(0, 0, 256, 256); });
  walkTex.repeat.set(200, 2);
  const walk = new THREE.Mesh(new THREE.BoxGeometry(400, 0.15, 4).translate(0, 0.075 - 0.15 + 0.0, 0), new THREE.MeshStandardMaterial({ map: walkTex, roughness: 0.9 }));
  walk.position.set(0, 0.0, -0.5);
  walk.receiveShadow = true;
  const dirtTex = canvasTex(256, (c) => noiseFill(c, 256, [96, 104, 70], 40));
  dirtTex.repeat.set(120, 120);
  const verge = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: dirtTex, roughness: 1 }));
  verge.position.y = -0.01;
  verge.receiveShadow = true;
  g.scene.add(road, line, walk, verge);
  // a few boxes as buildings for context / LOS
  const bm = new THREE.MeshStandardMaterial({ color: '#8b6f5a', roughness: 0.85 });
  const boxes: THREE.Mesh[] = [];
  for (const [x, z, w, d, h] of [[-40, 25, 18, 14, 9], [0, 28, 22, 16, 12], [40, 30, 16, 14, 7], [-10, -40, 26, 16, 15]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bm);
    b.position.set(x, h / 2, z);
    b.castShadow = b.receiveShadow = true;
    g.scene.add(b);
    boxes.push(b);
  }
  g.scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  g.world = {
    heightAt: () => 0, groundAt: () => 0,
    losBlocked: (a, b) => {
      const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
      const d = B.clone().sub(A); const L = d.length();
      ray.set(A, d.normalize()); ray.far = L - 0.05;
      return ray.intersectObjects(boxes, false).length > 0;
    },
    nearestNode: () => 1, route: () => [],
    randomSidewalkPoint: (near: Vec2, r: number, rnd = Math.random) => [near[0] + (rnd() - 0.5) * r, 2],
    staticMeshes: boxes, setNightFactor: () => {},
  };

  // stand-in player
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.1, 4, 12), new THREE.MeshStandardMaterial({ color: '#39424d', roughness: 0.8 }));
  body.castShadow = true;
  g.scene.add(body);
  const [px, pz] = (Q.get('player') ?? '-20,6').split(',').map(Number);
  const player = {
    position: new THREE.Vector3(px, 0, pz), velocity: new THREE.Vector3(), heading: 0, vehicleId: null as string | null,
    suspicious: false, plateFlagged: false, health: 100, controlsEnabled: true, busy: false,
    respawn(p: Vec2, h = 0) { this.position.set(p[0], 0, p[1]); this.heading = h; },
    face(h: number) { this.heading = h; },
  };
  g.player = player as any;
  g.audio = { play: () => null, listener: null };

  try { await preloadLibrary(); } catch (e) { console.warn(e); }
  await setupSurveillance(g);
  const s = g.surveillance as unknown as Surveillance;
  if (Q.has('cones')) s.vision.forceAll = true;

  const controls = new OrbitControls(g.camera, g.renderer.domElement);
  controls.target.set(-8, 3, 0);
  g.camera.position.set(-2, 5, -14);
  controls.update();

  // HUD
  const hud = document.getElementById('hud')!, toast = document.getElementById('toast')!, prompt = document.getElementById('prompt')!;
  const bar = document.querySelector('#bar>div') as HTMLDivElement;
  let toastT = 0;
  g.events.on('toast', (e) => { toast.textContent = e.text; toastT = (e.ms ?? 2500) / 1000; });
  g.events.on('prompt', (e) => { prompt.style.display = e.text ? '' : 'none'; prompt.textContent = e.text ?? ''; });
  const log: string[] = [];
  for (const k of ['takedown', 'witness', 'tamperAlert', 'plateHit', 'noise', 'score', 'banked', 'cameraDiscovered', 'cameraInstalled', 'escalation', 'runEnd', 'runStart', 'takedownCancel'] as const) {
    g.events.on(k, (e: any) => { log.push(`${k} ${JSON.stringify(e).slice(0, 90)}`); if (log.length > 8) log.shift(); });
  }
  (window as any).survlog = log;
  g.addSystem({
    name: 'survdev', order: -10,
    update: (dt) => {
      // WASD relative to view
      const fwd = new THREE.Vector3(); g.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const mv = new THREE.Vector3();
      if (!player.busy) {
        if (g.input.isDown('KeyW')) mv.add(fwd);
        if (g.input.isDown('KeyS')) mv.sub(fwd);
        if (g.input.isDown('KeyD')) mv.add(right);
        if (g.input.isDown('KeyA')) mv.sub(right);
      }
      if (mv.lengthSq()) { mv.normalize().multiplyScalar(4 * dt); player.position.add(mv); player.heading = Math.atan2(mv.x, -mv.z); }
      body.position.copy(player.position).add(new THREE.Vector3(0, 0.83, 0));
      body.rotation.y = -player.heading;
      toastT -= dt; if (toastT <= 0) toast.textContent = '';
      bar.style.width = `${(s.action?.t ?? 0) * 100}%`;
      bar.style.background = s.action?.seen ? '#ff3b30' : '#ffb020';
      hud.textContent = `streak ${s.streak}  score ${s.score}  hot ${s.hot}  banked ${s.banked}  x${s.multiplier.toFixed(1)}  grinder ${s.grinderCharges}/${s.grinderMax}\n` +
        `time ${g.sky?.time?.toFixed(1)}  night ${g.sky?.nightFactor?.toFixed(2)}  target ${s.selectedTarget ?? '-'} ${s.targetDistance?.toFixed(0) ?? ''}\n` +
        s.cameras().map((c) => `${c.id.padEnd(12)} ${c.type.padEnd(7)} ${c.status.padEnd(9)} cov ${c.coverage} ${c.seesPlayer ? 'SEES' : ''} ${c.discovered ? '' : '(unmapped)'}`).join('\n') +
        '\n' + log.join('\n');
    },
  });

  const camById = (id: string) => s.net.byId.get(id)!;
  const key = (code: string, down: boolean) => dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
  (window as any).survdev = {
    g, s, controls, player,
    ids: cams.map((c) => c.id),
    /** Frame a camera: dist m, azimuth deg (0 = from north/front), elevation deg, focus on 'eye' | 'mid' | 'base' */
    frame(id: string, dist = 2.5, az = 0, el = 10, focus: 'eye' | 'mid' | 'base' = 'eye') {
      const c = camById(id);
      const f = focus === 'eye' ? c.eye.clone() : focus === 'base' ? c.work.clone().setY(0.6) : c.work.clone().setY(c.eye.y * 0.5);
      const h = c.rc.heading + (az * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
      const e = (el * Math.PI) / 180;
      g.camera.position.copy(f).addScaledVector(dir, dist * Math.cos(e)).add(new THREE.Vector3(0, dist * Math.sin(e), 0));
      controls.target.copy(f);
      controls.update();
    },
    hour(h: number) { if (g.sky) g.sky.time = h; },
    hold(code: string, seconds: number) { key(code, true); setTimeout(() => key(code, false), seconds * 1000); },
    key,
    goTo(id: string, off = 1.4) { const c = camById(id); player.position.set(c.work.x, 0, c.work.z + off); },
    install() { return s.installCamera(); },
    drone() { return s.spawnDrone(); },
    newRun() { startNewRun(g); },
    select(id: string | null) { s.selectedTarget = id; },
  };
  const v = Q.get('view');
  if (v) (window as any).survdev.frame(v, Number(Q.get('dist') ?? 2.5), Number(Q.get('az') ?? 20), Number(Q.get('el') ?? 10), (Q.get('focus') as any) ?? 'eye');
  g.start();
  g.events.emit('worldReady', {});
  g.events.emit('runStart', {});
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre style="color:red;position:fixed;top:0;left:0;z-index:99">${e.stack}</pre>`); });
