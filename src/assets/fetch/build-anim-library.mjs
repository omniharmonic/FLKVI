#!/usr/bin/env node
// OWNER: assets agent. Builds public/assets/models/characters/anims.glb: a skeleton-only glb holding the
// selected clips of Quaternius' Universal Animation Library 1+2 (CC0). Clips bind by bone name, so they drive
// every Universal-Base-Character model (Superhero_Male/Female share the 65-bone UE-style rig).
// Usage: node build-anim-library.mjs UAL1.glb UAL2.glb out.glb
import fs from 'node:fs';

const KEEP = new Set([
  'Idle_Loop', 'Walk_Loop', 'Walk_Formal_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Crouch_Fwd_Loop', 'Crouch_Idle_Loop',
  'Driving_Loop', 'Fixing_Kneeling', 'Interact', 'PickUp_Table', 'Death01', 'Hit_Chest', 'Hit_Head', 'Hit_Knockback',
  'Idle_Talking_Loop', 'Idle_TalkingPhone_Loop', 'Idle_FoldArms_Loop', 'Idle_No_Loop', 'Yes', 'Jump_Start', 'Jump_Loop',
  'Jump_Land', 'Roll', 'Punch_Jab', 'Punch_Cross', 'Pistol_Idle_Loop', 'Pistol_Aim_Neutral', 'Push_Loop',
  'Sitting_Idle_Loop', 'Sitting_Enter', 'Sitting_Exit', 'LayToIdle', 'OverhandThrow', 'Walk_Carry_Loop', 'Dance_Loop',
  'ClimbUp_1m_RM', 'Slide_Loop',
]);

function readGlb(f) {
  const b = fs.readFileSync(f);
  const len = b.readUInt32LE(12);
  return { json: JSON.parse(b.subarray(20, 20 + len).toString()), bin: b.subarray(20 + len + 8) };
}

const [a1, a2, out] = process.argv.slice(2);
const srcs = [readGlb(a1), readGlb(a2)];
const base = srcs[0].json;

// Skeleton nodes (strip mesh + skin so no geometry ships).
const nodes = base.nodes.map((n) => { const c = { ...n }; delete c.mesh; delete c.skin; return c; });
const chunks = []; let offset = 0;
const bufferViews = []; const accessors = [];
const accMap = new Map();
function copyAccessor(src, idx) {
  const key = `${srcs.indexOf(src)}:${idx}`;
  if (accMap.has(key)) return accMap.get(key);
  const acc = src.json.accessors[idx];
  const bv = src.json.bufferViews[acc.bufferView];
  const data = src.bin.subarray((bv.byteOffset ?? 0), (bv.byteOffset ?? 0) + bv.byteLength);
  const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
  chunks.push(data); offset += data.length;
  accessors.push({ ...acc, bufferView: bufferViews.length - 1 });
  accMap.set(key, accessors.length - 1);
  return accessors.length - 1;
}
const nodeIndexByName = new Map(nodes.map((n, i) => [n.name, i]));
const animations = []; const seen = new Set();
for (const src of srcs) {
  for (const anim of src.json.animations) {
    if (!KEEP.has(anim.name) || seen.has(anim.name)) continue;
    seen.add(anim.name);
    // Drop scale tracks and translation tracks except root/pelvis (constant in UAL) — ~60% smaller.
    const keepCh = anim.channels.filter((c) => {
      const name = src.json.nodes[c.target.node].name;
      if (c.target.path === 'scale') return false;
      if (c.target.path === 'translation') return name === 'root' || name === 'pelvis';
      return true;
    });
    const samplers = []; const channels = [];
    for (const c of keepCh) {
      const s = anim.samplers[c.sampler];
      samplers.push({ ...s, input: copyAccessor(src, s.input), output: copyAccessor(src, s.output) });
      channels.push({ sampler: samplers.length - 1, target: { path: c.target.path, node: nodeIndexByName.get(src.json.nodes[c.target.node].name) } });
    }
    animations.push({ name: anim.name, samplers, channels });
  }
}
const bin = Buffer.concat(chunks);
const json = {
  asset: { version: '2.0', generator: 'groundtruth build-anim-library (source: Quaternius UAL, CC0)' },
  scene: 0, scenes: [{ nodes: base.scenes[0].nodes }], nodes, animations, accessors, bufferViews,
  buffers: [{ byteLength: bin.length }],
};
let js = Buffer.from(JSON.stringify(json));
js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
const binP = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + binP.length, 8);
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
fs.writeFileSync(out, Buffer.concat([header, ch(js.length, 0x4e4f534a), js, ch(binP.length, 0x004e4942), binP]));
console.log('clips', animations.length, [...seen].join(','), (fs.statSync(out).size / 1e6).toFixed(2), 'MB');
