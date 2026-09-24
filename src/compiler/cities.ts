// OWNER: compiler agent. Featured, pre-baked cities (public/recipes/<id>.json). UI imports this list.
export interface BakedCity {
  id: string; name: string; lat: number; lon: number; blurb: string;
  /** Bake-time DEM low-pass (see CompileOptions.terrainDenoise): Savannah's z15 tiles are SRTM-era canopy noise. */
  terrainDenoise?: { sigma: number; open?: number };
}

export const BAKED_CITIES: BakedCity[] = [
  { id: 'denver-lodo', name: 'Denver — Lower Downtown', lat: 39.7526, lon: -104.9995, blurb: 'Warehouse blocks, Union Station streets and broad avenues beneath the Rockies.' },
  { id: 'santa-fe', name: 'Santa Fe — Plaza', lat: 35.687, lon: -105.9378, blurb: 'Adobe courtyards, narrow old-town streets and dry foothill light.' },
  { id: 'moab', name: 'Moab, UT — Main Street', lat: 38.5733, lon: -109.5506, blurb: 'A desert small town: low storefronts, open roads and red-rock country.' },
  { id: 'boulder', name: 'Boulder, CO — Pearl Street', lat: 40.0176, lon: -105.2797, blurb: 'Brick main-street blocks, a pedestrian mall and the Flatirons looming over it all.' },
  { id: 'sf-mission', name: 'San Francisco — Mission District', lat: 37.7599, lon: -122.4214, blurb: 'Victorian row houses, taquerias and busy Valencia and Mission corridors.' },
  { id: 'nyc-village', name: 'New York — Greenwich Village', lat: 40.7336, lon: -74.0027, blurb: 'Brownstones, tangled pre-grid streets and cameras on every corner.' },
  { id: 'nola-quarter', name: 'New Orleans — French Quarter', lat: 29.9584, lon: -90.0644, blurb: 'Creole townhouses, iron balconies, live oaks and tight one-way streets.' },
  { id: 'chicago-loop', name: 'Chicago — The Loop', lat: 41.8819, lon: -87.6278, blurb: 'Canyons of towers under the L — the densest camera grid in the set.' },
  { id: 'phoenix-downtown', name: 'Phoenix — Downtown', lat: 33.4484, lon: -112.074, blurb: 'Wide desert boulevards, palms, parking lots and surveillance trailers.' },
  { id: 'seattle-caphill', name: 'Seattle — Capitol Hill', lat: 47.6205, lon: -122.3212, blurb: 'Brick apartment blocks, craftsman streets, bars on Pike and Pine and rain-slick hills.' },
  { id: 'austin-soco', name: 'Austin — South Congress', lat: 30.2494, lon: -97.7495, blurb: 'A wide neon strip under live oaks, with bungalow streets rolling off both sides.' },
  { id: 'savannah', name: 'Savannah — Historic District', lat: 32.0776, lon: -81.0928, blurb: 'Leafy squares every block, brick rowhouses and live oaks hung with moss.', terrainDenoise: { sigma: 28, open: 28 } },
  { id: 'miami-beach', name: 'Miami Beach — South Beach', lat: 25.78, lon: -80.132, blurb: 'Pastel deco hotels, palm-lined avenues and cameras watching every corner of the strip.' },
];
