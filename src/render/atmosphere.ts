// Physically based single-scattering atmosphere evaluated on the CPU into a small sky-view LUT
// (azimuth x elevation), plus sun/moon ephemeris. The GPU sky shader samples the LUT and adds
// phase functions, sun/moon disks, stars and clouds. CPU evaluation lets us derive sun color,
// fog color and aerial-perspective tint from the exact same model with no GPU readback.
import * as THREE from 'three';

const RG = 6360e3;
const RT = 6460e3;
const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6];
const BETA_M_SCA = 3.996e-6;
const BETA_M_EXT = 4.44e-6;
const BETA_O = [0.65e-6, 1.881e-6, 0.085e-6];
const HR = 8000;
const HM = 1200;

export const LUT_W = 64;
export const LUT_H = 48;

// --- optical depth table: (height, cos zenith) -> [odR, odM, odO] integrated to top of atmosphere
const OD_H = 48;
const OD_MU = 96;
const odTable = new Float32Array(OD_H * OD_MU * 3);

function hFromIdx(i: number) {
  const f = i / (OD_H - 1);
  return f * f * (RT - RG);
}
function muFromIdx(j: number) {
  return -1 + (2 * j) / (OD_MU - 1);
}
function rayTop(r: number, mu: number) {
  // distance along ray from radius r with zenith cosine mu to the atmosphere top
  const disc = r * r * (mu * mu - 1) + RT * RT;
  return -r * mu + Math.sqrt(Math.max(disc, 0));
}
function hitsGround(r: number, mu: number) {
  if (mu >= 0) return false;
  const disc = r * r * (mu * mu - 1) + RG * RG;
  return disc >= 0;
}
function ozone(h: number) {
  return Math.max(0, 1 - Math.abs(h - 25000) / 15000);
}

(function buildOD() {
  const STEPS = 40;
  for (let i = 0; i < OD_H; i++) {
    const h = hFromIdx(i);
    const r = RG + h;
    for (let j = 0; j < OD_MU; j++) {
      const mu = muFromIdx(j);
      const k = (i * OD_MU + j) * 3;
      if (hitsGround(r, mu)) {
        odTable[k] = odTable[k + 1] = odTable[k + 2] = 1e9;
        continue;
      }
      const L = rayTop(r, mu);
      let a = 0, b = 0, c = 0;
      const ds = L / STEPS;
      for (let s = 0; s < STEPS; s++) {
        const t = (s + 0.5) * ds;
        const rr = Math.sqrt(r * r + t * t + 2 * r * mu * t);
        const hh = rr - RG;
        a += Math.exp(-hh / HR) * ds;
        b += Math.exp(-hh / HM) * ds;
        c += ozone(hh) * ds;
      }
      odTable[k] = a;
      odTable[k + 1] = b;
      odTable[k + 2] = c;
    }
  }
})();

const _od = [0, 0, 0];
/** Optical depth from height h (m) toward zenith-cosine mu, bilinear. Returns large values if blocked by ground. */
function opticalDepth(h: number, mu: number): number[] {
  const hf = Math.sqrt(Math.min(Math.max(h, 0), RT - RG) / (RT - RG)) * (OD_H - 1);
  const mf = ((Math.min(Math.max(mu, -1), 1) + 1) / 2) * (OD_MU - 1);
  const i0 = Math.min(Math.floor(hf), OD_H - 2);
  const j0 = Math.min(Math.floor(mf), OD_MU - 2);
  const fi = hf - i0;
  const fj = mf - j0;
  for (let c = 0; c < 3; c++) {
    const v00 = odTable[(i0 * OD_MU + j0) * 3 + c];
    const v01 = odTable[(i0 * OD_MU + j0 + 1) * 3 + c];
    const v10 = odTable[((i0 + 1) * OD_MU + j0) * 3 + c];
    const v11 = odTable[((i0 + 1) * OD_MU + j0 + 1) * 3 + c];
    // if any corner is blocked, soften the terminator instead of averaging 1e9
    if (v00 > 1e8 || v01 > 1e8 || v10 > 1e8 || v11 > 1e8) {
      const vs = [v00, v01, v10, v11].filter((v) => v < 1e8);
      if (vs.length === 0) { _od[c] = 1e9; continue; }
      const w = [(1 - fi) * (1 - fj), (1 - fi) * fj, fi * (1 - fj), fi * fj];
      const vals = [v00, v01, v10, v11];
      let sw = 0, sv = 0, blocked = 0;
      for (let q = 0; q < 4; q++) {
        if (vals[q] < 1e8) { sw += w[q]; sv += w[q] * vals[q]; } else blocked += w[q];
      }
      _od[c] = sw > 0 ? sv / sw + blocked * 4e5 : 1e9;
      continue;
    }
    _od[c] = (v00 * (1 - fj) + v01 * fj) * (1 - fi) + (v10 * (1 - fj) + v11 * fj) * fi;
  }
  return _od;
}

/** Transmittance RGB from altitude h toward direction with zenith-cosine mu. */
export function transmittance(h: number, mu: number, mieScale = 1, out = new THREE.Color()) {
  const od = opticalDepth(h, mu);
  out.r = Math.exp(-(BETA_R[0] * od[0] + BETA_M_EXT * mieScale * od[1] + BETA_O[0] * od[2]));
  out.g = Math.exp(-(BETA_R[1] * od[0] + BETA_M_EXT * mieScale * od[1] + BETA_O[1] * od[2]));
  out.b = Math.exp(-(BETA_R[2] * od[0] + BETA_M_EXT * mieScale * od[1] + BETA_O[2] * od[2]));
  return out;
}

/** Elevation mapping for LUT rows: more resolution near the horizon. v in [0,1] -> elevation radians. */
export function lutRowToElevation(v: number) {
  const s = v * 2 - 1;
  return Math.sign(s) * s * s * (Math.PI / 2);
}

/**
 * Sky-view LUT. Each texel stores Rayleigh (tex R) and Mie (tex M) in-scatter for unit sun irradiance,
 * WITHOUT phase functions (applied per pixel in the shader so the sun glow stays sharp).
 * Computed incrementally (a few rows per call) so cost is spread over frames.
 */
export class SkyLUT {
  readonly rayleigh = new Float32Array(LUT_W * LUT_H * 4);
  readonly mie = new Float32Array(LUT_W * LUT_H * 4);
  readonly texR: THREE.DataTexture;
  readonly texM: THREE.DataTexture;
  private back = { r: new Float32Array(LUT_W * LUT_H * 4), m: new Float32Array(LUT_W * LUT_H * 4) };
  private row = 0;
  private sun = new THREE.Vector3(0, 1, 0);
  altitude = 1500;
  mieScale = 1;
  /** Increments each time a full LUT pass completes. */
  version = 0;

  constructor() {
    const mk = (data: Float32Array) => {
      const t = new THREE.DataTexture(data, LUT_W, LUT_H, THREE.RGBAFormat, THREE.FloatType);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    };
    this.texR = mk(this.rayleigh);
    this.texM = mk(this.mie);
  }

  /** Compute everything synchronously (startup, time jumps). */
  computeAll(sunDir: THREE.Vector3) {
    this.sun.copy(sunDir);
    this.row = 0;
    while (!this.step(LUT_H)) { /* loop */ }
  }

  /** Advance the incremental computation. Returns true when a full pass finished (textures updated). */
  step(rows: number, sunDir?: THREE.Vector3): boolean {
    if (this.row === 0 && sunDir) this.sun.copy(sunDir);
    const end = Math.min(LUT_H, this.row + rows);
    for (let y = this.row; y < end; y++) this.computeRow(y);
    this.row = end;
    if (this.row >= LUT_H) {
      this.rayleigh.set(this.back.r);
      this.mie.set(this.back.m);
      this.texR.needsUpdate = true;
      this.texM.needsUpdate = true;
      this.row = 0;
      this.version++;
      return true;
    }
    return false;
  }

  private computeRow(y: number) {
    const STEPS = 18;
    const el = lutRowToElevation((y + 0.5) / LUT_H);
    const cosEl = Math.cos(el);
    const sinEl = Math.sin(el);
    const h0 = Math.max(this.altitude, 1);
    const r0 = RG + h0;
    const sun = this.sun;
    const ms = this.mieScale;
    for (let x = 0; x < LUT_W; x++) {
      const az = ((x + 0.5) / LUT_W) * Math.PI * 2;
      // direction in world space (north=-Z, east=+X), azimuth from north clockwise
      const dx = Math.sin(az) * cosEl;
      const dz = -Math.cos(az) * cosEl;
      const dy = sinEl;
      const mu = dy;
      let L: number;
      if (hitsGround(r0, mu)) {
        const disc = r0 * r0 * (mu * mu - 1) + RG * RG;
        L = -r0 * mu - Math.sqrt(Math.max(disc, 0));
        L = Math.min(L, 120000);
      } else {
        L = rayTop(r0, mu);
      }
      let vR = 0, vM = 0, vO = 0;
      let sR0 = 0, sR1 = 0, sR2 = 0, sM0 = 0, sM1 = 0, sM2 = 0;
      let tPrev = 0;
      for (let s = 0; s < STEPS; s++) {
        // quadratic step distribution: dense near the observer
        const f1 = (s + 1) / STEPS;
        const t1 = f1 * f1 * L;
        const ds = t1 - tPrev;
        const t = tPrev + ds * 0.5;
        tPrev = t1;
        // sample position (observer at (0, r0, 0))
        const px = dx * t, py = r0 + dy * t, pz = dz * t;
        const rr = Math.sqrt(px * px + py * py + pz * pz);
        const hh = rr - RG;
        const dR = Math.exp(-hh / HR);
        const dM = Math.exp(-hh / HM);
        const dO = ozone(hh);
        vR += dR * ds * 0.5; vM += dM * ds * 0.5; vO += dO * ds * 0.5;
        const muS = (px * sun.x + py * sun.y + pz * sun.z) / rr;
        const od = opticalDepth(hh, muS);
        if (od[0] < 1e8) {
          const tauM = BETA_M_EXT * ms * (vM + od[1]);
          const t0 = Math.exp(-(BETA_R[0] * (vR + od[0]) + tauM + BETA_O[0] * (vO + od[2])));
          const t1c = Math.exp(-(BETA_R[1] * (vR + od[0]) + tauM + BETA_O[1] * (vO + od[2])));
          const t2 = Math.exp(-(BETA_R[2] * (vR + od[0]) + tauM + BETA_O[2] * (vO + od[2])));
          const wr = dR * ds, wm = dM * ds;
          sR0 += t0 * wr; sR1 += t1c * wr; sR2 += t2 * wr;
          sM0 += t0 * wm; sM1 += t1c * wm; sM2 += t2 * wm;
        }
        vR += dR * ds * 0.5; vM += dM * ds * 0.5; vO += dO * ds * 0.5;
      }
      const k = (y * LUT_W + x) * 4;
      const br = this.back.r, bm = this.back.m;
      br[k] = sR0 * BETA_R[0];
      br[k + 1] = sR1 * BETA_R[1];
      br[k + 2] = sR2 * BETA_R[2];
      br[k + 3] = 1;
      const bms = BETA_M_SCA * ms;
      bm[k] = sM0 * bms;
      bm[k + 1] = sM1 * bms;
      bm[k + 2] = sM2 * bms;
      bm[k + 3] = 1;
    }
  }

  /** Sample the (finished) LUT for a world direction; returns radiance for unit sun irradiance incl. phase. */
  sample(dir: THREE.Vector3, sunDir: THREE.Vector3, g: number, out: THREE.Color) {
    const el = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    let az = Math.atan2(dir.x, -dir.z);
    if (az < 0) az += Math.PI * 2;
    const s = Math.sign(el) * Math.sqrt(Math.abs(el) / (Math.PI / 2));
    const v = (s + 1) / 2;
    const yf = THREE.MathUtils.clamp(v * LUT_H - 0.5, 0, LUT_H - 1);
    const xf = (az / (Math.PI * 2)) * LUT_W - 0.5;
    const y0 = Math.floor(yf), y1 = Math.min(y0 + 1, LUT_H - 1), fy = yf - y0;
    const x0 = ((Math.floor(xf) % LUT_W) + LUT_W) % LUT_W, x1 = (x0 + 1) % LUT_W, fx = xf - Math.floor(xf);
    const cosT = dir.dot(sunDir);
    const pR = (3 / (16 * Math.PI)) * (1 + cosT * cosT);
    const pM = miePhase(cosT, g);
    const f = (arr: Float32Array, c: number) => {
      const a = arr[(y0 * LUT_W + x0) * 4 + c], b = arr[(y0 * LUT_W + x1) * 4 + c];
      const cc = arr[(y1 * LUT_W + x0) * 4 + c], d = arr[(y1 * LUT_W + x1) * 4 + c];
      return (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
    };
    out.r = f(this.rayleigh, 0) * pR + f(this.mie, 0) * pM;
    out.g = f(this.rayleigh, 1) * pR + f(this.mie, 1) * pM;
    out.b = f(this.rayleigh, 2) * pR + f(this.mie, 2) * pM;
    return out;
  }
}

export function miePhase(cosT: number, g: number) {
  const g2 = g * g;
  return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + cosT * cosT)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * cosT, 1.5));
}

// ---------------------------------------------------------------- ephemeris

const DEG = Math.PI / 180;

function julianDay(date: Date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Solar position for a given latitude/longitude, calendar day and local STANDARD time (hours).
 * Timezone is approximated from longitude (round(lon/15)), which ignores DST.
 * Returns elevation and azimuth (radians; azimuth from north, clockwise/eastward).
 */
export function solarPosition(lat: number, lon: number, day: Date, hours: number) {
  const tz = Math.round(lon / 15);
  const utcMs = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) + (hours - tz) * 3600000;
  const n = julianDay(new Date(utcMs)) - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const gA = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(gA) + 0.02 * Math.sin(2 * gA)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = gmst + lon / 15;
  const ha = (lst * 15) * DEG - ra;
  const phi = lat * DEG;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  const el = Math.asin(sinEl);
  const az = Math.atan2(-Math.cos(dec) * Math.sin(ha), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(ha));
  return { el, az: (az + Math.PI * 2) % (Math.PI * 2), dec, n };
}

/** Moon phase in [0,1): 0 new, 0.5 full. */
export function moonPhase(day: Date) {
  const knownNew = Date.UTC(2000, 0, 6, 18, 14);
  const synodic = 29.530588853;
  const d = (day.getTime() - knownNew) / 86400000;
  return (((d / synodic) % 1) + 1) % 1;
}

/** Approximate lunar position: the moon trails the sun by phase * 24.84 h and swings ±5° + 23° in declination. */
export function lunarPosition(lat: number, lon: number, day: Date, hours: number) {
  const ph = moonPhase(day);
  return solarPosition(lat, lon, day, hours - ph * 24.84);
}

export function dirFromElAz(el: number, az: number, out = new THREE.Vector3()) {
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

/** Local time (hours) in [lo,hi] at which solar elevation crosses target (descending), or null. */
export function findElevationTime(lat: number, lon: number, day: Date, targetDeg: number, lo = 12, hi = 21) {
  let prev = solarPosition(lat, lon, day, lo).el / DEG;
  for (let t = lo + 0.05; t <= hi; t += 0.05) {
    const e = solarPosition(lat, lon, day, t).el / DEG;
    if (prev >= targetDeg && e < targetDeg) return t;
    prev = e;
  }
  return null;
}
