// Controls reference (modal and embeddable).
import { h, btn } from './dom';

const K = (...keys: string[]) => h('span', {}, ...keys.map((k) => h('kbd', {}, k)));

export function controlsGrid(): HTMLElement {
  const row = (label: string, ...keys: string[]) => h('div', { class: 'k' }, h('span', {}, label), K(...keys));
  return h('div', { class: 'gt-keys' },
    h('h3', {}, 'On foot'),
    row('Move', 'W', 'A', 'S', 'D'), row('Look', 'Mouse'),
    row('Sprint', 'Shift'), row('Jump', 'Space'),
    row('Enter / exit vehicle', 'F'), row('Crouch (toggle)', 'C'),
    row('Walk (toggle)', 'X'), row('Punch / shove', 'Left click'), row('Zoom', 'Wheel'),
    h('h3', {}, 'Takedown'),
    row('Disable camera (hold)', 'E'), row('Cut down pole (hold)', 'R'),
    row('Camera map', 'M'), row('Camera map (alt)', 'Tab'),
    h('h3', {}, 'Driving'),
    row('Throttle / brake', 'W', 'S'), row('Steer', 'A', 'D'),
    row('Handbrake', 'Space'), row('Horn', 'H'),
    row('Look back', 'V'), row('Flip / reset car', 'R'),
    h('h3', {}, 'System'),
    row('Pause / settings', 'Esc'), row('Capture mouse', 'Click'),
  );
}

export function showControls(): void {
  const wrap = h('div', { class: 'gt-modal-wrap' });
  const close = () => { wrap.remove(); removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopPropagation(); close(); } };
  addEventListener('keydown', onKey, true);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.append(h('div', { class: 'gt-modal gt-glass' }, h('h2', {}, 'Controls'), controlsGrid(), h('div', { style: 'margin-top:22px;text-align:right' }, btn('Close', close))));
  document.body.appendChild(wrap);
}
