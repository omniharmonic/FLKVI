#!/usr/bin/env node
// Select complete street props from the CC0 Poly Haven source layouts, transform to
// base-at-origin metres, and simplify offline. No model simplification runs in-game.
import fs from 'node:fs';
import path from 'node:path';
import { Matrix4, Matrix3, Vector3, Quaternion } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
const root = process.cwd();
const output = path.join(root, 'public/assets/models/street');
await MeshoptSimplifier.ready;
fs.mkdirSync(output, { recursive: true });
const specs = [
  { id: 'hydrant', source: 'prop-hydrant', budget: 1900, select: [5, 6, 7, 8].map(node => ({ node, offset: [-0.3, 0, 0] })) },
  { id: 'trash', source: 'prop-trash-can', budget: 1700, select: [
    { node: 0, offset: [-0.5, 0, 0] }, { node: 1, position: [0, 0.906, 0], rotation: [0, 0, 0, 1] },
    { node: 2, offset: [-0.5, 0, 0] }, { node: 3, offset: [-0.5, 0, 0] },
  ] },
  { id: 'bench', source: 'prop-bench', budget: 2800, select: [
    { node: 0, offset: [1.16, 0, 0] },
    { node: 2, position: [-0.94, 0, 0] }, { node: 2, position: [0.94, 0, 0], scale: [-1, 1, 1] },
    { node: 5, offset: [1.16, 0, 0] }, { node: 6, offset: [1.16, 0, 0] },
    { node: 7, position: [-0.94, 0.55, 0] }, { node: 8, position: [0.94, 0.55, 0] },
    { node: 9, offset: [1.16, 0, 0] }, { node: 10, offset: [1.16, 0, 0] },
  ] },
];
const stats = [];
for (const spec of specs) {
  const sourceDir = path.join(root, 'public/assets/models/props', spec.source);
  const source = JSON.parse(fs.readFileSync(path.join(sourceDir, 'model.gltf'), 'utf8'));
  const binary = source.buffers.map(b => fs.readFileSync(path.join(sourceDir, b.uri)));
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const bytes = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 };
  function accessor(i) {
    const a = source.accessors[i], view = source.bufferViews[a.bufferView], b = binary[view.buffer];
    const n = components[a.type], out = a.componentType === 5126 ? new Float32Array(a.count * n) : new Uint32Array(a.count * n);
    const stride = view.byteStride ?? n * bytes[a.componentType];
    const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const read = { 5126: 'readFloatLE', 5125: 'readUInt32LE', 5123: 'readUInt16LE', 5121: 'readUInt8' }[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = b[read](offset + k * stride + c * bytes[a.componentType]);
    return out;
  }
  // Deduplicate equivalent materials exported once per layout object.
  const materialKeys = new Map(), materialSource = [], groups = new Map();
  function materialIndex(index) {
    const m = source.materials[index];
    const tex = n => n === undefined ? '' : source.images[source.textures[n].source].uri;
    const key = [m.name, tex(m.pbrMetallicRoughness?.baseColorTexture?.index), tex(m.normalTexture?.index)].join(':');
    if (!materialKeys.has(key)) { materialKeys.set(key, materialSource.length); materialSource.push(index); }
    return materialKeys.get(key);
  }
  let before = 0;
  const v = new Vector3();
  for (const chosen of spec.select) {
    const node = source.nodes[chosen.node];
    const t = [...(chosen.position ?? node.translation ?? [0, 0, 0])];
    if (chosen.offset) for (let i = 0; i < 3; i++) t[i] += chosen.offset[i];
    const matrix = new Matrix4().compose(new Vector3(...t), new Quaternion(...(chosen.rotation ?? node.rotation ?? [0, 0, 0, 1])), new Vector3(...(chosen.scale ?? node.scale ?? [1, 1, 1])));
    const normalMatrix = new Matrix3().getNormalMatrix(matrix);
    for (const primitive of source.meshes[node.mesh].primitives) {
      const material = materialIndex(primitive.material);
      if (!groups.has(material)) groups.set(material, { pos: [], normal: [], uv: [], index: [] });
      const group = groups.get(material), start = group.pos.length / 3;
      const pos = accessor(primitive.attributes.POSITION), normal = accessor(primitive.attributes.NORMAL), uv = accessor(primitive.attributes.TEXCOORD_0), index = accessor(primitive.indices);
      for (let i = 0; i < pos.length; i += 3) { v.fromArray(pos, i).applyMatrix4(matrix); group.pos.push(v.x, v.y, v.z); }
      for (let i = 0; i < normal.length; i += 3) { v.fromArray(normal, i).applyMatrix3(normalMatrix).normalize(); group.normal.push(v.x, v.y, v.z); }
      for (const value of uv) group.uv.push(value);
      const reverse = matrix.determinant() < 0;
      for (let i = 0; i < index.length; i += 3) group.index.push(start + index[i], start + index[i + (reverse ? 2 : 1)], start + index[i + (reverse ? 1 : 2)]);
      before += index.length / 3;
    }
  }
  // Base is exactly on the ground; meshes retain authored realistic dimensions.
  let minY = Infinity;
  for (const group of groups.values()) for (let i = 1; i < group.pos.length; i += 3) minY = Math.min(minY, group.pos[i]);
  for (const group of groups.values()) for (let i = 1; i < group.pos.length; i += 3) group.pos[i] -= minY;
  const accessors = [], bufferViews = [], chunks = [], primitives = [];
  let offset = 0, after = 0;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  function write(data, size, type) {
    const pad = (4 - offset % 4) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length });
    chunks.push(buffer); offset += buffer.length;
    const a = { bufferView: bufferViews.length - 1, componentType: data instanceof Float32Array ? 5126 : 5125, count: data.length / size, type };
    if (type === 'VEC3') {
      a.min = [Infinity, Infinity, Infinity]; a.max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i++) { a.min[i % 3] = Math.min(a.min[i % 3], data[i]); a.max[i % 3] = Math.max(a.max[i % 3], data[i]); }
    }
    accessors.push(a); return accessors.length - 1;
  }
  for (const [material, group] of groups) {
    const pos = Float32Array.from(group.pos), original = Uint32Array.from(group.index);
    const attrs = new Float32Array(pos.length / 3 * 5);
    for (let i = 0; i < pos.length / 3; i++) attrs.set([...group.normal.slice(i * 3, i * 3 + 3), ...group.uv.slice(i * 2, i * 2 + 2)], i * 5);
    const target = Math.max(48, Math.floor(spec.budget * (original.length / 3) / before)) * 3;
    const [indices, error] = MeshoptSimplifier.simplifyWithAttributes(original, pos, 3, attrs, 5, [0.3, 0.3, 0.3, 0.15, 0.15], null, Math.min(original.length, target), 0.035, ['Prune', 'Permissive']);
    const [remap, vertices] = MeshoptSimplifier.compactMesh(indices);
    const p = new Float32Array(vertices * 3), n = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2);
    for (let old = 0; old < remap.length; old++) {
      const at = remap[old]; if (at === 0xffffffff) continue;
      p.set(pos.subarray(old * 3, old * 3 + 3), at * 3);
      n.set(group.normal.slice(old * 3, old * 3 + 3), at * 3);
      uv.set(group.uv.slice(old * 2, old * 2 + 2), at * 2);
    }
    for (let i = 0; i < p.length; i++) { bounds.min[i % 3] = Math.min(bounds.min[i % 3], p[i]); bounds.max[i % 3] = Math.max(bounds.max[i % 3], p[i]); }
    primitives.push({ attributes: { POSITION: write(p, 3, 'VEC3'), NORMAL: write(n, 3, 'VEC3'), TEXCOORD_0: write(uv, 2, 'VEC2') }, indices: write(indices, 1, 'SCALAR'), material });
    after += indices.length / 3;
    console.log(spec.id, material, 'triangles', original.length / 3, '→', indices.length / 3, 'error', error.toFixed(4));
  }
  // External existing texture files stay shared/cacheable; each GLB references only its selected material textures.
  const images = [], textures = [], imageIds = new Map(), textureIds = new Map();
  function texture(index) {
    if (textureIds.has(index)) return textureIds.get(index);
    const t = source.textures[index], image = source.images[t.source];
    const uri = `../props/${spec.source}/${image.uri}`;
    if (!imageIds.has(uri)) { imageIds.set(uri, images.length); images.push({ uri }); }
    const result = textures.length; textures.push({ source: imageIds.get(uri), sampler: 0 }); textureIds.set(index, result); return result;
  }
  const materials = materialSource.map(i => {
    const m = structuredClone(source.materials[i]);
    delete m.extensions;
    const visit = o => { for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') { if (k.endsWith('Texture') && typeof v.index === 'number') { v.index = texture(v.index); v.texCoord = 0; } else visit(v); } };
    visit(m); m.doubleSided = false;
    return m;
  });
  const binaryOut = Buffer.concat(chunks);
  const json = { asset: { version: '2.0', generator: 'FLK VI street kit: CC0 Poly Haven + meshoptimizer offline' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: `street-${spec.id}` }], meshes: [{ primitives }], accessors, bufferViews, buffers: [{ byteLength: binaryOut.length }], materials, images, textures, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const bin = Buffer.concat([binaryOut, Buffer.alloc((4 - binaryOut.length % 4) % 4)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + js.length + bin.length, 8);
  const chunk = (length, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(length); b.writeUInt32LE(type, 4); return b; };
  const result = Buffer.concat([header, chunk(js.length, 0x4e4f534a), js, chunk(bin.length, 0x004e4942), bin]);
  fs.writeFileSync(path.join(output, `${spec.id}.glb`), result);
  stats.push({ id: spec.id, source: spec.source, triangles: after, originalTriangles: before, bytes: result.length, materials: materials.length, bounds });
}
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ models: stats }, null, 2) + '\n');
const licensesPath = path.join(root, 'public/assets/LICENSES.json');
const licenses = JSON.parse(fs.readFileSync(licensesPath, 'utf8'));
for (const spec of specs) {
  const source = licenses.assets.find(a => a.id === spec.source);
  const entry = { ...source, id: `street-${spec.id}`, path: `models/street/${spec.id}.glb`, date: '2026-09-25', modified: 'Selected assembled prop, grounded origin, simplified offline with UV/normal preservation. Shared original CC0 texture files.' };
  const i = licenses.assets.findIndex(a => a.id === entry.id);
  if (i < 0) licenses.assets.push(entry); else licenses.assets[i] = entry;
}
const manifestEntry = { id: 'street-kit-manifest', path: 'models/street/manifest.json', source: 'Generated asset budgets and dimensions from tools/build-street-kit.mjs', author: 'FLK VI contributors', license: 'CC0-1.0', date: '2026-09-25', webDistribution: true };
licenses.assets = licenses.assets.filter(a => a.id !== manifestEntry.id);
licenses.assets.push(manifestEntry);
fs.writeFileSync(licensesPath, JSON.stringify(licenses, null, 1) + '\n');
console.log(JSON.stringify(stats, null, 2));
