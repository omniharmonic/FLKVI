// Title-screen backdrop: a light-weight golden-hour render of a baked city (extruded footprints, roads, trees,
// far terrain, glowing camera markers) with a slow orbiting camera. Uses its own small WebGL context that is
// disposed as soon as the title is dismissed, so the game never pays for it.
import * as THREE from 'three';
import type { Recipe } from '../core/types';
import { reducedMotion } from './settings';

export interface TitleBackdrop { el: HTMLCanvasElement; dispose(): void }

export function createTitleBackdrop(r: Recipe, onReady: () => void): TitleBackdrop | null {
  let renderer: THREE.WebGLRenderer;
  const canvas = document.createElement('canvas');
  canvas.className = 'gt-titlebg';
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch { return null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const haze = new THREE.Color('#a8826a');
  scene.fog = new THREE.FogExp2(haze, 0.00026);
  const [sx, sz] = r.spawn.p;
  const baseY = r.spawn.y || 0;
  const geos: THREE.BufferGeometry[] = []; const mats: THREE.Material[] = [];

  // sky dome: vertical gradient, sun glow toward the sun azimuth
  const sunDir = new THREE.Vector3(-0.82, 0.13, 0.3).normalize();
  {
    const g = new THREE.SphereGeometry(9000, 32, 16);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { sun: { value: sunDir } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vD; uniform vec3 sun;
        void main(){
          float h = clamp(vD.y, -0.2, 1.0);
          vec3 top = vec3(0.07, 0.12, 0.26); vec3 mid = vec3(0.42, 0.3, 0.36); vec3 low = vec3(1.0, 0.58, 0.32);
          vec3 c = mix(low, mid, smoothstep(0.0, 0.1, h)); c = mix(c, top, smoothstep(0.08, 0.4, h));
          float s = max(dot(normalize(vD), sun), 0.0);
          c += vec3(1.0, 0.62, 0.3) * (pow(s, 12.0) * 0.55 + pow(s, 400.0) * 6.0);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    scene.add(new THREE.Mesh(g, m)); geos.push(g); mats.push(m);
  }

  // lights
  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.72, 0.48), 3.2);
  sun.position.copy(sunDir).multiplyScalar(900).add(new THREE.Vector3(sx, baseY, sz));
  sun.target.position.set(sx, baseY, sz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -520; sc.right = 520; sc.top = 520; sc.bottom = -520; sc.near = 10; sc.far = 2400;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(new THREE.Color('#8fa7c9'), new THREE.Color('#4a3426'), 0.9));

  // terrain helpers
  const terrainMesh = (t: Recipe['terrain'], step: number, color: (h: number, x: number, z: number) => THREE.Color, receive: boolean) => {
    const cols = Math.floor((t.cols - 1) / step) + 1, rows = Math.floor((t.rows - 1) / step) + 1;
    const pos = new Float32Array(cols * rows * 3); const col = new Float32Array(cols * rows * 3);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const hgt = t.heights[j * step * t.cols + i * step] ?? 0;
      const x = t.originX + i * step * t.cellSize, z = t.originZ + j * step * t.cellSize;
      const k = (j * cols + i) * 3; pos[k] = x; pos[k + 1] = hgt; pos[k + 2] = z;
      const cc = color(hgt, x, z); col[k] = cc.r; col[k + 1] = cc.g; col[k + 2] = cc.b;
    }
    const idx: number[] = [];
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = receive;
    geos.push(g); mats.push(m);
    return mesh;
  };
  const c1 = new THREE.Color();
  if (r.farTerrain?.heights?.length) {
    const b = r.bounds;
    const far = terrainMesh(r.farTerrain, 1, (hh, x, z) => {
      const inside = x > b.minX - 60 && x < b.maxX + 60 && z > b.minZ - 60 && z < b.maxZ + 60;
      const rel = hh - baseY;
      c1.setRGB(0.19, 0.17, 0.12).lerp(new THREE.Color(0.28, 0.25, 0.2), THREE.MathUtils.clamp(rel / 900, 0, 1));
      if (rel < 40) c1.lerp(new THREE.Color(0.2, 0.2, 0.15), 0.5);
      return inside ? c1.clone().multiplyScalar(0.6) : c1.clone();
    }, false);
    far.position.y = -0.6; // tuck under the detailed ground
    scene.add(far);
  }
  if (r.terrain?.heights?.length) scene.add(terrainMesh(r.terrain, 4, () => c1.setRGB(0.2, 0.19, 0.17), true));

  // roads: flat ribbons
  {
    const pos: number[] = []; const col: number[] = [];
    const push = (x: number, y: number, z: number, g: number) => { pos.push(x, y, z); col.push(g, g * 0.98, g * 0.95); };
    for (const rd of r.roads) {
      const hw = rd.width / 2 + (rd.sidewalk || 0);
      for (let i = 0; i < rd.pts.length - 1; i++) {
        const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
        const dx = bx - ax, dz = bz - az; const L = Math.hypot(dx, dz) || 1;
        const nx = -dz / L * hw, nz = dx / L * hw;
        const ay = (rd.ys?.[i] ?? baseY) + 0.25, by = (rd.ys?.[i + 1] ?? baseY) + 0.25;
        const g = rd.width > 12 ? 0.11 : 0.085;
        push(ax + nx, ay, az + nz, g); push(ax - nx, ay, az - nz, g); push(bx + nx, by, bz + nz, g);
        push(bx + nx, by, bz + nz, g); push(ax - nx, ay, az - nz, g); push(bx - nx, by, bz - nz, g);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; scene.add(mesh); geos.push(g); mats.push(m);
  }

  // buildings: extruded footprints with flat roofs, vertex colored
  {
    const pos: number[] = []; const col: number[] = [];
    const cc = new THREE.Color(); const roofC = new THREE.Color();
    for (const b of r.buildings) {
      const f = b.footprint; if (!f || f.length < 3) continue;
      const y0 = b.baseY + (b.minHeight ?? 0) - 0.5, y1 = b.baseY + b.height + (b.roofHeight || 0) * 0.45;
      try { cc.set(b.color || '#8a8a8a'); } catch { cc.set('#8a8a8a'); }
      cc.lerp(new THREE.Color('#9c9588'), 0.35);
      try { roofC.set(b.roof?.color || '#555555'); } catch { roofC.set('#555555'); }
      roofC.multiplyScalar(0.85);
      for (let i = 0; i < f.length; i++) {
        const [ax, az] = f[i], [bx, bz] = f[(i + 1) % f.length];
        pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
        for (let k = 0; k < 6; k++) col.push(cc.r, cc.g, cc.b);
      }
      const tris = THREE.ShapeUtils.triangulateShape(f.map(([x, z]) => new THREE.Vector2(x, z)), []);
      for (const t of tris) for (const k of [t[0], t[2], t[1]]) { pos.push(f[k][0], y1, f[k][1]); col.push(roofC.r, roofC.g, roofC.b); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh); geos.push(g); mats.push(m);
  }

  // trees
  if (r.trees?.length) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(0.13, 0.18, 0.09) });
    const im = new THREE.InstancedMesh(g, m, r.trees.length);
    const o = new THREE.Object3D();
    r.trees.forEach((t, i) => {
      const cr = Math.max(1.4, t.crown * 0.42);
      o.position.set(t.p[0], t.y + t.height - cr * 0.9, t.p[1]);
      o.scale.set(cr, Math.max(cr, t.height * 0.45), cr);
      o.rotation.y = (t.seed % 628) / 100;
      o.updateMatrix(); im.setMatrixAt(i, o.matrix);
    });
    im.castShadow = true; im.receiveShadow = true;
    scene.add(im); geos.push(g); mats.push(m);
  }

  // cameras: glowing red markers
  const glowMat = new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(1, 0.18, 0.22), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true });
  mats.push(glowMat);
  const glows: THREE.Sprite[] = [];
  for (const c of r.cameras) {
    const s = new THREE.Sprite(glowMat);
    s.position.set(c.p[0], c.y + (c.poleHeight || 6) + 1, c.p[1]);
    s.scale.setScalar(16);
    (s as any)._ph = (c.p[0] * 13.1 + c.p[1] * 7.7) % 6.28;
    scene.add(s); glows.push(s);
  }

  const cam = new THREE.PerspectiveCamera(38, 16 / 9, 2, 20000);
  const resize = () => {
    const w = innerWidth, hh = innerHeight;
    renderer.setSize(w, hh, false);
    cam.aspect = w / hh; cam.updateProjectionMatrix();
  };
  resize(); addEventListener('resize', resize);

  const rm = reducedMotion();
  let alive = true; let raf = 0; let first = true;
  const t0 = performance.now();
  const target = new THREE.Vector3(sx, baseY + 45, sz);
  const tick = () => {
    if (!alive) return;
    raf = requestAnimationFrame(tick);
    const t = (performance.now() - t0) / 1000;
    const a = -0.25 + Math.sin(t * (rm ? 0.004 : 0.022)) * 0.9;
    const R = 540, H = 150 + Math.sin(t * 0.05) * 15;
    cam.position.set(sx + Math.cos(a) * R, baseY + H, sz + Math.sin(a) * R);
    cam.lookAt(target);
    for (const s of glows) { const k = 0.6 + 0.4 * Math.sin(t * 2.2 + (s as any)._ph); s.material.opacity = 1; s.scale.setScalar(10 + k * 10); }
    renderer.render(scene, cam);
    if (first) { first = false; onReady(); }
  };
  raf = requestAnimationFrame(tick);

  return {
    el: canvas,
    dispose() {
      if (!alive) return;
      alive = false; cancelAnimationFrame(raf);
      removeEventListener('resize', resize);
      for (const g of geos) g.dispose();
      for (const m of mats) { (m as any).map?.dispose?.(); m.dispose(); }
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* */ }
      canvas.remove();
    },
  };
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.15, 'rgba(255,255,255,0.8)'); g.addColorStop(0.4, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
