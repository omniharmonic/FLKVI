// OWNER: compiler agent. Featured, pre-baked cities (public/recipes/<id>.json). UI imports this list.
export interface BakedCity { id: string; name: string; lat: number; lon: number; blurb: string }

export const BAKED_CITIES: BakedCity[] = [
  { id: 'boulder', name: 'Boulder, CO — Pearl Street', lat: 40.0176, lon: -105.2797, blurb: 'Brick main-street blocks, a pedestrian mall and the Flatirons looming over it all.' },
  { id: 'sf-mission', name: 'San Francisco — Mission District', lat: 37.7599, lon: -122.4214, blurb: 'Victorian row houses, taquerias and busy Valencia and Mission corridors.' },
  { id: 'nyc-village', name: 'New York — Greenwich Village', lat: 40.7336, lon: -74.0027, blurb: 'Brownstones, tangled pre-grid streets and cameras on every corner.' },
  { id: 'nola-quarter', name: 'New Orleans — French Quarter', lat: 29.9584, lon: -90.0644, blurb: 'Creole townhouses, iron balconies, live oaks and tight one-way streets.' },
  { id: 'chicago-loop', name: 'Chicago — The Loop', lat: 41.8819, lon: -87.6278, blurb: 'Canyons of towers under the L — the densest camera grid in the set.' },
  { id: 'phoenix-downtown', name: 'Phoenix — Downtown', lat: 33.4484, lon: -112.074, blurb: 'Wide desert boulevards, palms, parking lots and surveillance trailers.' },
];
