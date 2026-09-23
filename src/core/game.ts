// Game context + main loop. Modules register Systems and publish their service APIs on the Game.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { EventBus } from './events';
import { Input } from './input';
import type { Recipe } from './types';
import type { WorldAPI, PlayerAPI, VehiclesAPI, HeatAPI, SurveillanceAPI, SkyAPI, AudioAPI } from './api';

export type RAPIER = typeof RAPIER_NS;

export interface System {
  name: string;
  /** Fixed 60 Hz step (physics-coupled logic). */
  fixedUpdate?(dt: number, g: Game): void;
  /** Per-frame update (visuals, AI decisions, UI). */
  update?(dt: number, g: Game): void;
  /** Run after physics step and before render (sync meshes to bodies, camera). */
  lateUpdate?(dt: number, g: Game): void;
  /** Lower runs first. Default 0. */
  order?: number;
}

export type GameMode = 'takedown' | 'freeroam';

export class Game {
  readonly scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 4000);
  renderer!: THREE.WebGLRenderer;
  readonly events = new EventBus();
  readonly input: Input;
  readonly clock = new THREE.Clock();
  /** Elapsed game seconds. */
  elapsed = 0;
  paused = false;
  mode: GameMode = 'takedown';
  quality: 'high' | 'medium' | 'low' = 'high';

  // Physics
  rapier!: RAPIER;
  physics!: RAPIER_NS.World;

  // Service APIs (populated during setup by owning modules)
  world!: WorldAPI;
  player!: PlayerAPI;
  vehicles!: VehiclesAPI;
  heat!: HeatAPI;
  surveillance!: SurveillanceAPI;
  sky!: SkyAPI;
  audio!: AudioAPI;

  /** Render function (set by src/render; defaults to plain renderer.render). */
  renderFrame: (dt: number) => void = () => this.renderer.render(this.scene, this.camera);

  private systems: System[] = [];
  private acc = 0;
  static readonly FIXED_DT = 1 / 60;

  constructor(public recipe: Recipe, public container: HTMLElement) {
    this.input = new Input(container);
  }

  addSystem(s: System) {
    this.systems.push(s);
    this.systems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  removeSystem(name: string) {
    this.systems = this.systems.filter((s) => s.name !== name);
  }

  start() {
    this.clock.start();
    const loop = () => {
      requestAnimationFrame(loop);
      this.frame();
    };
    requestAnimationFrame(loop);
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (!this.paused) {
      this.elapsed += dt;
      this.acc += dt;
      let steps = 0;
      while (this.acc >= Game.FIXED_DT && steps < 4) {
        for (const s of this.systems) s.fixedUpdate?.(Game.FIXED_DT, this);
        this.physics?.step();
        this.acc -= Game.FIXED_DT;
        steps++;
      }
      if (steps === 4) this.acc = 0;
      for (const s of this.systems) s.update?.(dt, this);
      for (const s of this.systems) s.lateUpdate?.(dt, this);
    }
    this.input.endFrame();
    this.renderFrame(dt);
  }
}
