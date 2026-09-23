// OWNER: surveillance agent. Cameras, detection, takedowns, scoring/streak/banking, escalation.
//
// Controls: E hold = disable (spray / bag) · R hold = cut down (grinder, uses a charge) · Q hold = scan (show vision
// cones of discovered cameras) · B hold = binoculars (zoom; discovers cameras in view up to 250 m).
//
// Run model: a new run (runStart) REBUILDS the network — every camera is restored and run-installed cameras and
// drones are removed — so each run is a fresh, fair attempt at the longest streak. Map knowledge (fog-of-war
// discoveries) persists across runs within a session: what you scouted, you know.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { SurveillanceAPI } from '../core/api';
import type { RecipeCamera, Vec2, Vec3, CameraType } from '../core/types';
import { hashString, rng } from '../core/geo';
import { playerTarget } from '../ai/perception';
import { TUNE, streakMult } from './constants';
import { Network, type Cam } from './network';
import { VisionViz } from './vision';
import { Takedowns, type Acting } from './takedown';
import { CrewManager } from './van';
import { Drone } from './drone';
import { Beacon } from './beacon';

export { TUNE } from './constants';

const TYPE_NAME: Record<CameraType, string> = { pole: 'pole camera', ptz: 'PTZ dome', cluster: 'signal-mast cluster', tower: 'surveillance tower' };

interface HotEntry { points: number }

export class Surveillance implements SurveillanceAPI {
  streak = 0;
  score = 0;
  banked = 0;
  hot = 0;
  selectedTarget: string | null = null;
  targetDistance: number | null = null;
  multiplier = 1;
  grinderCharges: number = TUNE.grinderCharges;
  grinderMax: number = TUNE.grinderMax;
  action: SurveillanceAPI['action'] = null;
  scanning = false;
  binoculars = false;
  uiHandlesPrompts?: boolean;

  readonly root = new THREE.Group();
  readonly net: Network;
  readonly vision: VisionViz;
  readonly takedowns: Takedowns;
  readonly crews: CrewManager;
  readonly beacon = new Beacon();
  readonly droneList: Drone[] = [];
  private hotList: HotEntry[] = [];
  private checkT = 0;
  private scoutT = 0;
  private spottedT = 0;
  private tamper: { at: number; cam: Cam }[] = [];
  private scenes: { cam: Cam; until: number; reported: boolean }[] = [];
  private escalation = 0;
  private installT = 0;
  private droneT = 0;
  private installs = 0;
  private droneSeq = 0;
  private savedFov: number | null = null;
  private binoFov = 0;
  private runActive = true;
  private lastVehicleId: string | null = null;
  private binoOverlay: HTMLDivElement | null = null;

  constructor(readonly g: Game) {
    this.root.name = 'surveillance';
    g.scene.add(this.root);
    this.net = new Network(g, this.root);
    this.net.build();
    this.net.onClang = (cam, strength, p) => {
      g.audio?.play('metal-fall', { at: [p.x, p.y, p.z], volume: strength });
      g.events.emit('noise', { p: [p.x, p.z], radius: 45 * strength, kind: 'metal-fall' });
      this.takedowns.dust(p, strength);
      void cam;
    };
    this.vision = new VisionViz(g, this.net, this.root);
    this.crews = new CrewManager(g);
    this.root.add(this.crews.root);
    this.root.add(this.beacon.obj);
    const self = this;
    this.takedowns = new Takedowns({
      g,
      night: () => this.night(),
      get grinderCharges() { return self.grinderCharges; },
      nearestDrone: (p) => this.nearestDrone(p),
      targetCams: (p) => this.targetCam(p),
      makeOverlay: (cam, kind, seed) => this.net.makeOverlay(cam, kind, seed),
      clearOverlay: (cam) => this.net.clearOverlay(cam),
      complete: (a) => this.complete(a),
      ground: (x, z, fb) => this.net.groundAt(x, z, fb),
    });
    this.root.add(this.takedowns.root);
    this.net.recomputeCoverage();

    g.events.on('heatZero', () => this.bankAll());
    g.events.on('arrested', () => this.onArrested());
    g.events.on('runStart', () => this.resetRun());
    g.events.on('playerExitVehicle', (e) => { this.lastVehicleId = e.vehicleId; });
    g.events.on('playerEnterVehicle', (e) => { this.lastVehicleId = e.vehicleId; });
  }

  // ------------------------------------------------------------------ API
  cameras() {
    return this.net.cams.map((c) => ({ ...c.rc, status: c.status, discovered: c.discovered, coverage: c.coverage, seesPlayer: c.seesPlayer, installed: c.installed }));
  }
  drones = () => this.droneList.filter((d) => d.mode !== 'crashed').map((d) => ({ id: d.id, p: [d.pos.x, d.pos.y, d.pos.z] as [number, number, number] }));

  // ------------------------------------------------------------------ helpers
  night(): number { const n = this.g.sky?.nightFactor; return typeof n === 'number' ? n : 0; }
  private heatLevel(): number { return this.g.heat?.level ?? 0; }
  private toast(text: string, kind: 'info' | 'warn' | 'good' | 'bad' = 'info', ms = 2600) { this.g.events.emit('toast', { text, kind, ms }); }
  private pp(): THREE.Vector3 | null { return this.g.player?.position ?? null; }

  private targetCam(p: THREE.Vector3): Cam | null {
    let best: Cam | null = null, bd: number = TUNE.interactRadius;
    for (const c of this.net.cams) {
      if (c.status === 'down') continue;
      const d = Math.hypot(c.work.x - p.x, c.work.z - p.z);
      if (d < bd && Math.abs(c.groundY - p.y) < 2.5) { bd = d; best = c; }
    }
    return best;
  }

  private nearestDrone(p: THREE.Vector3): Drone | null {
    for (const d of this.droneList) if (d.reachable(p, this.net.groundAt(p.x, p.z, p.y))) return d;
    return null;
  }

  private streetName(p: THREE.Vector3): string | null {
    let best: string | null = null, bd = 60;
    for (const r of this.g.recipe.roads ?? []) {
      if (!r.name) continue;
      for (const q of r.pts) { const d = Math.hypot(q[0] - p.x, q[1] - p.z); if (d < bd) { bd = d; best = r.name; } }
    }
    return best;
  }

  // ------------------------------------------------------------------ frame
  update(dt: number) {
    const g = this.g;
    const t = g.elapsed;
    const night = this.night();
    const pos = this.pp();
    // input
    const inputOK = !!g.player && g.player.controlsEnabled !== false;
    this.scanning = inputOK && g.input.isDown('KeyQ');
    this.net.update(dt, t, night);
    this.takedowns.update(dt, t);
    const a = this.takedowns.acting;
    this.action = a ? { cameraId: a.id, mode: a.mode, t: a.t, seen: a.seen } : null;

    // perception at ~10 Hz
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = TUNE.detectInterval; this.perceive(t); }
    // fog of war at 4 Hz
    this.scoutT -= dt;
    if (this.scoutT <= 0) { this.scoutT = 0.25; this.scout(); }

    // aftermath timers
    for (let i = this.tamper.length - 1; i >= 0; i--) {
      if (t >= this.tamper[i].at) {
        const c = this.tamper[i].cam;
        g.events.emit('tamperAlert', { cameraId: c.rc.id, p: [c.work.x, c.work.z] });
        g.audio?.play('alert', { volume: 0.5 });
        this.toast(`Tamper alert: a unit is being sent to check the ${TYPE_NAME[c.type]}`, 'warn');
        this.tamper.splice(i, 1);
      }
    }
    for (const c of this.net.cams) {
      if (c.status === 'disabled' && t >= c.repairAt) {
        c.status = 'repairing';
        c.repairEndAt = t + TUNE.repairDuration;
        this.crews.dispatch(c);
        this.net.recomputeCoverage();
        if (pos && c.discovered && Math.hypot(c.work.x - pos.x, c.work.z - pos.z) < 250) this.toast(`A repair crew arrived at a ${TYPE_NAME[c.type]}`, 'info');
      } else if (c.status === 'repairing' && t >= c.repairEndAt) {
        c.status = 'active';
        this.net.clearOverlay(c);
        this.crews.release(c);
        this.net.recomputeCoverage();
        g.events.emit('cameraRepaired', { cameraId: c.rc.id });
      }
    }
    this.crews.update(dt, t, night);
    this.director(dt, t);
    this.updateDrones(dt, t, night);
    this.vision.scanning = this.scanning;
    this.vision.update(dt, t, night, pos);

    // target beacon
    const sel = this.selectedTarget ? this.net.byId.get(this.selectedTarget) : null;
    if (sel && pos) {
      const top = sel.status === 'down' ? sel.groundY + 1 : Math.max(sel.eye.y, sel.groundY + 3);
      this.beacon.update(t, sel.work, top, pos, g.camera.position);
    } else this.beacon.update(t, null, 0, pos ?? g.camera.position, g.camera.position);
    this.targetDistance = this.beacon.distance;
    if (sel && sel.status === 'down' && t - sel.lastTakedownAt > 3) this.selectedTarget = null;
  }

  /** Late update: binoculars FOV override (after gameplay's camera). */
  lateUpdate(dt: number) {
    const g = this.g;
    const want = !!g.player && g.player.controlsEnabled !== false && !this.takedowns.acting && g.input.isDown('KeyB');
    const cam = g.camera;
    if (want && this.savedFov === null) { this.savedFov = cam.fov; this.binoFov = cam.fov; }
    if (this.savedFov !== null) {
      const target = want ? TUNE.binocularFov : this.savedFov;
      this.binoFov += (target - this.binoFov) * Math.min(1, dt * 10);
      cam.fov = this.binoFov;
      cam.updateProjectionMatrix();
      if (!want && Math.abs(this.binoFov - this.savedFov) < 0.3) { cam.fov = this.savedFov; cam.updateProjectionMatrix(); this.savedFov = null; }
    }
    this.binoculars = want;
    this.binoOverlayShow(want);
  }

  private binoOverlayShow(on: boolean) {
    if (!on && !this.binoOverlay) return;
    if (!this.binoOverlay) {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;opacity:0;transition:opacity .25s;' +
        'background:radial-gradient(ellipse 34% 46% at 38% 50%, transparent 92%, rgba(0,0,0,.92) 100%),radial-gradient(ellipse 34% 46% at 62% 50%, transparent 92%, rgba(0,0,0,.92) 100%);' +
        'mix-blend-mode:multiply;';
      const inner = document.createElement('div');
      inner.style.cssText = 'position:absolute;inset:0;background:radial-gradient(ellipse 60% 55% at 50% 50%, transparent 60%, rgba(0,0,0,.85) 100%);';
      d.appendChild(inner);
      document.body.appendChild(d);
      this.binoOverlay = d;
    }
    this.binoOverlay.style.opacity = on ? '1' : '0';
  }

  // ------------------------------------------------------------------ perception
  private perceive(t: number) {
    const g = this.g;
    const target = playerTarget(g) as Vec3 | null;
    const pos = this.pp();
    let anySees = false;
    const a = this.takedowns.acting;
    for (const c of this.net.cams) {
      c.seesPlayer = false;
      if (!target || c.status !== 'active') continue;
      const dx = c.eye.x - target[0], dz = c.eye.z - target[2];
      if (dx * dx + dz * dz > (c.rc.rangeM + 3) ** 2) continue;
      // a camera can't report its own takedown (you're under / behind it), others can
      if (a && a.target.kind === 'cam' && a.target.cam === c) continue;
      c.seesPlayer = this.net.sees(c, target);
      if (c.seesPlayer) anySees = true;
    }
    for (const d of this.droneList) {
      d.seesPlayer = !!target && d.sees(g, target);
      if (d.seesPlayer) anySees = true;
    }
    if (!target || !pos) return;
    const p2: Vec2 = [pos.x, pos.z];
    const witness = (sourceId: string) => {
      g.events.emit('witness', { source: 'camera', p: p2, confidence: 1, delay: 0, sourceId });
      g.events.emit('playerSpotted', { by: 'camera' });
    };
    const watcher = () => this.net.cams.find((c) => c.seesPlayer)?.rc.id ?? this.droneList.find((d) => d.seesPlayer)?.id ?? 'camera';

    // 1) takedown in progress seen by any camera / drone → instant high-confidence report
    if (a && anySees) {
      if (!a.seen) {
        a.seen = true;
        g.audio?.play('alert', { volume: 0.8 });
        this.toast('SPOTTED by a camera!', 'bad', 1800);
        this.flagVehicle(pos);
      }
      if (t - (this.lastWitnessAt ?? -1e9) > TUNE.witnessRepeatS) { this.lastWitnessAt = t; witness(watcher()); }
    }
    // 2) lingering at a fresh scene (downed/disabled within 10 s) in view of a camera
    for (let i = this.scenes.length - 1; i >= 0; i--) {
      const s = this.scenes[i];
      if (t > s.until) { this.scenes.splice(i, 1); continue; }
      if (s.reported || !anySees) continue;
      if (Math.hypot(s.cam.work.x - pos.x, s.cam.work.z - pos.z) < TUNE.sceneRadiusM) {
        s.reported = true;
        witness(watcher());
        this.toast('A camera caught you at the scene', 'bad', 1800);
        this.flagVehicle(pos);
      }
    }
    // 3) plate readers: flagged vehicle driving through a plate-reader cone
    const vid = g.player?.vehicleId;
    if (vid) {
      const v = g.vehicles?.get?.(vid);
      const flagged = !!(v?.flagged || g.player.plateFlagged);
      if (flagged && v) {
        const vp: Vec3 = [v.position.x, v.position.y + 1.0, v.position.z];
        for (const c of this.net.cams) {
          if (!c.rc.plateReader || c.status !== 'active' || t - c.lastPlateAt < TUNE.plateHitCooldownS) continue;
          const dx = c.eye.x - vp[0], dz = c.eye.z - vp[2];
          if (dx * dx + dz * dz > c.rc.rangeM ** 2) continue;
          if (this.net.sees(c, vp)) {
            c.lastPlateAt = t;
            g.events.emit('plateHit', { cameraId: c.rc.id, p: [vp[0], vp[2]] });
            g.audio?.play('alert', { volume: 0.4 });
            this.toast('Plate reader logged your vehicle', 'bad', 2000);
          }
        }
      }
    }
    // 4) tracking: while wanted, a camera seeing you tells police where you are (does not escalate by itself)
    if (anySees && this.heatLevel() > 0 && t - this.spottedT > 0.5) { this.spottedT = t; g.events.emit('playerSpotted', { by: 'camera' }); }
  }
  private lastWitnessAt = -1e9;

  /** Seen at a takedown: the vehicle you arrived in is identified (if it's nearby). */
  private flagVehicle(p: THREE.Vector3) {
    const g = this.g;
    const id = g.player?.vehicleId ?? this.lastVehicleId;
    if (!id) return;
    const v = g.vehicles?.get?.(id);
    if (!v || v.destroyed) return;
    if (v.position.distanceTo(p) > 80) return;
    if (!v.flagged) { v.flagged = true; this.toast('Your vehicle was identified. Plate readers will flag it; switch cars out of sight.', 'warn', 4200); }
    if (g.player.vehicleId === id) g.player.plateFlagged = true;
  }

  // ------------------------------------------------------------------ fog of war
  private frustum = new THREE.Frustum();
  private scout() {
    const g = this.g;
    const pos = this.pp();
    if (!pos) return;
    const camObj = g.camera;
    camObj.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camObj.projectionMatrix, camObj.matrixWorldInverse));
    const from: Vec3 = [camObj.position.x, camObj.position.y, camObj.position.z];
    const radius = this.binoculars ? TUNE.binocularRadius : TUNE.discoverRadius;
    const w = g.world;
    let found = 0;
    for (const c of this.net.cams) {
      if (c.discovered) continue;
      const d = Math.hypot(c.work.x - pos.x, c.work.z - pos.z);
      if (d > radius) continue;
      const head = c.eye.clone();
      if (!this.frustum.containsPoint(head)) continue;
      let blocked = false;
      try { blocked = !!w?.losBlocked?.(from, [head.x, head.y + 0.2, head.z]); } catch { /* */ }
      if (blocked) continue;
      c.discovered = true;
      found++;
      g.events.emit('cameraDiscovered', { cameraId: c.rc.id, via: this.binoculars ? 'binoculars' : 'sight' });
      if (found <= 2) this.toast(`Spotted an unmapped ${TYPE_NAME[c.type]}${this.binoculars ? ` (${Math.round(d)} m)` : ''} — added to map`, 'good');
    }
  }

  // ------------------------------------------------------------------ takedown resolution + scoring
  private complete(a: Acting) {
    const g = this.g;
    const t = g.elapsed;
    const pos = this.pp()!;
    let type: CameraType = 'ptz';
    let coverage = 0;
    let points: number;
    let at: THREE.Vector3;
    const mult = streakMult(this.streak);
    if (a.target.kind === 'drone') {
      const d = a.target.drone;
      d.knockDown();
      at = d.pos.clone();
      points = Math.round(TUNE.baseDisable * TUNE.droneMult * mult);
      g.audio?.play('metal-fall', { at: [at.x, at.y, at.z], volume: 0.5 });
    } else {
      const c = a.target.cam;
      type = c.type;
      coverage = c.coverage;
      at = c.work.clone();
      const base = a.mode === 'cut' ? TUNE.baseCut : TUNE.baseDisable;
      const rehit = a.mode === 'disable' && c.hits > 0 ? TUNE.rehitMult : 1;
      points = Math.round(base * TUNE.typeMult[type] * (1 + TUNE.coveragePer * coverage) * mult * rehit);
      c.lastTakedownAt = t;
      if (a.mode === 'cut') {
        this.net.clearOverlay(c);
        this.net.topple(c, pos);
        this.grinderCharges = Math.max(0, this.grinderCharges - 1);
        if (this.grinderCharges === 0) this.toast('Grinder battery is empty. Bank your points to recharge.', 'warn');
      } else {
        c.status = 'disabled';
        c.hits++;
        const slow = this.escalation >= 1 ? TUNE.fastRepairMult : 1;
        c.repairAt = t + (TUNE.repairDelayMin + Math.random() * (TUNE.repairDelayMax - TUNE.repairDelayMin)) * slow;
      }
      if (!a.seen) this.tamper.push({ at: t + TUNE.tamperDelayMin + Math.random() * (TUNE.tamperDelayMax - TUNE.tamperDelayMin), cam: c });
      this.scenes.push({ cam: c, until: t + TUNE.sceneWindowS, reported: a.seen });
      this.net.recomputeCoverage();
      if (this.selectedTarget === c.rc.id && a.mode === 'cut') this.selectedTarget = null;
    }
    this.streak++;
    this.score += points;
    g.events.emit('takedown', {
      cameraId: a.id, mode: a.mode, type, seen: a.seen, coverage, p: [at.x, at.z], points, drone: a.target.kind === 'drone' || undefined,
    });
    // unseen with zero heat: bank right away (clean work feels good)
    if (!a.seen && this.heatLevel() === 0) {
      this.banked += points;
      this.emitScore(points);
      this.bankedToast(points);
      this.onBank(points);
    } else {
      this.hot += points;
      this.hotList.push({ points });
      this.emitScore(points);
      this.toast(`+${points} (hot) — lose the heat to bank it`, 'warn', 2400);
    }
    this.multiplier = streakMult(this.streak);
  }

  private emitScore(points: number) {
    this.multiplier = streakMult(this.streak);
    this.g.events.emit('score', { points, streak: this.streak, hot: this.hot, banked: this.banked, multiplier: this.multiplier });
  }

  private bankedToast(points: number) { this.toast(`+${points} banked`, 'good', 2000); }

  private onBank(amount: number) {
    this.g.events.emit('banked', { amount, total: this.banked });
    if (this.grinderCharges < TUNE.grinderMax) {
      this.grinderCharges++;
      this.toast(`Grinder battery +1 (${this.grinderCharges}/${TUNE.grinderMax})`, 'good', 1800);
    }
  }

  private bankAll() {
    if (this.hot <= 0) return;
    const amount = this.hot;
    this.banked += amount;
    this.hot = 0;
    this.hotList = [];
    this.emitScore(0);
    this.toast(`Heat lost — +${amount} banked`, 'good', 2600);
    this.onBank(amount);
  }

  private onArrested() {
    if (!this.runActive) return;
    this.runActive = false;
    this.takedowns.cancel();
    const lost = this.hot;
    this.hot = 0;
    this.hotList = [];
    this.score = this.banked;
    if (lost > 0) this.toast(`Arrested — ${lost} hot points lost`, 'bad', 3500);
    this.g.events.emit('runEnd', { streak: this.streak, score: this.score, banked: this.banked, reason: 'arrested' });
  }

  endRun(reason: 'arrested' | 'quit') {
    if (reason === 'arrested') return this.onArrested();
    if (!this.runActive) return;
    this.runActive = false;
    this.takedowns.cancel();
    this.bankAll();
    this.g.events.emit('runEnd', { streak: this.streak, score: this.score, banked: this.banked, reason });
  }

  /** runStart: fresh network, streak and score reset; discoveries persist. */
  private resetRun() {
    this.runActive = true;
    this.takedowns.cancel();
    this.streak = 0; this.score = 0; this.banked = 0; this.hot = 0; this.hotList = [];
    this.multiplier = 1;
    this.grinderCharges = TUNE.grinderCharges;
    this.escalation = 0; this.installs = 0; this.installT = 0; this.droneT = 0;
    this.tamper = []; this.scenes = [];
    this.selectedTarget = null;
    this.crews.clear();
    for (const d of this.droneList) this.root.remove(d.obj);
    this.droneList.length = 0;
    for (const c of [...this.net.cams]) {
      if (c.installed) this.net.remove(c);
      else if (c.status !== 'active' || c.body) this.net.restore(c);
    }
    this.vision.reset();
    this.net.recomputeCoverage();
    this.emitScore(0);
  }

  // ------------------------------------------------------------------ escalation director (§9)
  private director(dt: number, t: number) {
    const s = this.streak;
    const lvl = s >= TUNE.escalateDrones ? 3 : s >= TUNE.escalateInstalls ? 2 : s >= TUNE.escalatePatrols ? 1 : 0;
    if (lvl > this.escalation) {
      this.escalation = lvl;
      const hotspots: Vec2[] = this.net.cams.filter((c) => c.status === 'active').slice(0, 24).map((c) => [c.work.x, c.work.z]);
      this.g.events.emit('escalation', { level: lvl, streak: s, hotspots });
      const ai = this.g as any;
      try { ai.heat?.requestPatrols?.(lvl, hotspots); } catch { /* optional hook */ }
      if (lvl === 1) this.toast('The city is stepping up patrols around the camera network. Repair crews move faster.', 'warn', 4200);
      if (lvl === 2) { this.toast('The city is installing new cameras.', 'warn', 4200); this.installT = 20; }
      if (lvl === 3) { this.toast('Surveillance drones are in the air.', 'bad', 4200); this.droneT = 5; }
      // faster repairs for already-queued cameras
      if (lvl === 1) for (const c of this.net.cams) if (c.status === 'disabled') c.repairAt = t + (c.repairAt - t) * TUNE.fastRepairMult;
    }
    if (this.escalation >= 2 && this.installs < TUNE.maxInstalls) {
      this.installT -= dt;
      if (this.installT <= 0) {
        this.installT = TUNE.installEveryS[0] + Math.random() * (TUNE.installEveryS[1] - TUNE.installEveryS[0]);
        this.installCamera();
      }
    }
    if (this.escalation >= 3) {
      this.droneT -= dt;
      const alive = this.droneList.filter((d) => d.mode !== 'crashed' && d.mode !== 'falling').length;
      if (this.droneT <= 0 && alive < TUNE.maxDrones) { this.droneT = TUNE.droneEveryS; this.spawnDrone(); }
    }
  }

  /** Install a new pole camera at a plausible intersection 120–600 m from the player. */
  installCamera(): Cam | null {
    const g = this.g;
    const pos = this.pp();
    if (!pos) return null;
    const graph = g.recipe.graph;
    if (!graph?.nodes?.length) return null;
    const deg = new Map<number, number>();
    for (const e of graph.edges) { deg.set(e.from, (deg.get(e.from) ?? 0) + 1); deg.set(e.to, (deg.get(e.to) ?? 0) + 1); }
    const r = rng(hashString(`install-${this.installs}-${Math.floor(g.elapsed)}`));
    const cands = graph.nodes.filter((n) => {
      const d = Math.hypot(n.p[0] - pos.x, n.p[1] - pos.z);
      if (d < 120 || d > 600) return false;
      if ((deg.get(n.id) ?? 0) < 5 && !n.signal) return false;
      for (const c of this.net.cams) if (Math.hypot(c.work.x - n.p[0], c.work.z - n.p[1]) < 60) return false;
      return true;
    });
    if (!cands.length) return null;
    const n = cands[Math.floor(r() * cands.length)];
    // pick a leg: point at the node, camera on the corner looking out along an edge
    const e = graph.edges.find((ed) => ed.from === n.id) ?? graph.edges.find((ed) => ed.to === n.id);
    if (!e) return null;
    const o = graph.nodes[e.from === n.id ? e.to : e.from];
    const dx = o.p[0] - n.p[0], dz = o.p[1] - n.p[1];
    const L = Math.hypot(dx, dz) || 1;
    const fx = dx / L, fz = dz / L;
    const road = g.recipe.roads.find((rd) => rd.id === e.roadId);
    const hw = (road?.width ?? 10) / 2 + (road?.sidewalk ? 0.9 : 1.2);
    const along = Math.min(L * 0.4, hw + 5);
    const p: Vec2 = [n.p[0] + fx * along + fz * hw, n.p[1] + fz * along - fx * hw];
    const heading = Math.atan2(fx, -fz);
    const rc: RecipeCamera = {
      id: `inst-${this.installs++}-${n.id}`, type: 'pole', p, y: this.net.groundAt(p[0], p[1], n.y), heading,
      poleHeight: 4.4 + r() * 0.8, cuttable: true, fovDeg: 40, rangeM: 55, plateReader: true, mapped: true,
    };
    const cam = this.net.add(rc);
    cam.installed = true;
    cam.discovered = true;
    this.net.recomputeCoverage();
    g.events.emit('cameraInstalled', { cameraId: rc.id });
    const near = this.streetName(cam.work) ?? road?.name;
    this.toast(`A new camera was installed near ${near ?? `${Math.round(Math.hypot(p[0] - pos.x, p[1] - pos.z))} m away`}`, 'warn', 3500);
    return cam;
  }

  spawnDrone(): Drone | null {
    const pos = this.pp();
    if (!pos) return null;
    const d = new Drone(`drone-${this.droneSeq++}`);
    const a = Math.random() * Math.PI * 2;
    d.pos.set(pos.x + Math.cos(a) * 220, this.net.groundAt(pos.x, pos.z, pos.y) + 45, pos.z + Math.sin(a) * 220);
    this.droneList.push(d);
    this.root.add(d.obj);
    return d;
  }

  private updateDrones(dt: number, t: number, night: number) {
    const g = this.g;
    const pos = this.pp();
    const lk = g.heat?.lastKnown;
    const focus = pos ? (this.heatLevel() > 0 && lk ? new THREE.Vector3(lk[0], pos.y, lk[1]) : pos.clone()) : null;
    const ground = (x: number, z: number) => this.net.groundAt(x, z, pos?.y ?? 0);
    for (let i = this.droneList.length - 1; i >= 0; i--) {
      const d = this.droneList[i];
      d.update(dt, t, night, focus, ground);
      if (d.mode === 'crashed' && t - d.crashedAt > 90) { this.root.remove(d.obj); this.droneList.splice(i, 1); }
    }
  }

  /** Respawn + clear heat + runStart. */
  startNewRun() {
    const g = this.g;
    const spawn = this.safeSpawn();
    try { g.player?.respawn(spawn.p, spawn.heading); } catch (e) { console.warn('[surveillance] respawn failed', e); }
    if (g.player) { g.player.controlsEnabled = true; g.player.busy = false; g.player.suspicious = false; g.player.plateFlagged = false; }
    try { g.heat?.clear(); } catch { /* */ }
    g.events.emit('runStart', {});
  }

  /** Recipe spawn, nudged to a sidewalk point away from police and active cameras if possible. */
  private safeSpawn(): { p: Vec2; heading: number } {
    const g = this.g;
    const sp = g.recipe.spawn;
    const police = (g.vehicles?.all?.() ?? []).filter((v) => v.kind === 'police');
    const score = (p: Vec2) => {
      let s = 0;
      for (const v of police) s -= Math.max(0, 150 - Math.hypot(v.position.x - p[0], v.position.z - p[1]));
      for (const c of this.net.cams) if (c.status === 'active' && Math.hypot(c.work.x - p[0], c.work.z - p[1]) < c.rc.rangeM) s -= 40;
      return s;
    };
    let best: Vec2 = sp.p, bs = score(sp.p);
    const r = rng(hashString(`spawn-${Math.floor(g.elapsed)}`));
    for (let i = 0; i < 12; i++) {
      let q: Vec2 | null = null;
      try { q = g.world?.randomSidewalkPoint?.(sp.p, 250, r) ?? null; } catch { q = null; }
      if (!q) continue;
      const s = score(q);
      if (s > bs) { bs = s; best = q; }
    }
    return { p: best, heading: sp.heading };
  }
}

let instance: Surveillance | null = null;

export async function setupSurveillance(g: Game): Promise<void> {
  const s = new Surveillance(g);
  instance = s;
  g.surveillance = s;
  g.addSystem({
    name: 'surveillance',
    order: 50,
    update: (dt) => s.update(dt),
    lateUpdate: (dt) => s.lateUpdate(dt),
  });
  (window as any).__surv = s;
}

/** Called by the UI after the results screen: respawn at a safe spot, clear heat, emit runStart. */
export function startNewRun(g: Game): void {
  const s = (g.surveillance as Surveillance | undefined) ?? instance;
  if (s && s instanceof Surveillance) s.startNewRun();
  else { g.heat?.clear(); g.events.emit('runStart', {}); }
}

/** End the run voluntarily (banks hot points first). */
export function endRun(g: Game, reason: 'quit' | 'arrested' = 'quit'): void {
  const s = g.surveillance as Surveillance | undefined;
  if (s && s instanceof Surveillance) s.endRun(reason);
}
