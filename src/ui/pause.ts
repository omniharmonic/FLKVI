// Pause menu: Resume / Settings / Controls / Credits / Quit to map.
import type { Game } from '../core/game';
import { h, uiRoot, fmt, fmtTime } from './dom';
import { controlsGrid } from './controls';
import { settingsRows } from './settingsPanel';
import { sfx } from '../audio/sfx';
import { runStats } from './runstats';

type Section = 'run' | 'settings' | 'controls' | 'credits';

export function openPause(g: Game, onResume: () => void, extra?: { photo?: () => void }): { close(): void; el: HTMLElement } {
  const content = h('div', { class: 'content' });
  const items: Record<string, HTMLElement> = {};
  const item = (id: string, label: string, fn: () => void) => {
    const b = h('button', { class: 'gt-menu-item', onmouseenter: () => sfx('ui-hover'), onclick: () => { sfx('ui-click'); fn(); } }, label);
    items[id] = b; return b;
  };
  const show = (s: Section) => {
    Object.entries(items).forEach(([k, b]) => b.classList.toggle('on', k === s));
    content.replaceChildren(...section(g, s));
  };
  const el = h('div', { class: 'gt-pause' },
    h('div', { class: 'side' },
      h('div', { class: 'logo', html: 'FLK <span class="flk-vi">VI</span>' }),
      h('div', { class: 'where' }, `PAUSED · ${(g.recipe?.name ?? '').toUpperCase()}`),
      item('resume', 'Resume', () => onResume()),
      item('run', 'Current run', () => show('run')),
      item('settings', 'Settings', () => show('settings')),
      ...(extra?.photo ? [item('photo', 'Photo mode', () => extra.photo!())] : []),
      item('controls', 'Controls', () => show('controls')),
      item('credits', 'Credits', () => show('credits')),
      item('quit', 'Quit to map', () => { location.replace(location.pathname); }),
    ),
    content,
  );
  uiRoot().appendChild(el);
  show('run');
  setTimeout(() => items.resume?.focus(), 0);
  return { el, close() { el.remove(); } };
}

function section(g: Game, s: Section): HTMLElement[] {
  if (s === 'run') {
    const sv = g.surveillance;
    const st = runStats(g);
    const stat = (label: string, v: string) => h('div', { class: 'gt-set', style: 'grid-template-columns:1fr auto' }, h('label', {}, label), h('div', { class: 'gt-mono', style: 'font-size:15px' }, v));
    return [h('h2', {}, g.mode === 'freeroam' ? 'Free roam' : 'Current run'),
      ...(g.mode === 'freeroam' ? [h('p', { style: 'color:var(--muted)' }, 'Exploring without a run. Pick “Run again” from the results screen or restart from the map to play Takedown.')] : [
        stat('Streak', String(sv?.streak ?? 0)), stat('Score', fmt(sv?.score ?? 0)), stat('Hot (unbanked)', fmt(sv?.hot ?? 0)), stat('Banked', fmt(sv?.banked ?? 0)),
        stat('Takedowns', `${st.cuts} cut · ${st.disables} disabled`), stat('Time', fmtTime(st.time()))]),
    ];
  }
  if (s === 'controls') return [h('h2', {}, 'Controls'), controlsGrid()];
  if (s === 'credits') return [h('h2', {}, 'Credits & attribution'), credits(g)];
  return [h('h2', {}, 'Settings'), ...settingsRows(g)];
}

function credits(g: Game): HTMLElement {
  const lic = h('ul', {}, h('li', { style: 'color:var(--muted)' }, 'Loading asset licenses…'));
  const el = h('div', { class: 'gt-credits' },
    h('h3', {}, 'Map data'),
    h('p', { html: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, available under the <a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noopener">Open Database License (ODbL) 1.0</a>. This world is a derived database built from OSM data (fetched via the Overpass API) and is itself ODbL-licensed.' }),
    h('h3', {}, 'Terrain'),
    h('p', { html: 'Elevation from <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Terrain Tiles</a> (Mapzen / Tilezen). 3DEP (formerly NED) and NED topobathy courtesy of the U.S. Geological Survey; SRTM courtesy of NASA and USGS; GMTED2010 courtesy of USGS; ETOPO1 courtesy of NOAA. <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Full terrain attribution</a>.' }),
    h('h3', {}, 'Location picker'),
    h('p', { html: 'Base map tiles: Esri World Dark Gray Canvas &mdash; Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community (CARTO basemaps &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> when configured). Place search and reverse geocoding by <a href="https://nominatim.org/" target="_blank" rel="noopener">Nominatim</a>, data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL).' }),
    h('h3', {}, 'This world'),
    h('ul', {}, ...((g.recipe?.attribution?.length ? g.recipe.attribution : ['OpenStreetMap contributors']).map((a) => h('li', {}, a)))),
    h('h3', {}, 'Assets (CC0 1.0 public domain)'),
    h('p', { html: 'Textures, HDRIs and props from <a href="https://polyhaven.com" target="_blank" rel="noopener">Poly Haven</a> and <a href="https://ambientcg.com" target="_blank" rel="noopener">ambientCG</a>; characters and animations by <a href="https://quaternius.com" target="_blank" rel="noopener">Quaternius</a>; vehicles and sound effects by <a href="https://kenney.nl" target="_blank" rel="noopener">Kenney</a>. Everything else is generated procedurally in code.' }),
    lic,
    h('h3', {}, 'Software'),
    h('p', {}, 'Three.js, postprocessing, N8AO, Rapier, ez-tree, Leaflet. Fonts: Inter, JetBrains Mono (OFL). Sound effects and music are synthesized procedurally in the browser unless listed above.'),
    h('h3', {}, 'Disclaimer'),
    h('p', {}, 'FLK VI is a work of fiction set in real places. No real brands, agencies or insignia are depicted. Don’t do this in real life.'),
  );
  fetch(`${import.meta.env.BASE_URL}assets/LICENSES.json`).then((r) => (r.ok ? r.json() : Promise.reject())).then((data) => {
    const entries: any[] = Array.isArray(data) ? data : Array.isArray(data?.assets) ? data.assets : Object.entries(data ?? {}).map(([k, v]) => (typeof v === 'object' ? { id: k, ...(v as object) } : { id: k, license: String(v) }));
    if (!entries.length) { lic.replaceChildren(h('li', {}, 'No downloaded assets listed.')); return; }
    lic.replaceChildren(...entries.map((e) => {
      const name = e.name ?? e.title ?? e.id ?? e.file ?? 'asset';
      const by = e.author ?? e.creator ?? e.source ?? '';
      const url = e.url ?? e.sourceUrl ?? e.link;
      const li = h('li', {}, url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, name) : name, by ? ` — ${by}` : '', h('span', { class: 'lic' }, e.license ?? ''));
      return li;
    }));
  }).catch(() => lic.replaceChildren(h('li', { style: 'color:var(--muted)' }, 'Asset license manifest not available.')));
  return el;
}
