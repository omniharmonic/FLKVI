/** Quaternius Fixing_Kneeling is 5.2 s: enter 0–1, work 1–4, stand 4–5.2.
 * Sample only the work section while held, so long interactions never stand up mid-cut.
 * A cosine ping-pong keeps both loop turnarounds continuous without another mixer action.
 */
export function kneelingWorkTime(elapsed: number): number {
  if (elapsed <= 1.2) return Math.max(0, elapsed);
  return 1.2 + 1.3 * (1 - Math.cos((elapsed - 1.2) * Math.PI / 2.6));
}
