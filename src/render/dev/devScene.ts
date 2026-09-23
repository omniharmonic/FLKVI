// Render dev scene (/?renderdev): textured ground, box buildings with windows, PBR spheres, lamps,
// distant mountains. Free camera: drag mouse to look, WASD/QE to fly, Shift = fast.
// Keys 1-5 jump to noon / golden hour / sunset / dusk / night. [ ] shift time, \ pause, F7 rain.
import * as THREE from 'three';
import { Game } from '../../core/game';
import { setupRendering } from '../index';

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

function noise(c: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number, seed = 1) {
  const img = c.createImageData(w, h);
  let s = seed * 9301 + 49297;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < w * h; i++) {
    const n = (r() - 0.5) * amp;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}

export async function startDevScene() {
  document.getElementById('ui-root')?.style.setProperty('display', 'none');
  const container = document.getElementById('app')!;
  container.style.cssText = 'position:fixed;inset:0;';
  const recipe = {
    version: 1, name: 'renderdev', origin: { lat: 40.0176, lon: -105.2797 },
    bounds: { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }, region: 'mountain-west', climate: 'arid', tier: 'A',
    spawn: { p: [0, 0], y: 1640, heading: 0 }, roads: [], buildings: [], areas: [], trees: [], props: [], cameras: [], attribution: [],
  } as any;
  const g = new Game(recipe, container);
  (window as any).game = g;
  g.camera.far = 20000;
  g.camera.near = 0.3;
  g.camera.updateProjectionMatrix();
  await setupRendering(g, { dev: true });
  const scene = g.scene;

  // ground: asphalt with a subtle grid of concrete sidewalks
  const groundMap = canvasTex(512, 512, (c) => {
    noise(c, 512, 512, [70, 70, 72], 30, 3);
    c.fillStyle = 'rgba(160,158,150,0.9)';
    c.fillRect(0, 0, 512, 60);
    c.fillRect(0, 0, 60, 512);
    c.strokeStyle = 'rgba(220,200,90,0.9)';
    c.lineWidth = 4;
    c.setLineDash([40, 30]);
    c.beginPath(); c.moveTo(0, 286); c.lineTo(512, 286); c.stroke();
    c.beginPath(); c.moveTo(286, 0); c.lineTo(286, 512); c.stroke();
  });
  groundMap.repeat.set(40, 40);
  const roughMap = canvasTex(256, 256, (c) => noise(c, 256, 256, [215, 215, 215], 60, 7), false);
  roughMap.repeat.set(160, 160);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: groundMap, roughnessMap: roughMap, roughness: 1, metalness: 0 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  // facades with windows (emissive map for night)
  const facade = (wall: string, seed: number) => {
    const map = canvasTex(256, 256, (c) => {
      c.fillStyle = wall; c.fillRect(0, 0, 256, 256);
      const img = c.getImageData(0, 0, 256, 256);
      let s = seed;
      const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < img.data.length; i += 4) { const n = (r() - 0.5) * 24; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
      c.putImageData(img, 0, 0);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        c.fillStyle = '#1d232b'; c.fillRect(x * 64 + 14, y * 64 + 12, 36, 40);
        c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(x * 64 + 14, y * 64 + 12, 36, 6);
        c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x * 64 + 12, y * 64 + 52, 40, 4);
      }
    });
    const emissive = canvasTex(256, 256, (c) => {
      c.fillStyle = '#000'; c.fillRect(0, 0, 256, 256);
      let s = seed + 11;
      const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        if (r() < 0.45) { c.fillStyle = r() < 0.7 ? '#ffc98a' : '#cfe0ff'; c.fillRect(x * 64 + 14, y * 64 + 12, 36, 40); }
      }
    });
    return new THREE.MeshStandardMaterial({ map, emissiveMap: emissive, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.85 });
  };
  const mats = [facade('#8c5a44', 3), facade('#b8ab94', 5), facade('#6f7479', 9), facade('#c9b79a', 13)];
  const windowMats: THREE.MeshStandardMaterial[] = mats;
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a3b3d, roughness: 0.9 });
  let s = 42;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let bx = -4; bx <= 4; bx++) for (let bz = -4; bz <= 4; bz++) {
    if (Math.abs(bx) <= 0 && Math.abs(bz) <= 0) continue;
    for (let k = 0; k < 2; k++) {
      const w = 12 + r() * 14, d = 12 + r() * 14, h = 8 + Math.floor(r() * (Math.abs(bx) + Math.abs(bz) < 3 ? 10 : 5)) * 4;
      const geo = new THREE.BoxGeometry(w, h, d);
      // world-scale UVs: one 256px tile = 16 m x 16 m (4x4 windows of 4 m)
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const nrm = geo.attributes.normal as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
        const u = nx > 0.5 ? pos.getZ(i) : pos.getX(i);
        uv.setXY(i, ny > 0.5 ? 0 : u / 16, (pos.getY(i) + h / 2) / 16);
      }
      const m = mats[Math.floor(r() * mats.length)];
      const mesh = new THREE.Mesh(geo, [m, m, roofMat, roofMat, m, m]);
      mesh.position.set(bx * 64 + (k ? 16 : -16) + (r() - 0.5) * 6, h / 2, bz * 64 + (r() - 0.5) * 20);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  // PBR spheres: roughness across, metalness down
  for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.4, 48, 32), new THREE.MeshStandardMaterial({
      color: j ? 0xd8b070 : 0xb03a2e, roughness: 0.05 + i * 0.22, metalness: j,
    }));
    m.position.set(-6 + i * 3.2, 1.4, 6 + j * 3.4);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  // a glossy "car body" block and a glass pane
  const car = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.3, 1.9), new THREE.MeshPhysicalMaterial({ color: 0x14306a, roughness: 0.25, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.05 }));
  car.position.set(8, 0.95, 3); car.castShadow = car.receiveShadow = true; scene.add(car);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 0.1), new THREE.MeshPhysicalMaterial({ color: 0x88aacc, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.35 }));
  glass.position.set(-10, 1.5, 2); scene.add(glass);

  // streetlights: emissive heads + point lights
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffb35c, emissiveIntensity: 0 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3c3e, roughness: 0.5, metalness: 0.8 });
  const lights: THREE.PointLight[] = [];
  for (let i = -3; i <= 3; i++) {
    const x = i * 22, z = -8;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 7, 10), poleMat);
    pole.position.set(x, 3.5, z); pole.castShadow = true; scene.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.18, 0.4), lampMat);
    head.position.set(x, 7, z + 0.5); scene.add(head);
    const pl = new THREE.PointLight(0xffb870, 0, 30, 2);
    pl.position.set(x, 6.7, z + 0.5);
    scene.add(pl);
    lights.push(pl);
  }
  // siren-ish red/blue emissive blocks to check bloom
  const siren = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.2, 0.3), new THREE.MeshStandardMaterial({ color: 0, emissive: 0xff2020, emissiveIntensity: 30 }));
  siren.position.set(8, 1.75, 3); scene.add(siren);

  // distant mountains to the west (aerial perspective check)
  const mg = new THREE.PlaneGeometry(30000, 16000, 200, 100).rotateX(-Math.PI / 2);
  const mp = mg.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < mp.count; i++) {
    const x = mp.getX(i), z = mp.getZ(i);
    const wx = x - 12000; // west of origin
    const dist = Math.max(0, -wx - 3000);
    const ridge = Math.sin(z * 0.0009) * 300 + Math.sin(z * 0.0023 + 1) * 180 + Math.sin(z * 0.006) * 60 + Math.sin(x * 0.004 + z * 0.003) * 70;
    const hgt = Math.min(1, dist / 3000) * (900 + ridge) * 1 + Math.min(1, dist / 3000) * Math.max(0, Math.sin(x * 0.0017) * Math.sin(z * 0.0021)) * 120;
    mp.setY(i, Math.max(-2, hgt - 1));
  }
  mg.computeVertexNormals();
  const mtn = new THREE.Mesh(mg, new THREE.MeshStandardMaterial({ color: 0x55604a, roughness: 1 }));
  mtn.position.set(-12000, -1, 0);
  scene.add(mtn);

  // world stub for night lights
  (g as any).world = {
    heightAt: () => 0,
    groundAt: () => 0,
    setNightFactor(f: number) {
      for (const m of windowMats) m.emissiveIntensity = f * 0.9;
      lampMat.emissiveIntensity = f * 25;
      for (const l of lights) l.intensity = f * 900;
    },
    staticMeshes: [],
  };

  // free camera
  const cam = g.camera;
  const q = new URLSearchParams(location.search);
  const camPreset = q.get('cam') || 'street';
  const presets: Record<string, [number, number, number, number, number]> = {
    street: [18, 2.2, 22, 0.55, 0.06],
    west: [30, 12, 20, 1.35, 0.02],
    east: [-20, 6, 10, -1.2, 0.05],
    high: [80, 60, 120, 0.5, -0.3],
    spheres: [0, 3, 18, 0.1, -0.12],
    sunset: [200, 45, 30, 1.45, -0.05],
    top: [0, 150, 150, 0, -0.7],
  };
  const pr = presets[camPreset] ?? presets.street;
  cam.position.set(pr[0], pr[1], pr[2]);
  let yaw = pr[3], pitch = pr[4];
  let drag = false;
  container.addEventListener('mousedown', () => (drag = true));
  addEventListener('mouseup', () => (drag = false));
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    yaw -= e.movementX * 0.003;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.003, -1.5, 1.5);
  });
  const sky = g.sky as any;
  const timeKeys: Record<string, number> = { Digit1: 12.5, Digit2: 17.3, Digit3: 17.85, Digit4: 18.3, Digit5: 22 };
  g.addSystem({
    name: 'dev-camera',
    order: 100,
    update(dt) {
      const i = g.input;
      for (const k in timeKeys) if (i.wasPressed(k)) sky.time = timeKeys[k];
      const sp = (i.isDown('ShiftLeft') ? 60 : 12) * dt;
      const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const rgt = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      if (i.isDown('KeyW')) cam.position.addScaledVector(f, sp);
      if (i.isDown('KeyS')) cam.position.addScaledVector(f, -sp);
      if (i.isDown('KeyD')) cam.position.addScaledVector(rgt, sp);
      if (i.isDown('KeyA')) cam.position.addScaledVector(rgt, -sp);
      if (i.isDown('KeyE')) cam.position.y += sp;
      if (i.isDown('KeyQ')) cam.position.y = Math.max(0.5, cam.position.y - sp);
      cam.rotation.set(pitch, yaw, 0, 'YXZ');
    },
  });

  // HUD readout
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:8px;top:8px;color:#fff;font:12px monospace;text-shadow:0 1px 2px #000;pointer-events:none;z-index:10';
  document.body.appendChild(hud);
  let acc = 0, frames = 0;
  g.addSystem({
    name: 'dev-hud', order: 1000,
    update(dt) {
      acc += dt; frames++;
      if (acc > 0.5) {
        const h = Math.floor(sky.time), m = Math.floor((sky.time - h) * 60);
        hud.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}  sun ${(sky.sunElevation * 57.3).toFixed(1)}°  night ${sky.nightFactor.toFixed(2)}  ${(frames / acc).toFixed(0)} fps  ${g.quality}  rain ${sky.rainTarget}`;
        acc = 0; frames = 0;
      }
    },
  });
  g.start();
}
