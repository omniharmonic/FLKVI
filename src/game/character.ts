// Player character: CC0 Quaternius Universal Base Character + Universal Animation Library (shared rig),
// dressed as a hooded protagonist with a backpack. Falls back to a procedural figure if loading fails.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl } from '../assets/library';
import { dressCharacter, preparePeople, type Look } from '../assets/characters';

import { damp } from './util';

/** The protagonist: charcoal hoodie (hood up), dark indigo jeans, gray sneakers, black gloves. */
const PLAYER_LOOK: Partial<Look> = {
  sex: 'm', build: 1, skin: '#c99a78', eyes: '#2e1c10', hair: 'buzz', hairColor: '#1a1410', glasses: false,
  top: 'hoodie', topColor: '#2c2f34', topColor2: '#2c2f34', open: false,
  bottom: 'jeans', bottomColor: '#222c42', belt: false,
  shoes: 'sneaker', shoeColor: '#43464b', soleColor: '#9a9893', sockColor: '#1a1a1c', crewSocks: false,
  gloves: '#141416', policeBack: false, hat: 'hood', hatColor: '#2c2f34',
};

/** 'reach': standing, both arms raised to work a telescopic paint pole on a lens at head height and above. */
export type Pose = 'none' | 'kneel' | 'interact' | 'drive' | 'reach';

export interface CharacterState {
  speed: number;
  grounded: boolean;
  crouch: boolean;
  vy: number;
  pose: Pose;
}

const CLIPS = {
  idle: 'Idle_Loop', walk: 'Walk_Loop', jog: 'Jog_Fwd_Loop', sprint: 'Sprint_Loop',
  cIdle: 'Crouch_Idle_Loop', cWalk: 'Crouch_Fwd_Loop',
  jumpStart: 'Jump_Start', jump: 'Jump_Loop', land: 'Jump_Land',
  punch: 'Punch_Cross', jab: 'Punch_Jab', interact: 'Interact', kneel: 'Fixing_Kneeling', drive: 'Driving_Loop',
  hit: 'Hit_Chest', push: 'Push_Loop', enter: 'Sitting_Enter', exit: 'Sitting_Exit',
} as const;
type ClipKey = keyof typeof CLIPS;
const ONE_SHOTS = new Set<ClipKey>(['punch','jab','jumpStart','land','hit','enter','exit']);
/** Speeds (m/s) at which each locomotion clip plays at timeScale 1 (measured from foot travel). */
const NATIVE: Partial<Record<ClipKey, number>> = { walk: 1.45, jog: 3.4, sprint: 5.6, cWalk: 1.2 };

let cache: Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[] } | null> | null = null;
function loadAssets() {
  if (!cache) {
    cache = (async () => {
      try {
        const loader = new GLTFLoader();
        const [char, lib] = await Promise.all([
          // Shared with the assets library (Quaternius UBC male + UAL clips, see public/assets/LICENSES.json).
          loader.loadAsync(assetUrl('models/characters/ubc-male.glb')),
          loader.loadAsync(assetUrl('models/characters/anims.glb')),
          preparePeople().catch(() => undefined),
        ]);
        return { scene: char.scene, clips: lib.animations };
      } catch (e) {
        console.warn('[gameplay] character model failed to load, using fallback', e);
        return null;
      }
    })();
  }
  return cache;
}

export class Character {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<ClipKey, THREE.AnimationAction>();
  private w = new Map<ClipKey, number>();
  private phase = 0;
  private air = 0;
  private landT = 0;
  private wasGrounded = true;
  private oneShot: { key: ClipKey; t: number; dur: number } | null = null;
  private fallback: THREE.Group | null = null;
  private fallbackLegs: THREE.Object3D[] = [];
  loaded = false;
  height = 1.8;

  static preload() { return loadAssets(); }

  async init() {
    this.root.name = 'player-character';
    const a = await loadAssets();
    if (!a) { this.buildFallback(); return; }
    const model = a.scene; // single player instance: use directly
    // Scale to ~1.78 m.
    const box = new THREE.Box3().setFromObject(model);
    const h = box.max.y - box.min.y;
    const s = h > 0.1 ? 1.78 / h : 1;
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;
    model.rotation.y = Math.PI; // glTF faces +Z; our forward is −Z
    this.height = 1.78;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
      }
    });
    this.dress(model);
    this.addGear(model);
    this.root.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    model.traverse((o) => { if (/^(upperarm|lowerarm|hand)_(l|r)$/.test(o.name)) this.arm[o.name] = o; });
    for (const [k, name] of Object.entries(CLIPS) as [ClipKey, string][]) {
      const clip = a.clips.find((c) => c.name === name);
      if (!clip) continue;
      // Strip root translation on the root/pelvis horizontal axes so clips stay in place.
      const act = this.mixer.clipAction(clip);
      const oneShot = ONE_SHOTS.has(k);
      act.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      act.clampWhenFinished = oneShot;
      act.enabled = true;
      act.setEffectiveWeight(k === 'idle' ? 1 : 0);
      if (!oneShot) act.play();
      this.actions.set(k, act);
      this.w.set(k, k === 'idle' ? 1 : 0);
    }
    this.loaded = true;
  }

  /**
   * Outfit (see src/assets/characters.ts): hoodie with the hood up, dark jeans, sneakers, gloves, on an average build;
   * cloth shells give the garments volume, and shoes are real geometry.
   */
  private dress(model: THREE.Object3D) {
    dressCharacter(model, { top: '#2c2f34', bottom: '#222c42', shoes: '#4a4d52', look: PLAYER_LOOK });
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; }
    });
  }

  /** Backpack + hood attached to the skeleton. */
  private addGear(model: THREE.Object3D) {
    const spine = model.getObjectByName('spine_03');
    const head = model.getObjectByName('Head') ?? model.getObjectByName('head');
    const worldScale = new THREE.Vector3();
    if (spine) {
      spine.getWorldScale(worldScale);
      const inv = 1 / (worldScale.x || 1);
      const pack = new THREE.Group();
      const fabric = new THREE.MeshStandardMaterial({ color: 0x23282a, roughness: 0.92 });
      const strapM = new THREE.MeshStandardMaterial({ color: 0x121314, roughness: 0.8 });
      const bag = new THREE.Mesh(roundBox(0.28, 0.38, 0.14, 0.06), fabric);
      const pocket = new THREE.Mesh(roundBox(0.22, 0.15, 0.05, 0.025), fabric);
      pocket.position.set(0, -0.09, 0.08);
      const top = new THREE.Mesh(roundBox(0.26, 0.05, 0.12, 0.024), strapM);
      top.position.set(0, 0.18, 0);
      pack.add(bag, pocket, top);
      for (const sx of [-0.1, 0.1]) {
        const strap = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.42, 0.015), strapM);
        strap.position.set(sx, 0.02, 0.12);
        pack.add(strap);
      }
      pack.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
      // Place behind the upper back, in bone space (bone axes vary; solve in world space).
      spine.add(pack);
      pack.scale.setScalar(inv);
      this.pack = pack;
    }
    void head; // the hood is part of the outfit now (PLAYER_LOOK.hat = 'hood', fitted to the head in assets/characters)
  }
  private pack: THREE.Object3D | null = null;
  private hood: THREE.Object3D | null = null;
  private gearPlaced = false;

  /** Position gear in world terms once the rig has posed (bone local axes differ per rig). */
  private placeGear() {
    if (this.gearPlaced) return;
    this.gearPlaced = true;
    this.root.updateMatrixWorld(true);
    const place = (obj: THREE.Object3D | null, localOffset: THREE.Vector3) => {
      if (!obj || !obj.parent) return;
      const bone = obj.parent;
      const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
      const target = bone.getWorldPosition(new THREE.Vector3()).add(localOffset.clone().applyQuaternion(rootQ));
      obj.position.copy(bone.worldToLocal(target));
      // Orientation: align with the character root.
      const bq = bone.getWorldQuaternion(new THREE.Quaternion());
      obj.quaternion.copy(bq.invert().multiply(rootQ));
    };
    // In root space the character faces −Z: "behind" is +Z.
    place(this.pack, new THREE.Vector3(0, -0.06, 0.19));
    place(this.hood, new THREE.Vector3(0, 0.115, -0.012));
  }

  private buildFallback() {
    const g = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.9 });
    const jeans = new THREE.MeshStandardMaterial({ color: 0x2c3a52, roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xc69a7a, roughness: 0.7 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.45, 4, 12), cloth);
    torso.position.y = 1.2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), skin);
    head.position.y = 1.62;
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), cloth);
    hood.position.set(0, 1.64, 0.02);
    const pack = new THREE.Mesh(roundBox(0.3, 0.38, 0.15, 0.05), new THREE.MeshStandardMaterial({ color: 0x2b3a2e, roughness: 0.9 }));
    pack.position.set(0, 1.22, 0.2);
    g.add(torso, head, hood, pack);
    for (const sx of [-0.1, 0.1]) {
      const leg = new THREE.Group();
      leg.position.set(sx, 0.9, 0);
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.7, 4, 8), jeans);
      m.position.y = -0.45;
      leg.add(m);
      g.add(leg);
      this.fallbackLegs.push(leg);
    }
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    this.fallback = g;
    this.root.add(g);
  }

  playOnce(key: 'punch' | 'jab' | 'hit' | 'jumpStart' | 'land' | 'enter' | 'exit') {
    const a = this.actions.get(key);
    if (!a) return;
    if (this.oneShot) this.actions.get(this.oneShot.key)?.stop();
    a.reset();
    a.setEffectiveWeight(1);
    a.play();
    this.oneShot = { key, t: 0, dur: a.getClip().duration };
  }

  update(dt: number, st: CharacterState) {
    if (this.fallback) return this.updateFallback(dt, st);
    if (!this.mixer) return;
    // Targets
    const tw: Partial<Record<ClipKey, number>> = {};
    const s = st.speed;
    if (st.pose === 'drive') tw.drive = 1;
    else if (st.pose === 'kneel') tw.kneel = 1;
    else if (st.pose === 'interact') tw.interact = 1;
    else if (st.pose === 'reach') tw.idle = 1;
    else if (!st.grounded && this.air > 0.12) tw.jump = 1;
    else if (st.crouch) {
      const k = Math.min(1, s / 1.0);
      tw.cIdle = 1 - k; tw.cWalk = k;
    } else {
      const pts: [ClipKey, number][] = [['idle', 0], ['walk', 1.45], ['jog', 3.4], ['sprint', 5.6]];
      if (s <= 0.05) tw.idle = 1;
      else if (s >= 5.6) tw.sprint = 1;
      else for (let i = 0; i < pts.length - 1; i++) {
        const [a, sa] = pts[i], [b, sb] = pts[i + 1];
        if (s >= sa && s <= sb) { const t = (s - sa) / (sb - sa); tw[a] = 1 - t; tw[b] = t; break; }
      }
    }
    if (!st.grounded) this.air += dt; else this.air = 0;
    if (st.grounded && !this.wasGrounded && st.vy < -4) this.landT = 0.25;
    this.wasGrounded = st.grounded;
    if (this.landT > 0) { this.landT -= dt; }
    // Blend weights
    for (const k of this.actions.keys()) {
      if (ONE_SHOTS.has(k)) continue;
      const cur = this.w.get(k) ?? 0;
      const nw = damp(cur, tw[k] ?? 0, 12, dt);
      this.w.set(k, nw);
    }
    // One-shot overlay (punch) takes priority, fading the rest.
    let shot = 0;
    if (this.oneShot) {
      this.oneShot.t += dt;
      const { t, dur } = this.oneShot;
      shot = t < 0.08 ? t / 0.08 : t > dur - 0.12 ? Math.max(0, (dur - t) / 0.12) : 1;
      this.actions.get(this.oneShot.key)!.setEffectiveWeight(shot);
      if (t >= dur) { this.actions.get(this.oneShot.key)!.stop(); this.oneShot = null; shot = 0; }
    }
    let total = 0;
    for (const v of this.w.values()) total += v;
    total = Math.max(total, 1e-3);
    for (const [k, a] of this.actions) {
      if (ONE_SHOTS.has(k)) continue;
      a.setEffectiveWeight(((this.w.get(k) ?? 0) / total) * (1 - shot));
    }
    // Phase-synced locomotion: all cycles share a normalized phase.
    let rate = 0, wsum = 0;
    for (const k of ['walk', 'jog', 'sprint', 'cWalk'] as ClipKey[]) {
      const a = this.actions.get(k);
      const w = this.w.get(k) ?? 0;
      if (!a || w <= 0) continue;
      rate += w * (s / (NATIVE[k] ?? 1)) / a.getClip().duration;
      wsum += w;
    }
    if (wsum > 0) this.phase = (this.phase + (rate / wsum) * dt) % 1;
    for (const k of ['walk', 'jog', 'sprint', 'cWalk'] as ClipKey[]) {
      const a = this.actions.get(k);
      if (a) { a.time = this.phase * a.getClip().duration; a.timeScale = 0; }
    }
    this.mixer.update(dt);
    this.reachW = damp(this.reachW, st.pose === 'reach' ? 1 : 0, 7, dt);
    if (this.reachW > 0.01) this.applyReach(this.reachW, dt);
    this.placeGear();
  }

  private arm: Record<string, THREE.Object3D> = {};
  private reachW = 0;
  private reachT = 0;
  /**
   * Procedural two-handed "reach up" (paint pole on a lens overhead): rotate each arm segment in world space
   * toward a target direction, rig-agnostic (works on whatever local bone axes the rig uses).
   */
  private applyReach(w: number, dt: number) {
    const A = this.arm;
    if (!A.upperarm_r || !A.lowerarm_r || !A.hand_r) return;
    this.reachT += dt;
    this.root.updateMatrixWorld(true);
    const rq = this.root.getWorldQuaternion(_rq);
    const fwd = _f.set(0, 0, -1).applyQuaternion(rq), right = _r.set(1, 0, 0).applyQuaternion(rq);
    const wob = Math.sin(this.reachT * 7) * 0.04; // small scrubbing motion while spraying
    const dirR = new THREE.Vector3(0, 1, 0).multiplyScalar(0.93).addScaledVector(fwd, 0.36 + wob).addScaledVector(right, 0.06).normalize();
    const dirL = new THREE.Vector3(0, 1, 0).multiplyScalar(0.62).addScaledVector(fwd, 0.72 + wob).addScaledVector(right, 0.12).normalize();
    const chain = (a: THREE.Object3D | undefined, b: THREE.Object3D | undefined, dir: THREE.Vector3) => {
      if (!a || !b || !a.parent) return;
      const pa = a.getWorldPosition(_pa), pb = b.getWorldPosition(_pb);
      const cur = pb.sub(pa);
      if (cur.lengthSq() < 1e-8) return;
      cur.normalize();
      const target = _qd.setFromUnitVectors(cur, dir).multiply(a.getWorldQuaternion(_qa));
      const local = a.parent.getWorldQuaternion(_qp).invert().multiply(target);
      a.quaternion.slerp(local, w);
      a.updateMatrixWorld(true);
    };
    chain(A.upperarm_r, A.lowerarm_r, dirR);
    chain(A.lowerarm_r, A.hand_r, dirR);
    chain(A.upperarm_l, A.lowerarm_l, dirL);
    chain(A.lowerarm_l, A.hand_l, dirL);
  }

  /** World position of the right hand (tools attach here), or null with the fallback figure. */
  handWorld(out: THREE.Vector3): THREE.Vector3 | null {
    const hand = this.arm.hand_r;
    if (!hand || !this.root.visible) return null;
    return hand.getWorldPosition(out);
  }

  /** Foot-contact phase for footstep sounds (0..1, contacts near 0 and 0.5). */
  get stepPhase() { return this.phase; }

  private fbPhase = 0;
  private updateFallback(dt: number, st: CharacterState) {
    this.fbPhase += dt * st.speed * 1.6;
    const a = Math.sin(this.fbPhase) * Math.min(0.7, st.speed * 0.15);
    this.fallbackLegs[0].rotation.x = a;
    this.fallbackLegs[1].rotation.x = -a;
    this.fallback!.scale.y = st.crouch ? 0.7 : 1;
    this.phase = (this.fbPhase / (Math.PI * 2)) % 1;
  }
}

const _rq = new THREE.Quaternion(), _qd = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qp = new THREE.Quaternion();
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _pa = new THREE.Vector3(), _pb = new THREE.Vector3();

function roundBox(w: number, h: number, d: number, r: number) {
  // Lightweight rounded box via a scaled sphere-capped box (cheap, soft silhouette).
  const g = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const cx = Math.sign(v.x) * Math.max(0, Math.abs(v.x) - (w / 2 - r));
    const cy = Math.sign(v.y) * Math.max(0, Math.abs(v.y) - (h / 2 - r));
    const cz = Math.sign(v.z) * Math.max(0, Math.abs(v.z) - (d / 2 - r));
    const c = new THREE.Vector3(cx, cy, cz);
    if (c.lengthSq() > 0) { const core = v.clone().sub(c); c.setLength(r); v.copy(core.add(c)); }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
