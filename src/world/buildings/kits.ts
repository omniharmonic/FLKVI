// Style kits → resolved per-building facade parameters. Seeded by building.seed so a building always
// looks the same. Kits (Asset Spec §4) share one grammar (facade.ts) driven by these parameters.
import * as THREE from 'three';
import type { RecipeBuilding, StyleKit, FacadeMaterial, Region } from '../../core/types';
import { rng } from '../../core/geo';

export type Ground = 'storefront' | 'residential' | 'lobby' | 'same' | 'blank' | 'loading' | 'parking';
export type Pattern = 'punched' | 'paired' | 'ribbon' | 'curtain' | 'parking' | 'blank';
export type Cornice = 'none' | 'simple' | 'bracketed' | 'corbel' | 'modern' | 'deco' | 'classical';
export type Porch = 'none' | 'craftsman' | 'victorian' | 'farm' | 'stoop' | 'portico' | 'colonnade' | 'stoop-small';
export type Lintel = 'none' | 'flat' | 'stone' | 'keystone' | 'soldier' | 'wood' | 'hood';

export interface Style {
  kit: StyleKit;
  wallTex: string;
  wallColor: THREE.Color;
  /** Secondary facade texture for base / accent panels (podium, modern). */
  accentTex: string | null;
  accentColor: THREE.Color;
  trim: THREE.Color;
  sash: THREE.Color;
  stone: THREE.Color;
  groundH: number;
  floorH: number;
  /** Raised first floor (foundation) height, residential. */
  foundation: number;
  win: {
    pattern: Pattern;
    w: number; h: number;
    /** sill height above floor */
    sill: number;
    bay: number;
    /** windows per bay (paired = 2) */
    group: number;
    muntin: number;
    reveal: number;
    casing: boolean;
    sillType: 'none' | 'thin' | 'stone';
    lintel: Lintel;
    shutters: boolean;
    /** interior kind for the shader */
    kind: number;
    /** 0 = clear glass, >0 reflective coating (fraction) */
    reflect: number;
  };
  ground: Ground;
  cornice: Cornice;
  corniceH: number;
  parapet: number;
  coping: boolean;
  stringCourse: boolean;
  floorBands: boolean;
  pilasters: boolean;
  cornerPiers: boolean;
  quoins: boolean;
  balconies: number;
  fireEscape: boolean;
  porch: Porch;
  garage: number;
  chimney: boolean;
  eave: number;
  awnings: boolean;
  awningColors: THREE.Color[];
  awningStriped: boolean;
  signStyle: number;
  vigas: boolean;
  canopy: boolean;
  rooftop: 'hvac' | 'tank' | 'none' | 'mech';
  sideWindows: number; // probability that non-street edges get windows
  steeple: boolean;
  blankSides: boolean;
}

const C = (h: string) => new THREE.Color(h);
const pick = <T>(r: () => number, a: T[]): T => a[Math.floor(r() * a.length) % a.length];
const range = (r: () => number, a: number, b: number) => a + (b - a) * r();

const TRIM_LIGHT = ['#f1eee6', '#ebe4d2', '#f4f1ea', '#e3dccb'];
const TRIM_DARK = ['#2b3a2f', '#2a2a2a', '#4a2a22', '#33404a', '#5b4636'];
const AWNING = ['#1f4d3a', '#7b1e1e', '#16324f', '#2e2e2e', '#6b4f2a', '#8a2f3c', '#3f5f3a', '#b88a3a', '#4b3f5e'];
const SIGN_WORDS = ['CAFE', 'BOOKS', 'GALLERY', 'BAKERY', 'OUTFITTERS', 'TAVERN', 'JEWELRY', 'BOUTIQUE', 'DELI', 'TOYS', 'PHARMACY', 'DINER', 'KITCHEN', 'MERCANTILE', 'FLOWERS', 'COFFEE', 'SHOES', 'ANTIQUES', 'MUSIC', 'OPTICAL', 'CYCLES', 'TEA HOUSE', 'WINE & SPIRITS', 'HARDWARE', 'BARBER', 'SALON', 'PIZZA', 'NOODLES', 'TACOS', 'GIFTS', 'THREADS', 'MARKET'];
export function signWord(b: RecipeBuilding, r: () => number): string {
  const s = b.signage?.trim();
  if (s && !/^(SHOP|FOOD|HOME|STORE)$/i.test(s)) return s.toUpperCase().slice(0, 22);
  return pick(r, SIGN_WORDS);
}

function eraMuntin(r: () => number, era: RecipeBuilding['era'], kit: StyleKit): number {
  switch (era) {
    case 'pre-1900': return pick(r, [4, 4, 2, 1]);
    case '1900-1939': return kit === 'craftsman' ? 3 : pick(r, [1, 1, 3, 4]);
    case '1940-1969': return pick(r, [1, 1, 6, 8]);
    case '1970-1999': return pick(r, [8, 1, 1, 0]);
    default: return kit === 'contemporary-suburban' || kit === 'colonial' ? pick(r, [2, 1, 2]) : pick(r, [0, 0, 1, 6]);
  }
}

function matToTex(m: FacadeMaterial): string {
  return m === 'glass-curtain' ? 'glass-curtain' : m;
}

function base(b: RecipeBuilding, r: () => number): Style {
  const wallColor = C(b.color || '#b0a590');
  return {
    kit: b.kit,
    wallTex: matToTex(b.material),
    wallColor,
    accentTex: null,
    accentColor: C('#9a9a96'),
    trim: C(pick(r, TRIM_LIGHT)),
    sash: C(pick(r, TRIM_LIGHT)),
    stone: C(pick(r, ['#c9c0ad', '#bdb5a3', '#d3cbb8', '#b9ad98'])),
    groundH: 3.0, floorH: 3.0, foundation: 0,
    win: { pattern: 'punched', w: 1.0, h: 1.5, sill: 0.85, bay: 3.0, group: 1, muntin: eraMuntin(r, b.era, b.kit), reveal: 0.12, casing: false, sillType: 'thin', lintel: 'none', shutters: false, kind: 0, reflect: 0 },
    ground: 'same', cornice: 'none', corniceH: 0.3, parapet: 0, coping: false, stringCourse: false, floorBands: false,
    pilasters: false, cornerPiers: false, quoins: false, balconies: 0, fireEscape: false, porch: 'none', garage: 0,
    chimney: false, eave: 0.4, awnings: false, awningColors: [C(pick(r, AWNING))], awningStriped: false, signStyle: Math.floor(r() * 8),
    vigas: false, canopy: false, rooftop: 'none', sideWindows: 1, steeple: false, blankSides: false,
  };
}

const isPitched = (b: RecipeBuilding) => b.roof.type !== 'flat';

export function resolveStyle(b: RecipeBuilding, region: Region = 'mountain-west'): Style {
  const r = rng(b.seed ^ 0x5bd1e995);
  const s = base(b, r);
  const w = s.win;
  const pre40 = b.era === 'pre-1900' || b.era === '1900-1939';
  let kit: StyleKit = b.kit;
  if (kit === 'generic') {
    kit = b.use === 'residential-single' ? (b.era === '2000+' || b.era === '1970-1999' ? 'contemporary-suburban' : 'ranch')
      : b.use === 'residential-multi' ? (b.levels >= 5 ? 'podium-mixed-use' : 'garden-apartments')
      : b.use === 'commercial' || b.use === 'mixed-use' ? (b.levels >= 5 ? 'podium-mixed-use' : pre40 ? 'main-street-block' : 'strip-mall')
      : b.use === 'office' ? (b.levels >= 10 ? 'glass-tower' : 'office-park')
      : b.use === 'industrial' ? (pre40 ? 'brick-warehouse' : 'metal-shed')
      : b.use === 'parking' ? 'parking-garage'
      : b.use === 'religious' ? 'worship'
      : b.use === 'school' ? 'school'
      : b.use === 'civic' || b.use === 'hospital' ? 'civic'
      : 'generic';
    s.kit = kit;
  }
  switch (kit) {
    case 'main-street-block': {
      s.groundH = range(r, 4.1, 4.6); s.floorH = range(r, 3.5, 4.0);
      Object.assign(w, { w: range(r, 0.95, 1.15), h: range(r, 1.9, 2.3), sill: 0.8, bay: range(r, 2.4, 3.2), group: r() < 0.3 ? 2 : 1, reveal: 0.2, sillType: 'stone', lintel: pick(r, ['stone', 'keystone', 'soldier', 'hood']), kind: r() < 0.5 ? 1 : 0 });
      if (b.era === '2000+' || b.era === '1970-1999') { w.muntin = 1; }
      s.ground = b.storefront || b.use === 'commercial' || b.use === 'mixed-use' ? 'storefront' : 'same';
      s.cornice = pick(r, ['bracketed', 'corbel', 'corbel', 'simple', 'classical']); s.corniceH = range(r, 0.6, 1.1);
      s.parapet = range(r, 0.6, 1.3); s.coping = true; s.stringCourse = r() < 0.7; s.pilasters = true; s.cornerPiers = true;
      s.awnings = r() < 0.65; s.awningStriped = r() < 0.3; s.awningColors = [C(pick(r, AWNING)), C('#e9e2d0')];
      s.fireEscape = b.levels >= 3 && r() < 0.5; s.rooftop = 'hvac'; s.sideWindows = 0.15; s.blankSides = true;
      s.sash = C(pick(r, ['#f1eee6', '#2a2a2a', '#3d2b20', '#26382b', '#e8e1cd']));
      s.trim = C(pick(r, ['#1e2a22', '#2a2a2a', '#4a2a22', '#e8e1cd', '#5b4636', '#233044']));
      break;
    }
    case 'art-deco': {
      s.groundH = 4.5; s.floorH = 3.8;
      Object.assign(w, { w: 1.2, h: 2.0, sill: 0.8, bay: 2.4, group: 1, reveal: 0.22, sillType: 'none', lintel: 'none', kind: 1, muntin: 6 });
      s.ground = b.storefront ? 'storefront' : 'lobby'; s.cornice = 'deco'; s.parapet = 1.8; s.coping = true; s.pilasters = true;
      s.floorBands = false; s.cornerPiers = true; s.rooftop = 'mech'; s.sash = C('#2a2a2a'); s.trim = C('#2a2a2a');
      break;
    }
    case 'masonry-tower': {
      s.groundH = 5.0; s.floorH = 3.7;
      Object.assign(w, { w: 1.1, h: 1.9, sill: 0.85, bay: 2.1, group: pick(r, [1, 2]), reveal: 0.2, sillType: 'stone', lintel: 'stone', kind: 1, muntin: 1 });
      s.ground = b.storefront ? 'storefront' : 'lobby'; s.cornice = 'classical'; s.corniceH = 1.2; s.parapet = 1.2; s.coping = true;
      s.stringCourse = true; s.cornerPiers = true; s.quoins = r() < 0.3; s.rooftop = region === 'northeast' && r() < 0.6 ? 'tank' : 'mech';
      break;
    }
    case 'brownstone': {
      s.groundH = 3.4; s.floorH = 3.3; s.foundation = 1.5;
      Object.assign(w, { w: 1.05, h: 2.1, sill: 0.6, bay: 2.1, group: 1, reveal: 0.22, sillType: 'stone', lintel: pick(r, ['hood', 'stone', 'keystone']), kind: 0, muntin: pick(r, [1, 4]) });
      s.porch = 'stoop'; s.cornice = 'bracketed'; s.corniceH = 0.8; s.parapet = 0.4; s.coping = true;
      s.rooftop = region === 'northeast' ? 'tank' : 'hvac'; s.fireEscape = r() < 0.3; s.blankSides = true; s.sideWindows = 0;
      s.trim = C(pick(r, ['#2a2320', '#3a2a22', '#1f1f1f'])); s.sash = C(pick(r, ['#2a2320', '#f0ece2']));
      s.stone = s.wallColor.clone().multiplyScalar(0.95);
      break;
    }
    case 'brick-warehouse': {
      s.groundH = 4.6; s.floorH = 4.2;
      Object.assign(w, { w: range(r, 1.6, 2.2), h: range(r, 2.2, 2.7), sill: 0.9, bay: range(r, 3.6, 4.6), group: 1, reveal: 0.3, sillType: 'stone', lintel: 'soldier', kind: b.use === 'industrial' ? 3 : 1, muntin: 5 });
      s.ground = b.storefront ? 'storefront' : 'loading'; s.cornice = 'corbel'; s.corniceH = 0.8; s.parapet = 1.0; s.coping = true;
      s.cornerPiers = true; s.pilasters = true; s.fireEscape = b.levels >= 2 && r() < 0.6; s.rooftop = 'hvac';
      s.sash = C(pick(r, ['#2a2a2a', '#3a3f3a', '#6b2a22'])); s.trim = C('#2a2a2a');
      if (s.ground === 'storefront') s.awnings = r() < 0.4;
      break;
    }
    case 'podium-mixed-use': {
      s.groundH = range(r, 4.5, 5.2); s.floorH = 3.1;
      Object.assign(w, { w: range(r, 1.4, 2.2), h: range(r, 1.9, 2.3), sill: 0.5, bay: range(r, 3.0, 3.8), group: 1, reveal: 0.1, sillType: 'thin', lintel: 'none', kind: 0, muntin: pick(r, [0, 6]) });
      s.ground = 'storefront'; s.cornice = 'modern'; s.corniceH = 0.5; s.parapet = 1.1; s.coping = true; s.floorBands = r() < 0.5;
      s.balconies = range(r, 0.2, 0.45); s.rooftop = 'hvac'; s.canopy = r() < 0.5; s.awnings = !s.canopy && r() < 0.5;
      s.accentTex = pick(r, ['metal-panel', 'brick-brown', 'stucco', 'brick-red', 'lap-siding']);
      s.accentColor = C(pick(r, ['#5b5e63', '#8f5a3c', '#c7c2b6', '#3f4a52', '#a8743f', '#6f7a6b']));
      s.sash = C(pick(r, ['#2a2a2a', '#3c3f42', '#5a5a58'])); s.trim = C('#3c3f42');
      break;
    }
    case 'garden-apartments': {
      s.groundH = 2.9; s.floorH = 2.9; s.foundation = 0.3;
      Object.assign(w, { w: range(r, 1.2, 1.8), h: 1.4, sill: 0.9, bay: range(r, 3.2, 4.2), group: 1, reveal: 0.08, sillType: 'thin', lintel: 'none', kind: 0, muntin: pick(r, [8, 1, 6]) });
      s.ground = 'residential'; s.balconies = range(r, 0.2, 0.5); s.eave = 0.6; s.chimney = false; s.rooftop = isPitched(b) ? 'none' : 'hvac';
      s.parapet = isPitched(b) ? 0 : 0.4; s.coping = !isPitched(b); s.floorBands = r() < 0.4;
      s.trim = C(pick(r, ['#f1eee6', '#6b5a48', '#3c3f42']));
      break;
    }
    case 'office-park': {
      s.groundH = 4.2; s.floorH = 3.9;
      Object.assign(w, { pattern: r() < 0.7 ? 'ribbon' : 'punched', w: 1.5, h: 1.9, sill: 0.9, bay: 1.5, group: 1, reveal: 0.08, sillType: 'none', lintel: 'none', kind: 1, reflect: r() < 0.5 ? range(r, 0.3, 0.6) : 0, muntin: 9 });
      s.ground = 'lobby'; s.cornice = 'modern'; s.parapet = 1.2; s.coping = true; s.rooftop = 'hvac'; s.floorBands = true;
      s.sash = C(pick(r, ['#2d2f31', '#6c6f72', '#3b3325'])); s.trim = s.sash.clone();
      break;
    }
    case 'glass-tower':
    case 'curtain-wall-tower': {
      s.groundH = 5.5; s.floorH = 3.9;
      Object.assign(w, { pattern: 'curtain', w: 1.5, h: 3.9, sill: 0, bay: kit === 'glass-tower' ? 1.5 : range(r, 1.5, 3.0), group: 1, reveal: 0.0, sillType: 'none', lintel: 'none', kind: 1, reflect: kit === 'glass-tower' ? range(r, 0.45, 0.8) : range(r, 0.15, 0.45), muntin: 0 });
      s.ground = 'lobby'; s.cornice = 'none'; s.parapet = 1.5; s.coping = true; s.rooftop = 'mech';
      s.sash = C(pick(r, ['#8a8f94', '#2d2f31', '#b9bcbf', '#4a4d50'])); s.trim = s.sash.clone();
      s.wallTex = 'metal-panel'; s.wallColor = s.sash.clone();
      break;
    }
    case 'strip-mall': {
      s.groundH = range(r, 4.2, 5.2); s.floorH = 3.6;
      Object.assign(w, { w: 1.2, h: 1.5, sill: 0.9, bay: 3.0, kind: 2, muntin: 0 });
      s.ground = 'storefront'; s.canopy = true; s.parapet = range(r, 1.0, 1.8); s.coping = true; s.rooftop = 'hvac'; s.blankSides = true; s.sideWindows = 0;
      s.sash = C(pick(r, ['#9da2a6', '#2d2f31', '#6b5a48'])); s.trim = C(pick(r, ['#c9b79a', '#b9b3a8', '#8a6a4a', '#d9d2c3']));
      break;
    }
    case 'big-box': {
      s.groundH = Math.max(6, b.height - 1.5); s.floorH = 6;
      Object.assign(w, { pattern: 'blank', kind: 2, muntin: 0 });
      s.ground = 'storefront'; s.parapet = 1.5; s.coping = true; s.rooftop = 'hvac'; s.blankSides = true; s.sideWindows = 0; s.floorBands = true;
      s.trim = C(pick(r, ['#8a8f94', '#6b5a48', '#3b4a5a']));
      break;
    }
    case 'gas-station': {
      s.groundH = 4.0; s.floorH = 3.5;
      Object.assign(w, { kind: 2, muntin: 0 });
      s.ground = 'storefront'; s.canopy = true; s.parapet = 0.8; s.coping = true; s.rooftop = 'hvac'; s.sideWindows = 0.2;
      break;
    }
    case 'metal-shed': {
      s.groundH = Math.max(4.5, b.height); s.floorH = 4.5;
      Object.assign(w, { w: 1.2, h: 0.9, sill: 2.6, bay: range(r, 6, 9), kind: 3, muntin: 8, reveal: 0.05, sillType: 'none' });
      s.ground = 'loading'; s.eave = 0.3; s.sideWindows = 0.3; s.rooftop = isPitched(b) ? 'none' : 'hvac';
      s.parapet = isPitched(b) ? 0 : 0.3; s.coping = !isPitched(b);
      s.sash = C('#8a8f94'); s.trim = C(pick(r, ['#3b4a5a', '#7a2a22', '#e8e6e0', '#2f3b30']));
      break;
    }
    case 'parking-garage': {
      s.groundH = 3.2; s.floorH = 3.0;
      Object.assign(w, { pattern: 'parking', kind: 5, muntin: 0, reveal: 0 });
      s.ground = 'parking'; s.parapet = 1.1; s.coping = false; s.rooftop = 'none';
      s.wallTex = 'concrete'; s.wallColor = C('#b8b4ab');
      break;
    }
    case 'civic': {
      s.groundH = 4.8; s.floorH = 4.4; s.foundation = 1.0;
      Object.assign(w, { w: 1.3, h: 2.6, sill: 0.9, bay: 3.4, group: 1, reveal: 0.3, sillType: 'stone', lintel: 'keystone', kind: 6, muntin: pick(r, [2, 1]) });
      s.ground = 'same'; s.porch = b.era === '2000+' || b.era === '1970-1999' ? 'none' : 'portico'; s.cornice = 'classical'; s.corniceH = 1.2;
      s.parapet = isPitched(b) ? 0 : 1.2; s.coping = true; s.stringCourse = true; s.quoins = r() < 0.5; s.cornerPiers = true; s.rooftop = 'mech';
      s.sash = C('#2a2a2a'); s.trim = C('#e6e0d2');
      if (b.era === '2000+' || b.era === '1970-1999') { w.pattern = 'ribbon'; w.muntin = 9; w.kind = 1; w.bay = 1.5; s.cornice = 'modern'; }
      break;
    }
    case 'school': {
      s.groundH = 4.0; s.floorH = 4.0;
      Object.assign(w, { pattern: pre40 ? 'punched' : 'ribbon', w: pre40 ? 1.6 : 1.5, h: 2.2, sill: 0.9, bay: pre40 ? 3.2 : 1.5, group: pre40 ? 3 : 1, reveal: 0.18, sillType: 'stone', lintel: pre40 ? 'stone' : 'none', kind: 6, muntin: pre40 ? 5 : 9 });
      s.ground = 'same'; s.cornice = pre40 ? 'simple' : 'modern'; s.parapet = isPitched(b) ? 0 : 0.8; s.coping = true; s.rooftop = 'hvac'; s.canopy = !pre40;
      break;
    }
    case 'worship': {
      s.groundH = Math.max(6, b.height * 0.8); s.floorH = s.groundH;
      Object.assign(w, { w: 1.3, h: Math.min(5, s.groundH * 0.6), sill: 1.4, bay: 3.6, reveal: 0.3, sillType: 'stone', lintel: 'keystone', kind: 6, muntin: 5 });
      s.ground = 'same'; s.steeple = r() < 0.6; s.eave = 0.3; s.cornice = 'simple'; s.sideWindows = 1;
      s.sash = C('#3a2a22');
      break;
    }
    case 'craftsman': {
      s.groundH = 2.9; s.floorH = 2.7; s.foundation = range(r, 0.5, 0.8);
      Object.assign(w, { w: range(r, 0.85, 1.0), h: 1.5, sill: 0.85, bay: range(r, 2.6, 3.4), group: r() < 0.5 ? 2 : 1, reveal: 0.08, casing: true, sillType: 'thin', lintel: 'wood', kind: 0, muntin: 3 });
      s.ground = 'residential'; s.porch = 'craftsman'; s.eave = range(r, 0.6, 0.9); s.chimney = r() < 0.75;
      s.trim = C(pick(r, ['#f1eee6', '#e8dfc8', '#5b4636', '#3e4a3a', '#7a4b2a'])); s.sash = C(pick(r, ['#f1eee6', '#e8dfc8', '#4a2a22']));
      break;
    }
    case 'victorian': {
      s.groundH = 3.3; s.floorH = 3.1; s.foundation = range(r, 0.6, 0.9);
      Object.assign(w, { w: range(r, 0.8, 0.95), h: range(r, 1.9, 2.2), sill: 0.65, bay: range(r, 2.0, 2.6), group: 1, reveal: 0.1, casing: true, sillType: 'thin', lintel: 'hood', kind: 0, muntin: pick(r, [4, 1]) });
      s.ground = 'residential'; s.porch = 'victorian'; s.eave = 0.45; s.chimney = true; s.cornice = isPitched(b) ? 'none' : 'bracketed'; s.corniceH = 0.6;
      s.trim = C(pick(r, ['#f1eee6', '#e8dfc8', '#3f5a4a', '#6b2a22', '#2f3f5a'])); s.sash = C(pick(r, ['#f1eee6', '#2a2a2a']));
      s.win.shutters = r() < 0.3;
      break;
    }
    case 'colonial': {
      s.groundH = 2.9; s.floorH = 2.8; s.foundation = 0.5;
      Object.assign(w, { w: 0.9, h: 1.55, sill: 0.8, bay: 2.6, group: 1, reveal: 0.08, casing: true, sillType: 'thin', lintel: 'flat', kind: 0, muntin: pick(r, [2, 2, 1]) });
      s.ground = 'residential'; s.porch = r() < 0.5 ? 'portico' : 'stoop-small'; s.eave = 0.3; s.chimney = true; s.win.shutters = r() < 0.75;
      s.cornice = 'simple'; s.trim = C('#f4f1ea'); s.sash = C('#f4f1ea');
      break;
    }
    case 'ranch': {
      s.groundH = 2.7; s.floorH = 2.7; s.foundation = 0.3;
      Object.assign(w, { w: range(r, 1.2, 1.8), h: 1.2, sill: 1.0, bay: range(r, 3.0, 4.0), group: 1, reveal: 0.07, casing: false, sillType: 'thin', lintel: 'none', kind: 0, muntin: pick(r, [8, 1, 6, 2]) });
      s.ground = 'residential'; s.garage = r() < 0.75 ? pick(r, [1, 2, 2]) : 0; s.eave = range(r, 0.5, 0.8); s.chimney = r() < 0.5; s.win.shutters = r() < 0.4;
      s.trim = C(pick(r, ['#f1eee6', '#e8dfc8', '#5b4636', '#3e4a3a'])); s.sash = C(pick(r, ['#f1eee6', '#e8dfc8', '#8a8a86']));
      break;
    }
    case 'contemporary-suburban': {
      s.groundH = 3.0; s.floorH = 2.9; s.foundation = 0.35;
      Object.assign(w, { w: range(r, 0.9, 1.2), h: 1.5, sill: 0.8, bay: range(r, 2.6, 3.4), group: r() < 0.3 ? 2 : 1, reveal: 0.08, casing: true, sillType: 'thin', lintel: 'flat', kind: 0 });
      s.ground = 'residential'; s.garage = r() < 0.85 ? pick(r, [2, 2, 3]) : 1; s.eave = 0.45; s.porch = r() < 0.5 ? 'farm' : 'stoop-small'; s.win.shutters = r() < 0.35;
      s.trim = C(pick(r, ['#f4f1ea', '#f4f1ea', '#e8dfc8'])); s.sash = C('#f4f1ea');
      break;
    }
    case 'modern-infill': {
      s.groundH = 3.2; s.floorH = 3.1; s.foundation = 0.15;
      Object.assign(w, { w: range(r, 1.4, 2.6), h: range(r, 1.8, 2.4), sill: 0.45, bay: range(r, 2.8, 4.0), group: 1, reveal: 0.15, casing: false, sillType: 'none', lintel: 'none', kind: 0, muntin: pick(r, [0, 6]) });
      s.ground = b.storefront ? 'storefront' : 'residential'; s.cornice = 'modern'; s.parapet = isPitched(b) ? 0 : 0.5; s.coping = true; s.balconies = range(r, 0.1, 0.3);
      s.accentTex = pick(r, ['board-batten', 'metal-panel', 'lap-siding', 'stucco']); s.accentColor = C(pick(r, ['#3a3a3a', '#8a6a4a', '#c9c2b4', '#5b6770', '#a2542f']));
      s.sash = C(pick(r, ['#1e1e1e', '#2d2f31'])); s.trim = s.sash.clone(); s.eave = 0.25;
      break;
    }
    case 'pueblo': {
      s.groundH = 3.0; s.floorH = 2.9; s.foundation = 0.1;
      Object.assign(w, { w: range(r, 0.8, 1.1), h: 1.2, sill: 0.9, bay: range(r, 2.8, 3.8), reveal: 0.3, sillType: 'none', lintel: 'wood', kind: 0, muntin: pick(r, [6, 2, 0]) });
      s.ground = b.storefront ? 'storefront' : 'residential'; s.parapet = 0.6; s.coping = false; s.vigas = true; s.eave = 0;
      s.wallTex = b.material === 'adobe' ? 'adobe' : 'stucco'; s.trim = C(pick(r, ['#5b3f28', '#2f5a6a', '#6b3a22'])); s.sash = s.trim.clone();
      break;
    }
    case 'mediterranean': {
      s.groundH = 3.1; s.floorH = 3.0; s.foundation = 0.2;
      Object.assign(w, { w: range(r, 0.9, 1.3), h: 1.7, sill: 0.7, bay: range(r, 2.6, 3.4), reveal: 0.22, sillType: 'thin', lintel: 'none', kind: 0, muntin: pick(r, [6, 2, 1]), shutters: r() < 0.3 });
      s.ground = b.storefront ? 'storefront' : 'residential'; s.eave = 0.35; s.balconies = 0.15; s.chimney = r() < 0.3; s.garage = b.use === 'residential-single' && r() < 0.6 ? 2 : 0;
      s.trim = C(pick(r, ['#5b3f28', '#2f3b30', '#e8dfc8'])); s.sash = C(pick(r, ['#2a2a2a', '#5b3f28', '#f1eee6']));
      break;
    }
    default: {
      // generic flat-roof commercial / unknown
      s.groundH = b.use === 'commercial' || b.use === 'mixed-use' ? 4.2 : 3.2; s.floorH = b.use === 'office' ? 3.8 : 3.1;
      Object.assign(w, { w: 1.2, h: 1.6, sill: 0.9, bay: 3.0, reveal: 0.12, sillType: 'thin', kind: b.use === 'office' ? 1 : b.use === 'industrial' ? 3 : 0 });
      s.ground = b.storefront ? 'storefront' : b.use === 'residential-single' ? 'residential' : 'same';
      s.parapet = isPitched(b) ? 0 : 0.6; s.coping = !isPitched(b); s.cornice = isPitched(b) ? 'none' : 'simple'; s.rooftop = isPitched(b) ? 'none' : 'hvac';
      if (b.use === 'residential-single') { s.foundation = 0.4; s.chimney = pre40; }
    }
  }
  // residential multi-story pre-war brick → fire escapes on rear
  if (!s.fireEscape && pre40 && b.levels >= 3 && b.material.startsWith('brick') && (b.use === 'residential-multi' || b.use === 'mixed-use')) s.fireEscape = r() < 0.6;
  if (s.porch === 'none' && b.use === 'residential-single' && (kit === 'generic' || kit === 'ranch') && r() < 0.3) s.porch = 'stoop-small';
  // seed-driven slight color variation per building (±4 %)
  const jit = 0.96 + r() * 0.08;
  s.wallColor.multiplyScalar(jit);
  return s;
}
