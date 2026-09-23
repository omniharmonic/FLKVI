// Overhead status icons for NPCs ("?" noticed, phone = calling police, "!" fleeing).
import * as THREE from 'three';

export type IconKind = 'notice' | 'phone' | 'alarm' | 'film' | 'shout';

const mats = new Map<IconKind, THREE.SpriteMaterial>();

function drawSpecial(kind: 'film' | 'shout'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  const x = c.getContext('2d')!;
  if (kind === 'film') {
    // recording badge: dark pill, red dot, "REC"
    c.width = 256; c.height = 128;
    x.fillStyle = 'rgba(12,12,14,0.82)';
    x.beginPath(); x.roundRect(8, 24, 240, 80, 40); x.fill();
    x.lineWidth = 5; x.strokeStyle = 'rgba(255,60,60,0.9)'; x.stroke();
    x.fillStyle = '#ff2a2a';
    x.beginPath(); x.arc(60, 64, 22, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#fff'; x.font = 'bold 54px system-ui, sans-serif'; x.textBaseline = 'middle';
    x.fillText('REC', 96, 66);
  } else {
    // speech bubble: "STOP! POLICE!"
    c.width = 256; c.height = 128;
    x.fillStyle = '#f4f6fa';
    x.beginPath(); x.roundRect(6, 10, 244, 82, 22); x.fill();
    x.beginPath(); x.moveTo(104, 90); x.lineTo(140, 90); x.lineTo(112, 122); x.closePath(); x.fill();
    x.lineWidth = 5; x.strokeStyle = '#1b2233'; x.beginPath(); x.roundRect(6, 10, 244, 82, 22); x.stroke();
    x.fillStyle = '#1b2233'; x.font = '900 40px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('STOP! POLICE!', 128, 53);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function draw(kind: IconKind): THREE.CanvasTexture {
  if (kind === 'film' || kind === 'shout') return drawSpecial(kind);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  x.clearRect(0, 0, 128, 128);
  // badge
  x.beginPath();
  x.arc(64, 60, 50, 0, Math.PI * 2);
  x.fillStyle = kind === 'phone' ? '#d8342c' : kind === 'alarm' ? '#f08a24' : '#f2c230';
  x.fill();
  x.lineWidth = 7;
  x.strokeStyle = 'rgba(0,0,0,0.55)';
  x.stroke();
  // pointer
  x.beginPath();
  x.moveTo(50, 104); x.lineTo(78, 104); x.lineTo(64, 124); x.closePath();
  x.fill();
  x.fillStyle = '#fff';
  if (kind === 'phone') {
    // handset glyph
    x.save();
    x.translate(64, 60);
    x.rotate(-0.6);
    x.beginPath();
    x.roundRect(-10, -30, 20, 60, 8);
    x.fill();
    x.fillRect(-20, -32, 22, 16);
    x.fillRect(-20, 16, 22, 16);
    x.restore();
    // signal waves
    x.strokeStyle = '#fff';
    x.lineWidth = 6;
    for (const r of [18, 30]) {
      x.beginPath();
      x.arc(78, 42, r, -1.2, 0.1);
      x.stroke();
    }
  } else {
    x.font = 'bold 84px system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = '#1a1a1a';
    x.fillText(kind === 'notice' ? '?' : '!', 64, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function iconMaterial(kind: IconKind): THREE.SpriteMaterial {
  let m = mats.get(kind);
  if (!m) {
    m = new THREE.SpriteMaterial({ map: draw(kind), depthTest: false, depthWrite: false, transparent: true, fog: false, toneMapped: false });
    mats.set(kind, m);
  }
  return m;
}

/** A sprite that can switch between icon kinds (or hide). */
export class Icon {
  readonly sprite: THREE.Sprite;
  kind: IconKind | null = null;
  constructor() {
    this.sprite = new THREE.Sprite(iconMaterial('notice'));
    this.sprite.scale.set(0.55, 0.55, 1);
    this.sprite.renderOrder = 999;
    this.sprite.visible = false;
  }
  set(kind: IconKind | null) {
    if (kind === this.kind) return;
    this.kind = kind;
    if (!kind) { this.sprite.visible = false; return; }
    this.sprite.material = iconMaterial(kind);
    const wide = kind === 'film' || kind === 'shout';
    this.sprite.scale.set(wide ? (kind === 'shout' ? 1.5 : 0.8) : 0.55, wide ? (kind === 'shout' ? 0.75 : 0.4) : 0.55, 1);
    this.sprite.visible = true;
  }
}
