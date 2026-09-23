// OWNER: assets agent. Visual test bench for the asset library (open /asset-test.html).
// URL params: ?env=day|golden|sunset|overcast|night  &view=materials|chars|decals  &cam=x,y,z
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TEXTURES, pbrMaterial, loadEnvironment, loadModelWithAnimations, loadModel, setAnisotropy, preloadLibrary, decalMaterial, modelIds, ENVIRONMENTS, textureSetReady } from '../library';

const q = new URLSearchParams(location.search);
const envId = q.get('env') ?? 'day';
const view = q.get('view') ?? 'materials';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = ENVIRONMENTS[envId]?.exposure ?? 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
setAnisotropy(renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
const controls = new OrbitControls(camera, renderer.domElement);

const sun = new THREE.DirectionalLight('#fff4e0', 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, far: 200 });
scene.add(sun, sun.target);
const e = ENVIRONMENTS[envId];
if (e) sun.position.set(e.sunDir[0], e.sunDir[1], e.sunDir[2]).multiplyScalar(60);
if (envId.startsWith('night')) sun.intensity = 0.15;
if (envId === 'overcast') sun.intensity = 0.4;

const status = document.createElement('div');
status.style.cssText = 'position:fixed;left:8px;top:8px;color:#fff;font:12px monospace;background:#0008;padding:4px 8px;white-space:pre';
document.body.appendChild(status);
(window as any).assetTestReady = false;

const mixers: THREE.AnimationMixer[] = [];

function label(text: string, pos: THREE.Vector3) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 40;
  const x = c.getContext('2d')!; x.fillStyle = '#000a'; x.fillRect(0, 0, 256, 40); x.fillStyle = '#fff'; x.font = '22px monospace'; x.fillText(text, 6, 28);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(1.6, 0.25, 1); s.position.copy(pos); scene.add(s);
}

/** Box with world-space meter UVs on every face (like the world builders will generate). */
function meterBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.getAttribute('position'); const nor = g.getAttribute('normal'); const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ny > 0.5) uv.setXY(i, x, z); else if (nx > 0.5) uv.setXY(i, z, y); else uv.setXY(i, x, y);
  }
  return g;
}

async function main() {
  const env = await loadEnvironment(envId);
  if (env) {
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromEquirectangular(env).texture;
    scene.background = env;
  }
  await preloadLibrary((f) => (status.textContent = `loading ${(f * 100) | 0}%`));

  // ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), pbrMaterial('asphalt'));
  (ground.geometry.getAttribute('uv') as THREE.BufferAttribute).array.forEach((_, i, a) => { (a as Float32Array)[i] = (a as Float32Array)[i] * 80; });
  ground.receiveShadow = true;
  scene.add(ground);

  if (view === 'materials') {
    const ids = Object.keys(TEXTURES).filter((k) => !TEXTURES[k].decal);
    const cols = 8;
    await Promise.all(ids.map((id) => textureSetReady(id)));
    ids.forEach((id, i) => {
      const x = (i % cols) * 3 - (cols * 3) / 2, z = Math.floor(i / cols) * 3.5 - 8;
      const m = new THREE.Mesh(meterBox(2, 2, 2), pbrMaterial(id));
      m.position.set(x, 1, z); m.castShadow = m.receiveShadow = true; scene.add(m);
      label(id, new THREE.Vector3(x, 2.3, z));
    });
    camera.position.set(0, 9, 20); controls.target.set(0, 1, 2);
  } else if (view === 'decals') {
    const slab = new THREE.Mesh(meterBox(24, 0.2, 6), pbrMaterial('concrete-sidewalk'));
    slab.position.set(0, 0.1, 0); slab.receiveShadow = true; scene.add(slab);
    const wall = new THREE.Mesh(meterBox(24, 5, 0.3), pbrMaterial('brick-red'));
    wall.position.set(0, 2.5, -3.15); wall.castShadow = wall.receiveShadow = true; scene.add(wall);
    const ids = Object.keys(TEXTURES).filter((k) => TEXTURES[k].decal);
    ['decal-puddle', 'decal-oil', 'decal-paint-splat'].forEach((k) => ids.includes(k) || ids.push(k));
    ids.forEach((id, i) => {
      const s = TEXTURES[id]?.sizeM ?? 1.5;
      const onWall = /leak|graffiti|splat/.test(id);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), decalMaterial(id));
      const x = -10 + i * 2.2;
      if (onWall) m.position.set(x, 2.5, -2.99); else { m.rotation.x = -Math.PI / 2; m.position.set(x, 0.201, 0.5); }
      scene.add(m);
      label(id, new THREE.Vector3(x, onWall ? 4.2 : 1.2, onWall ? -2.9 : 1));
    });
    camera.position.set(0, 4, 10); controls.target.set(0, 1.5, -1);
  } else if (view === 'props') {
    const ids = [...modelIds('prop'), ...modelIds('vehicle')];
    const side = new THREE.Mesh(meterBox(40, 0.15, 4), pbrMaterial('concrete-sidewalk'));
    side.position.set(0, 0.075, -3); side.receiveShadow = true; scene.add(side);
    await Promise.all(ids.map(async (id, i) => {
      const m = await loadModel(id);
      if (!m) return;
      const veh = id.startsWith('vehicle');
      const x = veh ? (i - ids.length + 6) * 5 : (i % 12) * 2.6 - 15, z = veh ? 5 : (i < 12 ? -3 : 0.5);
      m.position.set(x, veh || i >= 12 ? 0 : 0.15, z); scene.add(m);
      const b = new THREE.Box3().setFromObject(m); const sz = b.getSize(new THREE.Vector3());
      label(`${id.replace(/^(prop|vehicle)-/, '')} ${sz.y.toFixed(1)}m`, new THREE.Vector3(x, b.max.y + 0.3, z));
    }));
    camera.position.set(0, 6, 16); controls.target.set(0, 1, 0);
  } else {
    const ids = modelIds('character');
    const clip = q.get('clip') ?? 'walk';
    await Promise.all(ids.map(async (id, i) => {
      const r = await loadModelWithAnimations(id);
      if (!r) return;
      const x = (i - ids.length / 2) * 1.1;
      r.scene.position.set(x, 0, 0);
      scene.add(r.scene);
      const mixer = new THREE.AnimationMixer(r.scene);
      const c = r.clips[i % 3 === 0 ? 'idle' : clip] ?? r.animations[0];
      if (c) mixer.clipAction(c).play();
      mixer.setTime(i * 0.37);
      mixers.push(mixer);
      label(id.replace('character-', ''), new THREE.Vector3(x, 2.1, 0));
    }));
    camera.position.set(0, 1.7, 7); controls.target.set(0, 1, 0);
  }
  const cam = q.get('cam')?.split(',').map(Number);
  if (cam?.length === 3) camera.position.set(cam[0], cam[1], cam[2]);
  const tgt = q.get('target')?.split(',').map(Number);
  if (tgt?.length === 3) controls.target.set(tgt[0], tgt[1], tgt[2]);
  controls.update();
  status.textContent = `${envId} / ${view}`;
  (window as any).assetTestReady = true;
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  for (const m of mixers) m.update(dt);
  renderer.render(scene, camera);
});
main();
