import { Heightfield } from "./TerrainGenerator";

export interface ImportOptions {
  worldWidth: number; // m
  worldLength: number; // m
  elevMin: number; // m mapped to value 0
  elevMax: number; // m mapped to value 1
  invert: boolean;
  seaLevelOffset: number; // m added after mapping
  targetRes: number;
  units: "m" | "ft";
  flipY: boolean;
}

export interface ImportResult {
  heightfield: Heightfield;
  sourceWidth: number;
  sourceHeight: number;
  format: string;
  min: number;
  max: number;
}

function mapValues(
  raw: Float32Array,
  w: number,
  h: number,
  o: ImportOptions,
  normalized: boolean
): Heightfield {
  let lo = Infinity,
    hi = -Infinity;
  for (let k = 0; k < raw.length; k++) {
    if (!isFinite(raw[k])) raw[k] = 0;
    if (raw[k] < lo) lo = raw[k];
    if (raw[k] > hi) hi = raw[k];
  }
  const range = hi - lo || 1;
  const unitScale = o.units === "ft" ? 0.3048 : 1;
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const jj = o.flipY ? h - 1 - j : j;
    for (let i = 0; i < w; i++) {
      let t = normalized ? raw[jj * w + i] : (raw[jj * w + i] - lo) / range;
      if (o.invert) t = 1 - t;
      out[j * w + i] = (o.elevMin + t * (o.elevMax - o.elevMin)) * unitScale + o.seaLevelOffset;
    }
  }
  const hf = new Heightfield(w, h, o.worldWidth, o.worldLength, out);
  return o.targetRes && o.targetRes !== w ? hf.resample(o.targetRes, o.targetRes) : hf;
}

export async function loadHeightmapFile(file: File, o: ImportOptions): Promise<ImportResult> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp")) {
    const img = await loadImage(file);
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable — cannot decode image heightmap.");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const raw = new Float32Array(c.width * c.height);
    for (let k = 0; k < raw.length; k++) {
      // 16-bit style packing support: R high byte, G low byte if G varies
      raw[k] = (d[k * 4] * 256 + d[k * 4 + 1]) / 65535;
    }
    const hf = mapValues(raw, c.width, c.height, o, true);
    const st = hf.stats();
    return { heightfield: hf, sourceWidth: c.width, sourceHeight: c.height, format: "IMAGE", min: st.min, max: st.max };
  }
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const text = await file.text();
    const rows = text
      .trim()
      .split(/\r?\n/)
      .map((r) => r.split(/[,;\t ]+/).filter((s) => s.length).map(Number));
    const h = rows.length;
    const w = rows[0]?.length ?? 0;
    if (!w || !h) throw new Error("CSV heightmap is empty or malformed.");
    const raw = new Float32Array(w * h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) raw[j * w + i] = rows[j][i] ?? 0;
    // CSV values are treated as real elevations in the selected unit
    const unitScale = o.units === "ft" ? 0.3048 : 1;
    for (let k = 0; k < raw.length; k++) raw[k] = raw[k] * unitScale + o.seaLevelOffset;
    let hf = new Heightfield(w, h, o.worldWidth, o.worldLength, raw);
    if (o.invert) for (let k = 0; k < hf.data.length; k++) hf.data[k] = -hf.data[k];
    if (o.targetRes && o.targetRes !== w) hf = hf.resample(o.targetRes, o.targetRes);
    const st = hf.stats();
    return { heightfield: hf, sourceWidth: w, sourceHeight: h, format: "CSV", min: st.min, max: st.max };
  }
  if (name.endsWith(".json")) {
    const j = JSON.parse(await file.text());
    const w = j.width ?? j.nx;
    const h = j.height ?? j.ny;
    const arr: number[] = j.data ?? j.elevation;
    if (!w || !h || !arr) throw new Error("JSON terrain requires {width,height,data[]}.");
    let hf = new Heightfield(w, h, j.worldWidth ?? o.worldWidth, j.worldLength ?? o.worldLength, Float32Array.from(arr));
    if (o.invert) for (let k = 0; k < hf.data.length; k++) hf.data[k] = -hf.data[k];
    if (o.targetRes && o.targetRes !== w) hf = hf.resample(o.targetRes, o.targetRes);
    const st = hf.stats();
    return { heightfield: hf, sourceWidth: w, sourceHeight: h, format: "JSON", min: st.min, max: st.max };
  }
  if (name.endsWith(".raw") || name.endsWith(".r16")) {
    const buf = await file.arrayBuffer();
    const u16 = new Uint16Array(buf);
    const side = Math.round(Math.sqrt(u16.length));
    if (side * side !== u16.length) throw new Error("RAW heightmap must be square 16-bit unsigned data.");
    const raw = new Float32Array(u16.length);
    for (let k = 0; k < u16.length; k++) raw[k] = u16[k] / 65535;
    const hf = mapValues(raw, side, side, o, true);
    const st = hf.stats();
    return { heightfield: hf, sourceWidth: side, sourceHeight: side, format: "RAW16", min: st.min, max: st.max };
  }
  if (name.endsWith(".tif") || name.endsWith(".tiff")) {
    throw new Error(
      "GeoTIFF decoding is not available in this build (no decoder bundled). Convert to 16-bit PNG, RAW or CSV and re-import."
    );
  }
  throw new Error("Unsupported terrain file type: " + file.name);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      res(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("Image could not be decoded."));
    };
    img.src = url;
  });
}

/** Render a heightfield to a small canvas for preview. */
export function heightfieldPreview(hf: Heightfield, size = 160): string {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(size, size);
  const st = hf.stats();
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const e = hf.sampleUV(i / (size - 1), j / (size - 1));
      const k = (j * size + i) * 4;
      let r: number, g: number, b: number;
      if (e < 0) {
        const t = Math.min(1, -e / Math.max(1, -st.min));
        r = 10 + 30 * (1 - t);
        g = 50 + 70 * (1 - t);
        b = 90 + 90 * (1 - t);
      } else {
        const t = Math.min(1, e / Math.max(1, st.max));
        r = 90 + 130 * t;
        g = 110 + 100 * t;
        b = 70 + 110 * t;
      }
      img.data[k] = r;
      img.data[k + 1] = g;
      img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}
