import { Heightfield } from "./TerrainGenerator";
import { Noise2D, clamp } from "./noise";

export type BrushTool =
  | "raise"
  | "lower"
  | "flatten"
  | "smooth"
  | "roughen"
  | "mountain"
  | "valley"
  | "trench"
  | "island"
  | "basin"
  | "shelf"
  | "coastal";

export type BrushShape = "round" | "square" | "gauss";

export interface BrushParams {
  tool: BrushTool;
  radius: number; // m
  strength: number; // m per application
  falloff: number; // 0..1
  shape: BrushShape;
  pressure: number; // 0..1
}

const noise = new Noise2D(777);

function falloffWeight(d: number, r: number, p: BrushParams) {
  if (p.shape === "square") return d <= r ? 1 : 0;
  const t = clamp(1 - d / r, 0, 1);
  if (p.shape === "gauss") return Math.exp(-Math.pow(d / (r * 0.55), 2));
  return Math.pow(t, Math.max(0.05, p.falloff) * 3);
}

/** Apply a brush stroke to the heightfield at world coordinates (m). */
export function applyBrush(hf: Heightfield, wx: number, wy: number, p: BrushParams, seaLevel = 0) {
  const dx = hf.wx / hf.nx;
  const dy = hf.wy / hf.ny;
  const ri = Math.ceil(p.radius / dx);
  const ci = Math.floor((wx / hf.wx) * hf.nx);
  const cj = Math.floor((wy / hf.wy) * hf.ny);
  const i0 = Math.max(0, ci - ri),
    i1 = Math.min(hf.nx - 1, ci + ri);
  const j0 = Math.max(0, cj - ri),
    j1 = Math.min(hf.ny - 1, cj + ri);
  const strength = p.strength * clamp(p.pressure, 0.02, 1);

  // reference value for flatten
  let refValue = 0;
  if (p.tool === "flatten") refValue = hf.get(ci, cj);

  const src = p.tool === "smooth" ? hf.data.slice() : null;

  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const px = (i + 0.5) * dx,
        py = (j + 0.5) * dy;
      const d = Math.hypot(px - wx, py - wy);
      if (d > p.radius && p.shape !== "square") continue;
      const w = falloffWeight(d, p.radius, p);
      if (w <= 0) continue;
      const k = j * hf.nx + i;
      const cur = hf.data[k];
      switch (p.tool) {
        case "raise":
          hf.data[k] = cur + strength * w;
          break;
        case "lower":
          hf.data[k] = cur - strength * w;
          break;
        case "flatten":
          hf.data[k] = cur + (refValue - cur) * w * clamp(p.pressure, 0.02, 1);
          break;
        case "smooth": {
          const s = src!;
          const im = Math.max(0, i - 1),
            ip = Math.min(hf.nx - 1, i + 1);
          const jm = Math.max(0, j - 1),
            jp = Math.min(hf.ny - 1, j + 1);
          const avg =
            (s[j * hf.nx + im] + s[j * hf.nx + ip] + s[jm * hf.nx + i] + s[jp * hf.nx + i]) * 0.25;
          hf.data[k] = cur + (avg - cur) * w * clamp(p.pressure, 0.02, 1);
          break;
        }
        case "roughen":
          hf.data[k] = cur + noise.fbm(i * 0.18, j * 0.18, 4) * strength * w;
          break;
        case "mountain": {
          const t = clamp(1 - d / p.radius, 0, 1);
          const ridge = noise.ridged(i * 0.05, j * 0.05, 4);
          hf.data[k] = cur + strength * Math.pow(t, 1.6) * (0.6 + 0.9 * ridge) * 4;
          break;
        }
        case "valley": {
          const t = clamp(1 - d / p.radius, 0, 1);
          hf.data[k] = cur - strength * Math.pow(t, 1.1) * 2.2;
          break;
        }
        case "trench": {
          const t = clamp(1 - d / p.radius, 0, 1);
          hf.data[k] = cur - strength * Math.pow(t, 0.8) * 8;
          break;
        }
        case "island": {
          const t = clamp(1 - d / p.radius, 0, 1);
          const target = seaLevel + strength * 4 * Math.pow(t, 1.4) - (1 - t) * 0;
          hf.data[k] = Math.max(cur, cur + (target - cur) * w);
          break;
        }
        case "basin": {
          const t = clamp(1 - d / p.radius, 0, 1);
          const target = seaLevel - strength * 6 * Math.pow(t, 1.2);
          hf.data[k] = Math.min(cur, cur + (target - cur) * w);
          break;
        }
        case "shelf": {
          const target = seaLevel - 120;
          hf.data[k] = cur + (target - cur) * w * clamp(p.pressure, 0.02, 1) * 0.8;
          break;
        }
        case "coastal": {
          // blend towards a linear ramp crossing sea level through the brush centre
          const dirx = (px - wx) / Math.max(p.radius, 1);
          const target = seaLevel + dirx * strength * 6;
          hf.data[k] = cur + (target - cur) * w * clamp(p.pressure, 0.02, 1) * 0.7;
          break;
        }
      }
      if (!isFinite(hf.data[k])) hf.data[k] = cur;
    }
  }
}

export function normalizeField(hf: Heightfield, min: number, max: number) {
  const st = hf.stats();
  const range = st.max - st.min || 1;
  for (let k = 0; k < hf.data.length; k++) {
    hf.data[k] = min + ((hf.data[k] - st.min) / range) * (max - min);
  }
}

export function clampField(hf: Heightfield, min: number, max: number) {
  for (let k = 0; k < hf.data.length; k++) hf.data[k] = clamp(hf.data[k], min, max);
}

export function invertField(hf: Heightfield) {
  for (let k = 0; k < hf.data.length; k++) hf.data[k] = -hf.data[k];
}

export function scaleField(hf: Heightfield, f: number) {
  for (let k = 0; k < hf.data.length; k++) hf.data[k] *= f;
}

export function smoothWhole(hf: Heightfield, iterations = 1, amount = 0.5) {
  const tmp = new Float32Array(hf.data.length);
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < hf.ny; j++) {
      for (let i = 0; i < hf.nx; i++) {
        const k = j * hf.nx + i;
        const im = Math.max(0, i - 1),
          ip = Math.min(hf.nx - 1, i + 1);
        const jm = Math.max(0, j - 1),
          jp = Math.min(hf.ny - 1, j + 1);
        const avg =
          (hf.data[j * hf.nx + im] +
            hf.data[j * hf.nx + ip] +
            hf.data[jm * hf.nx + i] +
            hf.data[jp * hf.nx + i]) *
          0.25;
        tmp[k] = hf.data[k] + (avg - hf.data[k]) * amount;
      }
    }
    hf.data.set(tmp);
  }
}
