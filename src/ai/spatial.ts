// Uniform-grid spatial hash for 2D (x,z) neighbor queries. Rebuilt each tick (cheap for < 1000 agents).
export class SpatialHash<T extends { x: number; z: number }> {
  private cells = new Map<number, T[]>();
  private pool: T[][] = [];
  readonly cell: number;
  constructor(cell = 16) { this.cell = cell; }

  private key(ix: number, iz: number) {
    return ((ix + 32768) << 16) | ((iz + 32768) & 0xffff);
  }

  clear() {
    for (const arr of this.cells.values()) { arr.length = 0; this.pool.push(arr); }
    this.cells.clear();
  }

  insert(item: T) {
    const k = this.key(Math.floor(item.x / this.cell), Math.floor(item.z / this.cell));
    let arr = this.cells.get(k);
    if (!arr) { arr = this.pool.pop() ?? []; this.cells.set(k, arr); }
    arr.push(item);
  }

  /** Calls fn for each item within radius r of (x,z). */
  query(x: number, z: number, r: number, fn: (item: T, d2: number) => void) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    const r2 = r * r;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const arr = this.cells.get(this.key(ix, iz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          const dx = it.x - x, dz = it.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= r2) fn(it, d2);
        }
      }
    }
  }
}

/** Static grid of indices (e.g. edges by bounding box) built once. */
export class StaticGrid {
  private cells = new Map<number, number[]>();
  readonly cell: number;
  constructor(cell = 64) { this.cell = cell; }
  private key(ix: number, iz: number) {
    return ((ix + 32768) << 16) | ((iz + 32768) & 0xffff);
  }
  addBox(id: number, minX: number, minZ: number, maxX: number, maxZ: number) {
    const c = this.cell;
    for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++)
      for (let iz = Math.floor(minZ / c); iz <= Math.floor(maxZ / c); iz++) {
        const k = this.key(ix, iz);
        let a = this.cells.get(k);
        if (!a) this.cells.set(k, (a = []));
        a.push(id);
      }
  }
  /** Unique ids whose boxes touch the square around (x,z) of half-size r. */
  query(x: number, z: number, r: number, out: Set<number> = new Set()): Set<number> {
    const c = this.cell;
    for (let ix = Math.floor((x - r) / c); ix <= Math.floor((x + r) / c); ix++)
      for (let iz = Math.floor((z - r) / c); iz <= Math.floor((z + r) / c); iz++) {
        const a = this.cells.get(this.key(ix, iz));
        if (a) for (const id of a) out.add(id);
      }
    return out;
  }
}
