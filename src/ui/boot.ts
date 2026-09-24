// Light boot-time UI entry (title/picker + loading screen). main.ts imports this statically so the first visit
// only downloads the title screen; the HUD and the rest of ./index load with the game engine chunk.
import type { SpawnLocation } from '../core/location';
import { showSpawnPicker as pickerFlow, autostartLocation } from './picker';
import { unsupportedReason, showUnsupported } from './guard';

export { showLoading } from './loading';

export async function showSpawnPicker(): Promise<SpawnLocation> {
  const bad = unsupportedReason();
  if (bad) { showUnsupported(bad); return new Promise<SpawnLocation>(() => {}); }
  return autostartLocation() ?? pickerFlow();
}
