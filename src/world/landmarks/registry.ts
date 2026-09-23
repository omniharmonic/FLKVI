// OWNER: landmarks. The Landmark Registry (Tech Arch §5.4 "Landmark overrides", Asset Spec §10).
//
// Each entry names a real landmark, how to find it in a compiled recipe, and a procedural builder:
//   match.osmIds  — OSM building ids ("w…"/"r…-k") whose procedural output the landmark REPLACES
//                   (the buildings module skips them; physics uses the landmark's own collider).
//   match.areaId  — an OSM area (park / water) the landmark is fitted to (no replacement).
//   match.latlon  — a point (with `radius` m from the recipe origin) for landmarks that are not in the
//                   baked area at all, e.g. distant skyline backdrops.
// build(ctx) models the landmark in a LOCAL frame: meters, +Y up, origin at the fitted footprint center
// on the ground, FRONT FACADE FACING +Z, width along X (ctx.W) and depth along Z (ctx.D) fitted to the OSM
// footprint's minimum-area rectangle; `front` picks which side of that rectangle is the front.
// Dimensions come from public sources (see each model's header comment).
//
// Content rules: no real brand logos or names on signage; religious buildings are modelled plainly and
// flagged `sensitive` (the compiler already keeps cameras/spawns away from sensitive buildings).
import type * as THREE from 'three';
import type { Recipe, Vec2 } from '../../core/types';
import type { Game } from '../../core/game';
import type { Kit } from './kit';
import type { NightLamp } from './materials';
import { boulderCourthouse, savannahCityHall, phoenixCityHall, texasCapitol } from './models/civic';
import { stLouisCathedral, missionDolores, missionBasilica } from './models/sacred';
import { washingtonArch, squareFountain, jacksonSquare, cloudGate, spaceNeedle, lifeguardTower, neonFin } from './models/monuments';

export type Front = 'long' | { road: string } | { area: string } | { dir: Vec2 } | { latlon: [number, number] };

export interface LandmarkCtx {
  /** Fitted width (across the front, local X) and depth (local Z), meters. 0 for point landmarks. */
  W: number; D: number;
  /** Matched footprints / area polygon in the local frame. */
  polys: Vec2[][];
  /** Wall heights of matched buildings (recipe `height`), same order as polys. */
  heights?: number[];
  /** World y of the local origin. */
  baseY: number;
  recipe: Recipe;
  /** Night-lit materials (emissive fades in with the sky's night factor). */
  lamps: NightLamp[];
  toLocal(wx: number, wz: number): Vec2;
  toWorld(lx: number, lz: number): Vec2;
  /** Ground height relative to baseY at a local point. */
  ground(lx: number, lz: number): number;
  /** Per-frame hook (e.g. reflection probe refresh). */
  onUpdate(fn: (g: Game) => void): void;
  game: Game;
}

export interface LandmarkDef {
  id: string;
  /** Recipe file id (documentation / filtering); matching itself is by ids or location. */
  city: string;
  name: string;
  sensitive?: boolean;
  match: { osmIds?: string[]; areaId?: string; latlon?: [number, number]; radius?: number; facing?: number };
  front?: Front;
  /** false = decorate, keep the procedural building. Default true (replace). */
  replace?: boolean;
  /** Which ground sample becomes the base (default 'min'). */
  base?: 'min' | 'max' | 'center';
  /** Distance (m) where the simplified LOD takes over. */
  lodDist?: number;
  /** Far skyline element: no shadows, no collider needed. */
  backdrop?: boolean;
  build(ctx: LandmarkCtx): { kit: Kit; extra?: THREE.Object3D };
}

export const LANDMARKS: LandmarkDef[] = [
  // ---------------------------------------------------------------- Boulder, CO
  {
    id: 'boulder-county-courthouse', city: 'boulder', name: 'Boulder County Courthouse',
    match: { osmIds: ['w207358376'] }, front: { road: 'Pearl Street Mall' }, lodDist: 240,
    build: boulderCourthouse,
  },
  // ---------------------------------------------------------------- New York, Greenwich Village
  {
    id: 'washington-square-arch', city: 'nyc-village', name: 'Washington Square Arch',
    match: { osmIds: ['w248166269'] }, front: { road: '5th Avenue' }, lodDist: 260,
    build: washingtonArch,
  },
  {
    id: 'washington-square-fountain', city: 'nyc-village', name: 'Washington Square Fountain',
    match: { areaId: 'w959929617' }, base: 'max', lodDist: 160,
    build: squareFountain,
  },
  // ---------------------------------------------------------------- San Francisco, Mission
  {
    id: 'mission-dolores', city: 'sf-mission', name: 'Mission Dolores (Misión San Francisco de Asís)', sensitive: true,
    match: { osmIds: ['w256442765'] }, front: { road: 'Dolores Street' }, lodDist: 200,
    build: missionDolores,
  },
  {
    id: 'mission-dolores-basilica', city: 'sf-mission', name: 'Mission Dolores Basilica', sensitive: true,
    match: { osmIds: ['w256442760'] }, front: { road: 'Dolores Street' }, lodDist: 260,
    build: missionBasilica,
  },
  // ---------------------------------------------------------------- New Orleans, French Quarter
  {
    id: 'st-louis-cathedral', city: 'nola-quarter', name: 'St. Louis Cathedral', sensitive: true,
    match: { osmIds: ['w329364492'] }, front: { area: 'w27844554' }, lodDist: 300,
    build: stLouisCathedral,
  },
  {
    id: 'jackson-square', city: 'nola-quarter', name: 'Jackson Square (fence + equestrian statue)',
    match: { areaId: 'w27844554' }, lodDist: 120,
    build: jacksonSquare,
  },
  // ---------------------------------------------------------------- Chicago, Loop
  {
    id: 'cloud-gate', city: 'chicago-loop', name: 'Millennium Park mirror sculpture',
    match: { osmIds: ['w137060274'] }, front: 'long', base: 'center', lodDist: 400,
    build: cloudGate,
  },
  // ---------------------------------------------------------------- Seattle, Capitol Hill (backdrop)
  {
    id: 'space-needle', city: 'seattle-caphill', name: 'Space Needle (skyline backdrop)',
    match: { latlon: [47.62051, -122.34929], radius: 4000 }, backdrop: true, lodDist: 1e6,
    build: spaceNeedle,
  },
  // ---------------------------------------------------------------- Austin, South Congress (backdrop)
  {
    id: 'texas-capitol', city: 'austin-soco', name: 'Texas State Capitol (Congress Ave backdrop)',
    match: { latlon: [30.27467, -97.74035], radius: 4500 }, backdrop: true, lodDist: 1e6,
    build: texasCapitol,
  },
  // ---------------------------------------------------------------- Savannah, Historic District
  {
    id: 'savannah-city-hall', city: 'savannah', name: 'Savannah City Hall',
    match: { osmIds: ['w208324776', 'w533821152', 'w1547707860'] }, front: { road: 'Bull Street' }, lodDist: 300,
    build: savannahCityHall,
  },
  // ---------------------------------------------------------------- Phoenix, Downtown
  {
    id: 'phoenix-historic-city-hall', city: 'phoenix-downtown', name: 'Historic City Hall & County Courthouse',
    match: { osmIds: ['w209950211', 'w209950205', 'w209950206'] }, front: 'long', lodDist: 260,
    build: phoenixCityHall,
  },
  // ---------------------------------------------------------------- Miami Beach, South Beach
  {
    id: 'lifeguard-tower-sobe', city: 'miami-beach', name: 'Candy-striped lifeguard tower',
    match: { osmIds: ['w567439901'] }, front: { dir: [1, 0] }, lodDist: 120,
    build: lifeguardTower,
  },
  ...([
    ['w435587753', '#4fd6ff'], ['w380861901', '#ff4fa3'], ['w380861898', '#7cff6b'], ['w255394411', '#4fd6ff'],
    ['w380861927', '#ff6fd0'], ['w380861917', '#ffb347'],
  ] as [string, string][]).map(([id, color]): LandmarkDef => ({
    id: `ocean-drive-neon-${id}`, city: 'miami-beach', name: 'Ocean Drive Art Deco neon fin (generic)',
    match: { osmIds: [id] }, front: { road: 'Ocean Drive' }, replace: false, lodDist: 400,
    build: neonFin(color),
  })),
];
