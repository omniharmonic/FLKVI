// Shared vehicle materials (cached; never mutate per-instance).
import * as THREE from 'three';
import { paletteTexture } from './palette';

const cache = new Map<string, THREE.Material>();
function cached<T extends THREE.Material>(key: string, make: () => T): T {
  let m = cache.get(key) as T | undefined;
  if (!m) { m = make(); m.name = `veh-${key}`; cache.set(key, m); }
  return m;
}

/** Real-world-ish US car colors (sRGB). */
export const CAR_COLORS = [
  '#e9eaec', '#f4f4f2', '#b9bcc0', '#a7aaae', '#17181b', '#0c0d10', '#55595e', '#6a6e73',
  '#1f3a66', '#2c4f7c', '#8c1a1a', '#a11d1f', '#c8b79a', '#b3a283', '#2e4a35', '#3d5a45',
  '#6b1e2a', '#35383c',
];

/** Metallic-flake normal map: per-texel random micro-normals, tiled densely so the base coat sparkles under the clearcoat. */
let flakeTex: THREE.DataTexture | null = null;
function flakeNormal() {
  if (flakeTex) return flakeTex;
  const N = 128, data = new Uint8Array(N * N * 4);
  let seed = 987654321;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < N * N; i++) {
    const x = (r() - 0.5) * 0.9, y = (r() - 0.5) * 0.9, z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    data.set([(x * 0.5 + 0.5) * 255, (y * 0.5 + 0.5) * 255, (z * 0.5 + 0.5) * 255, 255], i * 4);
  }
  flakeTex = new THREE.DataTexture(data, N, N);
  flakeTex.wrapS = flakeTex.wrapT = THREE.RepeatWrapping;
  flakeTex.repeat.set(70, 16); // body UV: u spans ~2 car lengths, v spans 2.2 m → ~1 mm flakes
  flakeTex.magFilter = THREE.NearestFilter;
  flakeTex.minFilter = THREE.LinearMipmapLinearFilter;
  flakeTex.generateMipmaps = true;
  flakeTex.needsUpdate = true;
  return flakeTex;
}

export function paintMaterial(color: string, map: THREE.Texture | null, key: string): THREE.MeshPhysicalMaterial {
  return cached(`paint-${key}-${color}`, () => {
    const c = new THREE.Color(color);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    // Whites/creams read as solid paint; everything else is a metallic base coat with flake under a glossy clearcoat.
    const solid = hsl.l > 0.8 || (hsl.s > 0.6 && hsl.h > 0.1 && hsl.h < 0.2);
    return new THREE.MeshPhysicalMaterial({
      color: c,
      map,
      metalness: solid ? 0.05 : 0.62,
      roughness: solid ? 0.36 : 0.34,
      normalMap: solid ? null : flakeNormal(),
      normalScale: new THREE.Vector2(0.22, 0.22),
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      envMapIntensity: 1.15,
    });
  });
}

export const mats = {
  /** Near glass: see-through tinted with env reflections (cabin interior visible behind it). */
  get glass() {
    return cached('glass', () => {
      const m = new THREE.MeshPhysicalMaterial({
        color: 0x10171c, metalness: 0.0, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02,
        ior: 1.5, specularIntensity: 1, envMapIntensity: 2.2,
        transparent: true, opacity: 0.6, depthWrite: false,
      });
      // Fresnel alpha: tinted see-through head-on, mirror-like at grazing angles (like real auto glass).
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>',
          'diffuseColor.a = mix(diffuseColor.a, 1.0, pow(1.0 - saturate(dot(normal, geometryViewDir)), 2.5));\n#include <opaque_fragment>');
      };
      m.customProgramCacheKey = () => 'gt-car-glass';
      return m;
    });
  },
  /** Far LODs have no cabin: keep their glass opaque dark. */
  get glassFar() {
    return cached('glassFar', () => new THREE.MeshPhysicalMaterial({
      color: 0x0b1015, metalness: 0.0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02,
      ior: 1.5, specularIntensity: 1, envMapIntensity: 1.6,
    }));
  },
  get interior() {
    return cached('interior', () => new THREE.MeshStandardMaterial({ map: paletteTexture(), roughness: 0.85, metalness: 0 }));
  },
  get dark() {
    return cached('dark', () => new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.95, metalness: 0 }));
  },
  get trim() {
    return cached('trim', () => new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.55, metalness: 0.1 }));
  },
  get chrome() {
    return cached('chrome', () => new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.1, metalness: 1, envMapIntensity: 1.4 }));
  },
  get rim() {
    return cached('rim', () => new THREE.MeshStandardMaterial({ color: 0xc2c6cc, roughness: 0.26, metalness: 0.95, envMapIntensity: 1.3 }));
  },
  get rimDark() {
    return cached('rimDark', () => new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.5, metalness: 0.6 }));
  },
  get grille() {
    return cached('grille', () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: grilleTex, roughness: 0.6, metalness: 0.4 }));
  },
  get tire() {
    return cached('tire', () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: tireTex, roughness: 0.88, metalness: 0 }));
  },
  headOff: null as unknown as THREE.MeshPhysicalMaterial,
  headOn: null as unknown as THREE.MeshPhysicalMaterial,
  tailOff: null as unknown as THREE.MeshPhysicalMaterial,
  tailRun: null as unknown as THREE.MeshPhysicalMaterial,
  tailBrake: null as unknown as THREE.MeshPhysicalMaterial,
  revOff: null as unknown as THREE.MeshPhysicalMaterial,
  revOn: null as unknown as THREE.MeshPhysicalMaterial,
  redOff: null as unknown as THREE.MeshPhysicalMaterial,
  redOn: null as unknown as THREE.MeshPhysicalMaterial,
  blueOff: null as unknown as THREE.MeshPhysicalMaterial,
  blueOn: null as unknown as THREE.MeshPhysicalMaterial,
  amber: null as unknown as THREE.MeshPhysicalMaterial,
  amberOn: null as unknown as THREE.MeshPhysicalMaterial,
};

function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
/** Headlight insert: chrome reflector bowls, projector lenses and an LED signature strip. */
const headTex = canvasTex(256, 96, (x) => {
  const g = x.createLinearGradient(0, 0, 0, 96);
  g.addColorStop(0, '#9aa0a8'); g.addColorStop(0.5, '#e8ecef'); g.addColorStop(1, '#5b6068');
  x.fillStyle = g; x.fillRect(0, 0, 256, 96);
  for (const cx of [70, 170]) {
    const r = x.createRadialGradient(cx, 52, 2, cx, 52, 30);
    r.addColorStop(0, '#ffffff'); r.addColorStop(0.35, '#c9d0d8'); r.addColorStop(0.7, '#3a3f46'); r.addColorStop(1, '#8c939b');
    x.fillStyle = r; x.beginPath(); x.arc(cx, 52, 30, 0, Math.PI * 2); x.fill();
  }
  x.fillStyle = '#ffffff'; x.fillRect(10, 8, 236, 9);
  x.strokeStyle = '#2a2d31'; x.lineWidth = 4; x.strokeRect(2, 2, 252, 92);
});
/** Emissive mask for the headlight: bright lenses + LED strip. */
const headEm = canvasTex(256, 96, (x) => {
  x.fillStyle = '#2a2a2a'; x.fillRect(0, 0, 256, 96);
  x.fillStyle = '#ffffff'; x.fillRect(10, 8, 236, 9);
  for (const cx of [70, 170]) { x.beginPath(); x.arc(cx, 52, 24, 0, Math.PI * 2); x.fill(); }
});
const tailTex = canvasTex(128, 64, (x) => {
  x.fillStyle = '#7a0a0c'; x.fillRect(0, 0, 128, 64);
  for (let i = 0; i < 6; i++) { x.fillStyle = i % 2 ? '#a3141a' : '#5a0508'; x.fillRect(0, i * 11, 128, 6); }
  x.strokeStyle = '#220203'; x.lineWidth = 4; x.strokeRect(2, 2, 124, 60);
});
export const grilleTex = canvasTex(128, 64, (x) => {
  x.fillStyle = '#050506'; x.fillRect(0, 0, 128, 64);
  x.strokeStyle = '#3a3c40'; x.lineWidth = 1.6;
  for (let r = 0; r < 9; r++) for (let c = 0; c < 17; c++) {
    const cx = c * 8 + (r % 2) * 4, cy = r * 8;
    x.beginPath();
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; x.lineTo(cx + Math.cos(a) * 3.6, cy + Math.sin(a) * 3.6); }
    x.closePath(); x.stroke();
  }
});
/**
 * Tire: lathe UV (u around, v across the profile: sidewall → tread → sidewall). Rubber tone variation,
 * raised sidewall lettering blocks, circumferential grooves + lateral tread blocks, and dust on the shoulders.
 */
const tireTex = canvasTex(512, 64, (x) => {
  x.fillStyle = '#19191b'; x.fillRect(0, 0, 512, 64);
  // v (canvas y, flipped): rows 0-20 & 44-64 sidewalls, 20-44 tread
  x.fillStyle = '#141416'; x.fillRect(0, 21, 512, 22);
  for (let i = 0; i < 128; i++) { x.fillStyle = '#0c0c0d'; x.fillRect(i * 4, 22, 1.6, 20); }
  x.fillStyle = '#0a0a0b'; x.fillRect(0, 27, 512, 1.5); x.fillRect(0, 36, 512, 1.5);
  for (const y0 of [5, 52]) {
    for (let i = 0; i < 512; i += 9) {
      if ((i / 9) % 24 > 15) continue;
      x.fillStyle = (i / 9) % 3 ? '#2c2c2f' : '#333336';
      x.fillRect(i, y0, 6, 6);
    }
  }
  const g = x.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(110,100,85,0.18)'); g.addColorStop(0.3, 'rgba(110,100,85,0.0)');
  g.addColorStop(0.7, 'rgba(110,100,85,0.0)'); g.addColorStop(1, 'rgba(110,100,85,0.18)');
  x.fillStyle = g; x.fillRect(0, 0, 512, 64);
});
grilleTex.wrapS = grilleTex.wrapT = THREE.RepeatWrapping;
grilleTex.repeat.set(4, 1.5);

function lens(color: number, emissive: number, intensity: number, rough = 0.08, map?: THREE.Texture, emap?: THREE.Texture) {
  return new THREE.MeshPhysicalMaterial({
    color, emissive, emissiveIntensity: intensity, roughness: rough, metalness: 0.2,
    clearcoat: 1, clearcoatRoughness: 0.03, map: map ?? null, emissiveMap: emap ?? null,
  });
}
mats.headOff = lens(0xffffff, 0xfff2dc, 0, 0.1, headTex, headEm);
mats.headOn = lens(0xffffff, 0xfff2dc, 3, 0.1, headTex, headEm);
mats.tailOff = lens(0xffffff, 0xff1208, 0, 0.12, tailTex, tailTex);
mats.tailRun = lens(0xffffff, 0xff1208, 0.6, 0.12, tailTex, tailTex);
mats.tailBrake = lens(0xffffff, 0xff1208, 4, 0.12, tailTex, tailTex);
mats.revOff = lens(0x6a6d72, 0xffffff, 0, 0.05);
mats.revOn = lens(0xffffff, 0xffffff, 3);
mats.redOff = lens(0x4a0508, 0xff0a14, 0.05, 0.15);
mats.redOn = lens(0xff2020, 0xff0a14, 9, 0.15);
mats.blueOff = lens(0x05103a, 0x1f45ff, 0.05, 0.15);
mats.blueOn = lens(0x3050ff, 0x1f45ff, 11, 0.15);
mats.amber = lens(0x8a4a05, 0xff8a10, 0.0, 0.12);
mats.amberOn = lens(0xffa030, 0xff8a10, 6, 0.12);

/** Update shared light materials each frame from the night factor. */
export function updateSharedLightMaterials(night: number) {
  mats.headOn.emissiveIntensity = 1.5 + night * 5;
  mats.tailRun.emissiveIntensity = 0.25 + night * 1.6;
  mats.tailBrake.emissiveIntensity = 3.5 + night * 3;
  mats.revOn.emissiveIntensity = 2 + night * 3;
  mats.amberOn.emissiveIntensity = 4 + night * 3;
  beamMaterial().opacity = 0.55 * Math.min(1, night * 1.4);
}

let beamMat: THREE.MeshBasicMaterial | null = null;
/** Additive ground light pool cast by headlights (cheap stand-in for a spotlight on every car). */
export function beamMaterial() {
  if (beamMat) return beamMat;
  const t = canvasTex(64, 128, (x) => {
    // local: canvas top = far end of the beam, bottom = bumper
    const img = x.createImageData(64, 128);
    for (let j = 0; j < 128; j++) for (let i = 0; i < 64; i++) {
      const v = 1 - j / 127; // 0 at bumper, 1 far
      const u = (i / 63 - 0.5) * 2;
      const spread = 0.25 + v * 0.75;
      const lat = Math.max(0, 1 - (u / spread) ** 2);
      const along = Math.min(1, v * 7) * (1 - v) ** 1.3;
      const a = lat * along;
      const k = (j * 64 + i) * 4;
      img.data[k] = 255; img.data[k + 1] = 236; img.data[k + 2] = 205; img.data[k + 3] = Math.round(255 * a);
    }
    x.putImageData(img, 0, 0);
  });
  beamMat = new THREE.MeshBasicMaterial({ map: t, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  beamMat.name = 'veh-beam';
  return beamMat;
}

// ---------- Canvas textures ----------

let plateAtlas: THREE.CanvasTexture | null = null;
export const PLATE_CELLS = 16;
/** 4×4 atlas of generic license plates (no real state designs). */
export function plateTexture(): THREE.CanvasTexture {
  if (plateAtlas) return plateAtlas;
  const cw = 256, ch = 128;
  const cv = document.createElement('canvas');
  cv.width = cw * 4; cv.height = ch * 4;
  const x = cv.getContext('2d')!;
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  let seed = 1234567;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const styles = [
    { bg: '#f3f1ea', fg: '#1b2a6b', band: '#b3202a' },
    { bg: '#f6f4ec', fg: '#1a1a1a', band: '#2a5a9a' },
    { bg: '#fbf6df', fg: '#6b1414', band: '#6b1414' },
    { bg: '#eef3f6', fg: '#123a2a', band: '#2c7a4a' },
  ];
  for (let i = 0; i < PLATE_CELLS; i++) {
    const ox = (i % 4) * cw, oy = Math.floor(i / 4) * ch;
    const s = styles[i % styles.length];
    x.fillStyle = s.bg; x.fillRect(ox, oy, cw, ch);
    x.strokeStyle = '#444'; x.lineWidth = 4; x.strokeRect(ox + 3, oy + 3, cw - 6, ch - 6);
    x.fillStyle = s.band; x.fillRect(ox + 8, oy + 8, cw - 16, 16);
    let txt = '';
    const pattern = i % 3;
    for (let k = 0; k < 7; k++) {
      if (pattern === 0) txt += k === 0 ? String(1 + Math.floor(r() * 9)) : k < 4 ? L[Math.floor(r() * L.length)] : String(Math.floor(r() * 10));
      else if (pattern === 1) txt += k < 3 ? L[Math.floor(r() * L.length)] : k === 3 ? '-' : String(Math.floor(r() * 10));
      else txt += k < 3 ? String(Math.floor(r() * 10)) : k === 3 ? ' ' : L[Math.floor(r() * L.length)];
    }
    x.fillStyle = s.fg;
    x.font = 'bold 64px "Arial Narrow", Arial, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(txt, ox + cw / 2, oy + ch / 2 + 12, cw - 24);
  }
  plateAtlas = new THREE.CanvasTexture(cv);
  plateAtlas.colorSpace = THREE.SRGBColorSpace;
  plateAtlas.anisotropy = 4;
  return plateAtlas;
}

export function plateMaterial() {
  return cached('plate', () => new THREE.MeshStandardMaterial({ map: plateTexture(), roughness: 0.45, metalness: 0.3 }));
}
