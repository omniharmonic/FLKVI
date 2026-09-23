// Hold-to-act takedowns: prompt, progress, interruption, grinder/spray VFX + audio, noise events.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Cam } from './network';
import type { Drone } from './drone';
import { TUNE } from './constants';
import { Sparks, Mist, CutGlow, buildGrinder, buildPaintPole } from './vfx';

export type Target = { kind: 'cam'; cam: Cam } | { kind: 'drone'; drone: Drone };
type Sound = ReturnType<Game['audio']['play']>;

export interface Acting {
  target: Target;
  mode: 'cut' | 'disable';
  t: number;
  dur: number;
  seen: boolean;
  start: THREE.Vector3;
  health: number;
  noiseT: number;
  variant: 'spray' | 'bag';
  paint: THREE.Color;
  overlay: ((t: number) => void) | null;
  sound: Sound;
  id: string;
}

export interface TakedownHost {
  g: Game;
  night(): number;
  grinderCharges: number;
  nearestDrone(p: THREE.Vector3): Drone | null;
  targetCams(p: THREE.Vector3): Cam | null;
  makeOverlay(cam: Cam, kind: 'spray' | 'bag', seed: number): (t: number) => void;
  clearOverlay(cam: Cam): void;
  complete(a: Acting): void;
  ground(x: number, z: number, fb: number): number;
}

const PAINTS = ['#0b0b0c', '#0b0b0c', '#ff2d87', '#ff6a00', '#8bff1f', '#1fd3ff'];

export class Takedowns {
  acting: Acting | null = null;
  prompt: string | null = null;
  readonly sparks = new Sparks();
  readonly mist = new Mist();
  readonly glow = new CutGlow();
  readonly light = new THREE.PointLight(0xff8a2a, 0, 7, 2);
  readonly grinder = buildGrinder();
  readonly pole = buildPaintPole();
  readonly root = new THREE.Group();
  private lastPrompt: string | null = '';
  private coolingGlow = false;

  constructor(private h: TakedownHost) {
    this.root.name = 'surv-takedown-vfx';
    this.light.castShadow = false;
    this.grinder.visible = false;
    this.pole.group.visible = false;
    this.root.add(this.sparks.obj, this.mist.obj, this.glow.mesh, this.light, this.grinder, this.pole.group);
  }

  private player() { return this.h.g.player; }

  /** Per-frame: prompt, input, progress. */
  update(dt: number, t: number) {
    const g = this.h.g;
    const p = this.player();
    this.sparks.update(dt);
    this.mist.update(dt);
    this.glow.update(dt, this.coolingGlow);
    if (!p || !p.position) { this.setPrompt(null); return; }
    const onFoot = !p.vehicleId && p.controlsEnabled !== false;
    if (this.acting) { this.tick(dt, t); return; }
    if (!onFoot) { this.setPrompt(null); return; }

    // drones first (they come to you), then cameras
    const drone = this.h.nearestDrone(p.position);
    if (drone) {
      this.setPrompt('Hold E: Disable drone');
      if (g.input.isDown('KeyE')) this.begin({ kind: 'drone', drone }, 'disable');
      return;
    }
    const cam = this.h.targetCams(p.position);
    if (!cam) { this.setPrompt(null); return; }
    const parts: string[] = [];
    const canDisable = cam.status === 'active';
    const canCut = cam.rc.cuttable && cam.status !== 'down' && cam.status !== 'repairing';
    if (cam.status === 'repairing') { this.setPrompt('Repair crew on site'); return; }
    if (canDisable) parts.push('Hold E: Disable');
    if (canCut) parts.push(this.h.grinderCharges > 0 ? 'Hold R: Cut down' : 'Grinder battery empty');
    if (!cam.rc.cuttable && cam.status === 'active') parts.push('(signal mast: disable only)');
    this.setPrompt(parts.length ? parts.join('  ·  ') : null);
    if (canDisable && g.input.isDown('KeyE')) this.begin({ kind: 'cam', cam }, 'disable');
    else if (canCut && this.h.grinderCharges > 0 && g.input.isDown('KeyR')) this.begin({ kind: 'cam', cam }, 'cut');
  }

  private setPrompt(text: string | null) {
    this.prompt = text;
    if (text !== this.lastPrompt) {
      this.lastPrompt = text;
      this.h.g.events.emit('prompt', { text });
    }
  }

  private idOf(target: Target) { return target.kind === 'cam' ? target.cam.rc.id : target.drone.id; }

  private begin(target: Target, mode: 'cut' | 'disable') {
    const g = this.h.g;
    const p = this.player();
    const type = target.kind === 'cam' ? target.cam.type : 'ptz';
    const dur = target.kind === 'drone' ? 2.5 : mode === 'cut' ? TUNE.cutTime[type] : TUNE.disableTime[type];
    const r = Math.random();
    const a: Acting = {
      target, mode, t: 0, dur, seen: false, start: p.position.clone(), health: p.health, noiseT: 0,
      variant: target.kind === 'cam' && mode === 'disable' && r < 0.3 ? 'bag' : 'spray',
      paint: new THREE.Color(PAINTS[Math.floor(Math.random() * PAINTS.length)]),
      overlay: null, sound: null, id: this.idOf(target),
    };
    if (target.kind === 'cam' && mode === 'disable') a.overlay = this.h.makeOverlay(target.cam, a.variant, Math.floor(r * 1e6));
    this.acting = a;
    p.busy = true;
    p.suspicious = true;
    this.face(target);
    const at = this.workPoint(a);
    a.sound = g.audio?.play(mode === 'cut' ? 'grinder' : 'spray', { at: [at.x, at.y, at.z], loop: true, volume: mode === 'cut' ? 1 : 0.6 }) ?? null;
    g.events.emit('takedownStart', { cameraId: a.id, mode });
    const pos: [number, number] = [p.position.x, p.position.z];
    g.events.emit('crime', { kind: mode === 'cut' ? 'takedown-cut' : 'takedown-disable', p: pos, severity: mode === 'cut' ? 3 : 2 });
    this.setPrompt(mode === 'cut' ? 'Cutting… keep holding R' : 'Disabling… keep holding E');
    if (mode === 'cut' && target.kind === 'cam') {
      const cam = target.cam;
      const cut = cam.model.postOrigin.clone().applyMatrix4(cam.baseM);
      this.glow.heat = 0;
      this.coolingGlow = false;
      this.glow.place(cut, cam.model.cutRadius, cam.model.roundPost, -cam.rc.heading);
    }
  }

  /** Make the character face the target if gameplay allows it. */
  private face(target: Target) {
    const p = this.player() as any;
    const tp = target.kind === 'cam' ? target.cam.work : target.drone.pos;
    const h = Math.atan2(tp.x - p.position.x, -(tp.z - p.position.z));
    try {
      if (typeof p.face === 'function') p.face(h);
      else if (typeof p.setHeading === 'function') p.setHeading(h);
      else if (Object.getOwnPropertyDescriptor(p, 'heading')?.writable) p.heading = h;
    } catch { /* read-only heading */ }
  }

  /** The point the tool works on (cut ring or lens). */
  private workPoint(a: Acting): THREE.Vector3 {
    if (a.target.kind === 'drone') return a.target.drone.pos.clone();
    const cam = a.target.cam;
    if (a.mode === 'cut') return cam.model.postOrigin.clone().applyMatrix4(cam.baseM);
    return cam.model.lenses[0].p.clone().applyMatrix4(cam.headM);
  }

  cancel(reason?: string) {
    const a = this.acting;
    if (!a) return;
    const g = this.h.g;
    a.sound?.stop();
    if (a.target.kind === 'cam' && a.mode === 'disable') this.h.clearOverlay(a.target.cam);
    this.acting = null;
    this.endPose();
    if (a.mode === 'cut') this.coolingGlow = true;
    g.events.emit('takedownCancel', { cameraId: a.id });
    if (reason) g.events.emit('toast', { text: reason, kind: 'warn', ms: 1800 });
  }

  private endPose() {
    const p = this.player();
    if (p) { p.busy = false; p.suspicious = false; }
    this.grinder.visible = false;
    this.pole.group.visible = false;
    this.light.intensity = 0;
    this.setPrompt(null);
  }

  private tick(dt: number, t: number) {
    const a = this.acting!;
    const g = this.h.g;
    const p = this.player();
    const key = a.mode === 'cut' ? 'KeyR' : 'KeyE';
    // interruptions
    if (!g.input.isDown(key)) return this.cancel();
    if (p.vehicleId) return this.cancel();
    if (p.health < a.health - 0.01) return this.cancel('Interrupted!');
    if (Math.hypot(p.position.x - a.start.x, p.position.z - a.start.z) > 1.6) return this.cancel();
    for (const v of g.vehicles?.all?.() ?? []) {
      if (v.kind === 'police' && !v.destroyed && v.position.distanceTo(p.position) < TUNE.policeInterruptRadius) return this.cancel('Police! Get out of there.');
    }
    for (const o of ((g as any).police?.officers?.() ?? []) as { position: THREE.Vector3 }[]) {
      if (o.position.distanceTo(p.position) < TUNE.policeInterruptRadius) return this.cancel('Police! Get out of there.');
    }
    if (a.target.kind === 'cam' && a.mode === 'disable' && a.target.cam.status !== 'active') return this.cancel();
    if (a.target.kind === 'drone' && !a.target.drone.reachable(p.position, this.h.ground(p.position.x, p.position.z, p.position.y))) return this.cancel('The drone pulled away.');
    p.busy = true;
    p.suspicious = true;
    a.t = Math.min(1, a.t + dt / a.dur);
    a.health = Math.min(a.health, p.health);
    g.events.emit('takedownProgress', { cameraId: a.id, mode: a.mode, t: a.t });
    this.vfx(a, dt, t);
    // noise every second
    a.noiseT += dt;
    if (a.noiseT >= TUNE.noiseEveryS) {
      a.noiseT -= TUNE.noiseEveryS;
      const night = this.h.night();
      const radius = a.mode === 'cut' ? TUNE.noiseRadiusDay + (TUNE.noiseRadiusNight - TUNE.noiseRadiusDay) * night : TUNE.sprayNoiseRadius;
      g.events.emit('noise', { p: [p.position.x, p.position.z], radius, kind: a.mode === 'cut' ? 'grinder' : 'spray' });
    }
    if (a.t >= 1) {
      a.sound?.stop();
      this.acting = null;
      this.endPose();
      if (a.mode === 'cut') { this.coolingGlow = true; this.glow.heat = 1; }
      this.h.complete(a);
    }
  }

  private vfx(a: Acting, dt: number, t: number) {
    const p = this.player();
    const wp = this.workPoint(a);
    const hand = p.position.clone().add(new THREE.Vector3(0, 1.25, 0));
    const toW = new THREE.Vector3().subVectors(wp, hand);
    if (a.mode === 'cut' && a.target.kind === 'cam') {
      const cam = a.target.cam;
      // contact point on the post surface facing the player
      const flat = new THREE.Vector3(hand.x - wp.x, 0, hand.z - wp.z).normalize();
      const contact = wp.clone().addScaledVector(flat, cam.model.cutRadius + 0.005);
      this.grinder.visible = true;
      this.grinder.position.copy(contact).addScaledVector(flat, 0.05);
      this.grinder.lookAt(contact.clone().addScaledVector(flat, -1));
      this.grinder.rotateZ(Math.PI / 2);
      this.grinder.position.y += Math.sin(t * 40) * 0.002;
      // spark fountain tangent to the disc, away from the cut, slightly down
      const side = new THREE.Vector3(-flat.z, 0, flat.x);
      const dir = side.multiplyScalar(Math.sin(t * 0.7) > 0 ? 1 : -1).addScaledVector(flat, 0.35).add(new THREE.Vector3(0, -0.15, 0)).normalize();
      const n = Math.round((110 + Math.random() * 80) * dt * 1.8);
      this.sparks.emit(contact, dir, n, cam.groundY, 8.5, 0.5);
      if (Math.random() < 0.3) this.sparks.emit(contact, flat.clone().add(new THREE.Vector3(0, 0.3, 0)).normalize(), 2, cam.groundY, 4, 1.2);
      this.light.position.copy(contact).addScaledVector(flat, 0.25);
      this.light.intensity = (1.2 + Math.random() * 2.6) * (1 + this.h.night() * 0.8);
      this.glow.heat = Math.min(1, 0.25 + a.t * 0.9);
    } else {
      // telescopic paint pole from the hand to just in front of the lens
      const lens = a.target.kind === 'cam' ? a.target.cam.model.lenses[0] : null;
      const cam = a.target.kind === 'cam' ? a.target.cam : null;
      const ldir = lens && cam ? lens.d.clone().transformDirection(cam.headM) : new THREE.Vector3(0, -1, 0);
      const tip = wp.clone().addScaledVector(ldir, 0.35);
      const len = hand.distanceTo(tip);
      this.pole.group.visible = true;
      this.pole.group.position.copy(hand);
      this.pole.group.lookAt(tip);
      this.pole.group.rotateY(Math.PI);
      this.pole.setLength(len);
      if (a.variant === 'spray' || a.target.kind === 'drone') {
        const sprayDir = new THREE.Vector3().subVectors(wp, tip).normalize();
        this.mist.emit(tip, sprayDir, Math.max(1, Math.round(90 * dt)), a.paint, { speed: 3.2, spread: 0.18, life: 0.6, size: 0.04, grow: 0.35, alpha: 0.45 });
      }
      a.overlay?.(a.t);
    }
  }

  /** Dust burst where a toppled post lands. */
  dust(p: THREE.Vector3, strength: number) {
    const c = new THREE.Color(0.52, 0.49, 0.44);
    for (let i = 0; i < 6; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, 0.35, Math.random() - 0.5).normalize();
      this.mist.emit(p, d, Math.round(10 * strength), c, { speed: 2.2, spread: 0.6, life: 1.6, size: 0.25, grow: 1.2, alpha: 0.28 });
    }
    this.sparks.emit(p.clone().add(new THREE.Vector3(0, 0.05, 0)), new THREE.Vector3(0, 1, 0), Math.round(14 * strength), p.y - 0.1, 3, 1.2);
  }
}
