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
  featherSeams(tiles, x0, x1, y0, y1, size);
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

/**
 * Terrarium mosaics mix sources tile by tile (3DEP lidar, 1/3" NED, SRTM…), so two neighbouring z15 tiles can
 * disagree by several metres along their shared edge — a straight cliff across the city. Measure the step along
 * every shared edge (each side extrapolated to the boundary, smoothed along the edge) and feather half of it into
 * each tile over `feather` pixels, so the mosaic is continuous without touching tile interiors.
 */
export function featherSeams(tiles: Map<string, Float32Array>, x0: number, x1: number, y0: number, y1: number, size = 256, feather = 96) {
  const corr = new Map<string, Float32Array>();
  const C = (k: string) => { let c = corr.get(k); if (!c) corr.set(k, (c = new Float32Array(size * size))); return c; };
  const smooth = (d: Float32Array, r = 10) => {
    const o = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const j = i + k; if (j < 0 || j >= d.length) continue; s += d[j]; n++; } o[i] = s / n; }
    return o;
  };
  const fall = (k: number) => { const t = Math.max(0, 1 - k / feather); return t * t * (3 - 2 * t); };
  let worst = 0;
  for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
    const A = tiles.get(`${tx}/${ty}`);
    if (!A) continue;
    // east neighbour (shared vertical edge)
    const E = tiles.get(`${tx + 1}/${ty}`);
    if (E) {
      const d = new Float32Array(size);
      for (let y = 0; y < size; y++) {
        const l = A[y * size + size - 1] + 0.5 * (A[y * size + size - 1] - A[y * size + size - 2]);
        const r = E[y * size] - 0.5 * (E[y * size + 1] - E[y * size]);
        d[y] = r - l;
      }
      const ds = smooth(d);
      const cA = C(`${tx}/${ty}`), cE = C(`${tx + 1}/${ty}`);
      for (let y = 0; y < size; y++) {
        worst = Math.max(worst, Math.abs(ds[y]));
        for (let k = 0; k < feather; k++) { const f = fall(k + 0.5) * ds[y] * 0.5; cA[y * size + size - 1 - k] += f; cE[y * size + k] -= f; }
      }
    }
    // south neighbour (shared horizontal edge)
    const S = tiles.get(`${tx}/${ty + 1}`);
    if (S) {
      const d = new Float32Array(size);
      for (let x = 0; x < size; x++) {
        const u = A[(size - 1) * size + x] + 0.5 * (A[(size - 1) * size + x] - A[(size - 2) * size + x]);
        const b = S[x] - 0.5 * (S[size + x] - S[x]);
        d[x] = b - u;
      }
      const ds = smooth(d);
      const cA = C(`${tx}/${ty}`), cS = C(`${tx}/${ty + 1}`);
      for (let x = 0; x < size; x++) {
        worst = Math.max(worst, Math.abs(ds[x]));
        for (let k = 0; k < feather; k++) { const f = fall(k + 0.5) * ds[x] * 0.5; cA[(size - 1 - k) * size + x] += f; cS[k * size + x] -= f; }
      }
    }
  }
  for (const [k, c] of corr) { const t = tiles.get(k)!; for (let i = 0; i < t.length; i++) t[i] += c[i]; }
  return worst;
}

/**
 * Low-pass for DEMs whose z15 source is a noisy surface model (SRTM-era canopy/roof returns: ±5 m blobs that turn
 * a flat city into rolling hills). A grey-scale opening (min then max over `openM`) first strips positive
 * canopy/roof bias while keeping step edges such as river bluffs, then a separable Gaussian (σ = `sigmaM`).
 */
export function denoiseHeights(h: Float64Array, cols: number, rows: number, cell: number, sigmaM: number, openM = 0) {
  const pass = (src: Float64Array, r: number, op: (a: number, b: number) => number, horiz: boolean) => {
    const out = new Float64Array(src.length);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      let v = src[y * cols + x];
      for (let k = -r; k <= r; k++) {
        const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        v = op(v, src[yy * cols + xx]);
      }
      out[y * cols + x] = v;
    }
    return out;
  };
  let a = h;
  const ro = Math.round(openM / cell);
  if (ro > 0) {
    a = pass(pass(a, ro, Math.min, true), ro, Math.min, false);
    a = pass(pass(a, ro, Math.max, true), ro, Math.max, false);
  }
  // water (bathymetry: a separate, much lower mode) is excluded from the blur so river banks stay put
  const sorted = Float64Array.from(a).sort();
  const med = sorted[sorted.length >> 1];
  const dev = Float64Array.from(a, (v) => Math.abs(v - med)).sort();
  const thr = med - 4 * dev[dev.length >> 1] - 2;
  const s = sigmaM / cell, R = Math.ceil(s * 3);
  const w: number[] = [];
  for (let k = -R; k <= R; k++) w.push(Math.exp(-(k * k) / (2 * s * s)));
  const blur = (src: Float64Array, horiz: boolean) => {
    const out = new Float64Array(src.length);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      let acc = 0, ws = 0;
      for (let k = -R; k <= R; k++) {
        const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        const v = src[yy * cols + xx];
        if (v < thr) continue;
        const wk = w[k + R]; acc += v * wk; ws += wk;
      }
      out[y * cols + x] = src[y * cols + x] < thr || ws <= 0 ? src[y * cols + x] : acc / ws;
    }
    return out;
  };
  if (s > 0.3) a = blur(blur(a, true), false);
  h.set(a);
}

/** Terrarium z at which pixel size ≈ target meters. */
export function zoomForCell(lat: number, cellM: number, maxZ = 15): number {
  const mpp0 = 156543.03 * Math.cos((lat * Math.PI) / 180);
  let z = Math.round(Math.log2(mpp0 / cellM));
  return Math.max(1, Math.min(maxZ, z));
}

export async function buildHeightfield(
  proj: Projection, minX: number, minZ: number, maxX: number, maxZ: number, cell: number, zoom: number,
  load: TileLoader, smoothPasses = 1, denoise?: { sigma: number; open?: number },
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
  if (denoise && denoise.sigma > 0) denoiseHeights(h, cols, rows, cell, denoise.sigma, denoise.open ?? 0);
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
