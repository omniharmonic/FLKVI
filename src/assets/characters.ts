// OWNER: assets agent. Dresses Quaternius Universal Base Characters (CC0, realistic proportions, underwear only)
// into street clothes without new meshes: each body vertex is classified by its dominant skin-weight bone
// (torso/arms → top, pelvis/legs → bottom, feet → shoes, head/hands → skin) and the material paints that region
// a fabric color while keeping lighting + normals. Police get navy long sleeves + a procedural cap.
import * as THREE from 'three';

export interface Outfit {
  top: string;
  bottom: string;
  shoes: string;
  /** Long sleeves cover the forearms. */
  longSleeves?: boolean;
  /** Shorts / skirt: calves show skin. */
  shorts?: boolean;
  /** Multiplies skin texture (lighter base can't be brightened; '#fff' = texture as-is). */
  skin?: string;
  hair?: string;
  /** Adds a procedural police-style peaked cap (no insignia). */
  cap?: string;
  /** Hair mesh: 'short' (parted, Hair_SimpleParted) | 'long' (Hair_Long) | 'none' (bald). Default by body. */
  hairStyle?: 'short' | 'long' | 'none';
}

export interface DressExtras {
  /** Static hair mesh in model space (rest pose); attached to the Head bone. */
  hair?: THREE.Object3D | null;
  normalMap?: THREE.Texture | null;
  roughnessMap?: THREE.Texture | null;
}

const SKIN = 0, TOP = 1, BOTTOM = 2, SHOES = 3;

function boneRegion(name: string, o: Outfit): number {
  const n = name.toLowerCase();
  if (n.startsWith('foot') || n.startsWith('ball')) return SHOES;
  if (n.startsWith('calf')) return o.shorts ? SKIN : BOTTOM;
  if (n.startsWith('thigh') || n === 'pelvis' || n === 'root') return BOTTOM;
  if (n.startsWith('spine') || n.startsWith('clavicle') || n.startsWith('upperarm')) return TOP;
  if (n.startsWith('lowerarm')) return o.longSleeves ? TOP : SKIN;
  return SKIN; // head, neck, hands, fingers
}

function srgbToLinear(hex: string): THREE.Color {
  return new THREE.Color(hex); // THREE.Color.set() converts sRGB hex → linear working space
}

/** Returns a cloned geometry with a `clothColor` (rgb linear + mask) attribute for the outfit. */
function dressGeometry(mesh: THREE.SkinnedMesh, o: Outfit): THREE.BufferGeometry {
  const g = mesh.geometry.clone();
  const si = g.getAttribute('skinIndex'); const sw = g.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const cols = [null, srgbToLinear(o.top), srgbToLinear(o.bottom), srgbToLinear(o.shoes)];
  const arr = new Float32Array(si.count * 4);
  const acc = [0, 0, 0, 0];
  for (let v = 0; v < si.count; v++) {
    acc.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(v, k);
      if (w > 0) acc[boneRegion(bones[si.getComponent(v, k)]?.name ?? '', o)] += w;
    }
    let best = 0; for (let r = 1; r < 4; r++) if (acc[r] > acc[best]) best = r;
    const c = cols[best];
    if (c) { arr[v * 4] = c.r; arr[v * 4 + 1] = c.g; arr[v * 4 + 2] = c.b; arr[v * 4 + 3] = best === SHOES ? 2 : 1; }
  }
  g.setAttribute('clothColor', new THREE.BufferAttribute(arr, 4));
  return g;
}

function clothMaterial(base: THREE.MeshStandardMaterial, o: Outfit, x: DressExtras): THREE.MeshStandardMaterial {
  const m = base.clone();
  m.name = base.name + ':dressed';
  if (o.skin) m.color.set(o.skin);
  if (x.normalMap) { m.normalMap = x.normalMap; m.normalScale.set(1, -1); }
  if (x.roughnessMap) { m.roughnessMap = x.roughnessMap; m.roughness = 1; }
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 clothColor;\nvarying vec4 vCloth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCloth = clothColor;\n// fabric sits slightly off the skin (softens painted muscle definition, looser pants)\ntransformed += objectNormal * (clothColor.a > 1.5 ? 0.012 : clothColor.a > 0.5 ? 0.007 : 0.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vCloth;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (vCloth.a > 0.5) {
          // keep a little painted form shading from the body texture as fabric variation
          float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) / max(dot(diffuse, vec3(0.299,0.587,0.114)), 1e-3);
          float detail = mix(1.0, clamp(lum / 0.45, 0.8, 1.1), 0.15);
          diffuseColor.rgb = vCloth.rgb * detail;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (vCloth.a > 1.5) roughnessFactor = 0.45; else if (vCloth.a > 0.5) roughnessFactor = 0.92;`)
      .replace('#include <normal_fragment_maps>', 'if (vCloth.a < 0.5) {\n#include <normal_fragment_maps>\n}');
  };
  m.customProgramCacheKey = () => 'gt-cloth';
  return m;
}

function makeCap(color: string): THREE.Group {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const visor = new THREE.MeshStandardMaterial({ color: '#0b0b0d', roughness: 0.25, metalness: 0.1 });
  const band = new THREE.MeshStandardMaterial({ color: '#111114', roughness: 0.5 });
  const cap = new THREE.Group();
  cap.name = 'cap';
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.105, 0.075, 20), mat);
  crown.position.y = 0.06; crown.scale.z = 1.12;
  const bandM = new THREE.Mesh(new THREE.CylinderGeometry(0.106, 0.106, 0.035, 20), band);
  bandM.position.y = 0.02; bandM.scale.z = 1.12;
  const bill = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.008, 16, 1, false, -Math.PI / 2, Math.PI), visor);
  bill.position.set(0, 0.008, 0.07); bill.rotation.x = 0.25;
  cap.add(crown, bandM, bill);
  cap.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
  return cap;
}

/**
 * Dress a freshly loaded UBC character scene in place (call once on the template; then SkeletonUtils.clone it).
 * Body = SkinnedMesh whose material name contains 'Superhero'. Hair meshes = material name contains 'Hair'.
 */
export function dressCharacter(root: THREE.Object3D, o: Outfit, x: DressExtras = {}): void {
  const skinned: THREE.SkinnedMesh[] = [];
  root.traverse((obj) => { if ((obj as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(obj as THREE.SkinnedMesh); });
  for (const mesh of skinned) {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (/superhero/i.test(mat.name)) {
      mesh.geometry = dressGeometry(mesh, o);
      mesh.material = clothMaterial(mat, o, x);
    } else if (/hair/i.test(mat.name) && o.hair) {
      const h = mat.clone(); h.color.set(o.hair); mesh.material = h;
      if (o.cap) mesh.visible = false; // hair cards poke through the cap
    }
  }
  let headBone: THREE.Object3D | undefined;
  root.traverse((obj) => { if (obj.name === 'Head') headBone = obj; });
  if (x.hair && headBone && !o.cap && o.hairStyle !== 'none') {
    root.updateMatrixWorld(true);
    const hair = x.hair.clone(true);
    hair.traverse((h) => {
      const hm = h as THREE.Mesh;
      if (!hm.isMesh) return;
      hm.castShadow = true;
      const mm = (hm.material as THREE.MeshStandardMaterial).clone();
      if (o.hair) mm.color.set(o.hair);
      mm.roughness = 0.75; mm.side = THREE.DoubleSide;
      hm.material = mm;
    });
    root.add(hair);
    headBone.attach(hair);
  }
  if (o.cap) {
    let head: THREE.Object3D | undefined;
    root.traverse((obj) => { if (obj.name === 'Head') head = obj; });
    if (head) {
      // Head bone axes differ from world; place in world space at rest pose then re-parent (keeps world transform).
      root.updateMatrixWorld(true);
      const cap = makeCap(o.cap);
      const hp = new THREE.Vector3(); head.getWorldPosition(hp);
      const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
      cap.position.copy(hp.applyMatrix4(rootInv)).add(new THREE.Vector3(0, CAP_Y, CAP_Z));
      root.add(cap);
      head.attach(cap);
    }
  }
}

/** Offsets of the cap from the Head bone origin in model space (meters, model faces +Z). */
const CAP_Y = 0.135, CAP_Z = 0.0;
