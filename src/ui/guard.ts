// Unsupported-device guard: WebGL2 + a keyboard/mouse desktop browser are required. `?force` bypasses.
import { h, uiRoot } from './dom';

export function unsupportedReason(): string | null {
  const q = new URLSearchParams(location.search);
  if (q.has('force')) return null;
  // WebGL2
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return 'webgl';
    try { (gl.getExtension('WEBGL_lose_context') as any)?.loseContext(); } catch { /* */ }
  } catch { return 'webgl'; }
  // Phones / tablets / touch-only devices
  const ua = navigator.userAgent || '';
  const mobileUA = /Android|iPhone|iPod|Mobile|Windows Phone|webOS|BlackBerry/i.test(ua) || (navigator as any).userAgentData?.mobile === true;
  let touchOnly = false;
  try { touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches; } catch { /* */ }
  const iPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1 && !matchMedia('(any-pointer: fine)').matches;
  if (mobileUA || touchOnly || iPadOS) return 'device';
  return null;
}

export function showUnsupported(reason: string): void {
  const detail = reason === 'webgl'
    ? 'This browser can’t create a WebGL 2 context. Update your browser or enable hardware acceleration, then reload.'
    : 'It’s a real-time 3D game played with WASD and a mouse, and it needs the memory and GPU of a desktop or laptop.';
  const el = h('div', { class: 'gt-unsupported', role: 'alert' },
    h('div', { class: 'box' },
      h('div', { class: 'logo', html: 'GROUNDTRUTH<span class="dot">.</span>' }),
      h('h1', {}, 'Groundtruth needs a desktop browser with a keyboard and mouse'),
      h('p', {}, detail),
      h('p', { class: 'dim' }, 'Open this page on a computer running a recent Chrome, Edge, Firefox or Safari.'),
      h('div', { class: 'url' }, location.host + location.pathname),
      h('a', { class: 'force', href: `${location.pathname}?force` }, 'Try anyway'),
    ));
  uiRoot().appendChild(el);
}
