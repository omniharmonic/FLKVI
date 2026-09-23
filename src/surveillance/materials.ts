// Shared PBR materials for surveillance hardware. Textures are generated procedurally on canvases
// (galvanized spangle, weathered plastic, solar cells, concrete) so there are no asset dependencies.
import * as THREE from 'three';
import { rng } from '../core/geo';
import { textureSet, pbrMaterial } from '../assets/library';

type Mats = ReturnType<typeof createMaterials>;
let cached: Mats | null = null;

export function mats(): Mats {
  return (cached ??= createMaterials());
}

// ---------- tiny value-noise helpers (canvas generation only) ----------
function makeNoise(seed: number) {
  const r = rng(seed);
  const N = 256;
  const perm = new Uint8Array(N * 2);
  const vals = new Float32Array(N);
  for (let i = 0; i < N; i++) { perm[i] = i; vals[i] = r(); }
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < N; i++) perm[i + N] = perm[i];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const fade = (t: number) => t * t * (3 - 2 * t);
  // periodic 2D value noise with period p
  const n2 = (x: number, y: number, p: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = fade(x - xi), yf = fade(y - yi);
    const h = (a: number, b: number) => vals[perm[(((a % p) + p) % p) + perm[(((b % p) + p) % p)]]];
    return lerp(lerp(h(xi, yi), h(xi + 1, yi), xf), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), xf), yf);
  };
  return (u: number, v: number, oct = 4, base = 4) => {
    let s = 0, a = 0.5, f = base, tot = 0;
    for (let o = 0; o < oct; o++) { s += a * n2(u * f, v * f, f); tot += a; a *= 0.5; f *= 2; }
    return s / tot;
  };
}

function canvasTex(size: number, draw: (img: ImageData) => void, srgb: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  draw(img);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

/** Galvanized steel: mottled spangle crystals + faint vertical weathering streaks. Texture tile = 1 m. */
function galvanizedTextures() {
  const S = 512;
  const nz = makeNoise(11);
  const r = rng(99);
  // Voronoi-ish spangle cells
  const pts: [number, number, number][] = [];
  for (let i = 0; i < 380; i++) pts.push([r(), r(), r()]);
  const cell = (u: number, v: number) => {
    let best = 9, val = 0;
    for (const p of pts) {
      let dx = Math.abs(u - p[0]); dx = Math.min(dx, 1 - dx);
      let dy = Math.abs(v - p[1]); dy = Math.min(dy, 1 - dy);
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; val = p[2]; }
    }
    return val;
  };
  const cells = new Float32Array(S * S);
  const step = 2; // compute spangle at half res
  for (let y = 0; y < S; y += step) for (let x = 0; x < S; x += step) {
    const c = cell(x / S, y / S);
    for (let yy = 0; yy < step; yy++) for (let xx = 0; xx < step; xx++) cells[(y + yy) * S + x + xx] = c;
  }
  const color = canvasTex(S, (img) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const sp = cells[y * S + x];
      const n = nz(u, v, 5, 3);
      const streak = nz(u * 1, v * 0.08 + 0.3, 3, 16); // vertical streaks
      let g = 150 + (sp - 0.5) * 26 + (n - 0.5) * 40 - Math.max(0, streak - 0.55) * 90;
      const i = (y * S + x) * 4;
      img.data[i] = g * 0.98; img.data[i + 1] = g; img.data[i + 2] = g * 1.02; img.data[i + 3] = 255;
    }
  }, true);
  const rough = canvasTex(S, (img) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const sp = cells[y * S + x];
      const n = nz(u + 0.37, v + 0.11, 5, 3);
      const streak = nz(u, v * 0.08 + 0.3, 3, 16);
      const g = 105 + (sp - 0.5) * 70 + (n - 0.5) * 60 + Math.max(0, streak - 0.55) * 120;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, g)); img.data[i + 3] = 255;
    }
  }, false);
  return { color, rough };
}

/** Weathered paint/plastic grime: mostly clean with soft dirt blotches and drip streaks. */
function grimeTextures(seed: number) {
  const S = 256;
  const nz = makeNoise(seed);
  const color = canvasTex(S, (img) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const n = nz(u, v, 5, 2);
      const drip = nz(u * 1, v * 0.1, 3, 24);
      const g = 245 - Math.max(0, n - 0.5) * 70 - Math.max(0, drip - 0.6) * 110;
      const i = (y * S + x) * 4;
      img.data[i] = g; img.data[i + 1] = g * 0.99; img.data[i + 2] = g * 0.96; img.data[i + 3] = 255;
    }
  }, true);
  const rough = canvasTex(S, (img) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const n = nz(u + 0.5, v, 5, 4);
      const g = 95 + n * 70;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g; img.data[i + 3] = 255;
    }
  }, false);
  return { color, rough };
}

/** Monocrystalline solar panel: dark cells, silver busbars and fingers. One texture = one panel face. */
function solarTexture() {
  const S = 512;
  const nz = makeNoise(5);
  return canvasTex(S, (img) => {
    const cols = 6, rows = 4, gap = 5;
    const cw = (S - gap) / cols, ch = (S - gap) / rows;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const cx = (x - gap) % cw, cy = (y - gap) % ch;
      let r = 205, g = 210, b = 215; // backsheet between cells (white)
      if (cx >= 0 && cy >= 0 && cx < cw - gap && cy < ch - gap) {
        // chamfered corners of mono cells show the backsheet
        const c = 7, ex = cw - gap - 1 - cx, ey = ch - gap - 1 - cy;
        const inCorner = (cx + cy < c) || (ex + cy < c) || (cx + ey < c) || (ex + ey < c);
        if (!inCorner) {
          const n = nz(x / S, y / S, 3, 8);
          r = 14 + n * 10; g = 20 + n * 12; b = 44 + n * 22;
          // busbars (3 vertical) and fine fingers (horizontal)
          const bb = (cx / (cw - gap)) * 3;
          if (Math.abs(bb - Math.round(bb - 0.5) - 0.5) < 0.012 * 3) { r = g = b = 160; }
          else if (Math.floor(cy) % 6 === 0) { r += 18; g += 20; b += 24; }
        }
      }
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }, true);
}

function concreteTextures() {
  const S = 256;
  const nz = makeNoise(21);
  const r = rng(3);
  const color = canvasTex(S, (img) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = nz(x / S, y / S, 6, 4);
      const pit = r() < 0.02 ? -40 : 0;
      const g = 150 + (n - 0.5) * 60 + pit;
      const i = (y * S + x) * 4;
      img.data[i] = g; img.data[i + 1] = g * 0.98; img.data[i + 2] = g * 0.94; img.data[i + 3] = 255;
    }
  }, true);
  return color;
}

/** Paint splatter + drips on transparent background, used as a lens decal. */
export function splatterTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const r = rng(seed);
  ctx.fillStyle = '#fff';
  // central blob
  ctx.beginPath();
  for (let a = 0; a <= 64; a++) {
    const t = (a / 64) * Math.PI * 2;
    const rad = 70 + r() * 28 + Math.sin(t * 7 + seed) * 8;
    const x = 128 + Math.cos(t) * rad, y = 110 + Math.sin(t) * rad;
    a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.fill();
  // satellite droplets
  for (let i = 0; i < 40; i++) {
    const t = r() * Math.PI * 2, d = 80 + r() * 45;
    ctx.beginPath();
    ctx.arc(128 + Math.cos(t) * d, 110 + Math.sin(t) * d, 1 + r() * 7, 0, Math.PI * 2);
    ctx.fill();
  }
  // drips running down
  for (let i = 0; i < 7; i++) {
    const x = 70 + r() * 116, w = 3 + r() * 6, len = 40 + r() * 100;
    ctx.fillRect(x - w / 2, 150, w, len);
    ctx.beginPath(); ctx.arc(x, 150 + len, w * 0.9, 0, Math.PI * 2); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function createMaterials() {
  const galv = galvanizedTextures();
  const grimeW = grimeTextures(31);
  const conc = textureSet('concrete') ? pbrMaterial('concrete', { tint: '#b8b4ad' }) : null;

  const galvanized = new THREE.MeshStandardMaterial({
    name: 'surv-galvanized', color: '#c9ccce', map: galv.color, roughnessMap: galv.rough,
    roughness: 1.0, metalness: 0.88, envMapIntensity: 1.0,
  });
  const galvanizedDark = new THREE.MeshStandardMaterial({
    name: 'surv-galv-dark', color: '#8d9194', map: galv.color, roughnessMap: galv.rough, roughness: 1.15, metalness: 0.8,
  });
  const plasticWhite = new THREE.MeshStandardMaterial({
    name: 'surv-plastic-white', color: '#eceae4', map: grimeW.color, roughnessMap: grimeW.rough, roughness: 1.0, metalness: 0.0,
  });
  const plasticGrey = new THREE.MeshStandardMaterial({
    name: 'surv-plastic-grey', color: '#9a9ea1', map: grimeW.color, roughnessMap: grimeW.rough, roughness: 1.05, metalness: 0.05,
  });
  const plasticDark = new THREE.MeshStandardMaterial({ name: 'surv-plastic-dark', color: '#26282b', roughness: 0.55, metalness: 0.05, map: grimeW.color });
  const rubber = new THREE.MeshStandardMaterial({ name: 'surv-rubber', color: '#141414', roughness: 0.85, metalness: 0 });
  const aluminum = new THREE.MeshStandardMaterial({ name: 'surv-aluminum', color: '#cdd0d3', roughness: 0.32, metalness: 1.0, roughnessMap: galv.rough });
  const lensGlass = new THREE.MeshPhysicalMaterial({
    name: 'surv-lens', color: '#040507', roughness: 0.04, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6,
  });
  const lensCoating = new THREE.MeshPhysicalMaterial({
    name: 'surv-lens-coat', color: '#1a1030', roughness: 0.08, metalness: 0.6, iridescence: 1, iridescenceIOR: 1.8,
    clearcoat: 1, envMapIntensity: 2,
  });
  const smokedDome = new THREE.MeshPhysicalMaterial({
    name: 'surv-dome', color: '#15171a', roughness: 0.03, metalness: 0.0, transparent: true, opacity: 0.55,
    clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.8, depthWrite: false,
  });
  const solar = new THREE.MeshPhysicalMaterial({
    name: 'surv-solar', map: solarTexture(), roughness: 0.12, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.4,
  });
  const concrete = conc ?? new THREE.MeshStandardMaterial({ name: 'surv-concrete', map: concreteTextures(), color: '#c8c4bc', roughness: 0.92, metalness: 0 });
  const paintWhite = new THREE.MeshStandardMaterial({ name: 'surv-paint-white', color: '#e9e8e2', map: grimeW.color, roughnessMap: grimeW.rough, roughness: 0.9, metalness: 0.15 });
  const paintYellow = new THREE.MeshStandardMaterial({ name: 'surv-paint-yellow', color: '#d9a51c', map: grimeW.color, roughnessMap: grimeW.rough, roughness: 0.85, metalness: 0.1 });
  const steelDark = new THREE.MeshStandardMaterial({ name: 'surv-steel-dark', color: '#3b3d40', roughness: 0.5, metalness: 0.85, roughnessMap: galv.rough });
  const strap = new THREE.MeshStandardMaterial({ name: 'surv-strap', color: '#b9bcbf', roughness: 0.35, metalness: 1 });
  const cable = new THREE.MeshStandardMaterial({ name: 'surv-cable', color: '#111112', roughness: 0.45, metalness: 0 });
  const signalYellow = new THREE.MeshStandardMaterial({ name: 'surv-signal-housing', color: '#2a2c22', roughness: 0.6, metalness: 0.2 });
  const hiVis = new THREE.MeshStandardMaterial({ name: 'surv-hivis', color: '#d6ff1f', roughness: 0.7, emissive: '#3a4a00', emissiveIntensity: 0.3 });
  const denim = new THREE.MeshStandardMaterial({ name: 'surv-denim', color: '#2c3646', roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ name: 'surv-skin', color: '#a8795a', roughness: 0.7 });
  const cone = new THREE.MeshStandardMaterial({ name: 'surv-cone', color: '#ff5a12', roughness: 0.6 });
  const windowGlass = new THREE.MeshPhysicalMaterial({ name: 'surv-window', color: '#0b0e12', roughness: 0.05, metalness: 0.4, clearcoat: 1, envMapIntensity: 1.5 });
  const trashBag = new THREE.MeshPhysicalMaterial({ name: 'surv-bag', color: '#0b0b0c', roughness: 0.35, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.3, sheen: 0.4 });

  // Unlit instanced emitters (per-instance color drives LED blink / IR glow; values >1 bloom).
  const led = new THREE.MeshBasicMaterial({ name: 'surv-led', color: '#ffffff', toneMapped: false });
  const ir = new THREE.MeshBasicMaterial({ name: 'surv-ir', color: '#ffffff', toneMapped: false });
  const strobe = new THREE.MeshBasicMaterial({ name: 'surv-strobe', color: '#ffffff', toneMapped: false });
  for (const m of [plasticWhite, plasticGrey, paintWhite, signalYellow]) m.side = THREE.DoubleSide;

  // Hot cut line on a post.
  const hotMetal = new THREE.MeshStandardMaterial({
    name: 'surv-hot', color: '#1a0c05', emissive: new THREE.Color('#ff7a1a'), emissiveIntensity: 0, roughness: 0.5, metalness: 0.6,
  });

  return {
    galvanized, galvanizedDark, plasticWhite, plasticGrey, plasticDark, rubber, aluminum, lensGlass, lensCoating, smokedDome, solar,
    concrete, paintWhite, paintYellow, steelDark, strap, cable, signalYellow, hiVis, denim, skin, cone, windowGlass, trashBag,
    led, ir, strobe, hotMetal,
  };
}
