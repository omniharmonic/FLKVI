// OWNER: compiler agent. OSM buildings → RecipeBuilding[] with inferred height/roof/use/era/style.
import type { RecipeBuilding, Vec2, BuildingUse, RoofType, Era } from '../core/types.ts';
import type { OsmData, Tags } from './osm.ts';
import { multipolygonRings, parseLength, parseNum } from './osm.ts';
import { cleanRing, makeCCW, makeCW, polyArea, centroid, pointInRing, pointInPoly, orientedBox, GridIndex, bbox, distToRing, r2 } from './geom.ts';
import { rng, hashString } from '../core/geo.ts';
import { resolveStyle } from './style.ts';
import { localeFor } from './region.ts';
import type { Ctx } from './context.ts';
import type { RoadIndex } from './roads.ts';
import { PUBLIC_STREET } from './roads.ts';

export interface RawBuilding { id: string; outer: Vec2[]; holes: Vec2[][]; tags: Tags; part: boolean; area: number; c: Vec2 }

function ringFromIds(ids: number[], data: OsmData, ctx: Ctx): Vec2[] | null {
  const pts: Vec2[] = [];
  for (const id of ids) { const n = data.nodes.get(id); if (!n) return null; pts.push(ctx.proj.toLocal(n.lat, n.lon)); }
  return pts;
}

/** Collect building outlines and parts in local coordinates (unclipped). */
export function collectRawBuildings(data: OsmData, ctx: Ctx): RawBuilding[] {
  const out: RawBuilding[] = [];
  const add = (id: string, outerIds: number[], innerIds: number[][], tags: Tags) => {
    const isPart = !!tags['building:part'] && tags['building:part'] !== 'no' && !tags.building;
    if (!isPart && (!tags.building || tags.building === 'no')) return;
    if (tags.location === 'underground' || tags.building === 'underground' || tags.building === 'construction' && !tags.height && !tags['building:levels']) {
      if (tags.location === 'underground' || tags.building === 'underground') return;
    }
    const o = ringFromIds(outerIds, data, ctx); if (!o) return;
    let outer = cleanRing(o);
    if (outer.length < 3) return;
    const area = polyArea(outer);
    if (area < 6) return;
    outer = makeCCW(outer);
    const holes: Vec2[][] = [];
    for (const h of innerIds) { const r = ringFromIds(h, data, ctx); if (r) { const c = cleanRing(r); if (c.length >= 3 && polyArea(c) > 2) holes.push(makeCW(c)); } }
    out.push({ id, outer, holes, tags, part: isPart, area, c: centroid(outer) });
  };
  for (const w of data.ways.values()) {
    const t = w.tags; if (!t || !(t.building || t['building:part'])) continue;
    if (w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
    add(`w${w.id}`, w.nodes, [], t);
  }
  for (const r of data.rels.values()) {
    const t = r.tags; if (!t || !(t.building || t['building:part']) || t.type !== 'multipolygon') continue;
    const { outers, inners } = multipolygonRings(r, data);
    outers.forEach((o, k) => {
      // assign inner rings to this outer
      const oPts = ringFromIds(o, data, ctx); if (!oPts) return;
      const myInners = inners.filter((inn) => { const n0 = data.nodes.get(inn[0]); if (!n0) return false; const p = ctx.proj.toLocal(n0.lat, n0.lon); return pointInRing(p[0], p[1], oPts); });
      add(outers.length > 1 ? `r${r.id}-${k}` : `r${r.id}`, o, myInners, t);
    });
  }
  return out;
}

// ---- POIs ----
export interface Poi { p: Vec2; tags: Tags; cat: string | null; kind: 'shop' | 'food' | 'office' | 'service' | 'other' }

const CUISINE: Record<string, string> = {
  pizza: 'PIZZA', burger: 'BURGERS', mexican: 'TACOS', chinese: 'NOODLES', sushi: 'SUSHI', japanese: 'SUSHI', thai: 'THAI', indian: 'CURRY',
  italian: 'TRATTORIA', vietnamese: 'PHO', coffee_shop: 'CAFE', sandwich: 'SANDWICHES', ice_cream: 'ICE CREAM', bagel: 'BAGELS', donut: 'DONUTS',
  seafood: 'SEAFOOD', steak_house: 'STEAKHOUSE', barbecue: 'BBQ', breakfast: 'DINER', diner: 'DINER', american: 'DINER', ramen: 'RAMEN',
  korean: 'KOREAN BBQ', greek: 'GYROS', mediterranean: 'MEZZE', french: 'BISTRO', cajun: 'CAJUN', creole: 'CREOLE', chicken: 'CHICKEN', noodle: 'NOODLES',
  juice: 'JUICE', tea: 'TEA', bubble_tea: 'BOBA', crepe: 'CREPES', tacos: 'TACOS', burrito: 'BURRITOS', hot_dog: 'HOT DOGS', middle_eastern: 'FALAFEL',
};
const AMENITY_SIGN: Record<string, string> = {
  cafe: 'CAFE', bar: 'BAR', pub: 'PUB', biergarten: 'BEER GARDEN', ice_cream: 'ICE CREAM', bank: 'BANK', pharmacy: 'PHARMACY', dentist: 'DENTIST',
  clinic: 'CLINIC', doctors: 'CLINIC', theatre: 'THEATER', cinema: 'CINEMA', nightclub: 'CLUB', library: 'LIBRARY', post_office: 'POST OFFICE',
  fuel: 'GAS', car_wash: 'CAR WASH', arts_centre: 'ARTS', veterinary: 'VET', bureau_de_change: 'EXCHANGE', money_transfer: 'CHECKS CASHED',
  community_centre: 'COMMUNITY', coworking_space: 'COWORKING', spa: 'SPA', gym: 'GYM', fitness_centre: 'GYM', marketplace: 'MARKET', casino: 'CASINO',
};
const SHOP_SIGN: Record<string, string> = {
  bakery: 'BAKERY', books: 'BOOKS', clothes: 'CLOTHING', boutique: 'BOUTIQUE', fashion: 'CLOTHING', shoes: 'SHOES', hairdresser: 'SALON', beauty: 'BEAUTY',
  convenience: 'MARKET', supermarket: 'GROCERY', greengrocer: 'PRODUCE', jewelry: 'JEWELRY', gift: 'GIFTS', florist: 'FLOWERS', hardware: 'HARDWARE',
  doityourself: 'HARDWARE', outdoor: 'OUTDOOR', sports: 'SPORTS', bicycle: 'BIKES', alcohol: 'LIQUOR', wine: 'WINE', beverages: 'LIQUOR', optician: 'OPTICAL',
  tattoo: 'TATTOO', art: 'GALLERY', furniture: 'FURNITURE', mobile_phone: 'PHONES', electronics: 'ELECTRONICS', computer: 'COMPUTERS', toys: 'TOYS',
  music: 'RECORDS', musical_instrument: 'MUSIC', deli: 'DELI', butcher: 'BUTCHER', laundry: 'LAUNDRY', dry_cleaning: 'CLEANERS', variety_store: 'DISCOUNT',
  cannabis: 'DISPENSARY', pet: 'PETS', cosmetics: 'COSMETICS', chocolate: 'CHOCOLATE', confectionery: 'CANDY', tea: 'TEA', coffee: 'COFFEE',
  bag: 'LEATHER', department_store: 'DEPARTMENT STORE', mall: 'SHOPS', second_hand: 'THRIFT', charity: 'THRIFT', antiques: 'ANTIQUES', stationery: 'PAPER',
  frame: 'FRAMING', photo: 'PHOTO', car_repair: 'AUTO REPAIR', tyres: 'TIRES', car: 'AUTO SALES', car_parts: 'AUTO PARTS', kitchen: 'KITCHEN',
  interior_decoration: 'HOME', houseware: 'HOME', massage: 'MASSAGE', nutrition_supplements: 'VITAMINS', herbalist: 'HERBS', tobacco: 'SMOKE SHOP',
  e_cigarette: 'VAPE', perfumery: 'PERFUME', travel_agency: 'TRAVEL', copyshop: 'PRINT', nails: 'NAILS', ticket: 'TICKETS', games: 'GAMES', hobby: 'HOBBY',
  video_games: 'GAMES', lottery: 'LOTTO', pawnbroker: 'PAWN', seafood: 'FISH MARKET', cheese: 'CHEESE', pastry: 'PASTRY', erotic: 'BOUTIQUE',
  fabric: 'FABRIC', craft: 'CRAFTS', garden_centre: 'GARDEN', medical_supply: 'MEDICAL', hearing_aids: 'HEARING', paint: 'PAINT', locksmith: 'LOCKSMITH',
};

export function poiCategory(t: Tags): { cat: string | null; kind: Poi['kind'] } {
  if (t.shop) return { cat: SHOP_SIGN[t.shop] ?? (t.shop === 'yes' || t.shop === 'vacant' ? null : 'SHOP'), kind: 'shop' };
  const a = t.amenity;
  if (a === 'restaurant' || a === 'fast_food' || a === 'food_court') {
    const cz = (t.cuisine ?? '').split(/[;,]/)[0].trim();
    return { cat: CUISINE[cz] ?? (a === 'fast_food' ? 'FOOD' : 'RESTAURANT'), kind: 'food' };
  }
  if (a && AMENITY_SIGN[a]) return { cat: AMENITY_SIGN[a], kind: a === 'bar' || a === 'pub' || a === 'cafe' || a === 'ice_cream' ? 'food' : 'service' };
  if (t.tourism === 'hotel' || t.tourism === 'motel' || t.tourism === 'hostel' || t.tourism === 'guest_house') return { cat: t.tourism === 'motel' ? 'MOTEL' : t.tourism === 'hostel' ? 'HOSTEL' : 'HOTEL', kind: 'service' };
  if (t.tourism === 'gallery' || t.tourism === 'museum') return { cat: t.tourism === 'museum' ? 'MUSEUM' : 'GALLERY', kind: 'service' };
  if (t.leisure === 'fitness_centre') return { cat: 'GYM', kind: 'service' };
  if (t.office) return { cat: t.office === 'estate_agent' ? 'REALTY' : t.office === 'insurance' ? 'INSURANCE' : t.office === 'lawyer' ? 'LAW OFFICE' : null, kind: 'office' };
  if (t.craft) return { cat: t.craft === 'brewery' ? 'BREWERY' : t.craft === 'winery' ? 'WINERY' : t.craft === 'distillery' ? 'DISTILLERY' : null, kind: 'shop' };
  return { cat: null, kind: 'other' };
}

export function collectPois(data: OsmData, ctx: Ctx): Poi[] {
  const out: Poi[] = [];
  for (const n of data.nodes.values()) {
    const t = n.tags; if (!t) continue;
    if (!(t.shop || t.amenity || t.office || t.craft || t.tourism || t.leisure === 'fitness_centre')) continue;
    const { cat, kind } = poiCategory(t);
    if (kind === 'other' && !t.amenity) continue;
    out.push({ p: ctx.proj.toLocal(n.lat, n.lon), tags: t, cat, kind });
  }
  return out;
}

// ---- Landuse / grounds lookups ----
export interface Zone { kind: string; ring: Vec2[]; bb: { minX: number; minZ: number; maxX: number; maxZ: number } }
export function collectZones(data: OsmData, ctx: Ctx): Zone[] {
  const zones: Zone[] = [];
  const push = (kind: string, ids: number[]) => {
    const r = ringFromIds(ids, data, ctx); if (!r || r.length < 3) return;
    zones.push({ kind, ring: r, bb: bbox(r) });
  };
  const kindOf = (t: Tags): string | null => {
    if (t.amenity && /^(school|kindergarten|hospital|place_of_worship|university|college|grave_yard|clinic)$/.test(t.amenity)) return t.amenity;
    if (t.historic === 'memorial' || t.memorial) return 'memorial';
    if (t.landuse && /^(residential|commercial|retail|industrial|religious|education|institutional|civic_admin)$/.test(t.landuse)) return t.landuse;
    return null;
  };
  for (const w of data.ways.values()) {
    const t = w.tags; if (!t || t.building) continue;
    const k = kindOf(t); if (!k) continue;
    if (w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
    push(k, w.nodes);
  }
  for (const r of data.rels.values()) {
    const t = r.tags; if (!t || t.building || t.type !== 'multipolygon') continue;
    const k = kindOf(t); if (!k) continue;
    for (const o of multipolygonRings(r, data).outers) push(k, o);
  }
  return zones;
}
function zoneAt(zones: Zone[], p: Vec2): string[] {
  const out: string[] = [];
  for (const z of zones) if (p[0] >= z.bb.minX && p[0] <= z.bb.maxX && p[1] >= z.bb.minZ && p[1] <= z.bb.maxZ && pointInRing(p[0], p[1], z.ring)) out.push(z.kind);
  return out;
}

// ---- Inference ----
function useFrom(t: Tags, pois: Poi[], zones: string[], area: number, density: number, rowhouseCity = false): BuildingUse {
  const b = t.building ?? 'yes';
  const a = t.amenity;
  if (a === 'place_of_worship' || /^(church|chapel|cathedral|mosque|synagogue|temple|shrine|religious|monastery)$/.test(b)) return 'religious';
  if (/^(school|kindergarten|university|college)$/.test(b) || /^(school|kindergarten|university|college)$/.test(a ?? '')) return 'school';
  if (b === 'hospital' || a === 'hospital') return 'hospital';
  if (/^(parking|carport)$/.test(b) || a === 'parking') return b === 'carport' ? 'residential-single' : 'parking';
  if (/^(civic|public|government|townhall|fire_station|police|courthouse|library|museum|train_station|transportation|stadium|grandstand)$/.test(b) || /^(townhall|library|courthouse|fire_station|police|community_centre|theatre|arts_centre|post_office)$/.test(a ?? '')) return 'civic';
  if (/^(industrial|warehouse|manufacture|factory|hangar|storage_tank|service|digester|works)$/.test(b)) return 'industrial';
  if (/^(barn|farm|farm_auxiliary|greenhouse|stable|cowshed|silo|agricultural)$/.test(b)) return 'agricultural';
  if (b === 'office' || t.office) return pois.some((p) => p.kind === 'shop' || p.kind === 'food') ? 'mixed-use' : 'office';
  if (/^(house|detached|bungalow|semidetached_house|cabin|static_caravan|farmhouse|villa)$/.test(b)) return 'residential-single';
  if (/^(garage|garages|shed|hut|roof|kiosk|toilets|bunker|gazebo)$/.test(b)) return b === 'kiosk' ? 'commercial' : b === 'roof' ? 'commercial' : 'residential-single';
  const shopish = pois.filter((p) => p.kind === 'shop' || p.kind === 'food' || p.kind === 'service').length;
  if (/^(apartments|residential|terrace|dormitory|condominium|flats)$/.test(b)) return shopish > 0 ? 'mixed-use' : 'residential-multi';
  if (/^(commercial|retail|supermarket|hotel|mall|shop|restaurant|bank)$/.test(b)) return b === 'hotel' || b === 'commercial' && t['building:levels'] && +t['building:levels'] >= 3 && shopish ? (b === 'hotel' ? 'commercial' : 'mixed-use') : 'commercial';
  // building=yes: infer from POIs, zones, size
  if (shopish > 0) return (parseNum(t['building:levels']) ?? 0) >= 3 ? 'mixed-use' : 'commercial';
  if (pois.some((p) => p.kind === 'office')) return 'office';
  if (zones.some((z) => z === 'school' || z === 'university' || z === 'college' || z === 'kindergarten' || z === 'education')) return 'school';
  if (zones.includes('hospital')) return 'hospital';
  if (zones.includes('place_of_worship') || zones.includes('religious')) return 'religious';
  if (zones.includes('industrial')) return 'industrial';
  if (zones.includes('commercial') || zones.includes('retail')) return density > 0.3 || area > 250 ? 'commercial' : 'residential-single';
  // dense rowhouse cities: a 110+ m² attached footprint is a walk-up / rowhouse, not a detached house
  if (zones.includes('residential')) return area > 450 || (rowhouseCity && density > 0.35 && area > 110) ? 'residential-multi' : 'residential-single';
  if (density > 0.35) return area > 1500 ? 'commercial' : area > 110 ? 'residential-multi' : 'residential-single';
  return area > 600 ? 'commercial' : area > 350 ? 'residential-multi' : 'residential-single';
}

function parseYear(t: Tags): number | undefined {
  for (const k of ['start_date', 'building:start_date', 'construction_date', 'year_built', 'building:year_built']) {
    const v = t[k]; if (!v) continue;
    const m = v.match(/(1[6-9]\d\d|20[0-2]\d)/);
    if (m) return +m[1];
    const c = v.match(/C(\d\d)/i); if (c) return (+c[1] - 1) * 100 + 50;
  }
  return undefined;
}
function eraOfYear(y: number): Era {
  return y < 1900 ? 'pre-1900' : y < 1940 ? '1900-1939' : y < 1970 ? '1940-1969' : y < 2000 ? '1970-1999' : '2000+';
}

const ERA_PRIORS: Record<string, [number, number, number, number, number]> = {
  northeast: [0.2, 0.4, 0.2, 0.1, 0.1],
  midwest: [0.1, 0.4, 0.25, 0.13, 0.12],
  'mountain-west': [0.05, 0.3, 0.3, 0.2, 0.15],
  pacific: [0.08, 0.37, 0.28, 0.15, 0.12],
  southwest: [0.01, 0.12, 0.32, 0.32, 0.23],
  'south-central': [0.12, 0.3, 0.28, 0.18, 0.12],
  southeast: [0.08, 0.25, 0.3, 0.22, 0.15],
  'alaska-hawaii': [0.02, 0.1, 0.35, 0.33, 0.2],
};
const ERAS: Era[] = ['pre-1900', '1900-1939', '1940-1969', '1970-1999', '2000+'];
function pickEra(w: number[], r: number): Era {
  let s = 0; for (const x of w) s += x;
  let x = r * s;
  for (let i = 0; i < 5; i++) { x -= w[i]; if (x <= 0) return ERAS[i]; }
  return '2000+';
}

const ROOF_MAP: Record<string, RoofType> = {
  flat: 'flat', gabled: 'gable', gable: 'gable', hipped: 'hip', hip: 'hip', 'half-hipped': 'hip', side_hipped: 'hip', skillion: 'shed', lean_to: 'shed',
  mansard: 'mansard', gambrel: 'gambrel', pyramidal: 'pyramid', dome: 'dome', onion: 'dome', round: 'gable', saltbox: 'gable', cone: 'pyramid',
  crosspitched: 'hip', 'cross-gabled': 'gable', 'double_saltbox': 'gable', 'quadruple_saltbox': 'hip', sawtooth: 'shed', butterfly: 'flat',
};

export interface BuildResult { buildings: RecipeBuilding[]; grid: GridIndex<number>; sensitivePts: { p: Vec2; ring: Vec2[] }[] }

export function buildBuildings(raw: RawBuilding[], pois: Poi[], zones: Zone[], roads: RoadIndex, ctx: Ctx): BuildResult {
  const { bounds, heightAt, density, region, climate } = ctx;
  const locale = localeFor(ctx.lat, ctx.lon, region);
  // --- building:part handling: drop outlines that contain parts; parts inherit tags.
  const parts = raw.filter((r) => r.part);
  const outlines = raw.filter((r) => !r.part);
  const partGrid = new GridIndex<number>(40);
  parts.forEach((p, i) => partGrid.insert(i, p.c[0], p.c[1], p.c[0], p.c[1]));
  const used: RawBuilding[] = [];
  const parentOf = new Map<RawBuilding, RawBuilding>();
  for (const o of outlines) {
    const bb = bbox(o.outer);
    let covered = 0;
    const mine: RawBuilding[] = [];
    for (const k of partGrid.query(bb.minX, bb.minZ, bb.maxX, bb.maxZ)) {
      const p = parts[k];
      if (pointInRing(p.c[0], p.c[1], o.outer)) { mine.push(p); covered += p.area; }
    }
    if (mine.length && covered > o.area * 0.35) { for (const p of mine) parentOf.set(p, o); }
    else used.push(o);
  }
  for (const p of parts) used.push(p);

  // POI index
  const poiGrid = new GridIndex<number>(30);
  pois.forEach((p, i) => poiGrid.insert(i, p.p[0], p.p[1], p.p[0], p.p[1]));

  const buildings: RecipeBuilding[] = [];
  const sensitivePts: { p: Vec2; ring: Vec2[] }[] = [];
  const inB = (p: Vec2) => p[0] >= bounds.minX && p[0] <= bounds.maxX && p[1] >= bounds.minZ && p[1] <= bounds.maxZ;

  for (const rb of used) {
    if (!inB(rb.c)) continue;
    const parent = parentOf.get(rb);
    const t: Tags = parent ? { ...parent.tags, ...rb.tags } : rb.tags;
    if (parent && !rb.tags.height && !rb.tags['building:levels']) { delete t.height; delete t['building:levels']; }
    const seed = hashString(rb.id);
    const R = rng(seed);
    const bb = bbox(rb.outer);
    const myPois: Poi[] = [];
    for (const k of poiGrid.query(bb.minX - 8, bb.minZ - 8, bb.maxX + 8, bb.maxZ + 8)) {
      const p = pois[k];
      if (pointInRing(p.p[0], p.p[1], rb.outer) || distToRing(p.p[0], p.p[1], rb.outer) < 6) myPois.push(p);
    }
    const zs = zoneAt(zones, rb.c);
    const dens = density(rb.c[0], rb.c[1]);
    const rowhouseCity = region === 'northeast' || region === 'midwest' || region === 'pacific';
    let use = useFrom(t, myPois, zs, parent ? parent.area : rb.area, dens, rowhouseCity);
    const bType = t.building ?? 'yes';
    const small = /^(garage|garages|shed|hut|carport|kiosk|toilets|gazebo)$/.test(bType);

    // --- levels & heights
    let levels = parseNum(t['building:levels']);
    const minLevel = parseNum(t['building:min_level']);
    const roofLevels = parseNum(t['roof:levels']) ?? 0;
    let hTag = parseLength(t.height) ?? parseLength(t['building:height']);
    const minHTag = parseLength(t.min_height);
    const floorH = use === 'residential-single' || use === 'residential-multi' ? 3.05 : use === 'industrial' || use === 'agricultural' ? 5 : use === 'parking' ? 3.1 : use === 'office' ? 3.8 : 3.9;
    if (levels == null) {
      if (hTag) levels = Math.max(1, Math.round((hTag - (use === 'commercial' || use === 'mixed-use' ? 1 : 0)) / floorH));
      else if (small) levels = 1;
      else {
        const r = R();
        switch (use) {
          case 'residential-single': levels = rb.area < 70 ? 1 : r < (region === 'northeast' ? 0.25 : region === 'southwest' ? 0.85 : region === 'mountain-west' ? 0.5 : 0.45) ? 1 : 2; break;
          case 'residential-multi': levels = dens > 0.45 ? 3 + Math.floor(r * 3) : 2 + Math.floor(r * 2); if (region === 'northeast' && dens > 0.45) levels += 1; if (region === 'south-central' || region === 'southeast') levels = 2 + Math.floor(r * 2.3); if (region === 'pacific' && rb.area < 400) levels = 2 + Math.floor(r * 2.4); break;
          case 'commercial': levels = rb.area > 4000 ? 1 : dens > 0.4 ? (r < 0.45 ? 2 : r < 0.8 ? 3 : 1) : r < 0.75 ? 1 : 2; break;
          case 'mixed-use': levels = 2 + Math.floor(r * 3); break;
          case 'office': levels = dens > 0.4 ? 3 + Math.floor(r * 4) : 1 + Math.floor(r * 3); break;
          case 'civic': levels = 2 + Math.floor(r * 2); break;
          case 'school': levels = rb.area > 2500 ? 2 : 1 + Math.floor(r * 2); break;
          case 'hospital': levels = 3 + Math.floor(r * 4); break;
          case 'parking': levels = 3 + Math.floor(r * 3); break;
          case 'religious': levels = 1; break;
          default: levels = 1;
        }
        // huge footprints in dense cores tend to be taller
        if (dens > 0.5 && rb.area > 1500 && (use === 'office' || use === 'mixed-use' || use === 'residential-multi')) levels += 2;
      }
    }
    levels = Math.max(1, Math.min(160, Math.round(levels)));
    let minHeight = minHTag ?? (minLevel != null ? minLevel * floorH : undefined);
    if (bType === 'roof' && minHeight == null) minHeight = 3.8;

    // --- roof shape
    const box = orientedBox(rb.outer);
    let roof: RoofType;
    const shapeTag = t['roof:shape'];
    if (shapeTag && ROOF_MAP[shapeTag]) roof = ROOF_MAP[shapeTag];
    else {
      const r = R();
      const attached = dens > 0.4 && (region === 'pacific' || region === 'northeast' || region === 'midwest' || region === 'south-central' || region === 'southeast');
      if ((use === 'residential-single' || use === 'residential-multi') && attached && !small) roof = r < (region === 'south-central' || region === 'southeast' ? 0.45 : 0.75) ? 'flat' : r < 0.9 ? 'gable' : 'mansard';
      else if (use === 'residential-single' && rb.area < 450 && !small) roof = region === 'southwest' && r < 0.55 ? 'flat' : r < 0.55 ? 'gable' : r < 0.92 ? 'hip' : 'gambrel';
      else if (small && rb.area < 80) roof = r < 0.7 ? 'gable' : r < 0.85 ? 'shed' : 'flat';
      else if (use === 'residential-multi' && rb.area < 500 && levels <= 3 && dens < 0.4) roof = r < 0.5 ? 'gable' : 'hip';
      else if (use === 'religious' && rb.area < 1500) roof = 'gable';
      else if (use === 'agricultural') roof = r < 0.7 ? 'gable' : 'gambrel';
      else roof = 'flat';
    }
    // --- era
    const year = parseYear(t) ?? (parent ? parseYear(parent.tags) : undefined);
    let era: Era;
    if (year) era = eraOfYear(year);
    else {
      const cellKey = `${Math.floor(rb.c[0] / 160)},${Math.floor(rb.c[1] / 160)}`;
      const nR = rng(hashString(cellKey) ^ ctx.seed);
      const pri = [...(ERA_PRIORS[region] ?? ERA_PRIORS.midwest)];
      // neighbourhood bias: shift weights toward one era per cell
      const bias = Math.floor(nR() * 5);
      pri[bias] += 0.35;
      if ((use === 'commercial' || use === 'mixed-use' || use === 'civic' || use === 'religious') && dens > 0.35 && levels <= 5) { pri[0] += 0.25; pri[1] += 0.6; }
      if (levels >= 12) { pri[0] = 0; pri[1] *= region === 'northeast' || region === 'midwest' ? 1.2 : 0.3; pri[3] += 0.4; pri[4] += 0.4; }
      if (use === 'office' && levels >= 5) { pri[3] += 0.3; pri[4] += 0.3; }
      if (rb.area > 5000 && levels <= 2) { pri[0] = 0; pri[1] *= 0.3; pri[3] += 0.3; pri[4] += 0.2; }
      if (use === 'residential-multi' && levels >= 4 && region !== 'northeast') { pri[4] += 0.5; }
      if (roof === 'flat' && use === 'residential-single') { pri[2] += 0.2; pri[3] += 0.2; }
      // tight-lot neighbourhoods near dense cores are streetcar-era; sparse ones are post-war
      if (use === 'residential-single' || use === 'residential-multi') {
        if (dens > 0.35) { pri[0] += 0.45; pri[1] += 0.8; pri[2] *= 0.6; pri[3] *= 0.6; }
        else if (dens > 0.2) { pri[0] += 0.25; pri[1] += 0.6; }
        else if (dens < 0.1) { pri[2] += 0.3; pri[3] += 0.3; pri[4] += 0.15; }
      }
      era = pickEra(pri, R());
    }

    // --- roof height
    let roofHeight = 0;
    const roofHTag = parseLength(t['roof:height']);
    if (roof !== 'flat') {
      const pitchDeg = roof === 'shed' ? 12 : era === 'pre-1900' ? 42 : era === '1900-1939' ? 34 : era === '1940-1969' ? 22 : 28;
      const span = roof === 'shed' ? box.wid : box.wid / 2;
      roofHeight = roofHTag ?? (roofLevels > 0 ? roofLevels * 2.6 : span * Math.tan((pitchDeg * Math.PI) / 180));
      if (roof === 'dome') roofHeight = roofHTag ?? box.wid * 0.45;
      if (roof === 'mansard') roofHeight = roofHTag ?? Math.min(3.5, box.wid * 0.25);
      roofHeight = Math.max(0.8, Math.min(roofHeight, roof === 'dome' || roof === 'pyramid' ? 30 : 9));
    }
    let height: number;
    if (hTag) {
      height = roof === 'flat' ? hTag : Math.max(2.4, hTag - roofHeight);
      if (hTag < roofHeight + 2.4 && roof !== 'flat') roofHeight = Math.max(0.5, hTag - 2.4);
    } else {
      height = levels * floorH + (use === 'commercial' || use === 'mixed-use' || use === 'office' ? 0.9 : 0.3);
      if (use === 'religious' && !t['building:levels']) height = Math.min(14, 7 + Math.sqrt(rb.area) * 0.15);
      if (small) height = Math.min(height, 3.2);
      if (bType === 'roof') height = Math.max((minHeight ?? 3.8) + 0.6, 5);
    }
    if (minHeight != null && minHeight >= height) minHeight = undefined;

    // --- style
    const useGroup = use === 'residential-single' ? 'rs' : use === 'residential-multi' ? 'rm' : use === 'commercial' || use === 'mixed-use' || use === 'office' ? 'c' : use;
    const famKey = `${Math.floor(rb.c[0] / 90)},${Math.floor(rb.c[1] / 90)}|${useGroup}|${era}`;
    const style = resolveStyle({
      region, climate, era, use, levels, area: rb.area, roof, density: dens,
      familySeed: hashString(famKey) ^ ctx.seed, seed, tags: t, amenity: t.amenity, urban: ctx.urban(rb.c[0], rb.c[1]), locale,
    });
    if (style.kit === 'victorian' && roof === 'flat' && use === 'residential-single' && !shapeTag) roof = 'gable';
    // Creole cottages / shotguns: steep side or front gables
    if (locale === 'creole' && (style.kit === 'colonial' || style.kit === 'victorian') && roof === 'flat' && !shapeTag) roof = 'gable';
    if (roof !== 'flat' && roofHeight === 0) {
      const pitchDeg = era === 'pre-1900' ? 42 : 34;
      roofHeight = Math.max(0.8, Math.min(9, (box.wid / 2) * Math.tan((pitchDeg * Math.PI) / 180)));
      if (!hTag) height = Math.max(2.4, height);
    }

    // --- storefront / signage
    const shopPois = myPois.filter((p) => p.kind === 'shop' || p.kind === 'food' || (p.kind === 'service' && p.cat));
    const storefront = (use === 'commercial' || use === 'mixed-use') && (shopPois.length > 0 || (dens > 0.4 && levels <= 6 && style.kit === 'main-street-block' && R() < 0.6)) && !small;
    let signage: string | undefined;
    if (storefront) {
      const named = shopPois.find((p) => p.cat) ?? myPois.find((p) => p.cat);
      signage = named?.cat ?? undefined;
    } else if (use === 'commercial' && myPois.find((p) => p.cat)) signage = myPois.find((p) => p.cat)!.cat!;

    // --- street edges
    const streetEdges: number[] = [];
    const ring = rb.outer;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz); if (L < 2.5) continue;
      const nx = -dz / L, nz = dx / L; // outward for CCW-from-above rings
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      let hit = false;
      for (const k of roads.grid.query(mx - 30, mz - 30, mx + 30, mz + 30)) {
        const s = roads.segs[k];
        const cls = s.info.road.cls;
        if (!PUBLIC_STREET.has(cls) && cls !== 'pedestrian' && !(cls === 'service' && s.info.service !== 'parking_aisle' && s.info.service !== 'driveway')) continue;
        // closest point
        const sx = s.b[0] - s.a[0], sz = s.b[1] - s.a[1];
        const l2 = sx * sx + sz * sz;
        let tt = l2 > 0 ? ((mx - s.a[0]) * sx + (mz - s.a[1]) * sz) / l2 : 0; tt = Math.max(0, Math.min(1, tt));
        const qx = s.a[0] + tt * sx - mx, qz = s.a[1] + tt * sz - mz;
        const d = Math.hypot(qx, qz);
        if (d - s.half > 13 || d < 0.01) continue;
        if ((qx * nx + qz * nz) / d > 0.55) { hit = true; break; }
      }
      if (hit) streetEdges.push(i);
    }

    // --- base
    let baseY = Infinity;
    for (const p of ring) baseY = Math.min(baseY, heightAt(p[0], p[1]));
    baseY = Math.min(baseY, heightAt(rb.c[0], rb.c[1]));

    const sensitive = /^(school|kindergarten|hospital|place_of_worship)$/.test(t.amenity ?? '') || /^(school|kindergarten|hospital)$/.test(bType) || use === 'hospital' || use === 'religious'
      || t.historic === 'memorial' || zs.some((z) => z === 'school' || z === 'kindergarten' || z === 'hospital' || z === 'place_of_worship' || z === 'memorial');

    const b: RecipeBuilding = {
      id: rb.id,
      footprint: ring.map((p) => [r2(p[0]), r2(p[1])] as Vec2),
      baseY: r2(baseY), height: r2(height), roofHeight: r2(roofHeight), levels,
      roof: { type: roof, material: style.roofMaterial, color: style.roofColor },
      use, era, kit: style.kit, material: style.material, color: style.color, seed, storefront, streetEdges,
    };
    if (roof !== 'flat') b.roof.orientation = +(((box.angle % Math.PI) + Math.PI) % Math.PI).toFixed(4);
    if (rb.holes.length) b.holes = rb.holes.map((h) => h.map((p) => [r2(p[0]), r2(p[1])] as Vec2));
    if (minHeight != null) b.minHeight = r2(minHeight);
    if (t.name) b.name = t.name;
    if (signage) b.signage = signage;
    if (sensitive) { b.sensitive = true; sensitivePts.push({ p: rb.c, ring }); }
    buildings.push(b);
  }
  const grid = new GridIndex<number>(32);
  buildings.forEach((b, i) => { const bb = bbox(b.footprint); grid.insert(i, bb.minX, bb.minZ, bb.maxX, bb.maxZ); });
  // sensitive grounds (school yards etc.) also count for camera exclusion
  for (const z of zones) if (/^(school|kindergarten|hospital|place_of_worship|memorial)$/.test(z.kind)) sensitivePts.push({ p: centroid(z.ring), ring: z.ring });
  return { buildings, grid, sensitivePts };
}

export function insideBuilding(x: number, z: number, res: BuildResult, margin = 0): boolean {
  for (const i of res.grid.near(x, z, margin + 0.5)) {
    const b = res.buildings[i];
    if (b.minHeight && b.minHeight > 2.5) continue; // overhangs/canopies don't block the ground
    if (pointInPoly(x, z, b.footprint, b.holes)) return true;
    if (margin > 0 && distToRing(x, z, b.footprint) < margin) return true;
  }
  return false;
}
