// Thin wrapper over three's earcut triangulator (ShapeUtils).
import * as THREE from 'three';

/** Triangulate a 2D contour with holes. Returns index triples into contour.concat(...holes). */
export function triangulate(contour: [number, number][], holes: [number, number][][] = []): number[][] {
  const c = contour.map((p) => new THREE.Vector2(p[0], p[1]));
  const h = holes.map((r) => r.map((p) => new THREE.Vector2(p[0], p[1])));
  return THREE.ShapeUtils.triangulateShape(c, h);
}
