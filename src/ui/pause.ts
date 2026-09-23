// Pause menu: Resume / Settings / Controls / Credits / Quit to map.
import type { Game } from '../core/game';
import * as render from '../render';
import { h, uiRoot, fmt, fmtTime } from './dom';
import { controlsGrid } from './controls';
import { settings, saveSettings } from './settings';
import { sfx } from '../audio/sfx';
import { runStats } from './runstats';

type Section = 'run' | 'settings' | 'controls' | 'credits';

export function openPause(g: Game, onResume: () => void): { close(): void; el: HTMLElement } {
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
      h('div', { class: 'logo', html: 'GROUNDTRUTH<span class="dot">.</span>' }),
      h('div', { class: 'where' }, `PAUSED · ${(g.recipe?.name ?? '').toUpperCase()}`),
      item('resume', 'Resume', () => onResume()),
      item('run', 'Current run', () => show('run')),
      item('settings', 'Settings', () => show('settings')),
      item('controls', 'Controls', () => show('controls')),
      item('credits', 'Credits', () => show('credits')),
      item('quit', 'Quit to map', () => { location.href = location.pathname; }),
    ),
    content,
  );
  uiRoot().appendChild(el);
  show('run');
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
  // settings
  const row = (label: string, input: HTMLElement, val?: HTMLElement) => h('div', { class: 'gt-set' }, h('label', {}, label), input, val ?? h('span'));
  const slider = (label: string, min: number, max: number, step: number, value: number, fmtV: (v: number) => string, on: (v: number) => void) => {
    const v = h('span', { class: 'v' }, fmtV(value));
    const i = h('input', { type: 'range', min, max, step, value });
    i.addEventListener('input', () => { const x = parseFloat(i.value); v.textContent = fmtV(x); on(x); });
    return row(label, i, v);
  };
  const opts = <T extends string>(label: string, list: T[], cur: T, on: (v: T) => void) => {
    const wrap = h('div', { class: 'opts' });
    const paint = (c: T) => wrap.replaceChildren(...list.map((o) => h("button", { class: o === c ? "on" : "", onclick: () => { sfx("ui-click"); on(o); paint(o); } }, o)));
    paint(cur);
    return row(label, wrap);
  };
  const skyTime = (() => { try { return g.sky?.time ?? 12; } catch { return 12; } })();
  return [h('h2', {}, 'Settings'),
    opts('Graphics quality', (['low', 'medium', 'high'] as ('low' | 'medium' | 'high')[]), g.quality ?? settings.quality, (q) => {
      g.quality = q; saveSettings({ quality: q });
      try { (render as any).setQuality?.(g, q); } catch (e) { console.warn(e); }
    }),
    slider('Time of day', 0, 24, 0.25, skyTime, (v) => `${String(Math.floor(v) % 24).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`, (v) => { try { if (g.sky) g.sky.time = v; } catch { /* */ } }),
    slider('Mouse sensitivity', 0.2, 3, 0.05, settings.mouseSensitivity, (v) => `${v.toFixed(2)}×`, (v) => saveSettings({ mouseSensitivity: v })),
    opts('Invert Y', ['off', 'on'], settings.invertY ? 'on' : 'off', (v) => saveSettings({ invertY: v === 'on' })),
    slider('Master volume', 0, 1, 0.01, settings.volume, (v) => `${Math.round(v * 100)}%`, (v) => saveSettings({ volume: v })),
    slider('Music volume', 0, 1, 0.01, settings.musicVolume, (v) => `${Math.round(v * 100)}%`, (v) => saveSettings({ musicVolume: v })),
  ];
}

function credits(g: Game): HTMLElement {
  const lic = h('ul', {}, h('li', { style: 'color:var(--muted)' }, 'Loading asset licenses…'));
  const el = h('div', { class: 'gt-credits' },
    h('h3', {}, 'Map data'),
    h('p', { html: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, available under the <a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noopener">Open Database License (ODbL)</a>. This world is a derived database built from OSM data. Terrain: AWS Terrain Tiles (Mapzen / USGS / SRTM and others). Location-picker base map tiles &copy; Esri (or CARTO when configured).' }),
    h('h3', {}, 'This world'),
    h('ul', {}, ...((g.recipe?.attribution?.length ? g.recipe.attribution : ['OpenStreetMap contributors']).map((a) => h('li', {}, a)))),
    h('h3', {}, 'Assets (CC0 and other open licenses)'), lic,
    h('h3', {}, 'Software'),
    h('p', {}, 'Three.js, postprocessing, N8AO, Rapier, ez-tree, Leaflet. Fonts: Inter, JetBrains Mono (OFL). Sound effects and music are synthesized procedurally in the browser unless listed above.'),
    h('h3', {}, 'Disclaimer'),
    h('p', {}, 'Groundtruth is a work of fiction set in real places. No real brands, agencies or insignia are depicted. Don’t do this in real life.'),
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
