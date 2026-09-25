import * as THREE from 'three';
import type { Bounds } from './stream-coordinates';
/** Clip road/water triangle attributes at ownership boundaries, preserving UVs and normals. */
export function clipGeometry(geo: THREE.BufferGeometry, b: Bounds): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb=geo.boundingBox!;
  if(bb.min.x>=b.minX&&bb.max.x<=b.maxX&&bb.min.z>=b.minZ&&bb.max.z<=b.maxZ)return geo;
  if(bb.max.x<b.minX||bb.min.x>b.maxX||bb.max.z<b.minZ||bb.min.z>b.maxZ)return new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([],3));
  const attrs=Object.entries(geo.attributes) as [string,THREE.BufferAttribute][];
  const sizes=attrs.map(([,a])=>a.itemSize),offsets:number[]=[];
  let width=0;for(const size of sizes){offsets.push(width);width+=size;}
  const pi=offsets[attrs.findIndex(([name])=>name==='position')],position=geo.attributes.position;
  const out=attrs.map(()=>[] as number[]),indices:number[]=[],reused=new Int32Array(position.count).fill(-1);
  let vertices=0;
  // Most triangles of a boundary mesh are entirely inside the district. Retain
  // their shared indices without allocating attribute arrays or clipping them.
  const original=(n:number)=>{
    if(reused[n]>=0)return reused[n];
    const id=vertices++;reused[n]=id;
    for(let a=0;a<attrs.length;a++)for(let k=0;k<sizes[a];k++)out[a].push(attrs[a][1].array[n*sizes[a]+k]);
    return id;
  };
  type Vertex={v:number[];source:number};
  const vertex=(n:number):Vertex=>{
    const v:number[]=[];for(const [,a] of attrs)for(let k=0;k<a.itemSize;k++)v.push(a.array[n*a.itemSize+k]);
    return {v,source:n};
  };
  const mask=(n:number)=>{const x=position.getX(n),z=position.getZ(n);return (x<b.minX?1:0)|(x>b.maxX?2:0)|(z<b.minZ?4:0)|(z>b.maxZ?8:0);};
  const planes=[[pi,b.minX,1],[pi,b.maxX,-1],[pi+2,b.minZ,1],[pi+2,b.maxZ,-1]];
  const count=geo.index?.count??position.count;
  for(let t=0;t<count;t+=3){
    const a=geo.index?geo.index.getX(t):t,c=geo.index?geo.index.getX(t+1):t+1,d=geo.index?geo.index.getX(t+2):t+2;
    const ma=mask(a),mc=mask(c),md=mask(d);
    if(ma&mc&md)continue;
    if(!(ma|mc|md)){indices.push(original(a),original(c),original(d));continue;}
    let poly=[vertex(a),vertex(c),vertex(d)];
    for(const [axis,edge,sign] of planes){
      const next:Vertex[]=[];
      for(let i=0;i<poly.length;i++){
        const a=poly[i],z=poly[(i+1)%poly.length],da=(a.v[axis]-edge)*sign,dz=(z.v[axis]-edge)*sign;
        if(da>=0)next.push(a);
        if((da>=0)!==(dz>=0)){const f=da/(da-dz);next.push({v:a.v.map((v,k)=>v+(z.v[k]-v)*f),source:-1});}
      }
      poly=next;if(poly.length<3)break;
    }
    if(poly.length<3)continue;
    const ids=poly.map(({v,source})=>{
      if(source>=0)return original(source);
      const id=vertices++;for(let a=0;a<attrs.length;a++)for(let k=0;k<sizes[a];k++)out[a].push(v[offsets[a]+k]);return id;
    });
    for(let k=1;k<ids.length-1;k++)indices.push(ids[0],ids[k],ids[k+1]);
  }
  const result=new THREE.BufferGeometry();
  attrs.forEach(([name],i)=>result.setAttribute(name,new THREE.Float32BufferAttribute(out[i],sizes[i])));
  result.setIndex(indices);result.computeBoundingSphere();return result;
}
