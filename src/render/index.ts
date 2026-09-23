// OWNER: render agent. Renderer, post-processing, sky, sun, time of day, fog, weather, quality tiers.
//
// Public helpers for other modules:
//   setQuality(g, 'high'|'medium'|'low')  - settings menu
//   setRain(g, on) / isRaining(g)         - weather toggle (F7 in game)
//   addGlobalUniforms(uniforms)           - for custom ShaderMaterials that include three's
//                                           fog / standard lighting chunks (built-ins need nothing)
//   renderGlobals.wet.x                   - current wetness 0..1 (read-only for others)
//   setupShadowMaterial(m)                - no-op kept for API compatibility (shadows need no setup)
// Shadows use three's built-in cascaded SunLight (2 cascades), so materials added later need no setup.
import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import type { Game } from '../core/game';
import type { SkyAPI } from '../core/api';
import { patchShaderChunks, globals, addGlobalUniforms } from './chunks';
import { SkyLUT, transmittance, solarPosition, lunarPosition, moonPhase, dirFromElAz, findElevationTime } from './atmosphere';
import { makeSkyUniforms, makeSkyMaterial, type SkyUniforms } from './skyShader';
import { createPost, type PostChain } from './post';
import { lookForRecipe, type LookPreset } from './grading';
import { Rain } from './rain';

export { addGlobalUniforms };
export const renderGlobals = globals;

export type Quality = 'high' | 'medium' | 'low';

/** Sun irradiance scale (scene-linear units; white Lambert surface facing the sun ≈ E/π). */
const E_SUN = 6.0;
const MOON_E = 0.35;
const SUN_DISK = 45;
/** Average albedo the IBL probe sees below the horizon (street + sunlit facades): warm bounce into shade. */
const GROUND_ALBEDO = 0.2;
/** Exposure key for the adaptation curve. */
const EXPO_KEY = 2.4;
const DEG = Math.PI / 180;
const SSR_DEBUG = Number(new URLSearchParams(location.search).get('ssrdebug') ?? 1);

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

function smoothstep(a: number, b: number, x: number) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function lum(c: THREE.Color) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }

interface TierCfg { pixelRatio: number; shadowMap: number; shadowFar: number; ao: boolean; aoHalf: boolean; aoMode: string; bloomScale: number; envSize: number; smaa: boolean }
function tierConfig(q: Quality): TierCfg {
  const dpr = window.devicePixelRatio || 1;
  switch (q) {
    case 'high': return { pixelRatio: Math.min(dpr, 1.5), shadowMap: 3072, shadowFar: 520, ao: true, aoHalf: true, aoMode: 'High', bloomScale: 0.5, envSize: 256, smaa: true };
    case 'medium': return { pixelRatio: Math.min(dpr, 1), shadowMap: 2048, shadowFar: 360, ao: true, aoHalf: true, aoMode: 'Low', bloomScale: 0.4, envSize: 128, smaa: true };
    default: return { pixelRatio: Math.min(dpr, 1) * 0.8, shadowMap: 1024, shadowFar: 220, ao: false, aoHalf: true, aoMode: 'Performance', bloomScale: 0.3, envSize: 128, smaa: true };
  }
}

class RenderSky implements SkyAPI {
  time = 17.5;
  timeScale = 60;
  cyclePaused = false;
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly moonDirection = new THREE.Vector3(0, -1, 0);
  nightFactor = 0;
  sun: THREE.DirectionalLight;
  readonly sunLight: SunLight;
  sunElevation = 0;
  ssrAllowed = true;

  // weather
  rainTarget = 0;
  rain = 0;
  wet = 0;

  readonly lut = new SkyLUT();
  readonly skyU: SkyUniforms;
  readonly skyMesh: THREE.Mesh;
  private envScene = new THREE.Scene();
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private pmrem: THREE.PMREMGenerator;
  private pmremRT: THREE.WebGLRenderTarget | null = null;
  private envSunDir = new THREE.Vector3(0, -2, 0);
  private envTimer = 0;
  private envRain = -1;
  private hemi: THREE.HemisphereLight;
  readonly rainFx = new Rain();

  private fogColor = new THREE.Color(0.5, 0.6, 0.7);
  private fogSun = new THREE.Color();
  private fogColorT = new THREE.Color(0.5, 0.6, 0.7);
  private fogSunT = new THREE.Color();
  private zenith = new THREE.Color();
  private lutVersion = -1;
  private exposure = 1;
  private lastTime = -1;
  readonly day = new Date();
  readonly look: LookPreset;
  private lat: number;
  private lon: number;
  private phase: number;

  constructor(private g: Game, private post: PostChain) {
    const r = g.recipe;
    this.lat = r.origin.lat;
    this.lon = r.origin.lon;
    this.look = lookForRecipe(r);
    this.phase = moonPhase(this.day);
    // observer altitude: recipes store absolute terrain heights when available
    // (compiled recipes use heights relative to the origin, so fall back to a regional guess)
    const y = Number.isFinite(r.spawn?.y) ? r.spawn.y : 0;
    const alt = y > 300 ? y : r.region === 'mountain-west' ? 1600 : r.region === 'southwest' ? 700 : 150;
    this.lut.altitude = THREE.MathUtils.clamp(alt, 0, 4000) + 2;
    this.lut.mieScale = this.look.mie;
    this.lut.msMatch = true;

    this.skyU = makeSkyUniforms(this.lut.texR, this.lut.texM);
    this.skyU.uMieG.value = this.look.mieG;
    const box = new THREE.BoxGeometry(2, 2, 2);
    this.skyMesh = new THREE.Mesh(box, makeSkyMaterial(this.skyU, false));
    this.skyMesh.name = 'sky';
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = 1e6; // after opaque geometry: only uncovered pixels shade the sky
    this.skyMesh.userData.treatAsOpaque = true;
    g.scene.add(this.skyMesh);
    const envMesh = new THREE.Mesh(box, makeSkyMaterial(this.skyU, true));
    envMesh.frustumCulled = false;
    this.envScene.add(envMesh);

    const size = tierConfig(g.quality).envSize;
    this.cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    this.pmrem = new THREE.PMREMGenerator(g.renderer);

    // Sun (and moon) light: built-in cascaded shadow maps, no per-material setup needed.
    const sl = new SunLight(0xffffff, E_SUN);
    sl.name = 'sun';
    sl.castShadow = true;
    sl.shadow.bias = -0.0002;
    sl.shadow.normalBias = 0.06;
    sl.shadow.radius = 2;
    sl.shadow.camera.near = 1;
    this.sunLight = sl;
    // SkyAPI types sun as DirectionalLight; SunLight shares color/intensity/position semantics.
    (sl as any).target = new THREE.Object3D();
    this.sun = sl as unknown as THREE.DirectionalLight;
    g.scene.add(sl);

    this.hemi = new THREE.HemisphereLight(0x4a5f8a, 0x8a5a2a, 0);
    this.hemi.name = 'night-fill';
    g.scene.add(this.hemi);

    g.scene.add(this.rainFx.object);
    g.scene.fog = new THREE.FogExp2(0x8899aa, this.look.haze);
    g.scene.environmentIntensity = 1;

    // starting time: honor ?time=, else a clear late afternoon with the sun still ~20° up
    // (warm, long soft shadows, streets still sunlit; typically 15:30-16:30)
    const q = new URLSearchParams(location.search);
    if (q.has('time')) this.time = parseFloat(q.get('time')!) || 16.0;
    else this.time = THREE.MathUtils.clamp(findElevationTime(this.lat, this.lon, this.day, 20) ?? 16.0, 14.0, 18.0);
    if (q.has('timescale')) this.timeScale = parseFloat(q.get('timescale')!);
    // weather: never rain on the first load of a browser session (first impression = sunny);
    // later loads roll the regional rain chance (≤ 15%).
    let firstLoad = true;
    try {
      firstLoad = !sessionStorage.getItem('gt.visited');
      sessionStorage.setItem('gt.visited', '1');
    } catch { /* storage blocked: treat as first load */ }
    if (q.has('rain')) this.rainTarget = q.get('rain') === '0' ? 0 : 1;
    else if (!firstLoad && Math.random() < Math.min(0.15, this.look.rainChance)) this.rainTarget = 1;
    this.rain = this.wet = this.rainTarget;

    this.updateCelestial();
    this.lut.computeAll(this.sunDirection);
    this.applyShadowTier(g.quality);
  }

  applyShadowTier(q: Quality) {
    const cfg = tierConfig(q);
    const sh = this.sunLight.shadow;
    if (sh.mapSize.x !== cfg.shadowMap) {
      sh.mapSize.set(cfg.shadowMap, cfg.shadowMap);
      sh.map?.dispose();
      (sh as any).map = null;
    }
    sh.camera.far = cfg.shadowFar;
    sh.camera.updateProjectionMatrix();
  }

  private updateCelestial() {
    const s = solarPosition(this.lat, this.lon, this.day, this.time);
    dirFromElAz(s.el, s.az, this.sunDirection);
    this.sunElevation = s.el;
    const m = lunarPosition(this.lat, this.lon, this.day, this.time);
    dirFromElAz(m.el, m.az, this.moonDirection);
  }

  forceEnvUpdate() { this.envTimer = 1e9; }

  update(dt: number) {
    const g = this.g;
    const inp = g.input;
    if (inp.wasPressed('BracketLeft')) this.time -= 1;
    if (inp.wasPressed('BracketRight')) this.time += 1;
    if (inp.wasPressed('Backslash')) {
      this.cyclePaused = !this.cyclePaused;
      g.events.emit('toast', { text: this.cyclePaused ? 'Time of day paused' : 'Time of day running', kind: 'info', ms: 1200 });
    }
    if (inp.wasPressed('F7')) this.toggleRain();
    if (!this.cyclePaused) this.time += (dt * this.timeScale) / 3600;
    this.time = ((this.time % 24) + 24) % 24;

    const jumped = this.lastTime < 0 || Math.abs(this.time - this.lastTime) > 0.25 && Math.abs(this.time - this.lastTime) < 23.75;
    this.lastTime = this.time;
    this.updateCelestial();
    const sunDir = this.sunDirection;
    const elDeg = this.sunElevation / DEG;

    if (jumped) {
      this.lut.computeAll(sunDir);
      this.forceEnvUpdate();
    } else {
      this.lut.step(6, sunDir);
    }
    const lutChanged = this.lut.version !== this.lutVersion;
    if (lutChanged) {
      this.lutVersion = this.lut.version;
      this.computeFogTargets();
    }
    const k = jumped ? 1 : 1 - Math.exp(-dt * 3);
    this.fogColor.lerp(this.fogColorT, k);
    this.fogSun.lerp(this.fogSunT, k);

    // weather smoothing: rain builds in ~6 s, surfaces soak in ~20 s and dry over ~90 s
    this.rain += (this.rainTarget - this.rain) * (1 - Math.exp(-dt / 6));
    const wetRate = this.rainTarget > this.wet ? 1 / 20 : 1 / 90;
    this.wet += (this.rainTarget - this.wet) * (1 - Math.exp(-dt * wetRate));
    const overcast = smoothstep(0, 1, this.rain);

    // --- night factor
    this.nightFactor = smoothstep(4, -8, elDeg);
    (g.world as any)?.setNightFactor?.(Math.min(1, this.nightFactor + overcast * 0.25));

    // --- sun / moon light
    const T = transmittance(this.lut.altitude, sunDir.y, this.look.mie, _c);
    const sunW = smoothstep(-1.5, 2.5, elDeg);
    const illum = (1 - Math.cos(this.phase * Math.PI * 2)) / 2;
    const moonW = smoothstep(-3, -9, elDeg) * smoothstep(-0.03, 0.12, this.moonDirection.y) * (0.25 + 0.75 * illum);
    const sl = this.sunLight;
    const dim = 1 - overcast * 0.88;
    if (sunW > 0.001) {
      sl.position.copy(sunDir);
      sl.color.setRGB(T.r, T.g, T.b);
      const m = Math.max(sl.color.r, sl.color.g, sl.color.b, 1e-6);
      sl.color.multiplyScalar(1 / m).lerp(_c2.setRGB(1, 0.97, 0.92), 0.12);
      sl.intensity = E_SUN * m * sunW * dim;
    } else if (moonW > 0.001) {
      sl.position.copy(this.moonDirection);
      sl.color.setRGB(0.62, 0.72, 1.0);
      sl.intensity = MOON_E * moonW * dim;
    } else {
      sl.intensity = 0;
    }
    sl.castShadow = sl.intensity > 0.02;
    sl.shadow.radius = 2 + overcast * 6;
    sl.shadow.intensity = 1 - overcast * 0.5;
    sl.updateMatrixWorld();

    // --- sky uniforms
    const u = this.skyU;
    u.uSunDir.value.copy(sunDir);
    u.uSunE.value = E_SUN * dim;
    u.uSunDisk.value.setRGB(T.r, T.g, T.b).multiplyScalar(SUN_DISK * smoothstep(-1.2, 0.5, elDeg));
    u.uMoonDir.value.copy(this.moonDirection);
    u.uMoon.value.set(this.phase, 0.9 * (0.3 + 0.7 * this.nightFactor), 0.0105);
    u.uNight.value = smoothstep(-5, -14, elDeg);
    const glow = this.look.cityGlow * (0.4 + 0.6 * this.nightFactor) * (1 + overcast * 1.5);
    const tw = smoothstep(-17, -5, elDeg) * smoothstep(4, -2, elDeg);
    u.uTwiCool.value.setRGB(0.0045, 0.009, 0.024).multiplyScalar(tw * dim);
    u.uTwiWarm.value.setRGB(0.06, 0.022, 0.006).multiplyScalar(tw * smoothstep(-13, -3, elDeg) * dim);
    u.uCityGlow.value.setRGB(0.026, 0.012, 0.0045).multiplyScalar(glow * smoothstep(-2, -10, elDeg));
    u.uClouds.value.x = THREE.MathUtils.lerp(this.look.clouds, 0.97, overcast);
    u.uClouds.value.y = 0.6 + overcast * 0.4;
    u.uClouds.value.z += dt * (this.cyclePaused ? 1 : Math.max(1, this.timeScale * 0.2));
    // cloud lighting: sun as seen from cloud altitude stays lit a little after ground sunset
    const Tc = transmittance(this.lut.altitude + 1800, sunDir.y + 0.02, this.look.mie, _c2);
    const cw = smoothstep(-4, 1, elDeg);
    u.uCloudSun.value.setRGB(Tc.r, Tc.g, Tc.b).multiplyScalar(E_SUN * 0.3 * cw * dim);
    u.uCloudAmb.value.copy(this.zenith).multiplyScalar(0.75 * dim).add(_c2.copy(u.uCityGlow.value).multiplyScalar(1.1));
    if (this.nightFactor > 0 && moonW > 0) u.uCloudAmb.value.add(_c2.setRGB(0.004, 0.005, 0.007).multiplyScalar(moonW));
    u.uOvercast.value = overcast * 0.85;
    _m4.makeRotationAxis(_v.set(0, Math.sin(this.lat * DEG), -Math.cos(this.lat * DEG)).normalize(), (this.time / 24) * Math.PI * 2);
    u.uStarRot.value.setFromMatrix4(_m4);
    // ground seen by the environment probe (albedo ~0.12)
    const sunIrr = sl.intensity * Math.max(sunDir.y, 0) * (sunW > 0.001 ? 1 : 0);
    u.uGround.value.copy(sl.color).multiplyScalar(sunIrr / Math.PI).add(_c2.copy(this.fogColor).multiplyScalar(0.8)).multiplyScalar(GROUND_ALBEDO);

    // --- fog / aerial perspective
    const fog = g.scene.fog as THREE.FogExp2;
    const fogCol = _c2.copy(this.fogColor);
    if (overcast > 0) fogCol.lerp(_c.setScalar(lum(this.fogColor)), overcast * 0.6);
    fog.color.copy(fogCol);
    fog.density = this.look.haze * (1 + overcast * 2.5);
    globals.fogHeight.set(this.look.heightFog * (1 + overcast * 2), this.look.heightFalloff, this.baseHeight(), 1);
    globals.sunDir.set(sunDir.x, sunDir.y, sunDir.z);
    globals.fogSun.set(this.fogSun.r * dim, this.fogSun.g * dim, this.fogSun.b * dim);
    globals.wet.set(this.wet, smoothstep(0.3, 1, this.wet), globals.wet.z + dt, 0);
    this.post.wetSSR.params.set(this.wet, smoothstep(0.3, 1, this.wet), 0.9, SSR_DEBUG);
    this.post.ssrPass.enabled = this.wet > 0.02 && this.ssrAllowed;

    // --- night fill (sky + city bounce)
    // dusk fill: lifts street-level shadows while the low sun only reaches rooftops
    const dusk = smoothstep(16, 1, elDeg) * smoothstep(-8, -1, elDeg);
    this.hemi.intensity = this.nightFactor * 0.26 * this.look.cityGlow + overcast * 0.25 * (1 - this.nightFactor) + dusk * 0.6;
    this.hemi.color.setRGB(0.38, 0.45, 0.62);
    this.hemi.groundColor.setRGB(0.42, 0.3, 0.2);

    // --- exposure (partial eye adaptation) + grading
    // horizontal illuminance (sun + sky dome) drives a partial, photographic eye adaptation:
    // mid-grey in full sun lands near middle grey, shade stays readable, night stays night.
    const sunHor = lum(sl.color) * sl.intensity * Math.max(sunDir.y, 0.04) * (sunW > 0.001 ? 1 : 0.2);
    const skyHor = Math.PI * 1.3 * (lum(this.zenith) + lum(this.skyU.uTwiCool.value) * 3);
    const sceneLum = sunHor + skyHor + 0.006;
    const targetExpo = THREE.MathUtils.clamp(EXPO_KEY / Math.pow(sceneLum, 0.6), 0.7, 3.6);
    this.exposure += (targetExpo - this.exposure) * (jumped ? 1 : 1 - Math.exp(-dt * 1.5));
    this.applyGrade(overcast);

    // --- environment (IBL) refresh when the sun moved noticeably / periodically
    this.envTimer += dt;
    const moved = this.envSunDir.angleTo(sunDir) > 0.6 * DEG;
    if ((moved && this.envTimer > 0.5) || this.envTimer > 30 || Math.abs(this.envRain - overcast) > 0.04) {
      this.updateEnvironment();
      this.envSunDir.copy(sunDir);
      this.envTimer = 0;
      this.envRain = overcast;
    }

    // --- rain particles follow the camera
    const amb = _c.copy(this.fogColor).multiplyScalar(this.exposure).addScalar(0.02 * this.nightFactor);
    this.rainFx.update(dt, g.camera.position, this.rain, amb);
  }

  private baseHeight() {
    const w = this.g.world as any;
    const p = this.g.camera.position;
    try {
      if (w?.heightAt) {
        const h = w.heightAt(p.x, p.z);
        if (Number.isFinite(h)) return h - 5;
      }
    } catch { /* world not ready */ }
    const y = this.g.recipe.spawn?.y;
    return Number.isFinite(y) ? y : 0;
  }

  private applyGrade(overcast: number) {
    const p = this.post;
    const L = this.look;
    const n = this.nightFactor;
    const golden = smoothstep(30, 8, this.sunElevation / DEG) * (1 - n);
    p.exposure.exposure = this.exposure;
    // golden hour: warm the whole frame a touch (daylight-balanced camera under low sun)
    p.exposure.whiteBalance.set(
      L.wb[0] * (1 - 0.06 * n) * (1 + 0.04 * golden),
      L.wb[1],
      L.wb[2] * (1 + 0.04 * n) * (1 - 0.07 * golden),
    );
    // subtle by day (only the sun glint / speculars bloom), rich halos around lamps and signs at night
    p.bloom.luminanceMaterial.threshold = p.bloomBaseThreshold / this.exposure * (1 - 0.35 * n);
    p.bloom.intensity = 0.35 + 0.75 * n + 0.15 * golden + 0.2 * overcast;
    const gu = (k: string) => p.grade.u(k).value;
    p.grade.u('saturation').value = L.saturation * (1 - 0.18 * overcast) * (1 - 0.12 * n) + 0.05 * golden;
    p.grade.u('contrast').value = L.contrast * (1 - 0.08 * overcast) + 0.03 * n;
    (gu('shadowTint') as THREE.Vector3).set(...L.shadowTint).lerp(new THREE.Vector3(0.93, 0.98, 1.08), n * 0.6);
    (gu('highlightTint') as THREE.Vector3).set(...L.highlightTint).lerp(new THREE.Vector3(1.06, 0.99, 0.9), golden * 0.5);
    (gu('lift') as THREE.Vector3).set(0.004, 0.006, 0.012).multiplyScalar(1 + n);
  }

  private computeFogTargets() {
    const sunDir = this.sunDirection;
    const g = this.look.mieG;
    const E = E_SUN;
    const acc = new THREE.Color(0, 0, 0);
    const d = new THREE.Vector3();
    const el = 2 * DEG;
    const N = 12;
    for (let i = 0; i < N; i++) {
      const az = (i / N) * Math.PI * 2;
      dirFromElAz(el, az, d);
      this.lut.sample(d, sunDir, g, _c);
      acc.r += _c.r; acc.g += _c.g; acc.b += _c.b;
    }
    acc.multiplyScalar(E / N);
    // night floor: airglow + city light pollution at the horizon (matches sky shader)
    const su = this.skyU;
    acc.add(su.uAirglow.value).add(_c.copy(su.uCityGlow.value).multiplyScalar(1.0))
      .add(_c.copy(su.uTwiCool.value).multiplyScalar(0.95)).add(_c.copy(su.uTwiWarm.value).multiplyScalar(0.3));
    this.fogColorT.copy(acc);
    // toward the sun
    const sAz = Math.atan2(sunDir.x, -sunDir.z);
    dirFromElAz(el, sAz, d);
    this.lut.sample(d, sunDir, g, _c).multiplyScalar(E);
    this.fogSunT.setRGB(Math.max(0, _c.r - acc.r), Math.max(0, _c.g - acc.g), Math.max(0, _c.b - acc.b)).multiplyScalar(0.8)
      .add(_c.copy(su.uTwiWarm.value).multiplyScalar(0.7));
    // zenith (for cloud ambient / exposure)
    this.lut.sample(d.set(0, 1, 0), sunDir, g, this.zenith).multiplyScalar(E);
    if (this.lutVersion <= 1) { this.fogColor.copy(this.fogColorT); this.fogSun.copy(this.fogSunT); }
  }

  updateEnvironment() {
    const r = this.g.renderer;
    this.cubeCam.update(r, this.envScene);
    this.pmremRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.pmremRT ?? undefined as any);
    if (this.g.scene.environment !== this.pmremRT.texture) this.g.scene.environment = this.pmremRT.texture;
  }

  setRain(on: boolean) {
    this.rainTarget = on ? 1 : 0;
  }
  toggleRain() {
    this.setRain(this.rainTarget < 0.5);
    this.g.events.emit('toast', { text: this.rainTarget ? 'Rain rolling in' : 'Skies clearing', kind: 'info', ms: 1500 });
  }
}

// ------------------------------------------------------------------------------------------------

interface RenderState {
  post: PostChain;
  sky: RenderSky;
  bench: { t: number; frames: number; sum: number; done: boolean; steps: number };
}
const STATE = new WeakMap<Game, RenderState>();

function readStoredQuality(): Quality | null {
  const q = new URLSearchParams(location.search).get('quality');
  if (q === 'high' || q === 'medium' || q === 'low') return q;
  try {
    const s = localStorage.getItem('gt.quality');
    if (s === 'high' || s === 'medium' || s === 'low') return s;
  } catch { /* ignore */ }
  return null;
}

let devMode = new URLSearchParams(location.search).has('renderdev');

export async function setupRendering(g: Game, opts: { dev?: boolean } = {}): Promise<void> {
  // In ?renderdev mode the normal boot path parks here so only the dev scene renders.
  if (devMode && !opts.dev) return new Promise<void>(() => {});
  patchShaderChunks();

  const renderer = new THREE.WebGLRenderer({
    powerPreference: 'high-performance',
    antialias: false,
    stencil: false,
    depth: true,
    alpha: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 1);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  g.container.appendChild(renderer.domElement);
  g.renderer = renderer;

  const stored = readStoredQuality();
  if (stored) g.quality = stored;
  const cfg = tierConfig(g.quality);
  renderer.setPixelRatio(cfg.pixelRatio);

  const size = () => ({ w: g.container.clientWidth || innerWidth, h: g.container.clientHeight || innerHeight });
  const { w, h } = size();
  renderer.setSize(w, h, false);
  g.camera.aspect = w / h;
  g.camera.updateProjectionMatrix();

  const post = createPost(renderer, g.scene, g.camera, w, h);
  const sky = new RenderSky(g, post);
  g.sky = sky;
  const state: RenderState = { post, sky, bench: { t: 0, frames: 0, sum: 0, done: !!stored, steps: 0 } };
  STATE.set(g, state);
  applyQuality(g, g.quality);

  const onResize = () => {
    const s = size();
    renderer.setSize(s.w, s.h, false);
    post.composer.setSize(s.w, s.h);
    g.camera.aspect = s.w / s.h;
    g.camera.updateProjectionMatrix();
  };
  addEventListener('resize', onResize);
  new ResizeObserver(onResize).observe(g.container);
  onResize();

  // F7 opens caret browsing in some browsers; we use it for weather.
  addEventListener('keydown', (e) => { if (e.code === 'F7') e.preventDefault(); });

  sky.updateEnvironment();

  g.addSystem({
    name: 'render-sky',
    order: 900,
    update: (dt) => sky.update(dt),
  });
  g.addSystem({
    name: 'render-bench',
    order: 901,
    update: (dt) => autoBenchmark(g, dt),
  });

  // the composer issues many internal renders; accumulate info per frame so draw calls are measurable
  renderer.info.autoReset = false;
  g.renderFrame = (dt) => {
    renderer.info.reset();
    post.composer.render(dt);
  };
  (window as any).__render = { sky, post, setQuality: (q: Quality) => setQuality(g, q) };
}

function autoBenchmark(g: Game, dt: number) {
  const st = STATE.get(g);
  if (!st || st.bench.done) return;
  const b = st.bench;
  b.t += dt;
  if (b.t < 0.75) return; // skip warm-up (shader compiles)
  b.frames++;
  b.sum += dt;
  if (b.t < 2.75) return;
  const avg = b.sum / Math.max(1, b.frames);
  const order: Quality[] = ['high', 'medium', 'low'];
  const idx = order.indexOf(g.quality);
  if (avg > 1 / 42 && idx < 2 && b.steps < 2) {
    applyQuality(g, order[idx + 1]);
    console.info(`[render] auto quality: ${(1000 * avg).toFixed(1)} ms/frame -> ${order[idx + 1]}`);
    b.t = 0; b.frames = 0; b.sum = 0; b.steps++;
  } else {
    b.done = true;
  }
}

function applyQuality(g: Game, q: Quality) {
  const st = STATE.get(g);
  g.quality = q;
  if (!st) return;
  const cfg = tierConfig(q);
  const { post, sky } = st;
  g.renderer.setPixelRatio(cfg.pixelRatio);
  const w = g.container.clientWidth || innerWidth;
  const h = g.container.clientHeight || innerHeight;
  g.renderer.setSize(w, h, false);
  post.composer.setSize(w, h);
  post.ao.enabled = cfg.ao;
  if (cfg.ao) {
    post.ao.configuration.halfRes = cfg.aoHalf;
    post.ao.setQualityMode(cfg.aoMode);
  }
  post.bloom.resolution.scale = cfg.bloomScale;
  post.smaa.edgeDetectionMaterial.edgeDetectionThreshold = q === 'low' ? 0.15 : 0.08;
  sky.applyShadowTier(q);
  sky.ssrAllowed = q !== 'low';
}

/** Change quality tier (settings menu). Persists the choice and disables the auto-benchmark. */
export function setQuality(g: Game, q: Quality) {
  applyQuality(g, q);
  const st = STATE.get(g);
  if (st) st.bench.done = true;
  try { localStorage.setItem('gt.quality', q); } catch { /* ignore */ }
}

export function setRain(g: Game, on: boolean) { STATE.get(g)?.sky.setRain(on); }
export function isRaining(g: Game) { return (STATE.get(g)?.sky.rainTarget ?? 0) > 0.5; }

/** Kept for API compatibility: shadows use the built-in cascaded SunLight and need no material setup. */
export function setupShadowMaterial<T extends THREE.Material>(m: T): T { return m; }

// Dev test scene: /?renderdev
if (devMode) {
  if (new URLSearchParams(location.search).get('renderdev') === 'world') import('./dev/worldTest').then((m) => m.startWorldTest());
  else import('./dev/devScene').then((m) => m.startDevScene());
}
