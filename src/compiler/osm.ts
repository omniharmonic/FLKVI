// OWNER: compiler agent. Overpass fetching + OSM element indexing + multipolygon assembly.
export type Tags = Record<string, string>;
export interface OsmNode { id: number; lat: number; lon: number; tags?: Tags }
export interface OsmWay { id: number; nodes: number[]; tags?: Tags }
export interface OsmRel { id: number; members: { type: 'node' | 'way' | 'relation'; ref: number; role: string }[]; tags?: Tags }
export interface OsmData { nodes: Map<number, OsmNode>; ways: Map<number, OsmWay>; rels: Map<number, OsmRel> }

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface QueryOpts {
  /** Only the tag values the compiler actually reads (smaller, faster responses). Used for live compiles. */
  lean?: boolean;
  /** Server-side timeout (s) and memory cap (bytes). */
  timeoutS?: number; maxBytes?: number;
}

export function buildQuery(s: number, w: number, n: number, e: number, o: QueryOpts = {}): string {
  const bb = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
  const head = `[out:json][timeout:${o.timeoutS ?? 120}][maxsize:${o.maxBytes ?? 536870912}][bbox:${bb}];`;
  if (!o.lean) return `${head}
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
  // Lean variant: same features, but only the values areas/buildings/props consume.
  const LU = '^(residential|commercial|retail|industrial|religious|education|institutional|civic_admin|railway|construction|brownfield|forest|grass|meadow|village_green|recreation_ground|flowerbed|farmland|orchard|vineyard|allotments|farmyard|cemetery|reservoir|basin)$';
  const LE = '^(park|garden|recreation_ground|dog_park|common|golf_course|nature_reserve|playground|pitch|track|swimming_pool)$';
  const NA = '^(water|wood|scrub|heath|grassland|wetland|sand|beach|bare_rock|scree|tree_row)$';
  const AM = '^(parking|school|kindergarten|hospital|place_of_worship|university|college|grave_yard|clinic)$';
  return `${head}
(
  way[highway][highway!~"^(proposed|construction|abandoned|platform|raceway|corridor|elevator|bus_stop|rest_area|services|escape|emergency_bay|bus_guideway|via_ferrata|no|disused|razed)$"];
  way[building]; relation[building][type=multipolygon];
  way["building:part"]; relation["building:part"][type=multipolygon];
  way[landuse~"${LU}"]; relation[landuse~"${LU}"][type=multipolygon];
  way[leisure~"${LE}"]; relation[leisure~"${LE}"][type=multipolygon];
  way[natural~"${NA}"]; relation[natural~"${NA}"][type=multipolygon];
  way[amenity~"${AM}"]; relation[amenity~"${AM}"][type=multipolygon];
  way[waterway~"^(river|stream|canal|ditch|drain|brook|tidal_channel|riverbank|dock)$"];
  way[water]; way[place=square]; way["area:highway"];
  way[barrier~"^(fence|hedge|wall|retaining_wall)$"];
  node[natural=tree];
  node[highway~"^(street_lamp|traffic_signals|stop|give_way|crossing|bus_stop)$"];
  node[amenity]; node[shop]; node[office]; node[craft]; node[tourism~"^(hotel|motel|hostel|guest_house|gallery|museum)$"];
  node[emergency=fire_hydrant]; node[barrier=bollard]; node[public_transport=platform]; node[man_made=utility_pole]; node[power=pole];
  node[leisure~"^(picnic_table|fitness_centre)$"];
);
out body qt;
>;
out skel qt;`;
}

export interface FetchOpts {
  userAgent?: string;
  /** Per-request client timeout (ms). */
  timeoutMs?: number;
  /** Human-readable status lines (mirror switches, retries). */
  onStatus?: (msg: string) => void;
  /** Bytes received so far on the winning request (for progress bars). */
  onBytes?: (bytes: number) => void;
  signal?: AbortSignal;
  /** Start a second mirror if the first hasn't sent a byte after this long (ms). 0 = never. */
  hedgeMs?: number;
  rounds?: number;
}

type FailKind = 'busy' | 'error' | 'net' | 'cancel';
class OverpassFail extends Error {
  kind: FailKind; retryAfterS: number;
  constructor(msg: string, kind: FailKind, retryAfterS = 0) { super(msg); this.kind = kind; this.retryAfterS = retryAfterS; }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new OverpassFail('Cancelled', 'cancel')); }, { once: true });
});

/** One POST to one mirror, streaming the body (reports bytes). */
async function overpassOnce(url: string, query: string, opts: FetchOpts, ctl: AbortController, onFirstByte: () => void): Promise<any> {
  const host = new URL(url).host;
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 150000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (opts.userAgent) headers['User-Agent'] = opts.userAgent;
    let res: Response;
    try { res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers, signal: ctl.signal }); }
    catch (e) { throw new OverpassFail(ctl.signal.aborted ? `timed out at ${host}` : `unreachable (${host})`, ctl.signal.aborted ? 'busy' : 'net'); }
    if (res.status === 429 || res.status === 504 || res.status === 503 || res.status === 502) {
      const ra = parseFloat(res.headers.get('retry-after') ?? '') || 0;
      throw new OverpassFail(`HTTP ${res.status} at ${host}`, 'busy', ra);
    }
    if (!res.ok) throw new OverpassFail(`HTTP ${res.status} at ${host}`, res.status === 400 ? 'error' : 'busy');
    let text: string;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = []; let got = 0, lastReport = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got === 0) onFirstByte();
        chunks.push(value); got += value.length;
        if (got - lastReport > 150_000) { lastReport = got; opts.onBytes?.(got); }
      }
      opts.onBytes?.(got);
      const buf = new Uint8Array(got); let o = 0;
      for (const c of chunks) { buf.set(c, o); o += c.length; }
      text = new TextDecoder().decode(buf);
    } else { onFirstByte(); text = await res.text(); }
    let json: any;
    try { json = JSON.parse(text); } catch { throw new OverpassFail(/rate_limited|Too Many/i.test(text) ? `rate limited at ${host}` : `bad response from ${host}`, 'busy'); }
    if (!json || !Array.isArray(json.elements)) throw new OverpassFail(`no elements from ${host}`, 'busy');
    if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new OverpassFail(`${host}: ${json.remark}`, 'busy');
    return json;
  } catch (e) {
    if (e instanceof OverpassFail) throw e;
    if (ctl.signal.aborted) throw new OverpassFail(`timed out at ${host}`, 'busy');
    throw new OverpassFail(`${(e as Error)?.message ?? e} (${host})`, 'net');
  } finally { clearTimeout(timer); }
}

/**
 * Overpass with mirror rotation, hedging and backoff:
 * - tries mirrors in turn; a busy (429/5xx/timeout) or failing mirror hands off to the next immediately;
 * - if the current mirror hasn't started answering after `hedgeMs`, a second mirror races it (first answer wins);
 * - between rounds, backs off (honouring Retry-After, capped) before trying all mirrors again.
 */
export async function fetchOverpass(query: string, opts: FetchOpts = {}): Promise<any> {
  const eps = OVERPASS_ENDPOINTS;
  const rounds = opts.rounds ?? 3;
  let lastErr: OverpassFail | null = null;
  let sawBusy = false, sawNet = false, sawMemory = false, retryAfter = 0;
  for (let round = 0; round < rounds; round++) {
    if (opts.signal?.aborted) throw new Error('Cancelled');
    if (round > 0) {
      const wait = Math.min(20000, Math.max(retryAfter * 1000, (sawBusy ? 5000 : 2000) * round));
      opts.onStatus?.(`Map servers busy — retrying in ${Math.round(wait / 1000)} s`);
      await sleep(wait, opts.signal);
    }
    try {
      return await new Promise<any>((resolve, reject) => {
        const ctls: AbortController[] = [];
        let next = 0, pending = 0, settled = false, receiving = false;
        const order = eps.map((_, i) => eps[(i + round) % eps.length]);
        const finish = (fn: () => void) => { if (settled) return; settled = true; clearInterval(hedge); opts.signal?.removeEventListener('abort', onAbort); for (const c of ctls) c.abort(); fn(); };
        const onAbort = () => finish(() => reject(new OverpassFail('Cancelled', 'cancel')));
        opts.signal?.addEventListener('abort', onAbort);
        const launch = () => {
          if (settled || next >= order.length) return;
          const url = order[next++];
          const ctl = new AbortController(); ctls.push(ctl); pending++;
          if (next > 1) opts.onStatus?.(`Asking another map server (${new URL(url).host})`);
          overpassOnce(url, query, opts, ctl, () => { receiving = true; })
            .then((j) => finish(() => resolve(j)))
            .catch((e: OverpassFail) => {
              if (settled) return;
              pending--;
              lastErr = e;
              if (e.kind === 'busy') { sawBusy = true; retryAfter = Math.max(retryAfter, e.retryAfterS); }
              if (e.kind === 'net') sawNet = true;
              if (/memory|maxsize/i.test(e.message)) sawMemory = true;
              if (next < order.length) launch();
              else if (pending === 0) finish(() => reject(e));
            });
        };
        const hedge = setInterval(() => { if (!receiving && opts.hedgeMs) launch(); }, opts.hedgeMs || 1e9);
        launch();
      });
    } catch (e) {
      if ((e as OverpassFail).kind === 'cancel') throw new Error('Cancelled');
      lastErr = e as OverpassFail;
    }
  }
  if (sawMemory) throw new Error('This area has too much map data to build live right now. Try a spot a little away from the densest downtown, or pick a featured city.');
  if (sawBusy) throw new Error('OpenStreetMap map servers are busy right now. Wait a minute and try again, or pick a featured city.');
  if (sawNet) throw new Error('Could not reach OpenStreetMap — check your connection, or pick a featured city.');
  throw new Error(`OpenStreetMap request failed: ${(lastErr as OverpassFail | null)?.message ?? 'unknown error'}`);
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
