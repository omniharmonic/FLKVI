// OWNER: compiler agent. AWS Terrain Tiles (Terrarium) → local heightfields.
import type { Terrain } from '../core/types.ts';
import type { Projection } from '../core/geo.ts';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** Decoded tile: RGB(A) bytes, width/height, channels per pixel. */
export interface DecodedTile { width: number; height: number; channels: number; data: Uint8Array | Uint8ClampedArray }
export type TileLoader = (z: number, x: number, y: number) => Promise<DecodedTile>;

function lonToTileX(lon: number, z: number) { return ((lon + 180) / 360) * 2 ** z; }
function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/** Elevation mosaic: fetches needed tiles and bilinearly samples elevation (m) at lat/lon. */
export async function makeElevationSampler(
  latMin: number, lonMin: number, latMax: number, lonMax: number, z: number, load: TileLoader,
): Promise<(lat: number, lon: number) => number> {
  const x0 = Math.floor(lonToTileX(lonMin, z)), x1 = Math.floor(lonToTileX(lonMax, z));
  const y0 = Math.floor(latToTileY(latMax, z)), y1 = Math.floor(latToTileY(latMin, z));
  const tiles = new Map<string, Float32Array>();
  const jobs: Promise<void>[] = [];
  for (let tx = x0; tx <= x1; tx++)
    for (let ty = y0; ty <= y1; ty++) {
      jobs.push((async () => {
        let t: DecodedTile | null = null;
        for (let a = 0; a < 3 && !t; a++) {
          try { t = await load(z, tx, ty); } catch (e) { if (a === 2) throw e; await new Promise((r) => setTimeout(r, 500 * (a + 1))); }
        }
        const { width, height, channels, data } = t!;
        const h = new Float32Array(width * height);
        for (let i = 0; i < width * height; i++) {
          const o = i * channels;
          h[i] = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
        }
        despike(h, width, height);
        tiles.set(`${tx}/${ty}`, h);
      })());
    }
  await Promise.all(jobs);
  const size = 256;
  const px = (gx: number, gy: number): number => {
    const tx = Math.floor(gx / size), ty = Math.floor(gy / size);
    let t = tiles.get(`${tx}/${ty}`);
    let lx = gx - tx * size, ly = gy - ty * size;
    if (!t) {
      // clamp into available mosaic
      const cx = Math.min(Math.max(tx, x0), x1), cy = Math.min(Math.max(ty, y0), y1);
      t = tiles.get(`${cx}/${cy}`)!;
      lx = Math.min(Math.max(gx - cx * size, 0), size - 1); ly = Math.min(Math.max(gy - cy * size, 0), size - 1);
    }
    return t[ly * size + lx];
  };
  return (lat: number, lon: number) => {
    const gx = lonToTileX(lon, z) * size - 0.5, gy = latToTileY(lat, z) * size - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const a = px(ix, iy), b = px(ix + 1, iy), c = px(ix, iy + 1), d = px(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/**
 * Terrarium tiles carry occasional bogus pixels (nodata pits of −100 m and worse, isolated spikes).
 * Replace any pixel that differs from the median of its 8 neighbours by more than `tol` m.
 */
export function despike(h: Float32Array, w: number, ht: number, tol = 25) {
  const nb = new Float32Array(8);
  const fixes: [number, number][] = [];
  for (let y = 0; y < ht; y++) for (let x = 0; x < w; x++) {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= ht) continue;
      nb[k++] = h[yy * w + xx];
    }
    if (k < 3) continue;
    const a = Array.from(nb.subarray(0, k)).sort((p, q) => p - q);
    const med = k % 2 ? a[(k - 1) / 2] : (a[k / 2 - 1] + a[k / 2]) / 2;
    const v = h[y * w + x];
    if (Math.abs(v - med) > tol || v < -500) fixes.push([y * w + x, med]);
  }
  for (const [i, m] of fixes) h[i] = m;
}

/** Terrarium z at which pixel size ≈ target meters. */
export function zoomForCell(lat: number, cellM: number, maxZ = 15): number {
  const mpp0 = 156543.03 * Math.cos((lat * Math.PI) / 180);
  let z = Math.round(Math.log2(mpp0 / cellM));
  return Math.max(1, Math.min(maxZ, z));
}

export async function buildHeightfield(
  proj: Projection, minX: number, minZ: number, maxX: number, maxZ: number, cell: number, zoom: number,
  load: TileLoader, smoothPasses = 1,
): Promise<Terrain> {
  const cols = Math.ceil((maxX - minX) / cell) + 1, rows = Math.ceil((maxZ - minZ) / cell) + 1;
  const sw = proj.toLatLon(minX - cell, maxZ + cell), ne = proj.toLatLon(maxX + cell, minZ - cell);
  const sample = await makeElevationSampler(sw.lat, sw.lon, ne.lat, ne.lon, zoom, load);
  let h = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const ll = proj.toLatLon(minX + c * cell, minZ + r * cell);
      let v = sample(ll.lat, ll.lon);
      if (!isFinite(v) || v < -500 || v > 9000) v = 0;
      h[r * cols + c] = v;
    }
  // light smoothing: separable [1 2 1]/4
  for (let pass = 0; pass < smoothPasses; pass++) {
    const t = new Float64Array(h.length);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const l = h[r * cols + Math.max(0, c - 1)], m = h[r * cols + c], rr = h[r * cols + Math.min(cols - 1, c + 1)];
        t[r * cols + c] = (l + 2 * m + rr) / 4;
      }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const u = t[Math.max(0, r - 1) * cols + c], m = t[r * cols + c], d = t[Math.min(rows - 1, r + 1) * cols + c];
        h[r * cols + c] = (u + 2 * m + d) / 4;
      }
  }
  return { cols, rows, originX: minX, originZ: minZ, cellSize: cell, heights: Array.from(h) };
}

export function terrainSampler(t: Terrain) {
  return (x: number, z: number): number => {
    let fx = (x - t.originX) / t.cellSize, fz = (z - t.originZ) / t.cellSize;
    fx = Math.min(Math.max(fx, 0), t.cols - 1.0001); fz = Math.min(Math.max(fz, 0), t.rows - 1.0001);
    const c = Math.floor(fx), r = Math.floor(fz), ax = fx - c, az = fz - r;
    const H = t.heights, C = t.cols;
    const a = H[r * C + c], b = H[r * C + c + 1], cc = H[(r + 1) * C + c], d = H[(r + 1) * C + c + 1];
    return (a * (1 - ax) + b * ax) * (1 - az) + (cc * (1 - ax) + d * ax) * az;
  };
}

/** Browser tile loader: fetch + createImageBitmap + OffscreenCanvas. */
export function browserTileLoader(signal?: AbortSignal): TileLoader {
  return async (z, x, y) => {
    const url = TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const res = await fetch(url, { signal, mode: 'cors' });
    if (!res.ok) throw new Error(`terrain tile ${z}/${x}/${y}: HTTP ${res.status}`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } as ImageBitmapOptions);
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' } as any) as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close?.();
    return { width: img.width, height: img.height, channels: 4, data: img.data };
  };
}
