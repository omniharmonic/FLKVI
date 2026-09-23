// OWNER: UI agent. Title/spawn picker, loading screen, HUD, minimap, camera map, results, pause/settings.
import type { Game } from '../core/game';
import type { SpawnLocation } from '../core/location';
export async function showSpawnPicker(): Promise<SpawnLocation> {
  return { lat: 40.0176, lon: -105.2797, name: 'Pearl Street, Boulder, CO', baked: 'boulder' };
}
export function showLoading(): { update(stage: string, f: number): void; done(): void } {
  return { update() {}, done() {} };
}
export function setupHUD(g: Game): void {}
