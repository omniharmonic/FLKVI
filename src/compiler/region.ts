// OWNER: compiler agent. Coarse US region / climate / ecoregion priors from lat/lon.
import type { Region, Climate } from '../core/types.ts';

export function regionFor(lat: number, lon: number): Region {
  if (lat > 51 || lon < -140 || (lat < 23 && lon < -150)) return 'alaska-hawaii';
  // Pacific: WA/OR/CA (rough lon/lat boxes)
  if (lon < -120.0 && lat > 32) return 'pacific';
  if (lat >= 42 && lon < -116.9) return 'pacific';
  if (lat < 39 && lat > 32.4 && lon < -114.6 && !(lat > 35 && lon > -120 + (lat - 35) * 1.3)) {
    // California south of the NV diagonal
    if (lon < -117 || lat < 34.5) return 'pacific';
  }
  if (lon < -103 && lat < 37.1) return 'southwest';
  if (lon < -102) return 'mountain-west';
  if (lon < -89 && lat < 37) return 'south-central';
  if (lon < -80.5 && lat >= 37) return 'midwest';
  if (lon >= -80.5 && lat > 39.7) return 'northeast';
  if (lon > -75.8 && lat > 38.8) return 'northeast';
  return 'southeast';
}

export function climateFor(lat: number, lon: number, region: Region): Climate {
  switch (region) {
    case 'southwest': return 'arid';
    case 'mountain-west': return lat > 44.5 ? 'cold' : 'arid';
    case 'pacific':
      if (lon < -121.3 || (lat < 34.5 && lon < -117.3)) return 'coastal';
      return lat > 42 ? 'humid' : 'arid';
    case 'northeast': return lon > -75 && lat < 42.5 ? 'coastal' : 'cold';
    case 'midwest': return lat > 40 ? 'cold' : 'humid';
    case 'alaska-hawaii': return lat > 40 ? 'cold' : 'coastal';
    case 'south-central': return lon < -100 ? 'arid' : 'humid';
    default: return lat < 30.5 || lon > -78.5 ? 'coastal' : 'humid';
  }
}

export interface Species { name: string; h: [number, number]; crown: number /* crown/height ratio */; w: number /* weight */ }
export interface TreePalette { id: string; street: Species[]; park: Species[]; forest: Species[] }

const S = (name: string, h: [number, number], crown: number, w = 1): Species => ({ name, h, crown, w });

export const PALETTES: Record<string, TreePalette> = {
  'front-range': {
    id: 'front-range',
    street: [S('honey-locust', [9, 14], 0.8, 3), S('green-ash', [10, 16], 0.7, 2), S('linden', [9, 14], 0.6, 2), S('silver-maple', [12, 20], 0.8, 1.5), S('crabapple', [4, 7], 0.9, 1)],
    park: [S('cottonwood', [15, 25], 0.7, 2), S('silver-maple', [12, 20], 0.8, 1.5), S('blue-spruce', [9, 16], 0.4, 1.5), S('ponderosa-pine', [12, 22], 0.4, 1), S('honey-locust', [9, 14], 0.8, 1), S('green-ash', [10, 16], 0.7, 1)],
    forest: [S('ponderosa-pine', [12, 24], 0.4, 3), S('cottonwood', [15, 25], 0.7, 1), S('blue-spruce', [10, 18], 0.4, 1)],
  },
  pacific: {
    id: 'pacific',
    street: [S('london-plane', [10, 18], 0.7, 2), S('brisbane-box', [8, 14], 0.6, 2), S('ginkgo', [8, 14], 0.5, 1), S('red-maple', [8, 14], 0.6, 1), S('canary-palm', [9, 16], 0.6, 0.8)],
    park: [S('coast-live-oak', [9, 16], 1.0, 2), S('monterey-cypress', [12, 22], 0.7, 1.5), S('eucalyptus', [18, 30], 0.5, 1), S('london-plane', [10, 18], 0.7, 1), S('canary-palm', [10, 18], 0.6, 0.7)],
    forest: [S('coast-live-oak', [9, 16], 1.0, 2), S('douglas-fir', [20, 35], 0.35, 2), S('eucalyptus', [18, 30], 0.5, 1)],
  },
  northeast: {
    id: 'northeast',
    street: [S('london-plane', [12, 20], 0.7, 3), S('honey-locust', [9, 15], 0.8, 2), S('pin-oak', [12, 18], 0.6, 1.5), S('linden', [9, 15], 0.6, 1.5), S('ginkgo', [8, 14], 0.5, 1.5), S('callery-pear', [7, 11], 0.6, 1)],
    park: [S('pin-oak', [14, 22], 0.7, 2), S('red-maple', [10, 18], 0.6, 2), S('american-elm', [15, 25], 0.8, 1), S('london-plane', [14, 22], 0.7, 1), S('white-pine', [15, 25], 0.4, 0.7)],
    forest: [S('red-maple', [12, 20], 0.6, 2), S('red-oak', [15, 24], 0.7, 2), S('white-pine', [15, 28], 0.4, 1)],
  },
  midwest: {
    id: 'midwest',
    street: [S('honey-locust', [9, 15], 0.8, 3), S('linden', [9, 15], 0.6, 2), S('ginkgo', [8, 14], 0.5, 1), S('hackberry', [10, 16], 0.7, 1.5), S('american-elm', [14, 22], 0.8, 1)],
    park: [S('bur-oak', [14, 22], 0.9, 2), S('silver-maple', [12, 20], 0.8, 2), S('american-elm', [15, 25], 0.8, 1), S('cottonwood', [16, 26], 0.7, 1), S('white-pine', [14, 24], 0.4, 0.7)],
    forest: [S('bur-oak', [14, 22], 0.9, 2), S('silver-maple', [12, 20], 0.8, 1), S('cottonwood', [16, 26], 0.7, 1)],
  },
  gulf: {
    id: 'gulf',
    street: [S('live-oak', [10, 16], 1.3, 3), S('crape-myrtle', [4, 7], 0.9, 2), S('sabal-palm', [8, 14], 0.4, 1), S('water-oak', [12, 18], 0.9, 1), S('magnolia', [9, 15], 0.6, 1)],
    park: [S('live-oak', [12, 18], 1.4, 3), S('bald-cypress', [15, 25], 0.4, 1.5), S('magnolia', [10, 16], 0.6, 1), S('sabal-palm', [9, 15], 0.4, 1), S('washingtonia-palm', [12, 20], 0.3, 0.6)],
    forest: [S('live-oak', [12, 18], 1.3, 2), S('bald-cypress', [15, 25], 0.4, 2), S('loblolly-pine', [18, 28], 0.4, 2)],
  },
  southeast: {
    id: 'southeast',
    street: [S('willow-oak', [12, 18], 0.8, 2), S('crape-myrtle', [4, 7], 0.9, 2), S('red-maple', [9, 15], 0.6, 1.5), S('magnolia', [9, 15], 0.6, 1), S('london-plane', [12, 18], 0.7, 1)],
    park: [S('willow-oak', [14, 22], 0.8, 2), S('loblolly-pine', [18, 28], 0.4, 2), S('magnolia', [10, 16], 0.6, 1), S('tulip-poplar', [18, 28], 0.5, 1)],
    forest: [S('loblolly-pine', [18, 28], 0.4, 3), S('tulip-poplar', [18, 28], 0.5, 1), S('white-oak', [15, 24], 0.8, 1)],
  },
  'south-central': {
    id: 'south-central',
    street: [S('live-oak', [9, 14], 1.2, 3), S('cedar-elm', [10, 15], 0.7, 2), S('crape-myrtle', [4, 7], 0.9, 2), S('bur-oak', [12, 18], 0.9, 1)],
    park: [S('live-oak', [10, 16], 1.3, 3), S('pecan', [15, 24], 0.8, 2), S('cedar-elm', [10, 16], 0.7, 1), S('ashe-juniper', [5, 9], 0.6, 1)],
    forest: [S('ashe-juniper', [5, 9], 0.6, 2), S('live-oak', [9, 14], 1.2, 2), S('post-oak', [10, 15], 0.8, 1)],
  },
  southwest: {
    id: 'southwest',
    street: [S('palo-verde', [5, 8], 1.1, 2), S('mesquite', [5, 9], 1.2, 2), S('washingtonia-palm', [12, 22], 0.25, 2), S('date-palm', [9, 16], 0.5, 1), S('desert-willow', [4, 7], 0.9, 1), S('chinese-elm', [8, 12], 0.8, 0.8)],
    park: [S('aleppo-pine', [10, 16], 0.6, 1.5), S('mesquite', [5, 9], 1.2, 2), S('washingtonia-palm', [14, 24], 0.25, 1.5), S('eucalyptus', [14, 22], 0.5, 0.8), S('palo-verde', [5, 8], 1.1, 1.5), S('ironwood', [5, 8], 1.0, 1)],
    forest: [S('mesquite', [4, 8], 1.2, 2), S('palo-verde', [4, 7], 1.1, 2), S('saguaro', [5, 11], 0.15, 0.5)],
  },
  tropical: {
    id: 'tropical',
    street: [S('royal-palm', [12, 20], 0.3, 3), S('coconut-palm', [9, 16], 0.35, 2.5), S('sabal-palm', [8, 13], 0.4, 1.5), S('gumbo-limbo', [8, 12], 0.9, 1), S('black-olive', [8, 12], 0.8, 1)],
    park: [S('coconut-palm', [10, 18], 0.35, 2), S('royal-palm', [14, 22], 0.3, 1.5), S('banyan-fig', [10, 16], 1.4, 1), S('live-oak', [10, 15], 1.2, 1), S('sea-grape', [4, 7], 1.1, 1)],
    forest: [S('sabal-palm', [8, 14], 0.4, 2), S('live-oak', [10, 15], 1.2, 1), S('slash-pine', [16, 24], 0.4, 1)],
  },
  northwest: {
    id: 'northwest',
    street: [S('red-maple', [9, 15], 0.6, 2), S('london-plane', [12, 18], 0.7, 2), S('cherry', [5, 9], 0.9, 1.5), S('linden', [9, 15], 0.6, 1)],
    park: [S('douglas-fir', [20, 35], 0.35, 3), S('western-red-cedar', [18, 30], 0.4, 1.5), S('bigleaf-maple', [14, 22], 0.8, 1.5)],
    forest: [S('douglas-fir', [22, 40], 0.35, 3), S('western-red-cedar', [18, 32], 0.4, 1.5), S('western-hemlock', [18, 30], 0.4, 1)],
  },
};

/** Finer-grained architectural/landscape locales on top of the coarse region (null = use region rules). */
export type Locale = 'creole' | 'miami' | 'lowcountry' | 'bay' | 'pnw' | 'socal' | null;
export function localeFor(lat: number, lon: number, region: Region): Locale {
  if (lat > 29.4 && lat < 30.8 && lon > -92.6 && lon < -89.4) return 'creole'; // New Orleans / Acadiana
  if (region === 'southeast' && lat < 27.3 && lon > -81.9) return 'miami'; // SE Florida
  if (region === 'southeast' && lat > 31 && lat < 33.6 && lon > -82.2) return 'lowcountry'; // Savannah / Charleston
  if (region === 'pacific' && lat > 36.9 && lat < 38.3 && lon > -122.8 && lon < -121.7) return 'bay';
  if (region === 'pacific' && lat > 42) return 'pnw';
  if (region === 'pacific' && lat < 35) return 'socal';
  return null;
}

export function paletteFor(lat: number, lon: number, region: Region, elevation = 0): TreePalette {
  if (elevation > 2350 && lat > 34) return {
    id: 'alpine',
    street: [S('aspen',[7,13],.45,3),S('blue-spruce',[8,16],.35,2)],
    park: [S('aspen',[9,17],.45,2),S('blue-spruce',[10,22],.35,3),S('ponderosa-pine',[12,24],.4,2)],
    forest: [S('blue-spruce',[12,25],.35,4),S('ponderosa-pine',[14,28],.35,3),S('aspen',[10,18],.4,2)],
  };
  if (region === 'mountain-west' && lon < -107 && lat < 40.5) return {
    id: 'high-desert',street: PALETTES['front-range'].street,
    park: [S('cottonwood',[9,17],.7,3),S('ashe-juniper',[3,7],.7,2)],
    forest: [S('ashe-juniper',[3,7],.75,4),S('ponderosa-pine',[6,12],.45,1)],
  };
  const loc = localeFor(lat, lon, region);
  if (loc === 'miami') return PALETTES.tropical;
  if (loc === 'lowcountry') return PALETTES.gulf;
  if (region === 'pacific' && lat > 42) return PALETTES.northwest;
  if (region === 'pacific') return lat < 34.5 && lon > -117.3 ? PALETTES.southwest : PALETTES.pacific;
  if (region === 'southwest') return PALETTES.southwest;
  if (region === 'mountain-west') return PALETTES['front-range'];
  if ((region === 'south-central' || region === 'southeast') && lat < 31.5 && lon > -97.5) return PALETTES.gulf;
  if (region === 'south-central') return PALETTES['south-central'];
  if (region === 'southeast') return lat < 28.5 ? PALETTES.gulf : PALETTES.southeast;
  if (region === 'northeast') return PALETTES.northeast;
  if (region === 'alaska-hawaii') return lat > 40 ? PALETTES.northwest : PALETTES.gulf;
  return PALETTES.midwest;
}

export function pickWeighted<T extends { w: number }>(arr: T[], r: number): T {
  let tot = 0;
  for (const a of arr) tot += a.w;
  let x = r * tot;
  for (const a of arr) { x -= a.w; if (x <= 0) return a; }
  return arr[arr.length - 1];
}
