import type { Recipe } from '../core/types.ts';
/** Merge OSM graph identities while keeping initial node indices stable. Resident districts only. */
export function mergeDistrictGraphs(core: Recipe, districts: readonly Recipe[], ready: (x:number,z:number)=>boolean): Recipe {
  const roads=new Map(core.roads.map(r=>[r.id,r]));
  const nodes=core.graph.nodes.map(n=>({...n})), edges=core.graph.edges.map(e=>({...e}));
  const nodeIds=new Map(nodes.map((n,i)=>[n.id,i]));
  const edgeIds=new Set(edges.map(e=>`${e.from}:${e.to}:${e.roadId}`));
  for(const r of districts){
    for(const road of r.roads)if(!roads.has(road.id))roads.set(road.id,road);
    const remap=new Map<number,number>();
    for(const e of r.graph.edges){
      const a=r.graph.nodes[e.from],b=r.graph.nodes[e.to];if(!a||!b||!ready(...a.p)||!ready(...b.p))continue;
      for(const i of [e.from,e.to]){
        const n=r.graph.nodes[i];let id=nodeIds.get(n.id);
        if(id===undefined){id=nodes.length;nodes.push({...n});nodeIds.set(n.id,id);}remap.set(i,id);
      }
      const from=remap.get(e.from)!,to=remap.get(e.to)!,key=`${from}:${to}:${e.roadId}`;
      if(!edgeIds.has(key)){edgeIds.add(key);edges.push({...e,from,to});}
    }
  }
  return {...core,roads:[...roads.values()],graph:{nodes,edges}};
}
