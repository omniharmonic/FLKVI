// OWNER: compiler agent. Style rules engine: (region, era, use, levels, footprint, neighborhood) → kit + materials + palette.
import type { Region, Climate, Era, BuildingUse, StyleKit, FacadeMaterial, RoofMaterial, RoofType } from '../core/types.ts';
import { rng, hashString } from '../core/geo.ts';
import type { Locale } from './region.ts';

export interface StyleInput {
  region: Region; climate: Climate; era: Era; use: BuildingUse; levels: number; area: number;
  roof: RoofType; /** 0..1 local building density (fraction of 60 m disc covered) */ density: number;
  /** Seed shared by buildings of the same block/era/use (neighborhood coherence). */ familySeed: number;
  seed: number; tags: Record<string, string>; amenity?: string;
  /** 0..1 coverage over ≈300 m (whole-neighbourhood urbanity). */ urban?: number;
  locale?: Locale;
}
export interface StyleOut { kit: StyleKit; material: FacadeMaterial; color: string; roofMaterial: RoofMaterial; roofColor: string }

type W<T> = [T, number][];
function pick<T>(opts: W<T>, r: number): T {
  let tot = 0; for (const [, w] of opts) tot += w;
  let x = r * tot;
  for (const [v, w] of opts) { x -= w; if (x <= 0) return v; }
  return opts[opts.length - 1][0];
}

// Facade palettes per material (believable, slightly desaturated real-world tones).
const MATERIAL_COLORS: Record<FacadeMaterial, string[]> = {
  'brick-red': ['#8e4a37', '#9b5139', '#7f3f2f', '#a4583f', '#88452f'],
  'brick-brown': ['#6f4a38', '#7a5440', '#5f4033', '#80583f'],
  'brick-tan': ['#b8946b', '#c2a078', '#a98760', '#cdb08a'],
  'brick-painted': ['#e8e2d6', '#d9d2c3', '#c9c8c0', '#7d8a86', '#a3413a', '#3f4f5c', '#d8c49a'],
  stucco: ['#e6dcc8', '#d8c7a6', '#efe6d4', '#cfb996', '#e2cfb2', '#d4b58e', '#f0ebe0', '#c9a27a'],
  'lap-siding': ['#e9e6dd', '#c8cfc9', '#9fb0b4', '#6f8c96', '#d8cfae', '#b8a58a', '#a7b59a', '#5f6e7a', '#f2efe6', '#8a4b3f'],
  'board-batten': ['#ecebe6', '#3d4247', '#6b6f68', '#a39e8f'],
  stone: ['#a9a295', '#9a9184', '#bdb5a6', '#8b8579'],
  sandstone: ['#c49a74', '#b8866a', '#caa382', '#a87559'],
  concrete: ['#b3b0a9', '#a09d96', '#c2bfb8', '#8f8c86'],
  'glass-curtain': ['#5d7482', '#4f6572', '#6f8794', '#40515c', '#7a8f99'],
  'metal-panel': ['#9aa1a6', '#7e878d', '#c4c7c6', '#5f666b', '#b5a58c'],
  adobe: ['#c49a6c', '#b98a5c', '#d0a878', '#a97c55'],
  'wood-shingle': ['#8d7157', '#9b8266', '#6f5a47', '#a9967c'],
};

// Vernacular paint palettes: French Quarter / Marigny (earthy pastels) and Miami Beach deco (sherbet + white).
const PASTELS: Record<'creole' | 'miami', string[]> = {
  creole: ['#e3b98e', '#d79a8a', '#a8c2ad', '#e4d08a', '#9db3c4', '#c98e66', '#efe4cc', '#8fae94', '#d8b4c4', '#b8a0c9', '#e8c3a0', '#7fa4a0'],
  miami: ['#f3e9d9', '#f6d7c9', '#bfe3d6', '#f4e1a1', '#c9ddee', '#f2c6cf', '#fdfbf5', '#e9d3ef', '#fbe3c4', '#d8efe3'],
};

const ROOF_COLORS: Record<RoofMaterial, string[]> = {
  'asphalt-shingle': ['#4a4a4a', '#5a5550', '#3e3f42', '#6b5f55', '#555c60', '#7a6c5e'],
  'clay-tile': ['#a4553a', '#b5643f', '#9a4f36', '#c07550'],
  'standing-seam': ['#5d6b6f', '#7a2e2a', '#3f4a44', '#8f9597', '#2f3a45'],
  slate: ['#4b5057', '#565b63', '#3f444a'],
  membrane: ['#b9b9b4', '#9c9c98', '#d2d2cc', '#8a8a86'],
  gravel: ['#8e8a82', '#7d7a73', '#9a958c'],
};

/** Locale-specific vernaculars (null → fall through to the regional rules). */
function localeKit(i: StyleInput, r: () => number, old: boolean, core: boolean): StyleKit | null {
  const { use, levels, era, area } = i;
  const resi = use === 'residential-single' || use === 'residential-multi';
  const shopish = use === 'commercial' || use === 'mixed-use';
  switch (i.locale) {
    case 'creole': {
      // Creole cottages, shotguns, and 2–4 story balconied townhouses; the odd modern infill.
      if (!(resi || shopish) || levels > 5 || (shopish && area > 2500)) return null;
      if (!old && era !== '1900-1939' && r() < (era === '2000+' ? 0.45 : 0.15)) return null;
      if (levels <= 1) return pick<StyleKit>([['victorian', 3], ['colonial', 2]], r());
      if (use === 'residential-single' && levels === 2) return pick<StyleKit>([['colonial', 1.2], ['main-street-block', 1], ['victorian', 1]], r());
      return 'main-street-block';
    }
    case 'miami': {
      if (use === 'residential-single' && !core) return pick<StyleKit>([['mediterranean', 3], ['ranch', 1], ['modern-infill', 0.6]], r());
      if (!(resi || shopish || use === 'office') || levels > 8) return null;
      if (old) return pick<StyleKit>([['art-deco', 3], ['mediterranean', 1.5]], r());
      if (era === '1940-1969') return pick<StyleKit>([['art-deco', 1], ['modern-infill', 2], ['mediterranean', 1]], r());
      return null;
    }
    case 'bay': {
      if (!resi || levels > 5 || (!core && use === 'residential-single' && !old)) return null;
      if (old) return pick<StyleKit>([['victorian', 4], ['mediterranean', 1]], r());
      if (era === '1940-1969' || era === '1970-1999') return pick<StyleKit>([['mediterranean', 2], ['modern-infill', 1]], r());
      return levels >= 4 ? 'podium-mixed-use' : 'modern-infill';
    }
    case 'pnw': {
      if (!resi || levels > 6) return null;
      if (use === 'residential-single' && levels <= 3) return old ? pick<StyleKit>([['craftsman', 3], ['victorian', 1]], r()) : null;
      return old ? pick<StyleKit>([['main-street-block', 2], ['brownstone', 1]], r()) : null;
    }
    case 'lowcountry': {
      if (!resi || levels > 5) return null;
      if (old) return core ? pick<StyleKit>([['brownstone', 2], ['colonial', 2], ['victorian', 1]], r()) : pick<StyleKit>([['colonial', 2], ['victorian', 1.5]], r());
      return null;
    }
  }
  return null;
}

function kitFor(i: StyleInput, r: () => number): StyleKit {
  const { region, era, use, levels, area, density } = i;
  const old = era === 'pre-1900' || era === '1900-1939';
  const t = i.tags;
  if (i.amenity === 'fuel') return 'gas-station';
  // city core: locally dense, or inside a built-up district (no garden apartments / ranches there)
  const core = density > 0.4 || (i.urban ?? 0) > 0.28;
  const lk = localeKit(i, r, old, core);
  if (lk) return lk;
  const sunbelt = region === 'southwest' || region === 'south-central' || region === 'southeast' || i.locale === 'socal';
  switch (use) {
    case 'parking': return 'parking-garage';
    case 'civic': return levels >= 6 ? 'masonry-tower' : 'civic';
    case 'school': return 'school';
    case 'religious': return 'worship';
    case 'hospital': return levels >= 5 ? (old ? 'masonry-tower' : 'curtain-wall-tower') : 'civic';
    case 'industrial':
    case 'agricultural':
      return old || (region === 'northeast' && era === '1940-1969') ? 'brick-warehouse' : pick<StyleKit>([['metal-shed', 3], ['brick-warehouse', era === '1940-1969' ? 2 : 0.3]], r());
    case 'office':
      if (levels >= 12) return old ? pick<StyleKit>([['art-deco', 1], ['masonry-tower', 1.5]], r()) : era === '1940-1969' ? 'curtain-wall-tower' : era === '1970-1999' ? pick<StyleKit>([['curtain-wall-tower', 2], ['glass-tower', 1]], r()) : 'glass-tower';
      if (levels >= 5) return old ? pick<StyleKit>([['masonry-tower', 2], ['art-deco', 1]], r()) : era === '2000+' ? pick<StyleKit>([['modern-infill', 2], ['glass-tower', 1]], r()) : 'curtain-wall-tower';
      return old ? 'main-street-block' : density < 0.25 ? 'office-park' : 'modern-infill';
    case 'commercial':
    case 'mixed-use':
      if (levels >= 12) return old ? 'masonry-tower' : era === '2000+' ? 'glass-tower' : 'curtain-wall-tower';
      if (levels <= 2 && area > 6000) return 'big-box';
      if (old) return levels >= 6 ? pick<StyleKit>([['art-deco', 1], ['masonry-tower', 1]], r()) : 'main-street-block';
      if (era === '2000+') return levels >= 3 ? 'podium-mixed-use' : 'modern-infill';
      if (levels <= 2 && density < 0.3 && area > 600) return 'strip-mall';
      if (levels <= 3) return density > 0.35 ? 'main-street-block' : 'strip-mall';
      return era === '1940-1969' ? 'masonry-tower' : 'modern-infill';
    case 'residential-multi':
      if (levels >= 12) return old ? 'masonry-tower' : era === '2000+' ? 'glass-tower' : 'curtain-wall-tower';
      if (old) {
        if (region === 'northeast' || (region === 'midwest' && density > 0.45)) return levels <= 6 ? 'brownstone' : 'masonry-tower';
        if (i.locale === 'socal') return levels <= 4 ? 'mediterranean' : 'masonry-tower';
        if (region === 'pacific') return levels <= 4 ? 'victorian' : 'masonry-tower';
        if (region === 'south-central' || region === 'southeast') return levels <= 5 ? (density > 0.4 ? pick<StyleKit>([['main-street-block', 2], ['colonial', 1]], r()) : 'colonial') : 'masonry-tower';
        if (region === 'southwest') return levels <= 4 ? pick<StyleKit>([['main-street-block', 2], ['pueblo', 1], ['mediterranean', 1]], r()) : 'masonry-tower';
        return levels <= 4 ? (core ? 'brownstone' : pick<StyleKit>([['brownstone', 1], ['main-street-block', 1]], r())) : 'masonry-tower';
      }
      if (era === '1940-1969' || era === '1970-1999') {
        if (levels > 4) return 'masonry-tower';
        if (core) return sunbelt || region === 'pacific' ? pick<StyleKit>([['mediterranean', 2], ['modern-infill', 1]], r()) : pick<StyleKit>([['main-street-block', 2], ['modern-infill', 1]], r());
        return region === 'southwest' ? pick<StyleKit>([['garden-apartments', 2], ['pueblo', 1]], r()) : 'garden-apartments';
      }
      return levels >= 4 ? 'podium-mixed-use' : 'modern-infill';
    case 'residential-single':
    default: {
      if (area < 45) return 'generic';
      if (core && old && region === 'northeast') return pick<StyleKit>([['brownstone', 3], ['colonial', 1]], r());
      if (core && old && region === 'midwest') return pick<StyleKit>([['brownstone', 2], ['victorian', 1]], r());
      if (core && !old && region !== 'southwest') {
        // infill houses in a city core: rowhouse-ish, never ranch / cul-de-sac suburban
        if (era === '2000+') return 'modern-infill';
        if (region === 'northeast' || region === 'midwest') return pick<StyleKit>([['main-street-block', 1], ['brownstone', 1]], r());
        return pick<StyleKit>([['mediterranean', region === 'pacific' || sunbelt ? 2 : 0.3], ['modern-infill', 1], ['colonial', sunbelt ? 0.8 : 0]], r());
      }
      if (density > 0.4 && (region === 'south-central' || region === 'southeast') && old) return pick<StyleKit>([['colonial', 2], ['victorian', 1], ['main-street-block', 1]], r());
      if (region === 'southwest') return old ? pick<StyleKit>([['pueblo', 2], ['mediterranean', 1.5], ['craftsman', 0.5]], r()) : era === '2000+' ? pick<StyleKit>([['mediterranean', 2], ['contemporary-suburban', 1], ['pueblo', 1]], r()) : pick<StyleKit>([['ranch', 3], ['pueblo', 1]], r());
      if (old) {
        if (era === 'pre-1900') return region === 'northeast' || region === 'southeast' ? pick<StyleKit>([['victorian', 2], ['colonial', 1.5]], r()) : 'victorian';
        if (region === 'pacific') return pick<StyleKit>([['craftsman', 2], ['victorian', 1.2], ['mediterranean', 1]], r());
        if (region === 'northeast') return pick<StyleKit>([['colonial', 2], ['victorian', 1], ['craftsman', 1]], r());
        if (region === 'south-central' || region === 'southeast') return pick<StyleKit>([['craftsman', 2], ['victorian', 1], ['colonial', 1]], r());
        return pick<StyleKit>([['craftsman', 3], ['victorian', 1]], r());
      }
      if (era === '1940-1969') return levels >= 2 && region === 'northeast' ? 'colonial' : 'ranch';
      if (era === '1970-1999') return pick<StyleKit>([['ranch', 1], ['contemporary-suburban', 2], ['colonial', region === 'northeast' || region === 'southeast' ? 1 : 0.2]], r());
      return density > 0.35 ? 'modern-infill' : 'contemporary-suburban';
    }
  }
}

function materialFor(kit: StyleKit, i: StyleInput, r: () => number): FacadeMaterial {
  const { region, era } = i;
  const warm = region === 'southwest' || region === 'pacific' || region === 'south-central';
  const t = i.tags['building:material'] || i.tags['building:facade:material'];
  if (t) {
    const m: Record<string, FacadeMaterial> = { brick: 'brick-red', stone: 'stone', sandstone: 'sandstone', concrete: 'concrete', glass: 'glass-curtain', wood: 'lap-siding', timber_framing: 'board-batten', plaster: 'stucco', stucco: 'stucco', metal: 'metal-panel', adobe: 'adobe', limestone: 'stone', steel: 'metal-panel', cement_block: 'concrete', vinyl: 'lap-siding' };
    if (m[t]) return m[t];
  }
  if (i.locale === 'creole') {
    if (kit === 'main-street-block') return pick<FacadeMaterial>([['stucco', 3], ['brick-painted', 2], ['brick-red', 1.2]], r());
    if (kit === 'colonial') return pick<FacadeMaterial>([['stucco', 2], ['lap-siding', 2], ['brick-painted', 0.6]], r());
    if (kit === 'victorian') return 'lap-siding';
  }
  if (i.locale === 'miami' && (kit === 'art-deco' || kit === 'modern-infill' || kit === 'main-street-block' || kit === 'masonry-tower')) return pick<FacadeMaterial>([['stucco', 4], ['concrete', 1]], r());
  switch (kit) {
    case 'ranch': return pick<FacadeMaterial>([['brick-red', region === 'south-central' || region === 'southeast' || region === 'midwest' ? 2 : 1], ['brick-tan', 1], ['lap-siding', 2], ['stucco', warm ? 3 : 0.4]], r());
    case 'craftsman': return pick<FacadeMaterial>([['lap-siding', 3], ['wood-shingle', region === 'pacific' || region === 'northeast' ? 1 : 0.3], ['brick-red', region === 'midwest' || region === 'mountain-west' ? 1.5 : 0.4], ['stucco', warm ? 1 : 0]], r());
    case 'victorian': return pick<FacadeMaterial>([['lap-siding', 3], ['brick-red', region === 'mountain-west' || region === 'midwest' ? 2 : region === 'pacific' ? 0 : 0.5], ['wood-shingle', 0.5], ['stucco', region === 'pacific' ? 0.6 : 0]], r());
    case 'colonial': return pick<FacadeMaterial>([['lap-siding', 2], ['brick-red', 2], ['brick-painted', 0.7], ['stucco', region === 'south-central' ? 1.5 : 0]], r());
    case 'contemporary-suburban': return pick<FacadeMaterial>([['lap-siding', 2], ['stucco', warm ? 3 : 1], ['stone', 0.4], ['brick-tan', 0.6]], r());
    case 'modern-infill': return pick<FacadeMaterial>([['board-batten', 1], ['metal-panel', 1.2], ['concrete', 0.8], ['brick-brown', 1], ['stucco', warm ? 1 : 0.3], ['glass-curtain', 0.4]], r());
    case 'pueblo': return pick<FacadeMaterial>([['adobe', 2], ['stucco', 3]], r());
    case 'mediterranean': return 'stucco';
    case 'brownstone': return pick<FacadeMaterial>([['sandstone', region === 'northeast' ? 2 : 0.5], ['brick-brown', 1.5], ['brick-red', 1.5]], r());
    case 'garden-apartments': return pick<FacadeMaterial>([['brick-red', region === 'northeast' || region === 'midwest' ? 2 : 0.8], ['brick-tan', 1], ['stucco', warm ? 2 : 0.5], ['lap-siding', 1]], r());
    case 'podium-mixed-use': return pick<FacadeMaterial>([['metal-panel', 1.5], ['brick-brown', 1], ['board-batten', 1], ['stucco', warm ? 1 : 0.3], ['concrete', 0.5]], r());
    case 'main-street-block':
      if (region === 'south-central' && i.density > 0.4) return pick<FacadeMaterial>([['stucco', 2], ['brick-painted', 2], ['brick-red', 1]], r());
      if (region === 'southwest') return pick<FacadeMaterial>([['stucco', 2], ['brick-tan', 1], ['brick-painted', 1]], r());
      if (region === 'pacific' && i.locale !== 'pnw') return pick<FacadeMaterial>([['stucco', 2.5], ['brick-painted', 1.5], ['lap-siding', 1], ['brick-red', 0.3], ['concrete', 0.5]], r());
      return pick<FacadeMaterial>([['brick-red', 3], ['brick-brown', 1.2], ['brick-tan', 1], ['brick-painted', 1.3], ['stone', era === 'pre-1900' ? 0.8 : 0.3], ['sandstone', region === 'mountain-west' ? 0.8 : 0.1]], r());
    case 'art-deco': return pick<FacadeMaterial>([['stone', 2], ['brick-tan', 1], ['concrete', 1]], r());
    case 'strip-mall': return pick<FacadeMaterial>([['stucco', warm ? 3 : 1], ['brick-tan', 1], ['concrete', 1]], r());
    case 'big-box': return pick<FacadeMaterial>([['concrete', 2], ['metal-panel', 1], ['stucco', 1]], r());
    case 'gas-station': return 'metal-panel';
    case 'office-park': return pick<FacadeMaterial>([['concrete', 1], ['glass-curtain', 1], ['brick-tan', 1], ['stucco', warm ? 1 : 0]], r());
    case 'masonry-tower': return pick<FacadeMaterial>([['brick-red', 1.5], ['brick-tan', 1], ['stone', 1.5], ['concrete', 1]], r());
    case 'curtain-wall-tower': return pick<FacadeMaterial>([['glass-curtain', 2], ['concrete', 1], ['metal-panel', 1]], r());
    case 'glass-tower': return 'glass-curtain';
    case 'brick-warehouse': return pick<FacadeMaterial>([['brick-red', 3], ['brick-brown', 1], ['brick-painted', 1]], r());
    case 'metal-shed': return pick<FacadeMaterial>([['metal-panel', 3], ['concrete', 1]], r());
    case 'parking-garage': return 'concrete';
    case 'civic': return pick<FacadeMaterial>([['stone', 2], ['brick-red', 1.5], ['sandstone', region === 'mountain-west' ? 1.5 : 0.3], ['concrete', 1], ['stucco', warm ? 1.5 : 0]], r());
    case 'school': return pick<FacadeMaterial>([['brick-red', 2], ['brick-tan', 1.5], ['concrete', 0.5], ['stucco', warm ? 1.5 : 0]], r());
    case 'worship': return pick<FacadeMaterial>([['stone', 2], ['brick-red', 2], ['sandstone', region === 'mountain-west' ? 1 : 0.2], ['stucco', warm ? 1.5 : 0.2]], r());
    default: return pick<FacadeMaterial>([['lap-siding', 1], ['stucco', warm ? 1 : 0.3], ['concrete', 0.3]], r());
  }
}

export function resolveStyle(i: StyleInput): StyleOut {
  // family rng drives choices shared across a block; building rng adds variation.
  const fam = rng(i.familySeed);
  const own = rng(i.seed ^ 0x9e3779b9);
  const coherent = own() < 0.7; // 70 % of buildings follow the family style
  const r = coherent ? fam : own;
  const kit = kitFor(i, r);
  const matR = coherent ? rng(i.familySeed ^ hashString(kit)) : own;
  const material = materialFor(kit, i, matR);
  const pastel = (i.locale === 'creole' || i.locale === 'miami') && (material === 'stucco' || material === 'lap-siding' || material === 'brick-painted');
  const cols = pastel ? PASTELS[i.locale as 'creole' | 'miami'] : MATERIAL_COLORS[material];
  const color = jitterColor(cols[Math.floor(own() * cols.length)], own, material === 'glass-curtain' ? 0.03 : 0.06);
  let roofMaterial: RoofMaterial;
  if (i.roof === 'flat') roofMaterial = own() < 0.6 ? 'membrane' : 'gravel';
  else if (i.tags['roof:material']) {
    const m: Record<string, RoofMaterial> = { roof_tiles: 'clay-tile', tile: 'clay-tile', metal: 'standing-seam', slate: 'slate', asphalt: 'asphalt-shingle', tar_paper: 'membrane', concrete: 'membrane', gravel: 'gravel', copper: 'standing-seam' };
    roofMaterial = m[i.tags['roof:material']] ?? 'asphalt-shingle';
  } else if (kit === 'mediterranean' || kit === 'pueblo' || (i.region === 'southwest' && own() < 0.5) || (i.region === 'pacific' && i.climate !== 'humid' && own() < 0.35)) roofMaterial = 'clay-tile';
  else if (kit === 'victorian' && own() < 0.3) roofMaterial = 'slate';
  else if ((kit === 'metal-shed' || kit === 'brick-warehouse' || kit === 'modern-infill' || kit === 'gas-station') || (i.region === 'mountain-west' && own() < 0.08)) roofMaterial = 'standing-seam';
  else if (kit === 'worship' || kit === 'civic') roofMaterial = own() < 0.5 ? 'slate' : 'asphalt-shingle';
  else roofMaterial = 'asphalt-shingle';
  const rc = ROOF_COLORS[roofMaterial];
  const roofColor = i.tags['roof:colour'] && /^#[0-9a-f]{6}$/i.test(i.tags['roof:colour']) ? i.tags['roof:colour'].toLowerCase() : jitterColor(rc[Math.floor((coherent ? fam() : own()) * rc.length)], own, 0.05);
  let finalColor = color;
  const bc = i.tags['building:colour'];
  if (bc && /^#[0-9a-f]{6}$/i.test(bc)) finalColor = bc.toLowerCase();
  else if (bc && NAMED[bc.toLowerCase()]) finalColor = NAMED[bc.toLowerCase()];
  return { kit, material, color: finalColor, roofMaterial, roofColor };
}

const NAMED: Record<string, string> = {
  white: '#ebe8e1', grey: '#9a9a96', gray: '#9a9a96', red: '#9b4a3a', brown: '#6f5140', beige: '#d8c6a4', yellow: '#dcc27a',
  tan: '#c2a57e', black: '#3a3a3a', blue: '#5f7a92', green: '#6e836a', cream: '#efe5cc', orange: '#c47a44', pink: '#d7a9a0',
};

function jitterColor(hex: string, r: () => number, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = 1 + (r() - 0.5) * 2 * amt;
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f + (r() - 0.5) * amt * 40)));
  const rr = ch((n >> 16) & 255), gg = ch((n >> 8) & 255), bb = ch(n & 255);
  return '#' + ((1 << 24) | (rr << 16) | (gg << 8) | bb).toString(16).slice(1);
}
