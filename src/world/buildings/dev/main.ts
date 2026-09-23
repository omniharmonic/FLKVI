// Buildings dev harness: open /src/world/buildings/dev/index.html (optionally ?recipe=boulder&view=street&night=0.8)
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { Recipe } from '../../../core/types';
import { buildFromRecipe } from '../index';
import { testRecipe } from './testset';
import { preloadLibrary } from '../../../assets/library';
import { texTimes } from '../textures';
(window as unknown as { __tex: unknown }).__tex = texTimes;

const qs = new URLSearchParams(location.search);
const hud = document.getElementById('hud')!;

async function main() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Number(qs.get('exposure') ?? 0.9);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 5000);
  const night = Number(qs.get('night') ?? 0);

  // sky + env
  const sky = new Sky();
  sky.scale.setScalar(10000);
  const su = sky.material.uniforms;
  su.turbidity.value = 4; su.rayleigh.value = 1.2; su.mieCoefficient.value = 0.005; su.mieDirectionalG.value = 0.8;
  const elev = THREE.MathUtils.degToRad(night > 0.5 ? -4 : Number(qs.get('sunElev') ?? 38));
  const azim = THREE.MathUtils.degToRad(Number(qs.get('sunAz') ?? 35));
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elev, azim);
  su.sunPosition.value.copy(sunDir);
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const sky2 = new Sky(); sky2.scale.setScalar(1000);
  sky2.material.uniforms.sunPosition.value.copy(sunDir);
  sky2.material.uniforms.turbidity.value = 4; sky2.material.uniforms.rayleigh.value = 1.2;
  envScene.add(sky2);
  const envGround = new THREE.Mesh(new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#4a4640' }));
  envGround.position.y = -5;
  envScene.add(envGround);
  const env = pmrem.fromScene(envScene, 0.02).texture;
  scene.environment = env;
  scene.environmentIntensity = night > 0.5 ? 0.03 : Number(qs.get('env') ?? 0.35);

  const sun = new THREE.DirectionalLight('#fff4e0', night > 0.5 ? 0.0 : 3.2);
  sun.position.copy(sunDir).multiplyScalar(400);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -220; sc.right = 220; sc.top = 220; sc.bottom = -220; sc.near = 10; sc.far = 1200;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#bcd4ec', '#6b5f50', night > 0.5 ? 0.06 : 0.35);
  scene.add(hemi);
  if (night > 0.5) {
    scene.background = new THREE.Color('#0b1020');
    sky.visible = false;
  }
  scene.fog = new THREE.Fog(night > 0.5 ? '#0b1020' : '#b9c8d6', 400, 2600);

  let recipe: Recipe;
  const rname = qs.get('recipe');
  if (rname) {
    hud.textContent = `loading ${rname}.json…`;
    const res = await fetch(`${import.meta.env.BASE_URL}recipes/${rname}.json`);
    recipe = await res.json();
  } else recipe = testRecipe();

  try { await preloadLibrary(); } catch (e) { console.warn('preloadLibrary failed', e); }

  // ground: terrain heightfield (or flat)
  scene.add(makeGround(recipe));
  scene.add(makeRoads(recipe));

  const t0 = performance.now();
  const res = await buildFromRecipe(recipe, (s, f) => { hud.textContent = `${s} ${(f * 100).toFixed(0)}%`; });
  const buildMs = performance.now() - t0;
  scene.add(res.group);
  res.setNightFactor(night);

  // camera
  const controls = new OrbitControls(camera, renderer.domElement);
  const view = qs.get('view') ?? 'aerial';
  const cam = qs.get('cam')?.split(',').map(Number);
  if (cam && cam.length >= 6) {
    camera.position.set(cam[0], cam[1], cam[2]); controls.target.set(cam[3], cam[4], cam[5]);
  } else if (rname) {
    const sp = recipe.spawn;
    if (view === 'street') { camera.position.set(sp.p[0], sp.y + 1.7, sp.p[1]); controls.target.set(sp.p[0] + Math.sin(sp.heading) * 30, sp.y + 4, sp.p[1] - Math.cos(sp.heading) * 30); }
    else { camera.position.set(sp.p[0] + 180, sp.y + 160, sp.p[1] + 180); controls.target.set(sp.p[0], sp.y, sp.p[1]); }
  } else {
    if (view === 'street') { camera.position.set(-40, 1.7, 9); controls.target.set(-20, 5, -6); }
    else if (view === 'res') { camera.position.set(-40, 6, -40); controls.target.set(-30, 3, -70); }
    else if (view === 'down') { camera.position.set(80, 20, 45); controls.target.set(130, 18, 0); }
    else { camera.position.set(-110, 80, 90); controls.target.set(20, 0, -20); }
  }
  controls.update();

  const fakeGame = { camera } as unknown as Parameters<NonNullable<typeof res.update>>[1];
  const tick = () => {
    controls.update();
    res.update?.(0.016, fakeGame);
    renderer.render(scene, camera);
    const i = renderer.info.render;
    const s = res.stats!;
    hud.textContent = `buildings ${s.buildings}  chunks ${s.chunks}  meshes ${s.meshes}\nbuild ${buildMs.toFixed(0)} ms (gen ${s.ms.toFixed(0)} ms)\ntris lod0 ${(s.trisLod0 / 1e6).toFixed(2)}M lod1 ${(s.trisLod1 / 1e6).toFixed(2)}M common ${(s.trisCommon / 1e6).toFixed(2)}M\nwindows ${s.windows}\ndraw calls ${i.calls}  frame tris ${(i.triangles / 1e6).toFixed(2)}M`;
    (window as unknown as { __bldg: unknown }).__bldg = { stats: s, buildMs, calls: i.calls, tris: i.triangles, cam: [camera.position.toArray(), controls.target.toArray()] };
  };
  renderer.setAnimationLoop(tick);
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
  (window as unknown as { __ready: boolean }).__ready = true;
  (window as unknown as { __THREE: unknown }).__THREE = THREE;
  (window as unknown as { __dev: unknown }).__dev = { scene, camera, controls, renderer, res, setNight: (f: number) => res.setNightFactor(f) };
}

function makeGround(r: Recipe): THREE.Object3D {
  const t = r.terrain;
  let geo: THREE.BufferGeometry;
  if (t && t.cols >= 2 && t.rows >= 2 && t.heights?.length === t.cols * t.rows) {
    geo = new THREE.PlaneGeometry((t.cols - 1) * t.cellSize, (t.rows - 1) * t.cellSize, t.cols - 1, t.rows - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let row = 0; row < t.rows; row++) for (let col = 0; col < t.cols; col++) {
      const i = row * t.cols + col;
      pos.setXYZ(i, t.originX + col * t.cellSize, t.heights[i] - 0.05, t.originZ + row * t.cellSize);
    }
    geo.computeVertexNormals();
  } else {
    geo = new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2);
  }
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#77746c', roughness: 0.95 }));
  m.receiveShadow = true;
  return m;
}

function makeRoads(r: Recipe): THREE.Object3D {
  const pos: number[] = [];
  for (const rd of r.roads ?? []) {
    const w = (rd.width || 6) / 2 + (rd.sidewalk || 0);
    for (let i = 0; i < rd.pts.length - 1; i++) {
      const a = rd.pts[i], b = rd.pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l * w, nz = dx / l * w;
      const ya = (rd.ys?.[i] ?? 0) + 0.03, yb = (rd.ys?.[i + 1] ?? 0) + 0.03;
      pos.push(a[0] + nx, ya, a[1] + nz, b[0] + nx, yb, b[1] + nz, b[0] - nx, yb, b[1] - nz);
      pos.push(a[0] + nx, ya, a[1] + nz, b[0] - nx, yb, b[1] - nz, a[0] - nx, ya, a[1] - nz);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#3a3a3c', roughness: 0.9, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  return m;
}

main().catch((e) => { hud.textContent = 'ERROR ' + (e as Error).message; console.error(e); });
