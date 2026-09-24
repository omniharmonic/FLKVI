import * as THREE from 'three';
import type { Bounds } from './stream-coordinates';
/** Clip road/water triangle attributes at ownership boundaries, preserving UVs and normals. */
export function clipGeometry(geo: THREE.BufferGeometry, b: Bounds): THREE.BufferGeometry {
  const attrs = Object.entries(geo.attributes) as [string, THREE.BufferAttribute][];
  const sizes = attrs.map(([,a]) => a.itemSize), offsets = sizes.map((_,i)=>sizes.slice(0,i).reduce((a,b)=>a+b,0));
  const pi = offsets[attrs.findIndex(([n])=>n==='position')];
  const out = attrs.map(()=>[] as number[]), indices: number[] = [];
  const vertex = (n: number) => attrs.flatMap(([,a])=>Array.from({length:a.itemSize},(_,k)=>a.array[n*a.itemSize+k]));
  geo.computeBoundingBox();
  const bb=geo.boundingBox!;
  if(bb.min.x>=b.minX&&bb.max.x<=b.maxX&&bb.min.z>=b.minZ&&bb.max.z<=b.maxZ)return geo;
  if(bb.max.x<b.minX||bb.min.x>b.maxX||bb.max.z<b.minZ||bb.min.z>b.maxZ)return new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([],3));
  const position=geo.attributes.position;
  const count = geo.index?.count ?? position.count;
  for (let t=0; t<count; t+=3) {
    const ids=[0,1,2].map(k=>geo.index?geo.index.getX(t+k):t+k);
    const xs=ids.map(n=>position.getX(n)),zs=ids.map(n=>position.getZ(n));
    if(Math.max(...xs)<b.minX||Math.min(...xs)>b.maxX||Math.max(...zs)<b.minZ||Math.min(...zs)>b.maxZ)continue;
    let poly = ids.map(vertex);
    for (const [axis,edge,sign] of [[pi,b.minX,1],[pi,b.maxX,-1],[pi+2,b.minZ,1],[pi+2,b.maxZ,-1]]) {
      const next: number[][]=[];
      for(let i=0;i<poly.length;i++) {
        const a=poly[i], z=poly[(i+1)%poly.length], da=(a[axis]-edge)*sign, dz=(z[axis]-edge)*sign;
        if(da>=0)next.push(a);
        if((da>=0)!==(dz>=0)){const f=da/(da-dz);next.push(a.map((v,k)=>v+(z[k]-v)*f));}
      }
      poly=next;
    }
    const base=out[0].length/sizes[0];
    for(const v of poly)for(let a=0;a<attrs.length;a++)out[a].push(...v.slice(offsets[a],offsets[a]+sizes[a]));
    for(let k=1;k<poly.length-1;k++)indices.push(base,base+k,base+k+1);
  }
  const result = new THREE.BufferGeometry();
  attrs.forEach(([n],i)=>result.setAttribute(n,new THREE.Float32BufferAttribute(out[i],sizes[i])));
  result.setIndex(indices);result.computeBoundingSphere();
  return result;
}
