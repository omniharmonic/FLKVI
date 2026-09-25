import type { SpawnLocation } from '../core/location.ts';
/** Pure parser: malformed coordinates/unknown cities return to the picker, never silently relocate. */
export function locationFromSearch(search: string, cities: readonly { id: string; lat: number; lon: number; name: string }[]): SpawnLocation | null {
  const q = new URLSearchParams(search);
  if (!q.has('autostart')) return null;
  let loc: SpawnLocation;
  if (q.has('lat') || q.has('lon')) {
    const latText = q.get('lat')?.trim(), lonText = q.get('lon')?.trim();
    if (!latText || !lonText) return null;
    const lat = Number(latText), lon = Number(lonText);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    loc = { lat, lon, name: q.get('name')?.trim().slice(0, 120) || `Pin ${lat.toFixed(3)}, ${lon.toFixed(3)}` };
  } else {
    const city = cities.find(c => c.id === (q.get('city') || 'boulder'));
    if (!city) return null;
    loc = { lat: city.lat, lon: city.lon, name: city.name, baked: city.id };
  }
  loc.mode = q.get('mode') === 'freeroam' ? 'freeroam' : 'takedown';
  return loc;
}

/** US states and supported territories; boxes screen pins before optional reverse geocoding. */
export function inUSBox(lat: number, lon: number): boolean {
  const boxes = [[24.3, 49.5, -125, -66.8], [51, 71.6, -179.9, -129.9], [18.8, 22.4, -160.4, -154.7],
    [17.8, 18.6, -67.4, -65.2], [17.5, 18.6, -65.2, -64.5]];
  return boxes.some(([south, north, west, east]) => lat >= south && lat <= north && lon >= west && lon <= east);
}
export const PICKER_COUNTRY_CODES = 'us,pr,vi';
export function supportedCountryCode(code?: string): boolean {
  return !code || PICKER_COUNTRY_CODES.split(',').includes(code.toLowerCase());
}
