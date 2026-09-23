// Tiny DOM helpers for the vanilla UI.
import { sfx } from '../audio/sfx';

export function uiRoot(): HTMLElement {
  let r = document.getElementById('ui-root');
  if (!r) { r = document.createElement('div'); r.id = 'ui-root'; document.body.appendChild(r); }
  return r;
}

type Attrs = Record<string, string | number | boolean | ((e: any) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as any);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid as any);
  return el;
}

/** Button with UI click/hover sounds. */
export function btn(label: string | Node, onClick: () => void, cls = 'gt-btn'): HTMLButtonElement {
  const b = h('button', { class: cls, onclick: () => { sfx('ui-click'); onClick(); }, onmouseenter: () => sfx('ui-hover') }, label);
  return b;
}

export function safe<T>(fn: () => T, fallback: T): T {
  try { const v = fn(); return v === undefined || v === null || (typeof v === 'number' && !isFinite(v)) ? fallback : v; } catch { return fallback; }
}

export function fmt(n: number): string { return Math.round(n).toLocaleString('en-US'); }

export function fmtTime(s: number): string {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60), ss = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

export const ICON = {
  cam: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h11l3 3v4l-3 3H3z"/><circle cx="9" cy="12" r="2.2"/><path d="M17 10l4-2v8l-4-2"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>`,
};
