// Typed event bus shared by all systems. Add new event types here (append only; don't rename).
import type { Vec2, CameraType } from './types';

export interface GameEvents {
  /** A crime/suspicious act happened at p. severity 1..5. */
  crime: { kind: 'takedown-cut' | 'takedown-disable' | 'carjack' | 'assault' | 'vehicle-hit' | 'reckless'; p: Vec2; severity: number };
  /** Noise that nearby NPCs can hear (grinder, crash, siren...). */
  noise: { p: Vec2; radius: number; kind: string };
  /** A witness (camera / npc / police) reports the player. */
  witness: { source: 'camera' | 'npc' | 'police'; p: Vec2; confidence: number; delay: number; sourceId?: string };
  plateHit: { cameraId: string; p: Vec2 };
  tamperAlert: { cameraId: string; p: Vec2 };
  takedownStart: { cameraId: string; mode: 'cut' | 'disable' };
  takedownProgress: { cameraId: string; mode: 'cut' | 'disable'; t: number };
  takedownCancel: { cameraId: string };
  takedown: { cameraId: string; mode: 'cut' | 'disable'; type: CameraType; seen: boolean; coverage: number; p: Vec2; /** points awarded (surveillance) */ points?: number; /** true when the target was a surveillance drone (type is reported as 'ptz') */ drone?: boolean };
  cameraRepaired: { cameraId: string };
  cameraInstalled: { cameraId: string };
  heatChanged: { heat: number; prev: number };
  heatZero: {};
  /** Player spotted by police right now (drives search/pursuit HUD). */
  playerSpotted: { by: 'police' | 'camera' | 'npc' };
  arrested: {};
  runStart: {};
  runEnd: { streak: number; score: number; banked: number; reason: 'arrested' | 'quit' };
  score: { points: number; streak: number; hot: number; banked: number; multiplier: number };
  banked: { amount: number; total: number };
  playerEnterVehicle: { vehicleId: string; stolen: boolean };
  playerExitVehicle: { vehicleId: string };
  toast: { text: string; kind?: 'info' | 'warn' | 'good' | 'bad'; ms?: number };
  worldReady: {};
  /** Contextual interaction prompt for the HUD (e.g. 'Hold E: Disable · Hold R: Cut'); null hides it. */
  prompt: { text: string | null };
  /** Surveillance: a previously unmapped camera was spotted (fog of war). */
  cameraDiscovered: { cameraId: string; via: 'sight' | 'binoculars' };
  /** Surveillance escalation director stepped up (1 = more patrols + faster repairs, 2 = new installs, 3 = drones). AI may add patrols near `hotspots`. */
  escalation: { level: number; streak: number; hotspots: Vec2[] };
  /** Gameplay: player swung a punch/shove at p toward dir. AI may knock over a pedestrian in range (and emit crime 'assault'). */
  playerMelee: { p: Vec2; dir: Vec2; range: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[events] handler for ${String(type)} failed`, e); }
    }
  }
}
