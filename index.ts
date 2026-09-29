import { clamp } from "../terrain/noise";

export type SourceKind = "fault" | "asteroid" | "explosion" | "custom" | "manual";

export interface GridInfo {
  nx: number;
  ny: number;
  dx: number;
  dy: number;
}

/** Result of evaluating a source: a vertical displacement field (m). */
export interface DisplacementField {
  /** seafloor / bed vertical displacement (m) */
  bed: Float32Array;
  /** additional direct water-surface displacement (m) */
  water: Float32Array;
  /** time (s) at which each portion is released; for staged/ruptured sources */
  duration: number;
  /** stage list for time-dependent release */
  stages: { t: number; weightBed: Float32Array | null; weightWater: Float32Array | null }[];
  info: Record<string, number | string>;
}

// ---------------------------------------------------------------- FAULT

export interface FaultSegment {
  id: string;
  /** centre position in world metres */
  x: number;
  y: number;
  length: number; // m
  width: number; // m
  depth: number; // km, top depth
  strike: number; // deg
  dip: number; // deg
  rake: number; // deg
  slip: number; // m
  startTime: number; // s (rupture onset)
}

export interface FaultParams {
  magnitude: number;
  segments: FaultSegment[];
  ruptureVelocity: number; // km/s
  ruptureDuration: number; // s
  rigidity: number; // Pa
  autoSlipFromMagnitude: boolean;
}

export function momentFromFault(seg: FaultSegment, rigidity: number) {
  return rigidity * seg.length * seg.width * seg.slip;
}

export function magnitudeFromMoment(m0: number) {
  if (m0 <= 0) return 0;
  return (2 / 3) * (Math.log10(m0) - 9.1);
}

export function slipFromMagnitude(mw: number, area: number, rigidity: number) {
  const m0 = Math.pow(10, 1.5 * mw + 9.1);
  return m0 / (rigidity * Math.max(area, 1));
}

/**
 * Simplified elastic dislocation vertical displacement for a rectangular
 * fault.  This is an analytic approximation to the Okada (1985) surface
 * deformation: an along-strike smoothed boxcar multiplied by an
 * across-strike asymmetric uplift/subsidence couple whose width scales with
 * source depth, with amplitude  u_z ~ slip * sin(dip) * sin(rake).
 */
export function faultDisplacement(
  grid: GridInfo,
  seg: FaultSegment,
  out: Float32Array,
  scale = 1
) {
  const { nx, ny, dx, dy } = grid;
  const strike = (seg.strike * Math.PI) / 180;
  const cs = Math.cos(strike),
    sn = Math.sin(strike);
  const dipR = (seg.dip * Math.PI) / 180;
  const rakeR = (seg.rake * Math.PI) / 180;
  const depthM = seg.depth * 1000;
  // Effective deformation half-width across strike: fault width projection +
  // depth-controlled smoothing of the elastic response.
  const W = Math.max(seg.width * Math.cos(dipR), 1000) * 0.5 + depthM * 0.75;
  const L = seg.length * 0.5;
  const amp = seg.slip * Math.sin(dipR) * Math.sin(rakeR) * scale;
  // Centroid offset of the uplift lobe towards the hanging wall
  const off = W * 0.55;

  for (let j = 0; j < ny; j++) {
    const wy = (j + 0.5) * dy;
    for (let i = 0; i < nx; i++) {
      const wx = (i + 0.5) * dx;
      const rx = wx - seg.x;
      const ry = wy - seg.y;
      // rotate into fault frame: p along strike, q across strike
      const p = rx * cs + ry * sn;
      const q = -rx * sn + ry * cs;
      // along-strike smoothed boxcar
      const alongArg = (Math.abs(p) - L) / (W * 0.9);
      const along = 1 / (1 + Math.exp(alongArg * 3));
      if (along < 1e-4) continue;
      // across-strike: uplift lobe (hanging wall) + subsidence lobe (footwall)
      const a = (q - off) / W;
      const b = (q + off * 1.35) / (W * 1.35);
      const up = Math.exp(-a * a);
      const down = -0.52 * Math.exp(-b * b);
      out[j * nx + i] += amp * along * (up + down);
    }
  }
  return out;
}

export function buildFaultSource(grid: GridInfo, params: FaultParams): DisplacementField {
  const n = grid.nx * grid.ny;
  const bed = new Float32Array(n);
  const water = new Float32Array(n);
  const stages: DisplacementField["stages"] = [];
  let m0 = 0;
  const vr = Math.max(0.1, params.ruptureVelocity) * 1000;
  let maxT = 0;
  for (const seg of params.segments) {
    const f = new Float32Array(n);
    faultDisplacement(grid, seg, f, 1);
    m0 += momentFromFault(seg, params.rigidity);
    const segDur = Math.max(1, seg.length / vr);
    const t0 = seg.startTime;
    maxT = Math.max(maxT, t0 + segDur);
    // discretise the rupture into 4 sub-stages along its duration
    const sub = 4;
    for (let s = 0; s < sub; s++) {
      const w = new Float32Array(n);
      for (let k = 0; k < n; k++) w[k] = f[k] / sub;
      stages.push({ t: t0 + (segDur * (s + 1)) / sub, weightBed: w, weightWater: null });
    }
    for (let k = 0; k < n; k++) bed[k] += f[k];
  }
  stages.sort((a, b) => a.t - b.t);
  return {
    bed,
    water,
    duration: Math.max(maxT, params.ruptureDuration),
    stages,
    info: {
      seismicMoment: m0,
      magnitude: magnitudeFromMoment(m0),
      segments: params.segments.length,
    },
  };
}

// ---------------------------------------------------------------- ASTEROID

export interface AsteroidParams {
  diameter: number; // m
  density: number; // kg/m^3
  velocity: number; // km/s
  angle: number; // deg from horizontal
  x: number;
  y: number;
  couplingEfficiency: number; // 0..1 fraction of KE coupled to the water
}

export interface ImpactResult {
  mass: number;
  energy: number; // J
  energyMt: number;
  impulse: number;
  cavityRadius: number;
  cavityDepth: number;
  displacedVolume: number;
  onLand: boolean;
  waterDepth: number;
}

export function asteroidMetrics(
  p: AsteroidParams,
  waterDepth: number,
  gravity: number
): ImpactResult {
  const r = p.diameter / 2;
  const mass = ((4 / 3) * Math.PI * r * r * r) * p.density;
  const v = p.velocity * 1000;
  const angleFactor = Math.pow(Math.sin(clamp((p.angle * Math.PI) / 180, 0.05, Math.PI / 2)), 1 / 3);
  const energy = 0.5 * mass * v * v * p.couplingEfficiency * angleFactor;
  const impulse = mass * v * Math.sin((p.angle * Math.PI) / 180);
  // Ward & Asphaug (2000) style transient cavity scaling
  const rhoW = 1000;
  const cavityRadius = 1.88 * Math.pow(energy / (rhoW * gravity), 0.22);
  const onLand = waterDepth <= 1;
  const cavityDepth = onLand
    ? Math.min(cavityRadius * 0.35, 2000)
    : Math.min(cavityRadius, waterDepth * 1.0);
  const displacedVolume = 0.5 * Math.PI * cavityRadius * cavityRadius * cavityDepth;
  return {
    mass,
    energy,
    energyMt: energy / 4.184e15,
    impulse,
    cavityRadius,
    cavityDepth,
    displacedVolume,
    onLand,
    waterDepth,
  };
}

/**
 * Volume-conserving impact cavity: a paraboloid depression surrounded by a
 * raised rim whose volume exactly balances the excavated water, so the
 * solver's total water volume is unchanged by the source.
 */
export function buildAsteroidSource(
  grid: GridInfo,
  p: AsteroidParams,
  metrics: ImpactResult
): DisplacementField {
  const n = grid.nx * grid.ny;
  const bed = new Float32Array(n);
  const water = new Float32Array(n);
  const Rc = metrics.cavityRadius;
  const Dc = metrics.cavityDepth;
  const Rd = Rc * 2.6; // outer rim radius
  // cavity volume (paraboloid) = 0.5*pi*Rc^2*Dc ; rim must balance it
  const cavVol = 0.5 * Math.PI * Rc * Rc * Dc;
  // rim profile: A * sin(pi*(r-Rc)/(Rd-Rc)) -> volume = A * integral
  const rimW = Rd - Rc;
  let rimIntegral = 0;
  const steps = 200;
  for (let s = 0; s < steps; s++) {
    const r = Rc + (rimW * (s + 0.5)) / steps;
    rimIntegral += Math.sin((Math.PI * (r - Rc)) / rimW) * 2 * Math.PI * r * (rimW / steps);
  }
  const A = rimIntegral > 0 ? cavVol / rimIntegral : 0;

  for (let j = 0; j < grid.ny; j++) {
    const wy = (j + 0.5) * grid.dy;
    for (let i = 0; i < grid.nx; i++) {
      const wx = (i + 0.5) * grid.dx;
      const d = Math.hypot(wx - p.x, wy - p.y);
      const k = j * grid.nx + i;
      let dz = 0;
      if (d < Rc) dz = -Dc * (1 - (d * d) / (Rc * Rc));
      else if (d < Rd) dz = A * Math.sin((Math.PI * (d - Rc)) / rimW);
      if (dz === 0) continue;
      if (metrics.onLand) {
        // excavate terrain for a land impact
        bed[k] += dz * 0.6;
        water[k] += dz * 0.4;
      } else {
        water[k] += dz;
        // partial seafloor cratering for shallow water
        if (metrics.waterDepth < Rc) bed[k] += dz * 0.25 * (1 - metrics.waterDepth / Rc);
      }
    }
  }
  return {
    bed,
    water,
    duration: 0,
    stages: [{ t: 0, weightBed: bed.slice(), weightWater: water.slice() }],
    info: {
      mass: metrics.mass,
      energy: metrics.energy,
      cavityRadius: Rc,
      cavityDepth: Dc,
      displacedVolume: metrics.displacedVolume,
    },
  };
}

// ---------------------------------------------------------------- EXPLOSION

export interface ExplosionParams {
  yieldKt: number;
  depth: number; // m below surface (0 = surface burst)
  x: number;
  y: number;
  burstType: "underwater" | "surface" | "airburst";
  coupling: number; // 0..1
  radiusScale: number;
}

export interface ExplosionMetrics {
  energy: number;
  cavityRadius: number;
  cavityDepth: number;
  displacedVolume: number;
  couplingEff: number;
}

export function explosionMetrics(
  p: ExplosionParams,
  waterDepth: number,
  gravity: number
): ExplosionMetrics {
  const energy = p.yieldKt * 4.184e12;
  let couplingEff = p.coupling;
  if (p.burstType === "airburst") couplingEff *= 0.08;
  if (p.burstType === "surface") couplingEff *= 0.45;
  // depth-of-burst efficiency: peaks near optimum depth ~ cavity radius
  const E = energy * couplingEff;
  const rhoW = 1000;
  let Rc = 1.88 * Math.pow(Math.max(E, 1) / (rhoW * gravity), 0.22) * p.radiusScale;
  const dob = Math.abs(p.depth);
  const eff = Math.exp(-Math.pow((dob - Rc * 0.35) / (Rc * 1.1 + 1), 2) * 0.6);
  Rc *= 0.6 + 0.4 * eff;
  const cavityDepth = Math.min(Rc * 0.8, Math.max(waterDepth, 1));
  return {
    energy,
    cavityRadius: Rc,
    cavityDepth,
    displacedVolume: 0.5 * Math.PI * Rc * Rc * cavityDepth,
    couplingEff,
  };
}

export function buildExplosionSource(
  grid: GridInfo,
  p: ExplosionParams,
  m: ExplosionMetrics
): DisplacementField {
  const n = grid.nx * grid.ny;
  const bed = new Float32Array(n);
  const water = new Float32Array(n);
  const Rc = m.cavityRadius;
  const Dc = m.cavityDepth;
  const Rd = Rc * 2.2;
  const cavVol = 0.5 * Math.PI * Rc * Rc * Dc;
  const rimW = Rd - Rc;
  let rimIntegral = 0;
  const steps = 200;
  for (let s = 0; s < steps; s++) {
    const r = Rc + (rimW * (s + 0.5)) / steps;
    rimIntegral += Math.sin((Math.PI * (r - Rc)) / rimW) * 2 * Math.PI * r * (rimW / steps);
  }
  const A = rimIntegral > 0 ? cavVol / rimIntegral : 0;
  for (let j = 0; j < grid.ny; j++) {
    const wy = (j + 0.5) * grid.dy;
    for (let i = 0; i < grid.nx; i++) {
      const wx = (i + 0.5) * grid.dx;
      const d = Math.hypot(wx - p.x, wy - p.y);
      const k = j * grid.nx + i;
      if (d < Rc) water[k] += -Dc * (1 - (d * d) / (Rc * Rc));
      else if (d < Rd) water[k] += A * Math.sin((Math.PI * (d - Rc)) / rimW);
    }
  }
  return {
    bed,
    water,
    duration: 0,
    stages: [{ t: 0, weightBed: null, weightWater: water.slice() }],
    info: { energy: m.energy, cavityRadius: Rc, cavityDepth: Dc },
  };
}

// ---------------------------------------------------------------- CUSTOM

export type CustomShape = "circle" | "ellipse" | "rectangle" | "gaussian" | "ring";

export interface CustomParams {
  shape: CustomShape;
  x: number;
  y: number;
  radius: number; // m
  radiusB: number; // m (ellipse/rect second axis)
  height: number; // m
  rotation: number; // deg
  falloff: number; // 0..1
  duration: number; // s
  applyToBed: boolean;
  conserveVolume: boolean;
}

export function buildCustomSource(grid: GridInfo, p: CustomParams): DisplacementField {
  const n = grid.nx * grid.ny;
  const bed = new Float32Array(n);
  const water = new Float32Array(n);
  const rot = (p.rotation * Math.PI) / 180;
  const cs = Math.cos(rot),
    sn = Math.sin(rot);
  const f = new Float32Array(n);
  for (let j = 0; j < grid.ny; j++) {
    const wy = (j + 0.5) * grid.dy;
    for (let i = 0; i < grid.nx; i++) {
      const wx = (i + 0.5) * grid.dx;
      const rx = wx - p.x,
        ry = wy - p.y;
      const px = rx * cs + ry * sn;
      const py = -rx * sn + ry * cs;
      const a = Math.max(p.radius, 1);
      const b = Math.max(p.radiusB, 1);
      let v = 0;
      switch (p.shape) {
        case "circle": {
          const d = Math.hypot(px, py) / a;
          v = d <= 1 ? Math.pow(1 - d, Math.max(0.05, p.falloff) * 3) : 0;
          break;
        }
        case "ellipse": {
          const d = Math.hypot(px / a, py / b);
          v = d <= 1 ? Math.pow(1 - d, Math.max(0.05, p.falloff) * 3) : 0;
          break;
        }
        case "rectangle": {
          const inX = Math.abs(px) <= a,
            inY = Math.abs(py) <= b;
          if (inX && inY) {
            const ex = 1 - Math.abs(px) / a,
              ey = 1 - Math.abs(py) / b;
            v = Math.pow(Math.min(1, Math.min(ex, ey) / Math.max(0.02, p.falloff * 0.5)), 1);
            v = Math.min(1, v);
          }
          break;
        }
        case "gaussian": {
          const d2 = (px * px) / (a * a) + (py * py) / (b * b);
          v = Math.exp(-d2 * 2.5);
          break;
        }
        case "ring": {
          const d = Math.hypot(px, py);
          const w = a * Math.max(0.08, p.falloff * 0.5);
          v = Math.exp(-Math.pow((d - a) / w, 2));
          break;
        }
      }
      f[j * grid.nx + i] = v * p.height;
    }
  }
  if (p.conserveVolume) {
    let sum = 0,
      cnt = 0;
    for (let k = 0; k < n; k++)
      if (f[k] !== 0) {
        sum += f[k];
        cnt++;
      }
    if (cnt > 0) {
      const mean = sum / cnt;
      for (let k = 0; k < n; k++) if (f[k] !== 0) f[k] -= mean;
    }
  }
  if (p.applyToBed) bed.set(f);
  else water.set(f);
  return {
    bed,
    water,
    duration: p.duration,
    stages: [
      {
        t: Math.max(0, p.duration),
        weightBed: p.applyToBed ? f.slice() : null,
        weightWater: p.applyToBed ? null : f.slice(),
      },
    ],
    info: { peak: p.height, radius: p.radius },
  };
}
