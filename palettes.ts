export type RGB = [number, number, number];

export interface Palette {
  id: string;
  name: string;
  stops: { t: number; c: RGB }[];
}

function mk(id: string, name: string, colors: string[]): Palette {
  return {
    id,
    name,
    stops: colors.map((c, i) => ({ t: i / (colors.length - 1), c: hex(c) })),
  };
}

export function hex(h: string): RGB {
  const v = parseInt(h.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export const PALETTES: Record<string, Palette> = {
  depth: mk("depth", "Depth (blue→cyan→white)", ["#04121f", "#0a2e52", "#1667a8", "#3fb3d6", "#c9f0ff"]),
  elevation: mk("elevation", "Elevation (green→tan→white)", ["#1d4023", "#4f7a34", "#9d9a5a", "#8a6a42", "#6b5343", "#ffffff"]),
  wave: mk("wave", "Wave height (dark→red)", ["#101014", "#3d2a10", "#8a6410", "#d9a021", "#e8631c", "#c0202a"]),
  arrival: mk("arrival", "Arrival (early→late)", ["#f5e6c8", "#d9a021", "#a35c2a", "#5a3b6b", "#1b2a4a"]),
  velocity: mk("velocity", "Velocity", ["#0b0e12", "#1d3c4c", "#2f7f87", "#8fc48b", "#f2e08a", "#d2542c"]),
  diverging: mk("diverging", "Diverging (−/+)", ["#1a3f6b", "#3f7fb5", "#e8e4da", "#c98a3a", "#8c2a1f"]),
  copper: mk("copper", "Copper", ["#14100e", "#432a1c", "#7d4a28", "#b5763c", "#e2b07a", "#f6e3c9"]),
  grayscale: mk("grayscale", "Greyscale", ["#0a0a0a", "#4a4a4a", "#9a9a9a", "#f0f0f0"]),
};

export function samplePalette(p: Palette, t: number): RGB {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const s = p.stops;
  for (let i = 0; i < s.length - 1; i++) {
    if (x >= s[i].t && x <= s[i + 1].t) {
      const f = (x - s[i].t) / (s[i + 1].t - s[i].t || 1);
      return [
        s[i].c[0] + (s[i + 1].c[0] - s[i].c[0]) * f,
        s[i].c[1] + (s[i + 1].c[1] - s[i].c[1]) * f,
        s[i].c[2] + (s[i + 1].c[2] - s[i].c[2]) * f,
      ];
    }
  }
  return s[s.length - 1].c;
}

export function paletteCss(p: Palette) {
  return `linear-gradient(90deg, ${p.stops
    .map((s) => `rgb(${s.c[0]},${s.c[1]},${s.c[2]}) ${(s.t * 100).toFixed(0)}%`)
    .join(", ")})`;
}

/** Terrain material classification from elevation + slope. */
export function terrainMaterialColor(elev: number, slope: number, seaLevel: number, maxEl: number): RGB {
  if (elev < seaLevel) {
    const d = seaLevel - elev;
    if (d > 3000) return [10, 24, 42];
    if (d > 1200) return [14, 38, 62];
    if (d > 300) return [22, 54, 82];
    if (d > 60) return [34, 78, 104];
    return [56, 104, 122];
  }
  const rel = Math.min(1, (elev - seaLevel) / Math.max(200, maxEl));
  const rock = Math.min(1, slope * 2.2);
  let base: RGB;
  if (elev - seaLevel < 6) base = [201, 182, 140]; // beach
  else if (rel < 0.06) base = [104, 124, 74]; // coastal plain
  else if (rel < 0.2) base = [86, 110, 62]; // grassland
  else if (rel < 0.42) base = [62, 86, 52]; // forest
  else if (rel < 0.72) base = [104, 94, 78]; // mountain
  else base = [150, 148, 142]; // high mountain
  if (rel > 0.85) {
    const s = Math.min(1, (rel - 0.85) / 0.15);
    base = [base[0] + (240 - base[0]) * s, base[1] + (242 - base[1]) * s, base[2] + (246 - base[2]) * s];
  }
  const r: RGB = [
    base[0] * (1 - rock) + 122 * rock,
    base[1] * (1 - rock) + 114 * rock,
    base[2] * (1 - rock) + 104 * rock,
  ];
  return r;
}
