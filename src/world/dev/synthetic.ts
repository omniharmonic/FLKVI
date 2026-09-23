// DEV ONLY: a small synthetic downtown recipe (Boulder-ish grid) used to test the world assembler
// before the compiler's real recipes exist.
import type {
  Recipe, RecipeRoad, RoadGraph, RecipeArea, RecipeTree, RecipeProp, RecipeBuilding, Terrain, Vec2, RoadClass,
} from '../../core/types';
import { rng } from '../../core/geo';

function hNoise(x: number, z: number) {
  return Math.sin(x * 0.013) * 1.6 + Math.cos(z * 0.011 + 1.3) * 1.2 + Math.sin((x + z) * 0.031) * 0.4;
}
const baseH = (x: number, z: number) => 1600 - x * 0.018 + hNoise(x, z) - (Math.abs(z - 225) < 30 ? 3 * Math.cos(((z - 225) / 30) * Math.PI / 2) : 0);

export function syntheticRecipe(): Recipe {
  const R = 600, cell = 5;
  const cols = (2 * R) / cell + 1, rows = cols;
  const heights: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights.push(baseH(-R + c * cell, -R + r * cell));
  const terrain: Terrain = { cols, rows, originX: -R, originZ: -R, cellSize: cell, heights };

  // Far terrain: 12 km, mountains to the west
  const FR = 6000, fcell = 60, fcols = (2 * FR) / fcell + 1;
  const fh: number[] = [];
  for (let r = 0; r < fcols; r++) for (let c = 0; c < fcols; c++) {
    const x = -FR + c * fcell, z = -FR + r * fcell;
    let h = baseH(x, z);
    const w = Math.max(0, -x - 1500);
    h += Math.min(w * 0.35, 900) * (0.75 + 0.25 * Math.sin(z * 0.002) * Math.cos(x * 0.003)) + Math.sin(z * 0.004 + x * 0.001) * w * 0.05;
    fh.push(h);
  }
  const farTerrain: Terrain = { cols: fcols, rows: fcols, originX: -FR, originZ: -FR, cellSize: fcell, heights: fh };
  const H = (x: number, z: number) => baseH(x, z);

  const roads: RecipeRoad[] = [];
  const graph: RoadGraph = { nodes: [], edges: [] };
  const nodeAt = new Map<string, number>();
  const node = (p: Vec2) => {
    const k = `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
    let id = nodeAt.get(k);
    if (id === undefined) { id = graph.nodes.length; nodeAt.set(k, id); graph.nodes.push({ id, p, y: H(p[0], p[1]) }); }
    return id;
  };
  let rid = 0;
  const road = (cls: RoadClass, pts: Vec2[], o: Partial<RecipeRoad> = {}) => {
    const lanes = o.lanes ?? (cls === 'primary' ? 4 : cls === 'footway' ? 1 : 2);
    const r: RecipeRoad = {
      id: `r${rid++}`, cls, pts, ys: pts.map((p) => H(p[0], p[1])),
      width: o.width ?? (cls === 'primary' ? 16 : cls === 'footway' ? 2 : cls === 'service' ? 5 : 11),
      lanes, oneway: o.oneway ?? false, sidewalk: o.sidewalk ?? (cls === 'footway' || cls === 'service' ? 0 : 3),
      maxSpeed: cls === 'primary' ? 15.6 : 11.2, surface: 'asphalt', nodes: pts.map((p) => node(p)), ...o,
    } as RecipeRoad;
    r.ys = pts.map((p) => H(p[0], p[1]));
    r.nodes = pts.map((p) => node(p));
    roads.push(r);
    if (['footway', 'path', 'pedestrian', 'cycleway', 'steps'].includes(cls)) return r;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = r.nodes[i], b = r.nodes[i + 1];
      const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      graph.edges.push({ from: a, to: b, roadId: r.id, length: len, lanes: r.lanes, speed: r.maxSpeed, cls });
      if (!r.oneway) graph.edges.push({ from: b, to: a, roadId: r.id, length: len, lanes: r.lanes, speed: r.maxSpeed, cls });
    }
    return r;
  };

  const xs = [-330, -220, -110, 0, 110, 220, 330];
  const zs = [-270, -180, -90, 0, 90, 180, 270];
  // N-S streets (Broadway at x=0 is primary 4-lane)
  for (const x of xs) {
    const pts: Vec2[] = zs.map((z) => [x, z] as Vec2);
    pts.unshift([x, -420]); pts.push([x, 420]);
    if (x === 0) road('primary', pts, { name: 'Broadway', lanes: 4, width: 16, sidewalk: 3.5 });
    else if (x === 220) road('residential', pts, { oneway: true, lanes: 2, width: 10, name: '15th St' });
    else road('residential', pts, { width: 11, lanes: 2 });
  }
  // E-W streets. z=0 is the pedestrian mall between x=-220..110
  for (const z of zs) {
    if (z === 0) {
      road('residential', [[-420, 0], [-330, 0], [-220, 0]], {});
      road('pedestrian', [[-220, 0], [-110, 0], [0, 0], [110, 0]], { width: 16, sidewalk: 0, lanes: 0 });
      road('residential', [[110, 0], [220, 0], [330, 0], [420, 0]], {});
      continue;
    }
    if (z === 180) continue; // replaced by diagonal road
    const pts: Vec2[] = xs.map((x) => [x, z] as Vec2);
    pts.unshift([-420, z]); pts.push([420, z]);
    road(z === -90 ? 'secondary' : 'residential', pts, z === -90 ? { lanes: 2, width: 13, name: 'Walnut St' } : {});
  }
  // A curving arterial replacing z=180 (Canyon-like): bends
  road('secondary', [[-420, 200], [-330, 180], [-220, 180], [-110, 180], [-40, 172], [0, 180], [110, 180], [180, 200], [220, 212], [330, 230], [420, 230]], { lanes: 4, width: 15, name: 'Canyon Blvd' });
  // Diagonal service road
  road('service', [[110, -270], [160, -230], [220, -180]], {});
  // Footways in park (park block x 220..330, z 180..270)
  road('footway', [[235, 195], [260, 225], [300, 240], [320, 262]], { width: 2.2, sidewalk: 0 });
  road('footway', [[230, 262], [275, 250], [300, 240]], { width: 2.2, sidewalk: 0 });
  // Bridge: a footbridge over the creek pond
  const br = road('footway', [[260, 205], [262, 214], [264, 222]], { width: 3, sidewalk: 0, bridge: true });
  br.ys = [H(260, 205) + 0.2, H(260, 205) + 1.5, H(264, 222) + 0.2];

  // Signals on Broadway and Canyon
  for (const n of graph.nodes) {
    if (Math.abs(n.p[0]) < 1 && Math.abs(n.p[1]) < 300 && Math.abs(n.p[1]) > 1) n.signal = true;
    if (Math.abs(n.p[1] + 90) < 1 && Math.abs(n.p[0]) < 300) n.signal = true;
  }
  for (const n of graph.nodes) if (!n.signal && Math.abs(n.p[0]) < 400 && Math.abs(n.p[1]) < 400 && (Math.abs(n.p[0] % 110) < 1)) n.stop = true;

  const areas: RecipeArea[] = [
    { id: 'a-park', kind: 'park', poly: [[227, 187], [323, 207], [323, 263], [227, 263]] },
    { id: 'a-pond', kind: 'water', poly: [[245, 212], [280, 208], [300, 216], [290, 228], [255, 226]] },
    { id: 'a-park2', kind: 'grass', poly: [[-323, -263], [-227, -263], [-227, -187], [-323, -187]] },
    { id: 'a-lot', kind: 'parking', poly: [[117, -83], [203, -83], [203, -40], [117, -40]] },
    { id: 'a-lot2', kind: 'parking', poly: [[-103, 97], [-60, 97], [-60, 170], [-103, 170]] },
    { id: 'a-plaza', kind: 'plaza', poly: [[7, 7], [60, 7], [60, 40], [7, 40]] },
    { id: 'a-pitch', kind: 'pitch', poly: [[-310, 200], [-240, 200], [-240, 255], [-310, 255]] },
  ];

  const R2 = rng(42);
  // Buildings: blocks filled with lots (skip park / lot blocks)
  const buildings: RecipeBuilding[] = [];
  const inArea = (x: number, z: number) => areas.some((a) => {
    const xsA = a.poly.map((p) => p[0]), zsA = a.poly.map((p) => p[1]);
    return x > Math.min(...xsA) - 3 && x < Math.max(...xsA) + 3 && z > Math.min(...zsA) - 3 && z < Math.max(...zsA) + 3;
  });
  let bid = 0;
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < zs.length; j++) {
    const x0 = xs[i] + 12, x1 = xs[i + 1] - 12, z0 = zs[j] + 12, z1 = zs[j + 1] - 12;
    if (zs[j] === 90 || zs[j + 1] === 180) continue; // canyon edge block, skip for simplicity
    const downtown = Math.abs((xs[i] + xs[i + 1]) / 2) < 250 && Math.abs((zs[j] + zs[j + 1]) / 2) < 150;
    // row of lots along north and south edges
    for (const side of [0, 1]) {
      let x = x0;
      while (x < x1 - 8) {
        const w = Math.min(x1 - x, 10 + R2() * 16);
        const d = 18 + R2() * 14;
        const zA = side === 0 ? z0 : z1 - d, zB = side === 0 ? z0 + d : z1;
        const cx = x + w / 2, cz = (zA + zB) / 2;
        if (!inArea(cx, cz) && !inArea(x, zA) && !inArea(x + w, zB)) {
          const fp: Vec2[] = [[x, zB], [x + w, zB], [x + w, zA], [x, zA]];
          const levels = downtown ? 2 + Math.floor(R2() * 4) : 1 + Math.floor(R2() * 2);
          const baseY = Math.min(...fp.map((p) => H(p[0], p[1])));
          buildings.push({
            id: `b${bid++}`, footprint: fp, baseY, height: levels * 3.8, roofHeight: 0, levels,
            roof: { type: 'flat', material: 'membrane', color: '#777' }, use: downtown ? 'mixed-use' : 'residential-single',
            era: '1900-1939', kit: downtown ? 'main-street-block' : 'craftsman', material: 'brick-red', color: '#a0553f',
            seed: bid * 7919, storefront: downtown, streetEdges: [side === 0 ? 2 : 0],
          });
        }
        x += w + (downtown ? 0 : 6);
      }
    }
  }

  // Trees along street edges (in the sidewalk tree lawn), plus park trees
  const trees: RecipeTree[] = [];
  const species = ['honey-locust', 'maple', 'green-ash', 'linden', 'elm'];
  for (const r of roads) {
    if (r.cls === 'footway' || r.cls === 'pedestrian' || r.cls === 'service') continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      for (let t = 18; t < len - 18; t += 11 + R2() * 4) for (const s of [-1, 1]) {
        if (R2() < 0.3) continue;
        const off = r.width / 2 + 1.1;
        const x = ax + ux * t - uz * off * s, z = az + uz * t + ux * off * s;
        const h = 7 + R2() * 7;
        trees.push({ p: [x, z], y: H(x, z), species: species[Math.floor(R2() * species.length)], height: h, crown: h * (0.55 + R2() * 0.2), seed: Math.floor(R2() * 1e9) });
      }
    }
  }
  for (let k = 0; k < 60; k++) {
    const x = 230 + R2() * 90, z = 190 + R2() * 70;
    if (x > 243 && x < 302 && z > 205 && z < 230) continue;
    const conifer = R2() < 0.4;
    const h = conifer ? 10 + R2() * 12 : 12 + R2() * 10;
    trees.push({ p: [x, z], y: H(x, z), species: conifer ? (R2() < 0.5 ? 'blue-spruce' : 'ponderosa-pine') : 'cottonwood', height: h, crown: conifer ? h * 0.4 : h * 0.7, seed: Math.floor(R2() * 1e9) });
  }
  // lots of far trees to test instancing/LOD
  for (let k = 0; k < 1500; k++) {
    const x = -580 + R2() * 1160, z = 300 + R2() * 280;
    if (Math.abs(z - 420) < 12 || xs.some((xx) => Math.abs(x - xx) < 12)) continue;
    const h = 8 + R2() * 12;
    const sp = ['cottonwood', 'ponderosa-pine', 'honey-locust', 'blue-spruce', 'maple'][Math.floor(R2() * 5)];
    trees.push({ p: [x, z], y: H(x, z), species: sp, height: h, crown: h * 0.6, seed: Math.floor(R2() * 1e9) });
  }

  const props: RecipeProp[] = [];
  const P = (type: RecipeProp['type'], x: number, z: number, rot = 0, variant = 0, line?: Vec2[]) => props.push({ type, p: [x, z], y: H(x, z), rot, variant, line });
  // streetlights along Broadway, Walnut
  for (let z = -400; z <= 400; z += 36) { if (Math.abs(z % 90) > 14) { P('streetlight', 8 + 0.6 + 3.5 - 0.6, z, 0); P('streetlight', -8 - 3.5 + 0.6, z + 18, Math.PI); } }
  // hydrants, benches, trash, bus stop, bike racks, etc. near Broadway & Walnut
  P('hydrant', 9.2, -110); P('hydrant', -9.2, 60); P('hydrant', 6.5, -105 + 200);
  P('bench', 11, -50, Math.PI / 2); P('bench', -11, -40, -Math.PI / 2); P('trash-can', 9.3, -46); P('trash-can', -9.3, -36);
  P('bus-stop', 10.8, 40, -Math.PI / 2); P('bike-rack', -10, 30, 0); P('mailbox', 9.4, 54); P('newspaper-box', 9.4, 56);
  P('parking-meter', 60, -97.2); P('parking-meter', 68, -97.2); P('planter', 30, 5); P('planter', 50, 5); P('planter', -60, 5); P('planter', -150, 5);
  P('bench', -80, 4, 0); P('bench', -130, -4, Math.PI); P('bollard', -218, -6); P('bollard', -218, -2); P('bollard', -218, 2); P('bollard', -218, 6);
  P('manhole', 2, -40); P('manhole', -3, 60); P('manhole', 110, -140);
  P('crosswalk', 0, -45, 0);
  for (let x = -420; x <= 420; x += 42) P('utility-pole', x, 136, 0);
  P('shrub', 240, 190); P('shrub', 243, 191); P('shrub', 310, 258);
  P('hedge', 0, 0, 0, 0, [[125, -38], [200, -38]]);
  P('fence', 0, 0, 0, 0, [[-312, 198], [-238, 198], [-238, 257]]);
  for (const n of graph.nodes) if (n.stop) {
    for (const [dx, dz] of [[1, 1], [-1, -1]]) P('stop-sign', n.p[0] + dx * 7, n.p[1] + dz * 7);
  }

  return {
    version: 1, name: 'Synthetic Downtown', origin: { lat: 40.0176, lon: -105.2797 },
    bounds: { minX: -R, minZ: -R, maxX: R, maxZ: R }, region: 'mountain-west', climate: 'arid', tier: 'S',
    terrain, farTerrain, roads, graph, buildings, areas, trees, props, cameras: [],
    spawn: { p: [4, 30], y: H(4, 30), heading: 0 }, attribution: ['synthetic'],
  };
}
