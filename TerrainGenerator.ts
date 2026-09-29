import { Noise2D, clamp, lerp, smoothstep } from "./noise";

export interface TerrainParams {
  seed: number;
  continentalScale: number; // km-ish scale of the landmass structure
  mountainScale: number;
  ridgeStrength: number;
  valleyStrength: number;
  coastalSlope: number; // 0..1 (1 = very steep coast)
  islandFrequency: number;
  oceanBasinDepth: number; // m (positive)
  seafloorRoughness: number;
  trenchDepth: number; // m (positive)
  shelfWidth: number; // fraction of world width
  erosion: number; // 0..1
  smoothing: number; // 0..1
  maxElevation: number; // m
  minDepth: number; // m (positive, clamp)
  landFraction: number; // fraction of world occupied by continent
  bayStrength: number;
  orientation: number; // degrees: direction the coastline faces
}

export const DEFAULT_TERRAIN_PARAMS: TerrainParams = {
  seed: 20260114,
  continentalScale: 1.0,
  mountainScale: 2.4,
  ridgeStrength: 0.75,
  valleyStrength: 0.45,
  coastalSlope: 0.45,
  islandFrequency: 0.35,
  oceanBasinDepth: 4200,
  seafloorRoughness: 0.35,
  trenchDepth: 6500,
  shelfWidth: 0.16,
  erosion: 0.35,
  smoothing: 0.25,
  maxElevation: 1800,
  minDepth: 8000,
  landFraction: 0.34,
  bayStrength: 0.6,
  orientation: 0,
};

/** A heightfield: elevation (m) relative to the geoid/sea-level datum (0). */
export class Heightfield {
  nx: number;
  ny: number;
  /** world width (m) */
  wx: number;
  wy: number;
  data: Float32Array;

  constructor(nx: number, ny: number, wx: number, wy: number, data?: Float32Array) {
    this.nx = nx;
    this.ny = ny;
    this.wx = wx;
    this.wy = wy;
    this.data = data ?? new Float32Array(nx * ny);
  }

  clone() {
    return new Heightfield(this.nx, this.ny, this.wx, this.wy, this.data.slice());
  }

  get(i: number, j: number) {
    const ii = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
    const jj = j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
    return this.data[jj * this.nx + ii];
  }

  /** Bilinear sample in normalized [0,1] coordinates. */
  sampleUV(u: number, v: number) {
    const x = clamp(u, 0, 1) * (this.nx - 1);
    const y = clamp(v, 0, 1) * (this.ny - 1);
    const i = Math.floor(x),
      j = Math.floor(y);
    const fx = x - i,
      fy = y - j;
    const a = this.get(i, j),
      b = this.get(i + 1, j),
      c = this.get(i, j + 1),
      d = this.get(i + 1, j + 1);
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  }

  /** Resample to another resolution. */
  resample(nx: number, ny: number) {
    const out = new Heightfield(nx, ny, this.wx, this.wy);
    for (let j = 0; j < ny; j++) {
      const v = ny > 1 ? j / (ny - 1) : 0;
      for (let i = 0; i < nx; i++) {
        const u = nx > 1 ? i / (nx - 1) : 0;
        out.data[j * nx + i] = this.sampleUV(u, v);
      }
    }
    return out;
  }

  stats() {
    let min = Infinity,
      max = -Infinity,
      land = 0;
    for (let k = 0; k < this.data.length; k++) {
      const e = this.data[k];
      if (e < min) min = e;
      if (e > max) max = e;
      if (e > 0) land++;
    }
    return { min, max, landFraction: land / this.data.length };
  }
}

function smoothField(field: Float32Array, nx: number, ny: number, iterations: number, amount: number) {
  if (iterations <= 0 || amount <= 0) return;
  const tmp = new Float32Array(field.length);
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const im = i > 0 ? i - 1 : 0,
          ip = i < nx - 1 ? i + 1 : nx - 1;
        const jm = j > 0 ? j - 1 : 0,
          jp = j < ny - 1 ? j + 1 : ny - 1;
        const avg =
          (field[j * nx + im] + field[j * nx + ip] + field[jm * nx + i] + field[jp * nx + i]) * 0.25;
        tmp[k] = lerp(field[k], avg, amount);
      }
    }
    field.set(tmp);
  }
}

/** Cheap thermal-style erosion pass: moves material downslope. */
function erode(field: Float32Array, nx: number, ny: number, strength: number, passes: number) {
  if (strength <= 0) return;
  const talus = 1.2;
  for (let p = 0; p < passes; p++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        const h = field[k];
        if (h < 0) continue;
        let lowest = k,
          lowH = h;
        const nb = [k - 1, k + 1, k - nx, k + nx];
        for (const n of nb) {
          if (field[n] < lowH) {
            lowH = field[n];
            lowest = n;
          }
        }
        if (lowest !== k) {
          const d = h - lowH;
          if (d > talus) {
            const move = (d - talus) * 0.25 * strength;
            field[k] -= move;
            field[lowest] += move;
          }
        }
      }
    }
  }
}

export function generateTerrain(
  nx: number,
  ny: number,
  wx: number,
  wy: number,
  p: TerrainParams
): Heightfield {
  const hf = new Heightfield(nx, ny, wx, wy);
  const n1 = new Noise2D(p.seed);
  const n2 = new Noise2D(p.seed + 9871);
  const n3 = new Noise2D(p.seed + 4421);
  const n4 = new Noise2D(p.seed + 1337);

  const rad = (p.orientation * Math.PI) / 180;
  const cosO = Math.cos(rad),
    sinO = Math.sin(rad);

  const worldKm = Math.max(wx, wy) / 1000;
  // Noise frequency in cycles across the world, scaled by physical size
  const fCont = 0.9 * p.continentalScale * clamp(worldKm / 100, 0.35, 4);
  const fMtn = 3.2 * p.mountainScale * clamp(worldKm / 100, 0.4, 6);

  for (let j = 0; j < ny; j++) {
    const v = ny > 1 ? j / (ny - 1) : 0;
    for (let i = 0; i < nx; i++) {
      const u = nx > 1 ? i / (nx - 1) : 0;
      // rotated coastline axis: 'a' runs offshore->inland
      const cx = u - 0.5,
        cy = v - 0.5;
      const a = cx * cosO + cy * sinO + 0.5;
      const b = -cx * sinO + cy * cosO + 0.5;

      // Coastline position, warped by noise (creates bays and peninsulas)
      const warp =
        n1.fbm(b * fCont * 2.2, a * 0.6 * fCont, 4) * 0.12 * p.bayStrength +
        n2.fbm(b * fCont * 5.0 + 11.3, 3.7, 3) * 0.05 * p.bayStrength;
      const coast = 1 - p.landFraction + warp;

      // signed distance from coast in normalized units (>0 inland)
      const s = a - coast;

      let elev: number;
      if (s >= 0) {
        // ---- LAND ----
        const inland = clamp(s / Math.max(0.05, p.landFraction), 0, 1);
        const coastalPlain = Math.pow(inland, lerp(1.6, 0.55, p.coastalSlope)) * 180;
        const base = n1.fbm(b * fCont * 1.6, a * fCont * 1.6, 5) * 0.5 + 0.5;
        const ridges = n3.ridged(b * fMtn * 0.5 + 4.1, a * fMtn * 0.5 - 2.3, 6);
        const valleys = 1 - Math.pow(Math.abs(n4.fbm(b * fMtn * 0.8, a * fMtn * 0.8, 4)), 0.6);
        const mtnMask = smoothstep(0.08, 0.7, inland);
        const mountains =
          (ridges * p.ridgeStrength + base * 0.45) * mtnMask * p.maxElevation -
          valleys * p.valleyStrength * 220 * mtnMask;
        elev = coastalPlain + mountains;
        // beach flattening near coast
        elev *= smoothstep(-0.002, 0.03, s) * 0.9 + 0.1;
        elev = Math.max(elev, 0.4 * smoothstep(0, 0.01, s));
      } else {
        // ---- OCEAN ----
        const off = clamp(-s / Math.max(0.05, 1 - p.landFraction), 0, 1); // 0 at coast -> 1 far offshore
        const shelfW = clamp(p.shelfWidth, 0.01, 0.8);
        let depth: number;
        if (off < shelfW) {
          // continental shelf: gentle
          const t = off / shelfW;
          depth = lerp(2, 180, Math.pow(t, 0.8));
        } else {
          // slope then abyssal plain
          const t = clamp((off - shelfW) / 0.35, 0, 1);
          depth = lerp(180, p.oceanBasinDepth, smoothstep(0, 1, t));
        }
        // trench parallel to coast in the deep region
        const trenchPos = shelfW + 0.42;
        const tw = 0.07;
        const trench =
          Math.exp(-Math.pow((off - trenchPos) / tw, 2)) *
          p.trenchDepth *
          (0.55 + 0.45 * (n2.fbm(b * 3.0, 7.7, 3) * 0.5 + 0.5));
        depth += trench;
        // seafloor roughness (seamounts, abyssal hills)
        depth += n2.fbm(b * fMtn * 0.6, a * fMtn * 0.6, 5) * p.seafloorRoughness * 900;
        elev = -depth;

        // ---- ISLANDS ----
        if (p.islandFrequency > 0.001) {
          const iN = n4.fbm(b * fCont * 3.4 + 21.7, a * fCont * 3.4 - 8.9, 4) * 0.5 + 0.5;
          const thresh = 1 - p.islandFrequency * 0.55;
          if (iN > thresh) {
            const t = (iN - thresh) / (1 - thresh);
            const cone = Math.pow(t, 0.75);
            const peak = p.maxElevation * 0.55 * cone;
            const seaMount = lerp(elev, peak, smoothstep(0, 1, cone));
            elev = Math.max(elev, seaMount * smoothstep(0.03, 0.4, off));
          }
        }
      }

      hf.data[j * nx + i] = elev;
    }
  }

  erode(hf.data, nx, ny, p.erosion, Math.round(p.erosion * 6));
  smoothField(hf.data, nx, ny, Math.max(1, Math.round(p.smoothing * 6)), p.smoothing * 0.8);

  // clamp
  for (let k = 0; k < hf.data.length; k++) {
    let e = hf.data[k];
    if (!isFinite(e)) e = 0;
    hf.data[k] = clamp(e, -p.minDepth, p.maxElevation * 1.2);
  }
  return hf;
}

export function flatOceanTerrain(nx: number, ny: number, wx: number, wy: number, depth: number) {
  const hf = new Heightfield(nx, ny, wx, wy);
  hf.data.fill(-Math.abs(depth));
  return hf;
}
