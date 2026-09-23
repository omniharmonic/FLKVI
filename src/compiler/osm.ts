// OWNER: compiler agent. Overpass fetching + OSM element indexing + multipolygon assembly.
export type Tags = Record<string, string>;
export interface OsmNode { id: number; lat: number; lon: number; tags?: Tags }
export interface OsmWay { id: number; nodes: number[]; tags?: Tags }
export interface OsmRel { id: number; members: { type: 'node' | 'way' | 'relation'; ref: number; role: string }[]; tags?: Tags }
export interface OsmData { nodes: Map<number, OsmNode>; ways: Map<number, OsmWay>; rels: Map<number, OsmRel> }

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function buildQuery(s: number, w: number, n: number, e: number): string {
  const bb = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
  return `[out:json][timeout:120][maxsize:536870912][bbox:${bb}];
(
  way[highway];
  way[building]; relation[building][type=multipolygon];
  way["building:part"]; relation["building:part"][type=multipolygon];
  way[landuse]; relation[landuse][type=multipolygon];
  way[leisure]; relation[leisure][type=multipolygon];
  way[natural]; relation[natural][type=multipolygon];
  way[amenity]; relation[amenity][type=multipolygon];
  way[waterway]; relation[waterway];
  way[water]; way[place=square]; way["area:highway"];
  way[barrier~"^(fence|hedge|wall|retaining_wall)$"];
  node[natural=tree];
  node[highway~"^(street_lamp|traffic_signals|stop|give_way|crossing|bus_stop)$"];
  node[amenity]; node[shop]; node[office]; node[craft]; node[tourism]; node[emergency=fire_hydrant];
  node[barrier=bollard]; node[public_transport=platform]; node[man_made=utility_pole]; node[power=pole];
  node[leisure=picnic_table];
);
out body;
>;
out skel qt;`;
}

export interface FetchOpts { userAgent?: string; timeoutMs?: number; onStatus?: (msg: string) => void; signal?: AbortSignal }

export async function fetchOverpass(query: string, opts: FetchOpts = {}): Promise<any> {
  let lastErr: unknown = null;
  // Round-robin over mirrors; a busy (429/504) or failing mirror hands off to the next immediately.
  for (let round = 0; round < 3; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 3000 * round));
    for (const url of OVERPASS_ENDPOINTS) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 150000);
      const onAbort = () => ctl.abort();
      opts.signal?.addEventListener('abort', onAbort);
      const host = new URL(url).host;
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (opts.userAgent) headers['User-Agent'] = opts.userAgent;
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers, signal: ctl.signal });
        if (!res.ok) {
          lastErr = new Error(`Overpass HTTP ${res.status} at ${host}`);
          opts.onStatus?.(res.status === 429 || res.status === 504 ? `Map server busy (${host}), trying another` : `Map server error ${res.status} (${host}), trying another`);
          continue;
        }
        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) { lastErr = new Error('Overpass returned no elements'); continue; }
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) { lastErr = new Error(`Overpass: ${json.remark}`); opts.onStatus?.(`Map server overloaded (${host}), trying another`); continue; }
        return json;
      } catch (e) {
        if (opts.signal?.aborted) throw new Error('Cancelled');
        lastErr = e;
        opts.onStatus?.(`Map server unreachable (${host}), trying another`);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
    }
  }
  throw new Error(`Could not reach OpenStreetMap (Overpass): ${(lastErr as Error)?.message ?? lastErr}`);
}

export function indexOsm(json: any): OsmData {
  const nodes = new Map<number, OsmNode>(), ways = new Map<number, OsmWay>(), rels = new Map<number, OsmRel>();
  for (const el of json.elements as any[]) {
    if (el.type === 'node') {
      const prev = nodes.get(el.id);
      if (!prev || (!prev.tags && el.tags)) nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon, tags: el.tags ?? prev?.tags });
    } else if (el.type === 'way') {
      const prev = ways.get(el.id);
      if (!prev || (!prev.tags && el.tags)) ways.set(el.id, { id: el.id, nodes: el.nodes, tags: el.tags ?? prev?.tags });
    } else if (el.type === 'relation') {
      const prev = rels.get(el.id);
      if (!prev || (!prev.tags && el.tags)) rels.set(el.id, { id: el.id, members: el.members ?? [], tags: el.tags ?? prev?.tags });
    }
  }
  return { nodes, ways, rels };
}

/** Assemble multipolygon member ways into closed rings of node ids. */
export function assembleRings(wayIds: number[], data: OsmData): number[][] {
  const segs: number[][] = [];
  for (const id of wayIds) {
    const w = data.ways.get(id);
    if (w && w.nodes.length >= 2) segs.push(w.nodes.slice());
  }
  const rings: number[][] = [];
  while (segs.length) {
    let ring = segs.shift()!;
    let guard = 0;
    while (ring[0] !== ring[ring.length - 1] && guard++ < 1000) {
      const end = ring[ring.length - 1];
      let found = -1, rev = false;
      for (let i = 0; i < segs.length; i++) {
        if (segs[i][0] === end) { found = i; break; }
        if (segs[i][segs[i].length - 1] === end) { found = i; rev = true; break; }
      }
      if (found < 0) break;
      const s = segs.splice(found, 1)[0];
      if (rev) s.reverse();
      ring = ring.concat(s.slice(1));
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

export function multipolygonRings(rel: OsmRel, data: OsmData) {
  const outerIds = rel.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.ref);
  const innerIds = rel.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => m.ref);
  return { outers: assembleRings(outerIds, data), inners: assembleRings(innerIds, data) };
}

/** Parse a length like "12", "12 m", "40'", "40 ft", "12'6\"" → meters. */
export function parseLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase().replace(',', '.');
  const ftIn = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  if (ftIn) return parseFloat(ftIn[1]) * 0.3048 + (ftIn[2] ? parseFloat(ftIn[2]) * 0.0254 : 0);
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|meters?|ft|feet|foot|mi)?$/);
  if (!m) { const n = parseFloat(s); return isFinite(n) ? n : undefined; }
  const n = parseFloat(m[1]);
  if (m[2] === 'ft' || m[2] === 'feet' || m[2] === 'foot') return n * 0.3048;
  return n;
}

export function parseNum(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = parseFloat(v.split(';')[0]);
  return isFinite(n) ? n : undefined;
}
