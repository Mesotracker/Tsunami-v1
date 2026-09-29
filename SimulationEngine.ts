import { SWESolver, SolverConfig, BoundaryType, SolverState } from "./SWESolver";
import { Heightfield, TerrainParams, generateTerrain, DEFAULT_TERRAIN_PARAMS } from "../terrain/TerrainGenerator";
import {
  AsteroidParams,
  CustomParams,
  DisplacementField,
  ExplosionParams,
  FaultParams,
  GridInfo,
  SourceKind,
  asteroidMetrics,
  buildAsteroidSource,
  buildCustomSource,
  buildExplosionSource,
  buildFaultSource,
  explosionMetrics,
} from "../sources";

export type DetailLevel = "preview" | "low" | "medium" | "high" | "ultra" | "extreme" | "custom";
export type WorldScale = "micro" | "local" | "regional" | "basin" | "custom";

export interface DetailPreset {
  physics: number;
  terrain: number;
  render: number;
  substeps: number;
}

export const DETAIL_PRESETS: Record<Exclude<DetailLevel, "custom">, DetailPreset> = {
  preview: { physics: 96, terrain: 128, render: 128, substeps: 1 },
  low: { physics: 128, terrain: 192, render: 192, substeps: 1 },
  medium: { physics: 192, terrain: 320, render: 256, substeps: 1 },
  high: { physics: 256, terrain: 448, render: 320, substeps: 1 },
  ultra: { physics: 352, terrain: 640, render: 416, substeps: 1 },
  extreme: { physics: 512, terrain: 768, render: 512, substeps: 1 },
};

export const WORLD_SCALES: Record<Exclude<WorldScale, "custom">, { w: number; label: string }> = {
  micro: { w: 5000, label: "MICRO — experimental basin" },
  local: { w: 25000, label: "LOCAL — coastal region" },
  regional: { w: 100000, label: "REGIONAL — large coastline" },
  basin: { w: 500000, label: "BASIN — ocean region" },
};

export interface WorldConfig {
  scale: WorldScale;
  width: number; // m
  length: number; // m
  verticalExaggeration: number;
  seaLevel: number; // m
  detail: DetailLevel;
  physicsRes: number;
  terrainRes: number;
  renderRes: number;
}

export interface PhysicsConfig {
  gravity: number;
  manning: number;
  minDepth: number;
  cfl: number;
  boundary: BoundaryType;
  nonlinear: boolean;
  maxTimestep: number;
  spongeCells: number;
  activeRegion: boolean;
  velocityClamp: number;
  waterDensity: number;
  checkpointInterval: number; // sim seconds
  maxCheckpoints: number;
}

export interface TimelineEvent {
  t: number;
  label: string;
  severity: "info" | "warning" | "critical";
  detail?: string;
}

export interface Instrument {
  id: string;
  type: "buoy" | "gauge" | "sensor" | "camera";
  name: string;
  x: number;
  y: number;
  series: { t: number; eta: number; depth: number; speed: number }[];
  firstArrival: number;
  peak: number;
}

export interface City {
  id: string;
  name: string;
  x: number;
  y: number;
  population: number;
}

export interface Stats {
  maxWaveHeight: number;
  maxVelocity: number;
  maxInundationArea: number; // m^2
  maxInundationDistance: number; // m
  maxCoastalElevationReached: number;
  peakWaterLevel: number;
  firstArrivalTime: number;
  timeToPeak: number;
  volume: number;
  volumeError: number;
  energy: number;
  wetCells: number;
}

export interface SourceConfig {
  kind: SourceKind;
  fault: FaultParams;
  asteroid: AsteroidParams;
  explosion: ExplosionParams;
  custom: CustomParams;
}

interface Checkpoint {
  time: number;
  state: SolverState;
  bed: Float32Array;
  stageIndex: number;
  events: TimelineEvent[];
  instruments: { id: string; series: Instrument["series"]; firstArrival: number; peak: number }[];
}

export class SimulationEngine {
  world: WorldConfig;
  physics: PhysicsConfig;
  terrainParams: TerrainParams;
  terrain!: Heightfield; // high-res terrain (render/edit authority)
  bedOriginal!: Float32Array; // physics-grid bed before source
  solver!: SWESolver;
  source: SourceConfig;
  displacement: DisplacementField | null = null;
  stageIndex = 0;
  events: TimelineEvent[] = [];
  instruments: Instrument[] = [];
  cities: City[] = [];
  checkpoints: Checkpoint[] = [];
  stats: Stats = emptyStats();
  warnings: string[] = [];
  lastSampleTime = -1;
  maxSimTime = 3600;
  throttled = false;
  physicsMsAvg = 0;

  private eventFlags: Record<string, boolean> = {};

  constructor(world: WorldConfig, physics: PhysicsConfig, terrainParams: TerrainParams, source: SourceConfig) {
    this.world = world;
    this.physics = physics;
    this.terrainParams = terrainParams;
    this.source = source;
    this.rebuildTerrain();
  }

  get grid(): GridInfo {
    return {
      nx: this.world.physicsRes,
      ny: this.world.physicsRes,
      dx: this.world.width / this.world.physicsRes,
      dy: this.world.length / this.world.physicsRes,
    };
  }

  rebuildTerrain(hf?: Heightfield) {
    const { terrainRes, width, length } = this.world;
    this.terrain = hf ?? generateTerrain(terrainRes, terrainRes, width, length, this.terrainParams);
    this.rebuildSolver();
  }

  /** Re-sample terrain onto the physics grid and (re)create the solver. */
  rebuildSolver() {
    const g = this.grid;
    const bed = new Float32Array(g.nx * g.ny);
    for (let j = 0; j < g.ny; j++) {
      const v = (j + 0.5) / g.ny;
      for (let i = 0; i < g.nx; i++) {
        const u = (i + 0.5) / g.nx;
        bed[j * g.nx + i] = this.terrain.sampleUV(u, v);
      }
    }
    this.bedOriginal = bed.slice();
    const cfg: SolverConfig = {
      nx: g.nx,
      ny: g.ny,
      dx: g.dx,
      dy: g.dy,
      gravity: this.physics.gravity,
      manning: this.physics.manning,
      minDepth: this.physics.minDepth,
      cfl: this.physics.cfl,
      boundary: this.physics.boundary,
      nonlinear: this.physics.nonlinear,
      maxTimestep: this.physics.maxTimestep,
      spongeCells: this.physics.spongeCells,
      activeRegion: this.physics.activeRegion,
      velocityClamp: this.physics.velocityClamp,
    };
    this.solver = new SWESolver(cfg, bed, this.world.seaLevel);
    this.computeDistanceField();
    this.resetSimulation();
  }

  applyPhysicsConfig() {
    const s = this.solver;
    s.cfg.gravity = this.physics.gravity;
    s.cfg.manning = this.physics.manning;
    s.cfg.minDepth = this.physics.minDepth;
    s.cfg.cfl = this.physics.cfl;
    s.cfg.boundary = this.physics.boundary;
    s.cfg.nonlinear = this.physics.nonlinear;
    s.cfg.maxTimestep = this.physics.maxTimestep;
    s.cfg.spongeCells = this.physics.spongeCells;
    s.cfg.activeRegion = this.physics.activeRegion;
    s.cfg.velocityClamp = this.physics.velocityClamp;
    s.seaLevel = this.world.seaLevel;
    s.buildSponge();
  }

  /** Terrain edit → push new bathymetry into the running solver. */
  syncTerrainToSolver() {
    const g = this.grid;
    for (let j = 0; j < g.ny; j++) {
      const v = (j + 0.5) / g.ny;
      for (let i = 0; i < g.nx; i++) {
        const u = (i + 0.5) / g.nx;
        const k = j * g.nx + i;
        const b = this.terrain.sampleUV(u, v);
        this.bedOriginal[k] = b;
        this.solver.zb[k] = b;
        if (this.solver.eta[k] < b) this.solver.eta[k] = b;
      }
    }
    this.computeDistanceField();
  }

  // ------------------------------------------------------------ SOURCE
  buildDisplacement(): DisplacementField {
    const g = this.grid;
    const s = this.source;
    if (s.kind === "fault") return buildFaultSource(g, s.fault);
    if (s.kind === "asteroid") {
      const wd = Math.max(0, this.world.seaLevel - this.bedAtWorld(s.asteroid.x, s.asteroid.y));
      const m = asteroidMetrics(s.asteroid, wd, this.physics.gravity);
      return buildAsteroidSource(g, s.asteroid, m);
    }
    if (s.kind === "explosion") {
      const wd = Math.max(0, this.world.seaLevel - this.bedAtWorld(s.explosion.x, s.explosion.y));
      const m = explosionMetrics(s.explosion, wd, this.physics.gravity);
      return buildExplosionSource(g, s.explosion, m);
    }
    return buildCustomSource(g, s.custom);
  }

  bedAtWorld(x: number, y: number) {
    return this.terrain.sampleUV(x / this.world.width, y / this.world.length);
  }

  armSource() {
    this.displacement = this.buildDisplacement();
    this.stageIndex = 0;
  }

  clearSource() {
    this.displacement = null;
    this.stageIndex = 0;
  }

  private applyStage(stage: DisplacementField["stages"][0]) {
    const s = this.solver;
    const n = s.nx * s.ny;
    const hmin = s.cfg.minDepth;
    if (stage.weightBed) {
      for (let k = 0; k < n; k++) {
        const d = stage.weightBed[k];
        if (d === 0) continue;
        s.zb[k] += d;
        // water column is carried with the seafloor
        if (s.eta[k] - s.zb[k] > hmin) s.eta[k] += d;
        else s.eta[k] = Math.max(s.eta[k], s.zb[k]);
      }
    }
    if (stage.weightWater) {
      for (let k = 0; k < n; k++) {
        const d = stage.weightWater[k];
        if (d === 0) continue;
        if (s.eta[k] - s.zb[k] > hmin) s.eta[k] = Math.max(s.zb[k], s.eta[k] + d);
      }
    }
  }

  // ------------------------------------------------------------ RESET
  resetSimulation() {
    this.solver.zb.set(this.bedOriginal);
    this.solver.reset();
    this.stageIndex = 0;
    this.events = [
      { t: 0, label: "Simulation initialized", severity: "info", detail: `${this.solver.nx}×${this.solver.ny} physics grid` },
    ];
    this.eventFlags = {};
    this.checkpoints = [];
    this.stats = emptyStats();
    this.warnings = [];
    for (const ins of this.instruments) {
      ins.series = [];
      ins.firstArrival = -1;
      ins.peak = 0;
    }
    this.lastSampleTime = -1;
    if (this.displacement) this.armSource();
    this.storeCheckpoint();
    this.updateStats();
  }

  // ------------------------------------------------------------ STEP
  /** Advance simulation by up to `simSeconds`. Returns seconds actually advanced. */
  advance(simSeconds: number, maxSteps = 600): number {
    const t0 = performance.now();
    let advanced = 0;
    let steps = 0;
    this.throttled = false;
    while (advanced < simSeconds && steps < maxSteps) {
      let dt = this.solver.stableTimestep();
      if (!isFinite(dt) || dt <= 0) {
        this.pushWarning("Invalid timestep computed — solver halted.", "critical");
        break;
      }
      const remaining = simSeconds - advanced;
      if (dt > remaining) dt = remaining;
      // release pending source stages
      if (this.displacement) {
        while (
          this.stageIndex < this.displacement.stages.length &&
          this.displacement.stages[this.stageIndex].t <= this.solver.time + dt
        ) {
          this.applyStage(this.displacement.stages[this.stageIndex]);
          this.stageIndex++;
          if (this.stageIndex === 1) {
            this.addEvent(this.solver.time, `${this.source.kind.toUpperCase()} source release begins`, "critical");
          }
          if (this.stageIndex === this.displacement.stages.length) {
            this.addEvent(this.solver.time, "Initial displacement complete", "info");
          }
        }
      }
      this.solver.advance(dt);
      advanced += dt;
      steps++;
      if (this.solver.step % 32 === 0) {
        const bad = this.solver.sanitize();
        if (bad > 0) this.pushWarning(`NaN/Inf detected in ${bad} cells — field repaired.`, "critical");
      }
      this.sampleInstruments();
      this.detectEvents();
    }
    if (steps >= maxSteps && advanced < simSeconds) this.throttled = true;
    this.maybeCheckpoint();
    const ms = performance.now() - t0;
    this.physicsMsAvg = this.physicsMsAvg * 0.9 + ms * 0.1;
    return advanced;
  }

  /** Advance exactly one solver step (STEP button). */
  singleStep() {
    const dt = this.solver.stableTimestep();
    return this.advance(dt, 1);
  }

  // ------------------------------------------------------------ CHECKPOINTS
  private maybeCheckpoint() {
    const iv = this.physics.checkpointInterval;
    const last = this.checkpoints.length ? this.checkpoints[this.checkpoints.length - 1].time : -Infinity;
    if (this.solver.time - last >= iv) this.storeCheckpoint();
  }

  storeCheckpoint() {
    const cp: Checkpoint = {
      time: this.solver.time,
      state: this.solver.captureState(),
      bed: this.solver.zb.slice(),
      stageIndex: this.stageIndex,
      events: this.events.slice(),
      instruments: this.instruments.map((i) => ({
        id: i.id,
        series: i.series.slice(),
        firstArrival: i.firstArrival,
        peak: i.peak,
      })),
    };
    this.checkpoints.push(cp);
    const budget = 700e6;
    while (this.checkpoints.length > 2 && this.checkpointBytes() > budget) {
      this.checkpoints.splice(1, 1);
      this.pushWarning("Checkpoint cache exceeded 700 MB — oldest interior states discarded.", "warning");
    }
    while (this.checkpoints.length > this.physics.maxCheckpoints) {
      // drop every other interior checkpoint to keep coverage
      this.checkpoints.splice(1, 1);
    }
  }

  checkpointBytes() {
    const n = this.solver.nx * this.solver.ny;
    return this.checkpoints.length * n * 4 * 8;
  }

  /** Seek to an absolute simulation time, re-simulating from the nearest checkpoint. */
  seek(time: number, maxSteps = 4000): boolean {
    const target = Math.max(0, time);
    if (Math.abs(target - this.solver.time) < 1e-6) return true;
    if (target < this.solver.time) {
      let cp: Checkpoint | null = null;
      for (const c of this.checkpoints) if (c.time <= target + 1e-6) cp = c;
      if (!cp) cp = this.checkpoints[0] ?? null;
      if (!cp) return false;
      this.solver.zb.set(cp.bed);
      this.solver.restoreState(cp.state);
      this.stageIndex = cp.stageIndex;
      this.events = cp.events.slice();
      for (const rec of cp.instruments) {
        const ins = this.instruments.find((i) => i.id === rec.id);
        if (ins) {
          ins.series = rec.series.slice();
          ins.firstArrival = rec.firstArrival;
          ins.peak = rec.peak;
        }
      }
    }
    const cps = this.checkpoints.length;
    let guard = 0;
    while (this.solver.time < target - 1e-6 && guard < maxSteps) {
      const before = this.solver.time;
      this.advance(Math.min(target - this.solver.time, 2), 64);
      guard += 64;
      if (this.solver.time <= before + 1e-9) break;
    }
    // keep checkpoint list monotone with the new head time
    this.checkpoints = this.checkpoints.filter((c) => c.time <= this.solver.time + 1e-6);
    if (this.checkpoints.length === 0 && cps > 0) this.storeCheckpoint();
    this.updateStats();
    return true;
  }

  // ------------------------------------------------------------ INSTRUMENTS
  sampleInstruments() {
    const t = this.solver.time;
    if (t - this.lastSampleTime < 1.0 && this.lastSampleTime >= 0) return;
    this.lastSampleTime = t;
    const g = this.grid;
    for (const ins of this.instruments) {
      const i = Math.min(g.nx - 1, Math.max(0, Math.floor(ins.x / g.dx)));
      const j = Math.min(g.ny - 1, Math.max(0, Math.floor(ins.y / g.dy)));
      const k = j * g.nx + i;
      const s = this.solver;
      const rest = Math.max(this.world.seaLevel, s.zb[k]);
      const D = Math.max(0, s.eta[k] - s.zb[k]);
      const eta = s.eta[k] - rest;
      const speed = D > s.cfg.minDepth ? Math.hypot(s.M[k], s.N[k]) / D : 0;
      ins.series.push({ t, eta, depth: D, speed });
      if (ins.series.length > 4000) ins.series.shift();
      if (Math.abs(eta) > Math.abs(ins.peak)) ins.peak = eta;
      if (ins.firstArrival < 0 && Math.abs(eta) > 0.1) {
        ins.firstArrival = t;
        this.addEvent(t, `${ins.name}: first wave arrival`, "warning", `η = ${eta.toFixed(2)} m`);
      }
    }
  }

  addEvent(t: number, label: string, severity: TimelineEvent["severity"], detail?: string) {
    this.events.push({ t, label, severity, detail });
    if (this.events.length > 400) this.events.shift();
  }

  pushWarning(msg: string, severity: TimelineEvent["severity"] = "warning") {
    if (this.warnings.includes(msg)) return;
    this.warnings.push(msg);
    if (this.warnings.length > 12) this.warnings.shift();
    this.addEvent(this.solver.time, msg, severity);
  }

  // ------------------------------------------------------------ EVENTS
  private detectEvents() {
    const s = this.solver;
    const t = s.time;
    const g = this.grid;
    if (t - (this.lastEventScan ?? -99) < 2) return;
    this.lastEventScan = t;
    let maxEta = 0,
      maxShelf = 0,
      coastalWet = 0,
      maxLandDepth = 0,
      maxCoast = 0;
    for (let k = 0; k < g.nx * g.ny; k++) {
      const rest = Math.max(this.world.seaLevel, s.zb[k]);
      const disp = s.eta[k] - rest;
      if (disp > maxEta) maxEta = disp;
      if (s.zb[k] > -200 && s.zb[k] < 0 && disp > maxShelf) maxShelf = disp;
      if (s.zb[k] > this.world.seaLevel) {
        const D = s.eta[k] - s.zb[k];
        if (D > s.cfg.minDepth) {
          coastalWet++;
          if (D > maxLandDepth) maxLandDepth = D;
          if (s.zb[k] > maxCoast) maxCoast = s.zb[k];
        }
      }
    }
    const flag = (key: string) => {
      if (this.eventFlags[key]) return false;
      this.eventFlags[key] = true;
      return true;
    };
    if (maxEta > 0.5 && flag("offshore")) this.addEvent(t, "Offshore wave train formed", "info", `peak η ${maxEta.toFixed(2)} m`);
    if (maxShelf > 0.3 && flag("shelf")) this.addEvent(t, "Wave reaches continental shelf", "warning", `η ${maxShelf.toFixed(2)} m`);
    if (maxShelf > 2 && flag("amp")) this.addEvent(t, "Coastal amplification begins", "warning", `shelf η ${maxShelf.toFixed(2)} m`);
    if (coastalWet > 0 && flag("inund")) this.addEvent(t, "First coastal inundation", "critical", `${coastalWet} land cells flooded`);
    if (coastalWet > 0) {
      if (maxLandDepth > (this.peakLandDepth ?? 0)) {
        this.peakLandDepth = maxLandDepth;
        this.peakLandTime = t;
      }
      if (maxLandDepth > 5 && flag("major")) this.addEvent(t, "Major inland penetration", "critical", `flood depth ${maxLandDepth.toFixed(1)} m`);
      if (maxCoast > 10 && flag("runup")) this.addEvent(t, "Run-up exceeds 10 m elevation", "critical");
    }
    if (this.prevMaxEta !== undefined && this.prevMaxEta > 0.6 && maxEta < this.prevMaxEta * 0.5 && flag("recess"))
      this.addEvent(t, "Recession phase begins", "info");
    this.prevMaxEta = Math.max(this.prevMaxEta ?? 0, maxEta) * 0.999;
    if (maxEta > (this.prevMaxEta ?? 0)) this.prevMaxEta = maxEta;
  }

  private lastEventScan?: number;
  private prevMaxEta?: number;
  peakLandDepth = 0;
  peakLandTime = 0;

  // ------------------------------------------------------------ STATS
  updateStats() {
    const s = this.solver;
    const g = this.grid;
    const cellArea = g.dx * g.dy;
    let maxWave = 0,
      maxVel = 0,
      inundArea = 0,
      maxDist = 0,
      maxCoastEl = 0,
      peakLevel = 0,
      firstArr = Infinity,
      wet = 0,
      timeToPeak = 0;
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const k = j * g.nx + i;
        const me = s.maxEta[k];
        if (me > maxWave) {
          maxWave = me;
          timeToPeak = s.arrival[k] >= 0 ? s.arrival[k] : timeToPeak;
        }
        if (s.maxSpeed[k] > maxVel) maxVel = s.maxSpeed[k];
        const bed = this.bedOriginal[k];
        if (bed > this.world.seaLevel) {
          if (s.maxDepth[k] > s.cfg.minDepth) {
            inundArea += cellArea;
            if (bed > maxCoastEl) maxCoastEl = bed;
            const d = this.distanceToSeaCell(i, j);
            if (d > maxDist) maxDist = d;
          }
        }
        if (s.eta[k] - s.zb[k] > s.cfg.minDepth) wet++;
        if (s.maxEta[k] > peakLevel) peakLevel = s.maxEta[k];
        if (s.arrival[k] >= 0 && s.arrival[k] < firstArr) firstArr = s.arrival[k];
      }
    }
    this.stats = {
      maxWaveHeight: maxWave,
      maxVelocity: maxVel,
      maxInundationArea: inundArea,
      maxInundationDistance: maxDist,
      maxCoastalElevationReached: maxCoastEl,
      peakWaterLevel: peakLevel,
      firstArrivalTime: isFinite(firstArr) ? firstArr : -1,
      timeToPeak: this.peakLandTime || timeToPeak,
      volume: s.computeVolume(),
      volumeError: s.computeVolume() - s.initialVolume,
      energy: s.computeEnergy(),
      wetCells: wet,
    };
  }

  /** Chamfer distance transform: metres from each cell to the nearest
   *  originally-submerged cell (used for inland penetration statistics). */
  distToSea!: Float32Array;

  computeDistanceField() {
    const g = this.grid;
    const n = g.nx * g.ny;
    const d = new Float32Array(n).fill(1e9);
    for (let k = 0; k < n; k++) if (this.bedOriginal[k] <= this.world.seaLevel) d[k] = 0;
    const a = 1,
      b = Math.SQRT2;
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        const k = j * g.nx + i;
        let v = d[k];
        if (i > 0) v = Math.min(v, d[k - 1] + a);
        if (j > 0) v = Math.min(v, d[k - g.nx] + a);
        if (i > 0 && j > 0) v = Math.min(v, d[k - g.nx - 1] + b);
        if (i < g.nx - 1 && j > 0) v = Math.min(v, d[k - g.nx + 1] + b);
        d[k] = v;
      }
    for (let j = g.ny - 1; j >= 0; j--)
      for (let i = g.nx - 1; i >= 0; i--) {
        const k = j * g.nx + i;
        let v = d[k];
        if (i < g.nx - 1) v = Math.min(v, d[k + 1] + a);
        if (j < g.ny - 1) v = Math.min(v, d[k + g.nx] + a);
        if (i < g.nx - 1 && j < g.ny - 1) v = Math.min(v, d[k + g.nx + 1] + b);
        if (i > 0 && j < g.ny - 1) v = Math.min(v, d[k + g.nx - 1] + b);
        d[k] = v;
      }
    for (let k = 0; k < n; k++) d[k] *= g.dx;
    this.distToSea = d;
  }

  private distanceToSeaCell(i: number, j: number) {
    return this.distToSea ? this.distToSea[j * this.grid.nx + i] : 0;
  }

  memoryEstimate() {
    const n = this.world.physicsRes * this.world.physicsRes;
    const t = this.world.terrainRes * this.world.terrainRes;
    const r = this.world.renderRes * this.world.renderRes;
    const solverBytes = n * 4 * 9;
    const terrainBytes = t * 4;
    const renderBytes = r * (12 + 12 + 8 + 4) + r * 6 * 4;
    return { solverBytes, terrainBytes, renderBytes, total: solverBytes + terrainBytes + renderBytes };
  }
}

export function emptyStats(): Stats {
  return {
    maxWaveHeight: 0,
    maxVelocity: 0,
    maxInundationArea: 0,
    maxInundationDistance: 0,
    maxCoastalElevationReached: 0,
    peakWaterLevel: 0,
    firstArrivalTime: -1,
    timeToPeak: 0,
    volume: 0,
    volumeError: 0,
    energy: 0,
    wetCells: 0,
  };
}

export const DEFAULT_PHYSICS: PhysicsConfig = {
  gravity: 9.81,
  manning: 0.025,
  minDepth: 0.05,
  cfl: 0.45,
  boundary: "absorbing",
  nonlinear: true,
  maxTimestep: 4.0,
  spongeCells: 12,
  activeRegion: true,
  velocityClamp: 45,
  waterDensity: 1025,
  checkpointInterval: 30,
  maxCheckpoints: 32,
};

export { DEFAULT_TERRAIN_PARAMS };
