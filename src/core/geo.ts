// Local ENU projection around an origin. +X east, +Z south, meters.
import type { Vec2 } from './types';

const R = 6378137;

export function makeProjection(originLat: number, originLon: number) {
  const lat0 = (originLat * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * R * (1 - 0.00669438 * Math.sin(lat0) ** 2) ** -1.5 * (1 - 0.00669438);
  const mPerDegLon = (Math.PI / 180) * R * Math.cos(lat0) / Math.sqrt(1 - 0.00669438 * Math.sin(lat0) ** 2);
  return {
    toLocal(lat: number, lon: number): Vec2 {
      return [(lon - originLon) * mPerDegLon, -(lat - originLat) * mPerDegLat];
    },
    toLatLon(x: number, z: number): { lat: number; lon: number } {
      return { lat: originLat - z / mPerDegLat, lon: originLon + x / mPerDegLon };
    },
    mPerDegLat,
    mPerDegLon,
  };
}
export type Projection = ReturnType<typeof makeProjection>;

/** Deterministic hash → [0,1) PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
