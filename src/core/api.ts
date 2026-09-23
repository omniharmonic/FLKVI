// Service interfaces that modules expose on the Game object. Each module team owns its implementation.
// Keep these stable; extend by adding optional members.
import type * as THREE from 'three';
import type { Vec2, Vec3, RecipeCamera } from './types';

/** Owned by src/world. */
export interface WorldAPI {
  /** Terrain height at x,z (m). */
  heightAt(x: number, z: number): number;
  /** Top walkable surface at x,z (terrain, road deck; not roofs). */
  groundAt(x: number, z: number): number;
  /** True if static geometry (buildings/terrain) blocks the segment a→b. */
  losBlocked(a: Vec3, b: Vec3): boolean;
  /** Road graph helpers (graph lives in game.recipe.graph). */
  nearestNode(p: Vec2): number;
  /** Shortest path of graph node ids (A*). Empty if unreachable. */
  route(fromNode: number, toNode: number): number[];
  /** Random point on a sidewalk / pedestrian area near p within radius (for peds). */
  randomSidewalkPoint(near: Vec2, radius: number, rnd?: () => number): Vec2 | null;
  /** Meshes to raycast against (buildings, terrain), for camera collision etc. */
  staticMeshes: THREE.Object3D[];
  /** Night-light hook: set 0..1 for emissive windows/streetlights. */
  setNightFactor(f: number): void;
}

/** Owned by src/game. */
export interface PlayerAPI {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly heading: number;
  /** Id of the vehicle the player drives, or null on foot. */
  vehicleId: string | null;
  /** True while doing something obviously suspicious (e.g. takedown in progress). */
  suspicious: boolean;
  /** Whether the current vehicle's plate is flagged (seen at a takedown). */
  plateFlagged: boolean;
  health: number;
  /** Freeze controls (menus, arrest cutscene). */
  controlsEnabled: boolean;
  /** Teleport and reset (respawn). */
  respawn(p: Vec2, heading?: number): void;
  /** Busy lock for hold-to-act interactions (surveillance owns it while acting). */
  busy: boolean;
  /** Optional: crouching/sneaking (AI perception shortens detection range). */
  crouching?: boolean;
  /** Optional (gameplay): sprinting on foot — louder / more conspicuous. */
  sprinting?: boolean;
  /** Optional (gameplay): turn to face a world heading now (0 = north/−Z, clockwise), e.g. at a takedown. */
  face?(heading: number): void;
}

/** A dynamic vehicle in the world (player, traffic, police, parked). Owned by src/game (vehicles). */
export interface VehicleHandle {
  id: string;
  kind: 'civilian' | 'police' | 'player';
  object: THREE.Object3D;
  position: THREE.Vector3;
  heading: number;
  speed: number;
  /** AI or player control inputs, -1..1 */
  control: { throttle: number; brake: number; steer: number; handbrake: boolean };
  driver: 'player' | 'ai' | 'none';
  siren?: boolean;
  flagged?: boolean;
  destroyed?: boolean;
  /** Optional: hazard lights on (both turn signals blink) — broken down, crashed, pulled over. */
  hazards?: boolean;
}

export interface VehiclesAPI {
  all(): VehicleHandle[];
  get(id: string): VehicleHandle | undefined;
  spawn(opts: { kind: 'civilian' | 'police'; p: Vec2; heading: number; model?: string; physics?: boolean }): VehicleHandle;
  despawn(id: string): void;
  /** Nearest enterable vehicle within radius of p. */
  nearest(p: Vec2, radius: number): VehicleHandle | undefined;
}

/** Owned by src/ai (heat/police). */
export interface HeatAPI {
  /** 0..5 */
  readonly level: number;
  /** 0..1 progress within current level (for HUD). */
  readonly progress: number;
  readonly lastKnown: Vec2 | null;
  /** True while police currently see the player. */
  readonly spotted: boolean;
  /** 0..1 how close police are to catching (arrest meter). */
  readonly arrestMeter: number;
  add(amount: number, p: Vec2): void;
  clear(): void;
  /** Optional (ai): area police are searching while they've lost sight (level > 0, not spotted). Minimap draws it. */
  readonly searchArea?: { p: Vec2; r: number } | null;
}

/** Owned by src/ai (optional). Hooks for the surveillance Escalation director / debugging. */
export interface AIAPI {
  /** Idle police patrol cars cruising at heat 0 (default 2). */
  setPatrolDensity(n: number): void;
  readonly patrolDensity: number;
}

/** Owned by src/surveillance. */
export interface SurveillanceAPI {
  cameras(): (RecipeCamera & { status: 'active' | 'disabled' | 'down' | 'repairing'; discovered: boolean; /** # other active cameras watching this one */ coverage?: number; /** currently sees the player */ seesPlayer?: boolean; installed?: boolean })[];
  streak: number;
  score: number;
  banked: number;
  hot: number;
  selectedTarget: string | null;
  /** Optional: grinder battery charges remaining / max (HUD shows pips when defined). */
  grinderCharges?: number;
  grinderMax?: number;
  /** Distance (m) from the player to selectedTarget, or null. */
  targetDistance?: number | null;
  /** Current streak multiplier (1..3). */
  multiplier?: number;
  /** Hold-to-act progress, or null when idle. */
  action?: { cameraId: string; mode: 'cut' | 'disable'; t: number; seen: boolean } | null;
  /** True while Q (scan) is held / while binoculars (B) are up. */
  scanning?: boolean;
  binoculars?: boolean;
  /** Surveillance drones currently flying (escalation, streak 20+). */
  drones?: () => { id: string; p: [number, number, number] }[];
}

/** Owned by src/render. */
export interface SkyAPI {
  /** Hours 0..24. */
  time: number;
  /** Game-seconds per real second multiplier. */
  timeScale: number;
  readonly sunDirection: THREE.Vector3;
  /** 0 day .. 1 full night. */
  readonly nightFactor: number;
  readonly sun: THREE.DirectionalLight;
}

/** Owned by src/audio. */
export interface AudioAPI {
  play(name: string, opts?: { at?: Vec3; volume?: number; loop?: boolean; rate?: number }): { stop(): void; setVolume(v: number): void; setRate(r: number): void; setPosition(p: Vec3): void } | null;
  listener: THREE.AudioListener | null;
}
