// Featured-city previews: prebuilt top-down map thumbnails (tools/thumbs.ts → public/recipes/thumbs/<id>.png) plus
// a small index.json of facts (region, camera and building counts). Recipes are never fetched for thumbnails.
import type { Recipe, Region } from '../core/types';
import { unpackRecipe } from '../compiler/unpack';

export interface CityMeta { img: string; region: Region | string; cams: number; bldgs: number }
const THUMBS = `${import.meta.env.BASE_URL}recipes/thumbs/`;

export const REGION_LABEL: Record<string, string> = {
  northeast: 'Northeast', southeast: 'Southeast', midwest: 'Midwest', 'south-central': 'South Central',
  'mountain-west': 'Mountain West', southwest: 'Southwest', pacific: 'Pacific', 'alaska-hawaii': 'Alaska · Hawaii',
};

let indexP: Promise<Record<string, { region: string; cams: number; bldgs: number }>> | null = null;
/** Load prebuilt thumbnail metadata once; calls onReady per city that has a thumbnail. */
export function loadThumbs(ids: string[], onReady: (id: string, m: CityMeta) => void): void {
  indexP ??= fetch(`${THUMBS}index.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  indexP.then((idx) => {
    for (const id of ids) { const m = idx[id]; if (m) onReady(id, { img: `${THUMBS}${id}.png`, region: m.region, cams: m.cams, bldgs: m.bldgs }); }
  });
}

const inflight = new Map<string, Promise<Recipe | null>>();
/** Fetch + unpack a baked recipe (deduplicated while in flight). Used by the title-screen backdrop only. */
export function fetchRecipe(id: string): Promise<Recipe | null> {
  let p = inflight.get(id);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}recipes/${id}.json`)
      .then((r) => (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html') ? r.json() : null))
      .then((j) => (j ? unpackRecipe(j) : null))
      .catch(() => null)
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

