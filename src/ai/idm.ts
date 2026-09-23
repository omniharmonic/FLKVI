// Intelligent Driver Model (Treiber). Pure math, unit tested in tests/sim.test.ts.
export interface IdmParams {
  /** Max acceleration m/s^2 */
  a: number;
  /** Comfortable deceleration m/s^2 */
  b: number;
  /** Minimum bumper gap m */
  s0: number;
  /** Desired time headway s */
  T: number;
  /** Acceleration exponent */
  delta: number;
}

export const IDM_DEFAULT: IdmParams = { a: 1.6, b: 2.4, s0: 2.2, T: 1.3, delta: 4 };
export const IDM_POLICE: IdmParams = { a: 4.0, b: 5.0, s0: 1.6, T: 0.6, delta: 4 };
/** Hard braking limit (m/s^2). */
export const MAX_BRAKE = 9;

/**
 * IDM acceleration.
 * @param v own speed, @param v0 desired speed, @param gap bumper-to-bumper gap to the leader (Infinity if free),
 * @param dv approach rate v - vLeader (positive when closing).
 */
export function idmAccel(v: number, v0: number, gap: number, dv: number, p: IdmParams = IDM_DEFAULT): number {
  const free = 1 - Math.pow(Math.max(0, v) / Math.max(0.1, v0), p.delta);
  if (!isFinite(gap)) return clampAcc(p.a * free);
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const g = Math.max(0.1, gap);
  return clampAcc(p.a * (free - (sStar / g) ** 2));
}

function clampAcc(a: number) {
  return Math.max(-MAX_BRAKE, a);
}

/** Integrate speed with an acceleration; never goes negative. */
export function stepSpeed(v: number, acc: number, dt: number): number {
  return Math.max(0, v + acc * dt);
}

/** Can a car at speed v stop comfortably within distance d (for yellow-light decisions)? */
export function canStopComfortably(v: number, d: number, b = IDM_DEFAULT.b): boolean {
  return (v * v) / (2 * b) <= d + 0.5;
}
