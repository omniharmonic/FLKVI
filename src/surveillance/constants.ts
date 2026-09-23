// Tuning constants for the surveillance takedown mode. Everything gameplay-relevant lives here.
import type { CameraType } from '../core/types';

export const TUNE = {
  /** Seconds between perception ticks per camera. */
  detectInterval: 0.1,
  /** Cameras cannot see steeper than this below horizontal (blind spot under the head). */
  maxDownAngleDeg: 62,
  /** Vertical half-FOV above horizontal. */
  maxUpAngleDeg: 12,
  /** Player target point height above feet. */
  playerEyeH: 1.2,
  /** Near a downed/disabled camera within this window after takedown counts as being "at the scene". */
  sceneWindowS: 10,
  sceneRadiusM: 6,
  /** Min seconds between repeated camera witness reports while the player keeps being seen acting. */
  witnessRepeatS: 2.5,
  plateHitCooldownS: 8,

  // Takedowns
  interactRadius: 2.5,
  disableTime: { pole: 4, ptz: 4.5, cluster: 5, tower: 6 } as Record<CameraType, number>,
  cutTime: { pole: 15, ptz: 17, cluster: 999, tower: 20 } as Record<CameraType, number>,
  policeInterruptRadius: 4,
  noiseEveryS: 1,
  noiseRadiusDay: 40,
  noiseRadiusNight: 70,
  sprayNoiseRadius: 8,
  grinderCharges: 3,
  grinderMax: 4,

  // Aftermath
  tamperDelayMin: 5,
  tamperDelayMax: 10,
  repairDelayMin: 90,
  repairDelayMax: 150,
  repairDuration: 30,
  rehitMult: 0.5,

  // Scoring (§7)
  baseDisable: 100,
  baseCut: 300,
  typeMult: { pole: 1.0, ptz: 1.25, cluster: 1.5, tower: 2.5 } as Record<CameraType, number>,
  droneMult: 2.0,
  coveragePer: 0.25,
  streakStep: 0.1,
  streakCap: 3.0,

  // Fog of war / scouting
  discoverRadius: 60,
  binocularRadius: 250,
  binocularFov: 15,
  proximityConeRadius: 35,
  scanRadius: 320,

  // Escalation (§9)
  escalatePatrols: 5,
  escalateInstalls: 10,
  escalateDrones: 20,
  fastRepairMult: 0.6,
  installEveryS: [60, 95] as [number, number],
  maxInstalls: 12,
  droneEveryS: 70,
  maxDrones: 3,
} as const;

export function streakMult(streak: number) {
  return Math.min(TUNE.streakCap, 1 + TUNE.streakStep * streak);
}
