// Pure coordinate/ownership rules shared by streaming and its regression tests.
import type { Recipe, Vec2 } from '../core/types.ts';
import { hashString, makeProjection } from '../core/geo.ts';
import { terrainSampler } from '../compiler/terrain.ts';
import { clipPolylineRect, clipRingRect } from '../compiler/geom.ts';
export type Bounds = Recipe['bounds'];
export const DISTRICT_SIZE = 400;
export function contains(b: Bounds, x: number, z: number, inset = 0) {
  return x >= b.minX + inset && x <= b.maxX - inset && z >= b.minZ + inset && z <= b.maxZ - inset;
}
export function distanceTo(b: Bounds, x: number, z: number) {
  return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));
}
export function districtIndex(v: number, min: number, max: number) {
  return v < min ? Math.floor((v - min) / DISTRICT_SIZE) : v > max ? Math.ceil((v - max) / DISTRICT_SIZE) : 0;
}
export function districtBounds(core: Bounds, i: number, j: number): Bounds {
  const axis = (n: number, a: number, b: number): [number, number] => n < 0 ? [a + n * DISTRICT_SIZE, a + (n + 1) * DISTRICT_SIZE] : n > 0 ? [b + (n - 1) * DISTRICT_SIZE, b + n * DISTRICT_SIZE] : [a, b];
  const [minX, maxX] = axis(i, core.minX, core.maxX), [minZ, maxZ] = axis(j, core.minZ, core.maxZ);
  return { minX, minZ, maxX, maxZ };
}
/** Reproject every spatial field into the initial world's ENU frame and elevation datum. */
export function rebaseRecipe(source: Recipe, root: Recipe, bounds: Bounds): Recipe {
  const a = makeProjection(source.origin.lat, source.origin.lon), b = makeProjection(root.origin.lat, root.origin.lon);
  const move = (p: Vec2): Vec2 => { const ll = a.toLatLon(...p); return b.toLocal(ll.lat, ll.lon); };
  const dy = (source.elevation ?? 0) - (root.elevation ?? 0);
  const inside = (p: Vec2) => contains(bounds, ...p);
  // Retain a junction margin, but don't build an entire multi-kilometre source for one district.
  // OSM way IDs and elevation profiles survive clipping for route stitching.
  const margin=32, box={minX:bounds.minX-margin,minZ:bounds.minZ-margin,maxX:bounds.maxX+margin,maxZ:bounds.maxZ+margin};
  const crop = (pts:Vec2[]) => clipPolylineRect(pts,box.minX,box.minZ,box.maxX,box.maxZ);
  const ring = (pts:Vec2[]) => clipRingRect(pts,box.minX,box.minZ,box.maxX,box.maxZ);
  const nodeId = streamNodeId;
  // Clip before road tessellation/area subdivision. A single OSM park or arterial can span
  // kilometres; clipping its final mesh is too late to prevent a multi-second allocation spike.
  const movedRoads=source.roads.map(r=>({...r,pts:r.pts.map(move),ys:r.ys.map(y=>y+dy)}));
  const roads = movedRoads.flatMap(r => {
    const pts=r.pts;
    return crop(pts).map(piece => ({...r,pts:piece.pts,
      ys:piece.pts.map((p,i)=>{
        if(piece.src[i]>=0)return r.ys[piece.src[i]];
        let nearest=Infinity,y=0;
        for(let k=1;k<pts.length;k++){
          const a=pts[k-1],b=pts[k],dx=b[0]-a[0],dz=b[1]-a[1];
          const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(dx*dx+dz*dz||1)));
          const d=(p[0]-a[0]-dx*t)**2+(p[1]-a[1]-dz*t)**2;
          if(d<nearest){nearest=d;y=r.ys[k-1]+(r.ys[k]-r.ys[k-1])*t;}
        }
        return y;
      }),nodes:piece.pts.map((p,i)=>piece.src[i]>=0?r.nodes[piece.src[i]]:nodeId(p)),
    }));
  });
  const graph=clipRoadGraph({nodes:source.graph.nodes.map(n=>({...n,p:move(n.p),y:n.y+dy})),edges:source.graph.edges},bounds,false,movedRoads);
  const srcH = terrainSampler(source.terrain);
  const cellSize = 4, cols = Math.ceil((bounds.maxX - bounds.minX) / cellSize) + 1, rows = Math.ceil((bounds.maxZ - bounds.minZ) / cellSize) + 1;
  const heights: number[] = [];
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const ll = b.toLatLon(bounds.minX + x * cellSize, bounds.minZ + z * cellSize);
    heights.push(srcH(...a.toLocal(ll.lat, ll.lon)) + dy);
  }
  return {
    ...source, origin: root.origin, elevation: root.elevation, bounds, farTerrain: undefined,
    terrain: { cols, rows, cellSize, originX: bounds.minX, originZ: bounds.minZ, heights },
    roads, graph,
    buildings: source.buildings.map(v => ({ ...v, baseY: v.baseY + dy, footprint: v.footprint.map(move), holes: v.holes?.map(r => r.map(move)) }))
      .filter(v => inside([v.footprint.reduce((s,p)=>s+p[0],0)/v.footprint.length, v.footprint.reduce((s,p)=>s+p[1],0)/v.footprint.length])),
    areas: source.areas.map(v => ({ ...v, poly: ring(v.poly.map(move)), holes: v.holes?.map(r => ring(r.map(move))).filter(r=>r.length>=3) })).filter(v=>v.poly.length>=3),
    trees: source.trees.map(v => ({ ...v, p: move(v.p), y: v.y + dy })).filter(v => inside(v.p)),
    props: source.props.map(v => ({ ...v, p: move(v.p), y: v.y + dy, line: v.line?.map(move) })).filter(v => inside(v.p)),
    cameras: source.cameras.map(v => ({ ...v, p: move(v.p), y: v.y + dy })).filter(v => inside(v.p)),
    spawn: { ...source.spawn, p: move(source.spawn.p), y: source.spawn.y + dy },
  };
}

/** Stable shared boundary identity lets sparse rural graph edges connect across chunk seams. */
export const streamNodeId = (p:Vec2) => -1-hashString(`stream:${(Math.round(p[0]*1000)/1000).toFixed(3)},${(Math.round(p[1]*1000)/1000).toFixed(3)}`);
export function clipRoadGraph(input:Recipe['graph'],bounds:Bounds,preserveNodes=false,roads:readonly Recipe['roads'][number][]=[]):Recipe['graph'] {
  const graph:Recipe['graph']={nodes:preserveNodes?input.nodes.map(n=>({...n})):[],edges:[]};
  const nodeMap=new Map(graph.nodes.map((n,i)=>[n.id,i]));
  const addNode=(n:Recipe['graph']['nodes'][number])=>{
    let i=nodeMap.get(n.id);if(i!==undefined)return i;
    i=graph.nodes.length;nodeMap.set(n.id,i);graph.nodes.push(n);return i;
  };
  const byRoad=new Map<string,Recipe['roads']>();
  for(const road of roads){const list=byRoad.get(road.id)??[];list.push(road);byRoad.set(road.id,list);}
  for(const e of input.edges){
    const a=input.nodes[e.from],b=input.nodes[e.to];if(!a||!b)continue;
    const path=roadGraphPath(a,b,byRoad.get(e.roadId)??[]);
    for(const piece of clipPolylineRect(path.pts,bounds.minX,bounds.minZ,bounds.maxX,bounds.maxZ)){
      const at=(i:number)=>{
        const p=piece.pts[i],source=piece.src[i];
        const original=source===0?a:source===path.pts.length-1?b:undefined;
        return addNode(original?{...original,p}:{id:streamNodeId(p),p,y:projectToPath(p,path.pts,path.ys).y});
      };
      let segmentLength=0;for(let i=1;i<piece.pts.length;i++)segmentLength+=Math.hypot(piece.pts[i][0]-piece.pts[i-1][0],piece.pts[i][1]-piece.pts[i-1][1]);
      if(segmentLength>.01)graph.edges.push({...e,from:at(0),to:at(piece.pts.length-1),length:segmentLength});
    }
  }
  return graph;
}

function projectToPath(p:Vec2,pts:Vec2[],ys:number[]){
  let distance=Infinity,s=0,y=ys[0]??0,total=0;
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1],b=pts[i],dx=b[0]-a[0],dz=b[1]-a[1],len=Math.hypot(dx,dz);
    const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(len*len||1)));
    const d=Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dz*t);
    if(d<distance){distance=d;s=total+len*t;y=ys[i-1]+(ys[i]-ys[i-1])*t;}
    total+=len;
  }
  return {distance,s,y};
}
/** Graph edges skip shape-only OSM nodes. Clip their road's curve, never the endpoint chord. */
function roadGraphPath(a:Recipe['graph']['nodes'][number],b:Recipe['graph']['nodes'][number],roads:Recipe['roads']){
  let result={pts:[a.p,b.p],ys:[a.y,b.y]},best=2;
  for(const road of roads){
    const ap=projectToPath(a.p,road.pts,road.ys),bp=projectToPath(b.p,road.pts,road.ys),error=ap.distance+bp.distance;
    if(error>best)continue;best=error;
    const middle:Vec2[]=[],heights:number[]=[];let s=0;
    for(let i=1;i<road.pts.length;i++){
      s+=Math.hypot(road.pts[i][0]-road.pts[i-1][0],road.pts[i][1]-road.pts[i-1][1]);
      if(s>Math.min(ap.s,bp.s)+.001&&s<Math.max(ap.s,bp.s)-.001){middle.push(road.pts[i]);heights.push(road.ys[i]);}
    }
    if(ap.s>bp.s){middle.reverse();heights.reverse();}
    result={pts:[a.p,...middle,b.p],ys:[a.y,...heights,b.y]};
  }
  return result;
}
