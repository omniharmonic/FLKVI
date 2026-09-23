// Title screen + spawn picker (Leaflet map of the US, Nominatim search, featured baked cities, mode select).
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { SpawnLocation } from '../core/location';
import { h, btn, ICON, uiRoot } from './dom';
import { showControls } from './controls';
import { sfx } from '../audio/sfx';
import { startMenuAmbience } from '../audio';

export interface FeaturedCity { id: string; name: string; lat: number; lon: number; blurb: string }

const FALLBACK: FeaturedCity[] = [
  { id: 'boulder', name: 'Boulder, CO', lat: 40.0176, lon: -105.2797, blurb: 'Pearl Street Mall under the Flatirons. Dense downtown grid, plate readers on every arterial.' },
];
// cities.ts is created by the compiler agent; tolerate its absence.
const cityMods = import.meta.glob('../compiler/cities.ts', { eager: true }) as Record<string, { BAKED_CITIES?: FeaturedCity[] }>;
export function featuredCities(): FeaturedCity[] {
  const list = Object.values(cityMods)[0]?.BAKED_CITIES;
  return Array.isArray(list) && list.length ? list : FALLBACK;
}

/** Last chosen location (for the loading screen / pause menu). */
export let chosen: SpawnLocation | null = null;

type Tier = 'S' | 'A' | 'B';
const TIER_TEXT: Record<Tier, string> = {
  S: 'Hand-baked showcase city. Full detail, curated cameras, instant load.',
  A: 'Live-compiled urban area. Dense OSM data gives good building and street detail.',
  B: 'Live-compiled rural or sparse area. Fewer mapped buildings; more is inferred.',
};

// ---------- Nominatim (≤ 1 request / second, per usage policy) ----------
let lastReq = 0;
let queue: Promise<unknown> = Promise.resolve();
function nominatim(path: string): Promise<any> {
  const p = queue.then(async () => {
    const wait = lastReq + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReq = Date.now();
    const r = await fetch(`https://nominatim.openstreetmap.org/${path}`, { headers: { 'Accept-Language': 'en-US' } });
    if (!r.ok) throw new Error(`Nominatim ${r.status}`);
    return r.json();
  });
  queue = p.catch(() => {});
  return p;
}

function inUSBox(lat: number, lon: number): boolean {
  const boxes = [[24.3, 49.5, -125.0, -66.8], [51, 71.6, -179.9, -129.9], [18.8, 22.4, -160.4, -154.7], [17.8, 18.6, -67.4, -65.2]];
  return boxes.some(([a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d);
}

const STATE_ABBR: Record<string, string> = { Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC', 'Puerto Rico': 'PR' };

function describe(addr: any, fallback: string): { name: string; tier: Tier } {
  if (!addr) return { name: fallback, tier: 'B' };
  const place = addr.city || addr.town || addr.village || addr.hamlet || addr.suburb || addr.county || '';
  const street = addr.road || addr.neighbourhood || addr.suburb || '';
  const st = STATE_ABBR[addr.state] || addr.state || '';
  const name = [street && street !== place ? street : '', place, st].filter(Boolean).join(', ') || fallback;
  const tier: Tier = addr.city || addr.town ? 'A' : 'B';
  return { name, tier };
}

export function showSpawnPicker(): Promise<SpawnLocation> {
  return new Promise((resolve) => {
    const root = uiRoot();
    const cities = featuredCities();
    const el = h('div', { class: 'gt-picker' });
    const mapEl = h('div', { class: 'map' });
    el.append(mapEl, h('div', { class: 'vignette' }));
    root.appendChild(el);

    const map = L.map(mapEl, { zoomControl: false, attributionControl: true, worldCopyJump: true, minZoom: 3, maxZoom: 16, zoomSnap: 0.25 }).setView([39.5, -98.35], 4.25);
    // CARTO dark_all now returns "API KEY REQUIRED" watermarks without a key, so the default is Esri's
    // Dark Gray Canvas (keyless, attribution required). Set VITE_CARTO_KEY to use CARTO dark_all instead.
    const cartoKey = (import.meta.env as any).VITE_CARTO_KEY as string | undefined;
    if (cartoKey) {
      L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?api_key=${cartoKey}`, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd', maxZoom: 19,
      }).addTo(map);
    } else {
      const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
      L.tileLayer(`${esri}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, className: 'gt-tiles',
        attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, and the GIS user community' }).addTo(map);
      L.tileLayer(`${esri}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, className: 'gt-tiles-labels' }).addTo(map);
    }
    L.control.zoom({ position: 'topright' }).addTo(map);
    map.attributionControl.setPrefix(false);

    // ---------- state ----------
    let mode: 'takedown' | 'freeroam' = 'takedown';
    let sel: (SpawnLocation & { tier: Tier; pending?: boolean; error?: string }) | null = null;
    let pin: L.Marker | null = null;
    const pinIcon = L.divIcon({ className: '', html: '<div class="gt-pinmark"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
    const cityIcon = L.divIcon({ className: '', html: '<div class="gt-citymark"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });

    // ---------- panel ----------
    const input = h('input', { type: 'text', placeholder: 'Search any US address or place…', spellcheck: 'false', autocomplete: 'off' });
    const results = h('div', { class: 'gt-results' });
    const cityList = h('div', { class: 'gt-cities' });
    const selBox = h('div', { class: 'gt-sel' });
    const deploy = btn('Deploy', () => finish(), 'gt-btn primary');
    const seg = h('div', { class: 'gt-seg' });
    const segBtn = (m: typeof mode, label: string, sub: string) => {
      const b = h('button', { onclick: () => { sfx('ui-click'); mode = m; renderSeg(); }, onmouseenter: () => sfx('ui-hover') }, label, h('small', {}, sub));
      (b as any)._m = m; return b;
    };
    const segBtns = [segBtn('takedown', 'Takedown', 'Streak run. Get caught, it ends.'), segBtn('freeroam', 'Free roam', 'Explore. No run, no score.')];
    seg.append(...segBtns);
    const renderSeg = () => segBtns.forEach((b) => b.classList.toggle('on', (b as any)._m === mode));
    renderSeg();

    const panel = h('div', { class: 'gt-panel gt-glass' },
      h('div', { class: 'head' },
        h('div', { class: 'logo', html: 'GROUNDTRUTH<span class="dot">.</span>' }),
        h('div', { class: 'sub' }, 'Take down the surveillance grid. Don’t get caught. Pick anywhere in the United States.'),
      ),
      h('div', { class: 'body' },
        h('div', { class: 'gt-search', html: ICON.search }, input, results),
        h('div', { class: 'gt-label' }, 'Featured cities'),
        cityList,
        h('div', { class: 'gt-label', style: 'margin-top:20px' }, 'Or click anywhere on the map'),
      ),
      h('div', { class: 'foot' }, selBox, seg, h('div', { class: 'gt-row' }, deploy, btn('Controls', showControls, 'gt-btn'))),
    );
    el.append(panel, h('div', { class: 'gt-maphint gt-glass', html: 'CLICK MAP TO DROP A PIN · SCROLL TO ZOOM' }));

    const cityBtns: HTMLElement[] = [];
    const missing = new Set<string>();
    for (const c of cities) {
      const b = h('button', { class: 'gt-city', onmouseenter: () => sfx('ui-hover'), onclick: () => { sfx('ui-click'); pickCity(c); } },
        h('div', { class: 'ic', html: ICON.cam }),
        h('div', {}, h('div', { class: 'nm' }, c.name), h('div', { class: 'bl' }, c.blurb)),
        h('span', { class: 'gt-tier S' }, 'S'));
      (b as any)._id = c.id;
      // Baked recipe not shipped yet? Fall back to a live compile at the same spot.
      fetch(`${import.meta.env.BASE_URL}recipes/${c.id}.json`, { method: 'HEAD' }).then((r) => {
        const ct = r.headers.get('content-type') ?? '';
        if (!r.ok || ct.includes('text/html')) { missing.add(c.id); const t = b.querySelector('.gt-tier')!; t.className = 'gt-tier A'; t.textContent = 'A'; if (sel?.baked === c.id) pickCity(c); }
      }).catch(() => {});
      cityBtns.push(b); cityList.append(b);
      L.marker([c.lat, c.lon], { icon: cityIcon }).addTo(map).on('click', () => pickCity(c)).bindTooltip(c.name, { direction: 'top', offset: [0, -8] });
    }

    function renderSel() {
      cityBtns.forEach((b) => b.classList.toggle('sel', !!sel && cities.some((c) => c.id === (b as any)._id && c.lat === sel!.lat && c.lon === sel!.lon)));
      selBox.innerHTML = '';
      if (!sel) {
        selBox.append(h('div', { class: 'ex' }, 'Choose a featured city or drop a pin to generate a world from open map data.'));
        deploy.disabled = true; return;
      }
      selBox.append(
        h('div', {}, h('div', { class: 'nm' }, sel.pending ? 'Locating…' : sel.name), h('div', { class: 'co' }, `${sel.lat.toFixed(4)}°, ${sel.lon.toFixed(4)}°`)),
        h('div', { style: 'text-align:right' }, h('span', { class: `gt-tier ${sel.tier}`, title: 'World quality tier' }, `TIER ${sel.tier}`)),
        h('div', { class: 'ex' }, TIER_TEXT[sel.tier]),
      );
      if (sel.error) selBox.append(h('div', { class: 'err' }, sel.error));
      else if (!sel.baked) selBox.append(h('div', { class: 'warn', html: `<span style="width:14px;flex:none;margin-top:1px">${ICON.bolt}</span><span>Live compile from OpenStreetMap + terrain data. Takes about 20–40 seconds.</span>` }));
      deploy.disabled = !!sel.error || !!sel.pending;
    }

    function setPin(lat: number, lon: number) {
      if (pin) pin.setLatLng([lat, lon]); else pin = L.marker([lat, lon], { icon: pinIcon, zIndexOffset: 1000 }).addTo(map);
    }

    function pickCity(c: FeaturedCity) {
      sel = missing.has(c.id) ? { lat: c.lat, lon: c.lon, name: c.name, tier: 'A' } : { lat: c.lat, lon: c.lon, name: c.name, baked: c.id, tier: 'S' };
      setPin(c.lat, c.lon);
      map.flyTo([c.lat, c.lon], 13, { duration: 1.6 });
      renderSel();
    }

    async function pickPoint(lat: number, lon: number, knownName?: string, addr?: any) {
      sfx('ui-click');
      setPin(lat, lon);
      if (!inUSBox(lat, lon)) {
        sel = { lat, lon, name: 'Outside the United States', tier: 'B', error: 'Groundtruth only covers the United States. Pick a US location.' };
        renderSel(); return;
      }
      if (addr) {
        const d = describe(addr, knownName ?? 'Dropped pin');
        sel = { lat, lon, name: d.name, tier: d.tier };
        renderSel(); return;
      }
      const token = {};
      (pickPoint as any).token = token;
      sel = { lat, lon, name: 'Dropped pin', tier: 'B', pending: true };
      renderSel();
      try {
        const r = await nominatim(`reverse?format=json&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`);
        if ((pickPoint as any).token !== token) return;
        if (r?.address?.country_code && r.address.country_code !== 'us') {
          sel = { lat, lon, name: r.address.country || 'Outside the US', tier: 'B', error: 'Groundtruth only covers the United States. Pick a US location.' };
        } else {
          const d = describe(r?.address, `Dropped pin`);
          sel = { lat, lon, name: d.name, tier: d.tier };
        }
      } catch {
        if ((pickPoint as any).token !== token) return;
        sel = { lat, lon, name: `Pin ${lat.toFixed(3)}, ${lon.toFixed(3)}`, tier: 'A' };
      }
      renderSel();
    }

    map.on('click', (e: L.LeafletMouseEvent) => { if (!titleUp) pickPoint(e.latlng.lat, e.latlng.lng); });

    // ---------- search ----------
    let debounce: number | undefined; let seq = 0;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 3) { results.classList.remove('open'); return; }
      results.innerHTML = ''; results.append(h('div', { class: 'note' }, 'Searching…')); results.classList.add('open');
      debounce = window.setTimeout(async () => {
        const my = ++seq;
        try {
          const list = await nominatim(`search?format=json&countrycodes=us&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`);
          if (my !== seq) return;
          results.innerHTML = '';
          if (!list?.length) results.append(h('div', { class: 'note' }, 'No US results.'));
          for (const r of list ?? []) {
            results.append(h('div', { onclick: () => {
              results.classList.remove('open'); input.value = r.display_name.split(',').slice(0, 3).join(',');
              const lat = +r.lat, lon = +r.lon;
              map.flyTo([lat, lon], 15, { duration: 1.4 });
              pickPoint(lat, lon, r.display_name.split(',')[0], r.address);
            } }, r.display_name));
          }
        } catch {
          if (my === seq) { results.innerHTML = ''; results.append(h('div', { class: 'note' }, 'Search unavailable. Click the map instead.')); }
        }
      }, 650);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') results.classList.remove('open'); if (e.key === 'Enter') (results.querySelector('div:not(.note)') as HTMLElement | null)?.click(); });
    document.addEventListener('click', (e) => { if (!panel.contains(e.target as Node)) results.classList.remove('open'); });

    renderSel();

    // ---------- title overlay ----------
    let titleUp = true;
    const now = new Date();
    const title = h('div', { class: 'gt-title' },
      h('div', { class: 'scan' }),
      h('div', { class: 'rec' }, 'REC'),
      h('div', { class: 'tc', html: `CAM 04 · GRID 7<br>${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 8)}` }),
      h('div', { class: 'kicker' }, 'AN OPEN-WORLD HEIST AGAINST THE GRID'),
      h('h1', { html: 'GROUNDTRUTH<span class="dot">.</span>' }),
      h('div', { class: 'tag' }, 'Take down the surveillance grid. Don’t get caught.'),
      h('div', { class: 'press' }, 'CLICK OR PRESS ANY KEY'),
      h('div', { class: 'foot', html: 'Real US places, built from OpenStreetMap. A work of fiction: no real brands, agencies or insignia.' }),
    );
    el.append(title);
    const tc = title.querySelector('.tc') as HTMLElement;
    const tcTimer = setInterval(() => { const d = new Date(); tc.innerHTML = `CAM 04 · GRID 7<br>${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`; }, 1000);
    // slow cinematic drift
    let drift = true;
    const driftLoop = () => { if (!drift) return; map.panBy([0.35, 0.05], { animate: false }); requestAnimationFrame(driftLoop); };
    requestAnimationFrame(driftLoop);
    panel.style.display = 'none';
    const dismiss = () => {
      if (!titleUp) return;
      titleUp = false; drift = false; clearInterval(tcTimer);
      sfx('ui-click'); startMenuAmbience();
      title.classList.add('out');
      setTimeout(() => title.remove(), 900);
      panel.style.display = '';
      map.flyTo([39.2, -100.5], 4.5, { duration: 1.2 });
      removeEventListener('keydown', onKey);
      setTimeout(() => input.focus(), 900);
    };
    const onKey = (e: KeyboardEvent) => { if (!e.metaKey && !e.ctrlKey) dismiss(); };
    title.addEventListener('click', dismiss);
    addEventListener('keydown', onKey);

    function finish() {
      if (!sel || sel.error || sel.pending) return;
      const loc: SpawnLocation = { lat: sel.lat, lon: sel.lon, name: sel.name, mode };
      if (sel.baked) loc.baked = sel.baked;
      chosen = loc;
      (loc as any).tier = sel.tier;
      el.style.transition = 'opacity .5s'; el.style.opacity = '0';
      setTimeout(() => { map.remove(); el.remove(); }, 550);
      resolve(loc);
    }
  });
}

/** ?autostart[&city=<id>] → skip the picker. */
export function autostartLocation(): SpawnLocation | null {
  const q = new URLSearchParams(location.search);
  if (!q.has('autostart')) return null;
  const id = q.get('city') || 'boulder';
  const c = featuredCities().find((x) => x.id === id);
  const modeQ = q.get('mode');
  const loc: SpawnLocation = c ? { lat: c.lat, lon: c.lon, name: c.name, baked: c.id } : { lat: 40.0176, lon: -105.2797, name: 'Pearl Street, Boulder, CO', baked: id };
  loc.mode = modeQ === 'freeroam' ? 'freeroam' : 'takedown';
  chosen = loc;
  return loc;
}
