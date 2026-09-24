// Groundtruth shared contract: the World Recipe (compiler → client).
// Coordinates: local ENU meters around recipe.origin. +X = east, +Z = SOUTH (north is -Z), +Y = up.
// A 2D point is [x, z]. Heights (y) come from the terrain heightfield unless stated.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type Region =
  | 'northeast' | 'southeast' | 'midwest' | 'south-central'
  | 'mountain-west' | 'southwest' | 'pacific' | 'alaska-hawaii';

export type Climate = 'arid' | 'humid' | 'cold' | 'coastal';

export type Era = 'pre-1900' | '1900-1939' | '1940-1969' | '1970-1999' | '2000+';

export type BuildingUse =
  | 'residential-single' | 'residential-multi' | 'commercial' | 'office'
  | 'industrial' | 'civic' | 'agricultural' | 'mixed-use' | 'parking' | 'religious' | 'school' | 'hospital';

export type RoofType = 'flat' | 'gable' | 'hip' | 'shed' | 'mansard' | 'gambrel' | 'pyramid' | 'dome';

/** Style kit ids (Asset Spec §4). The assembler maps these to facade grammars. */
export type StyleKit =
  | 'ranch' | 'craftsman' | 'victorian' | 'colonial' | 'contemporary-suburban' | 'modern-infill'
  | 'pueblo' | 'mediterranean' | 'brownstone' | 'garden-apartments' | 'podium-mixed-use'
  | 'main-street-block' | 'art-deco' | 'strip-mall' | 'big-box' | 'gas-station' | 'office-park'
  | 'masonry-tower' | 'curtain-wall-tower' | 'glass-tower' | 'brick-warehouse' | 'metal-shed'
  | 'parking-garage' | 'civic' | 'school' | 'worship' | 'generic';

export type FacadeMaterial =
  | 'brick-red' | 'brick-brown' | 'brick-tan' | 'brick-painted' | 'stucco' | 'lap-siding'
  | 'board-batten' | 'stone' | 'sandstone' | 'concrete' | 'glass-curtain' | 'metal-panel' | 'adobe' | 'wood-shingle';

export type RoofMaterial = 'asphalt-shingle' | 'clay-tile' | 'standing-seam' | 'slate' | 'membrane' | 'gravel';

export interface RecipeBuilding {
  id: string;
  /** Outer ring, counter-clockwise when viewed from above (x east, z south → CCW in x/-z). Not closed (last != first). */
  footprint: Vec2[];
  /** Inner rings (courtyards), optional. */
  holes?: Vec2[][];
  /** Lowest terrain height under the footprint (m). */
  baseY: number;
  /** Wall height above baseY (eaves / parapet top), m. */
  height: number;
  /** Additional roof height above `height` for pitched roofs, m. */
  roofHeight: number;
  /** For building:part with min_height (e.g. upper setbacks). */
  minHeight?: number;
  levels: number;
  roof: { type: RoofType; material: RoofMaterial; color: string; /** ridge direction in radians, optional: atan2(dz, dx) of the ridge line (0 = ridge runs east-west), in [0, PI) */ orientation?: number };
  use: BuildingUse;
  era: Era;
  kit: StyleKit;
  material: FacadeMaterial;
  /** Facade tint hex like '#b5654a'. */
  color: string;
  /** Deterministic seed derived from id. */
  seed: number;
  /** Ground floor storefront on street-facing edges. */
  storefront: boolean;
  /** Indices of footprint edges (edge i = footprint[i]→footprint[i+1]) that face a street. */
  streetEdges: number[];
  name?: string;
  /** Business category for generic signage (no brands): 'DINER','PHARMACY',... */
  signage?: string;
  sensitive?: boolean;
  /** A vessel mapped as a building (OSM building=ship/boat/houseboat, ship=*, boat=*): floats / sits, never gets a plinth. */
  boat?: boolean;
}

export type RoadClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential'
  | 'service' | 'living_street' | 'unclassified' | 'pedestrian' | 'footway' | 'cycleway' | 'path' | 'steps';

export interface RecipeRoad {
  id: string;
  cls: RoadClass;
  /** Centerline polyline [x,z]. */
  pts: Vec2[];
  /** Centerline heights, same length as pts. */
  ys: number[];
  /** Carriageway width, curb to curb (m). */
  width: number;
  lanes: number;
  oneway: boolean;
  /** Sidewalk width each side (0 = none). When sidewalkL/R are present this is the wider of the two. */
  sidewalk: number;
  /** Optional per-side sidewalk widths (m), left / right of the travel direction along `pts`
   *  (right = (−dz, dx) seen from above). Present only when the two sides differ; override `sidewalk` per side. */
  sidewalkL?: number;
  sidewalkR?: number;
  maxSpeed: number; // m/s
  surface: 'asphalt' | 'concrete' | 'brick' | 'gravel' | 'paving';
  bridge?: boolean;
  tunnel?: boolean;
  name?: string;
  /** Node ids at each pt (from OSM) so junctions can be matched. */
  nodes: number[];
}

/** Road graph for traffic/police routing. */
export interface RoadGraph {
  nodes: { id: number; p: Vec2; y: number; signal?: boolean; stop?: boolean }[];
  /** Directed edges. roadId references RecipeRoad.id. */
  edges: { from: number; to: number; roadId: string; length: number; lanes: number; speed: number; cls: RoadClass }[];
}

export type AreaKind =
  | 'park' | 'grass' | 'forest' | 'water' | 'parking' | 'pedestrian' | 'sand' | 'farmland'
  | 'residential' | 'commercial' | 'industrial' | 'playground' | 'pitch' | 'cemetery' | 'plaza';

export interface RecipeArea { id: string; kind: AreaKind; poly: Vec2[]; holes?: Vec2[][] }

export interface RecipeTree {
  p: Vec2;
  y: number;
  species: string; // e.g. 'honey-locust', 'ponderosa-pine', 'cottonwood', 'blue-spruce', 'maple'
  height: number;
  crown: number; // crown diameter m
  seed: number;
}

export type PropType =
  | 'streetlight' | 'traffic-signal' | 'stop-sign' | 'hydrant' | 'bench' | 'trash-can' | 'bus-stop'
  | 'bike-rack' | 'bollard' | 'utility-pole' | 'mailbox' | 'parking-meter' | 'planter' | 'parked-car'
  | 'newspaper-box' | 'crosswalk' | 'manhole' | 'fence' | 'hedge' | 'shrub';

export interface RecipeProp {
  type: PropType; p: Vec2; y: number;
  /** Facing, same convention as RecipeCamera.heading: 0 = front faces -Z (north), clockwise seen from above.
   *  streetlight/hydrant/signal/sign/bench: faces the road; parked-car: direction the car's nose points;
   *  crosswalk: along the road's travel direction (stripes run across it); utility-pole: along the street. */
  rot: number;
  variant: number;
  /** fence/hedge polyline */ line?: Vec2[];
}

export type CameraType = 'pole' | 'ptz' | 'cluster' | 'tower';

export interface RecipeCamera {
  id: string;
  type: CameraType;
  p: Vec2;
  y: number;
  heading: number; // radians, 0 = looking toward -Z (north), increasing clockwise seen from above
  poleHeight: number;
  cuttable: boolean;
  fovDeg: number;
  rangeM: number;
  sweep?: { amplitudeDeg: number; periodS: number };
  plateReader: boolean;
  /** true = shown on camera map from the start (fog of war otherwise). */
  mapped: boolean;
}

export interface Terrain {
  /** Heightfield covering bounds; row-major, rows along +Z. heights[row * cols + col]. */
  cols: number;
  rows: number;
  /** World x,z of sample (0,0). */
  originX: number;
  originZ: number;
  /** Spacing in meters. */
  cellSize: number;
  heights: number[];
}

export interface Recipe {
  version: 1;
  name: string;
  origin: { lat: number; lon: number };
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  region: Region;
  climate: Climate;
  tier: 'S' | 'A' | 'B';
  terrain: Terrain;
  /** Optional coarse terrain (~10-15 km, 30-60 m cells) for distant backdrop (mountains, hills). */
  farTerrain?: Terrain;
  roads: RecipeRoad[];
  graph: RoadGraph;
  buildings: RecipeBuilding[];
  areas: RecipeArea[];
  trees: RecipeTree[];
  props: RecipeProp[];
  cameras: RecipeCamera[];
  spawn: { p: Vec2; y: number; heading: number };
  attribution: string[];
  /** Absolute elevation (m, NAVD88-ish) of y = 0. All y values are relative to this datum. */
  elevation?: number;
}
