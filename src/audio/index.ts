// OWNER: audio agent. Positional audio, procedural/CC0 sounds, ambience, sirens, engine.
import type { Game } from '../core/game';
export async function setupAudio(g: Game): Promise<void> {
  g.audio = { play: () => null, listener: null };
}
