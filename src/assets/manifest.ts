// OWNER: assets agent. Asset manifest: every id the library can serve, with real-world sizes and metadata.
// Texture entries are generated from src/assets/texture-manifest.json (written by src/assets/fetch/*.mjs);
// models / environments / sounds are listed here by hand. Licenses: public/assets/LICENSES.json (all CC0).
import textureJson from './texture-manifest.json';
import type { Outfit } from './characters';
import soundJson from './sound-manifest.json';

export type TextureMapKey = 'color' | 'normal' | 'rough' | 'ao' | 'opacity';

export interface TextureEntry {
  /** Real-world tile size in meters (width of one texture repeat). */
  sizeM: number;
  /** Which map files exist in public/assets/textures/<id>/<key>.jpg */
  maps: TextureMapKey[];
  /** Pixel width of the color map. */
  res: number;
  /** Average color of the color map (sRGB hex) — useful for distant LOD / flat fallback. */
  avg: string;
  /** True for alpha-masked decals (have an opacity map). */
  decal?: boolean;
  /** True when the color map is desaturated so `tint` fully controls the hue. */
  tintable?: boolean;
}

export const TEXTURES: Record<string, TextureEntry> = textureJson as Record<string, TextureEntry>;

/** Texture sets preloaded by preloadLibrary() (the ones every city uses). */
export const CORE_TEXTURES = [
  'asphalt', 'asphalt-worn', 'concrete-sidewalk', 'concrete', 'curb', 'grass', 'dirt',
  // Facades load their own offline-sized maps; full-resolution wall/roof maps are not needed
  // by the 512px texture arrays and cost hundreds of MB of decoded image memory at startup.
];

/** Flat fallback colors (used when a texture set is missing or not yet loaded). */
export const FALLBACK_COLORS: Record<string, string> = {
  asphalt: '#3a3a3c', 'asphalt-worn': '#48474a', 'asphalt-patched': '#3d3c3e', concrete: '#9a978f',
  'concrete-sidewalk': '#a9a59c', curb: '#a3a097', grass: '#4d6b2f', dirt: '#6b5a44', gravel: '#8a847a',
  'brick-red': '#8a4232', 'brick-brown': '#5e3d2d', 'brick-tan': '#b29a7c', 'brick-painted': '#d8d2c2',
  'brick-white': '#d9d6cf', stucco: '#d6d0c2', 'lap-siding': '#dcdcd8', 'board-batten': '#d8d6d0',
  stone: '#8c867c', sandstone: '#b59c78', 'metal-panel': '#8e9296', adobe: '#a07a58', 'wood-shingle': '#6d5440',
  plaster: '#d2cbbd', 'roof-asphalt-shingle': '#4a4a4c', 'roof-clay-tile': '#a2573a', 'roof-standing-seam': '#6d7278',
  'roof-slate': '#55585c', 'roof-membrane': '#b9b9b6', 'roof-gravel': '#8a867e', paving: '#9d978c', cobble: '#7d776e',
  'wood-planks': '#8b6c4c', 'rust-metal': '#7a4a2e', 'painted-metal': '#707478', bark: '#4f3f33', water: '#2c3e46',
};

export interface ModelEntry {
  path: string; // relative to public/assets/
  kind: 'character' | 'vehicle' | 'prop';
  /** Uniform scale to apply so the model is in meters (already applied by loadModel). */
  scale?: number;
  /** Rotation about Y (radians) applied so the model faces −Z... see `forward`. */
  rotY?: number;
  /** Semantic clip name → actual clip name in the file. */
  clips?: Record<string, string>;
  /** Approx height (m) after scale. */
  heightM?: number;
  tags?: string[];
  /** Material overrides applied on load: material name (substring match) → hex color. */
  tint?: Record<string, string>;
  /** Characters: procedural clothing applied to the base body (see characters.ts). */
  outfit?: Outfit;
  /** Characters: path of a skeleton-only glb whose clips drive this model (bind by bone name). */
  anims?: string;
}

/** Semantic clip names for every UBC character (Quaternius Universal Animation Library 1+2). All in place except `climb`. */
export const CHARACTER_CLIPS: Record<string, string> = {
  idle: 'Idle_Loop', walk: 'Walk_Loop', walkFormal: 'Walk_Formal_Loop', run: 'Jog_Fwd_Loop', sprint: 'Sprint_Loop',
  crouchWalk: 'Crouch_Fwd_Loop', crouchIdle: 'Crouch_Idle_Loop', drive: 'Driving_Loop',
  kneelWork: 'Fixing_Kneeling', interact: 'Interact', pickup: 'PickUp_Table', push: 'Push_Loop', carry: 'Walk_Carry_Loop',
  death: 'Death01', hit: 'Hit_Chest', hitHead: 'Hit_Head', knockback: 'Hit_Knockback', getUp: 'LayToIdle',
  talk: 'Idle_Talking_Loop', phone: 'Idle_TalkingPhone_Loop', foldArms: 'Idle_FoldArms_Loop', no: 'Idle_No_Loop', yes: 'Yes',
  jumpStart: 'Jump_Start', jump: 'Jump_Loop', jumpLand: 'Jump_Land', roll: 'Roll', slide: 'Slide_Loop', climb: 'ClimbUp_1m_RM',
  punch: 'Punch_Jab', punchCross: 'Punch_Cross', throw: 'OverhandThrow', aim: 'Pistol_Aim_Neutral', pistolIdle: 'Pistol_Idle_Loop',
  sit: 'Sitting_Idle_Loop', sitEnter: 'Sitting_Enter', sitExit: 'Sitting_Exit', dance: 'Dance_Loop',
};

/** Kenney Car Kit units → meters (stylized proportions; ~4.1 m long sedan). Wheels are separate nodes named wheel-*. */
const KENNEY_CAR_SCALE = 1.6;
const M = 'models/characters/ubc-male.glb', F = 'models/characters/ubc-female.glb', ANIMS = 'models/characters/anims.glb';
const ch = (path: string, outfit: Outfit, tags: string[]): ModelEntry => ({ path, rotY: Math.PI, kind: 'character', anims: ANIMS, clips: CHARACTER_CLIPS, outfit, heightM: path === M ? 1.8 : 1.7, tags });

/**
 * Model registry. Characters face +Z, feet at y=0, meters. Load with loadModel / loadModelWithAnimations.
 */
export const MODELS: Record<string, ModelEntry> = {
  'character-police': ch(M, { top: '#1b2638', bottom: '#141b28', shoes: '#0a0a0a', longSleeves: true, hair: '#1a1410', cap: '#141c2b' }, ['police', 'male']),
  'character-police-f': ch(F, { top: '#1b2638', bottom: '#141b28', shoes: '#0a0a0a', longSleeves: true, hair: '#2a1d14', cap: '#141c2b', skin: '#9a7058' }, ['police', 'female']),
  'character-ped-1': ch(M, { top: '#2f4a6b', bottom: '#2b2f3a', shoes: '#e8e6e0', hair: '#2a1d14' }, ['civilian', 'male']),
  'character-ped-2': ch(F, { top: '#b8433a', bottom: '#3a4d6e', shoes: '#f0efe9', hair: '#5a3a22' }, ['civilian', 'female']),
  'character-ped-3': ch(M, { top: '#c9c3b5', bottom: '#6b5b45', shoes: '#3a2a1e', longSleeves: true, skin: '#7a5a48', hair: '#0e0c0b' }, ['civilian', 'male']),
  'character-ped-4': ch(F, { top: '#3f5e3a', bottom: '#1d1f24', shoes: '#1a1a1a', longSleeves: true, skin: '#f2e6dc', hair: '#a07a4a' }, ['civilian', 'female']),
  'character-ped-5': ch(M, { top: '#6d6f72', bottom: '#4b5a78', shoes: '#9a9a96', shorts: true, skin: '#c9a58a', hair: '#6b4a2e' }, ['civilian', 'male']),
  'character-ped-6': ch(F, { top: '#e0c14a', bottom: '#e6e2d8', shoes: '#b04a3a', shorts: true, skin: '#8a6450', hair: '#15100c' }, ['civilian', 'female']),
  'character-ped-7': ch(M, { top: '#1c1c1f', bottom: '#1c1c1f', shoes: '#101010', longSleeves: true, hair: '#1a1410' }, ['civilian', 'male', 'dark-clothes']),
  'character-worker': ch(M, { top: '#e8762c', bottom: '#3d4a5c', shoes: '#2a2018', longSleeves: true, skin: '#d8b8a0', hair: '#3a2a1a' }, ['worker', 'male']),
  /** Player default: dark hoodie look. */
  'character-player': ch(M, { top: '#26282c', bottom: '#2e3542', shoes: '#2a2a2a', longSleeves: true, hair: '#1a1410' }, ['player', 'male']),
  // Poly Haven props (CC0, photoscanned/PBR, real scale in meters)
  'prop-barrel': { path: 'models/props/prop-barrel/model.gltf', kind: 'prop', tags: ['clutter'] },
  'prop-bench': { path: 'models/props/prop-bench/model.gltf', kind: 'prop', tags: ['street'] },
  'prop-bolt-cutters': { path: 'models/props/prop-bolt-cutters/model.gltf', kind: 'prop', tags: ['tool'] },
  'prop-cardboard-box': { path: 'models/props/prop-cardboard-box/model.gltf', kind: 'prop', tags: ['clutter'] },
  'prop-covered-car': { path: 'models/props/prop-covered-car/model.gltf', kind: 'prop', tags: ['vehicle'] },
  'prop-handsaw': { path: 'models/props/prop-handsaw/model.gltf', kind: 'prop', tags: ['tool'] },
  'prop-hydrant': { path: 'models/props/prop-hydrant/model.gltf', kind: 'prop', tags: ['street'] },
  'prop-jersey-barrier': { path: 'models/props/prop-jersey-barrier/model.gltf', kind: 'prop', tags: ['street'] },
  'prop-jersey-barrier-2': { path: 'models/props/prop-jersey-barrier-2/model.gltf', kind: 'prop', tags: ['street'] },
  'prop-manhole': { path: 'models/props/prop-manhole/model.gltf', kind: 'prop', tags: ['street'] },
  'prop-security-camera-1': { path: 'models/props/prop-security-camera-1/model.gltf', kind: 'prop', tags: ['surveillance'] },
  'prop-security-camera-2': { path: 'models/props/prop-security-camera-2/model.gltf', kind: 'prop', tags: ['surveillance'] },
  'prop-security-light': { path: 'models/props/prop-security-light/model.gltf', kind: 'prop', tags: ['light'] },
  'prop-shrub-2': { path: 'models/props/prop-shrub-2/model.gltf', kind: 'prop', tags: ['vegetation'] },
  'prop-spray-can': { path: 'models/props/prop-spray-can/model.gltf', kind: 'prop', tags: ['tool'] },
  'prop-street-lamp-1': { path: 'models/props/prop-street-lamp-1/model.gltf', kind: 'prop', tags: ['street','light'] },
  'prop-street-lamp-2': { path: 'models/props/prop-street-lamp-2/model.gltf', kind: 'prop', tags: ['street','light'] },
  'prop-trash-bag': { path: 'models/props/prop-trash-bag/model.gltf', kind: 'prop', tags: ['street'] },
  'prop-trash-can': { path: 'models/props/prop-trash-can/model.gltf', kind: 'prop', tags: ['street'] },
  'prop-utility-box-1': { path: 'models/props/prop-utility-box-1/model.gltf', kind: 'prop', tags: ['street'] },
  'prop-utility-box-2': { path: 'models/props/prop-utility-box-2/model.gltf', kind: 'prop', tags: ['street'] },
  'prop-wet-floor-sign': { path: 'models/props/prop-wet-floor-sign/model.gltf', kind: 'prop', tags: ['clutter'] },
  'vehicle-kenney-sedan': { path: 'models/vehicles/kenney/sedan.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['civilian','stylized'] },
  'vehicle-kenney-suv': { path: 'models/vehicles/kenney/suv.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['civilian','stylized'] },
  'vehicle-kenney-van': { path: 'models/vehicles/kenney/van.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['civilian','stylized'] },
  'vehicle-kenney-truck': { path: 'models/vehicles/kenney/truck.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['civilian','pickup','stylized'] },
  'vehicle-kenney-hatchback-sports': { path: 'models/vehicles/kenney/hatchback-sports.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['civilian','stylized'] },
  'vehicle-kenney-taxi': { path: 'models/vehicles/kenney/taxi.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['civilian','stylized'] },
  'vehicle-kenney-delivery': { path: 'models/vehicles/kenney/delivery.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['civilian','commercial','stylized'] },
  'vehicle-kenney-garbage-truck': { path: 'models/vehicles/kenney/garbage-truck.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['civilian','commercial','stylized'] },
  'vehicle-kenney-ambulance': { path: 'models/vehicles/kenney/ambulance.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['emergency','stylized'] },
  'vehicle-kenney-firetruck': { path: 'models/vehicles/kenney/firetruck.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['emergency','stylized'] },
  'vehicle-kenney-police': { path: 'models/vehicles/kenney/police.glb', kind: 'vehicle', scale: KENNEY_CAR_SCALE, tags: ['police','stylized'] },
  'prop-cone': { path: 'models/vehicles/kenney/cone.glb', kind: 'prop', scale: 1.2, tags: ['street', 'stylized'] },
  'prop-box': { path: 'models/vehicles/kenney/box.glb', kind: 'prop', tags: ['clutter', 'stylized'] },
};

export interface EnvEntry {
  path: string;
  /** Unit vector toward the sun/brightest point as sampled by three with EquirectangularReflectionMapping and
   *  no environmentRotation. Rotate the env (scene.environmentRotation.y / backgroundRotation.y) to match your sun. */
  sunDir: [number, number, number];
  /** Sun elevation in degrees baked into the HDRI. */
  sunElevDeg: number;
  /** Rough brightness class: suggested renderer toneMappingExposure multiplier. */
  exposure: number;
  /** Poly Haven source id. */
  source: string;
  note: string;
}
/** Poly Haven 2K .hdr sky domes ("puresky" = no ground baked in, so the 3D world supplies the horizon). */
export const ENVIRONMENTS: Record<string, EnvEntry> = {
  day: { path: 'hdri/day.hdr', sunDir: [0.553, 0.743, 0.376], sunElevDeg: 48, exposure: 1, source: 'kloofendal_48d_partly_cloudy_puresky', note: 'midday, partly cloudy, strong sun' },
  'day-clear': { path: 'hdri/day-clear.hdr', sunDir: [0.591, 0.683, 0.429], sunElevDeg: 43, exposure: 1, source: 'kloofendal_43d_clear_puresky', note: 'clear blue sky, strong sun' },
  golden: { path: 'hdri/golden.hdr', sunDir: [0.764, 0.329, 0.555], sunElevDeg: 19, exposure: 1.1, source: 'qwantani_late_afternoon_puresky', note: 'late afternoon golden hour, clear' },
  sunset: { path: 'hdri/sunset.hdr', sunDir: [0.756, 0.082, 0.65], sunElevDeg: 5, exposure: 1.6, source: 'kloppenheim_06_puresky', note: 'sunset, partly cloudy, sun on horizon' },
  overcast: { path: 'hdri/overcast.hdr', sunDir: [0.8, 0.394, 0.453], sunElevDeg: 23, exposure: 1.2, source: 'kloofendal_overcast_puresky', note: 'overcast, soft diffuse light (no hard sun)' },
  night: { path: 'hdri/night.hdr', sunDir: [0.638, 0.62, 0.457], sunElevDeg: 38, exposure: 0.5, source: 'kloppenheim_07_puresky', note: 'night, overcast clouds lit orange by city light pollution — best urban night' },
  'night-clear': { path: 'hdri/night-clear.hdr', sunDir: [-0.021, 0.995, 0.099], sunElevDeg: 84, exposure: 0.25, source: 'qwantani_night_puresky', note: 'clear starry night with moonlight (moon high)' },
};

/**
 * Sound id → variant file paths (Kenney CC0 audio packs, .ogg). Ids: footstep-{concrete,grass,wood,snow,carpet,leather},
 * impact-{metal,glass,plate}-{heavy,medium,light}, impact-{punch,soft}[-heavy], impact-{generic,wood,wood-heavy,tin,bell,mining,metal-scifi},
 * crash-crunch, explosion-low, electric-hum, computer-noise, motor-whine, thruster, glitch, ui-{click,select,confirm,error,back,open,close,
 * tick,toggle,scratch,drop,question,maximize,minimize,bong,switch,rollover}, metal-{click,latch,pot}, knife-{draw,slice}, cloth, cloth-belt,
 * door-{open,close}, creak, chop, coins.
 */
export const SOUNDS: Record<string, string[]> = soundJson as Record<string, string[]>;
