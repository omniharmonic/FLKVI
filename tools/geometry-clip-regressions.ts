import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clipGeometry } from '../src/world/clip.ts';
const bounds={minX:0,minZ:0,maxX:1,maxZ:1};
const area=(g:THREE.BufferGeometry)=>{
 const p=g.attributes.position,ix=g.index;let total=0;
 for(let i=0;i<(ix?.count??p.count);i+=3){const a=ix?ix.getX(i):i,b=ix?ix.getX(i+1):i+1,c=ix?ix.getX(i+2):i+2;
  total+=Math.abs((p.getX(b)-p.getX(a))*(p.getZ(c)-p.getZ(a))-(p.getX(c)-p.getX(a))*(p.getZ(b)-p.getZ(a)))/2;}
 return total;
};
const triangle=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([-1,0,0,2,0,0,0,0,2],3))
 .setAttribute('uv',new THREE.Float32BufferAttribute([-1,0,2,0,0,2],2))
 .setAttribute('normal',new THREE.Float32BufferAttribute([0,1,0,0,1,0,0,1,0],3));
for(const indexed of [false,true]){
 if(indexed)triangle.setIndex([0,1,2]);
 const clipped=clipGeometry(triangle,bounds),p=clipped.attributes.position,uv=clipped.attributes.uv,n=clipped.attributes.normal;
 assert(Math.abs(area(clipped)-1)<1e-6,'Clipped triangle must cover the complete unit square');
 for(let i=0;i<p.count;i++){
  assert(p.getX(i)>=0&&p.getX(i)<=1&&p.getZ(i)>=0&&p.getZ(i)<=1);
  assert(Math.abs(uv.getX(i)-p.getX(i))<1e-6&&Math.abs(uv.getY(i)-p.getZ(i))<1e-6,'Boundary UVs must interpolate without stretching');
  assert.equal(n.getY(i),1);
 }
 clipped.dispose();
}
assert.equal(clipGeometry(triangle,{minX:-3,minZ:-3,maxX:3,maxZ:3}),triangle,'Interior meshes should retain their buffers');
const empty=clipGeometry(triangle,{minX:10,minZ:10,maxX:11,maxZ:11});assert.equal(empty.attributes.position.count,0);empty.dispose();
const grid=new THREE.PlaneGeometry(8,8,80,80).rotateX(-Math.PI/2);
const clipped=clipGeometry(grid,{minX:-1,minZ:-1,maxX:1,maxZ:1});
assert(Math.abs(area(clipped)-4)<1e-5);
assert(clipped.attributes.position.count<clipped.index!.count/2,'Interior triangles must share vertices instead of tripling buffer size');
grid.dispose();clipped.dispose();triangle.dispose();
console.log('Geometry clipping passed: indexed/unindexed coverage, boundary attributes, empty/interior fast paths and shared vertex buffers');
