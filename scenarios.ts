import {
  DEFAULT_PHYSICS,
  DETAIL_PRESETS,
  PhysicsConfig,
  SourceConfig,
  WorldConfig,
  City,
  Instrument,
} from "../core/SimulationEngine";
import { DEFAULT_TERRAIN_PARAMS, TerrainParams } from "../terrain/TerrainGenerator";

export interface Scenario {
  id: string;
  name: string;
  description: string;
  world: WorldConfig;
  physics: PhysicsConfig;
  terrain: TerrainParams;
  source: SourceConfig;
  instruments: Instrument[];
  cities: City[];
}

let uid = 0;
export const nextId = (p = "id") => `${p}_${Date.now().toString(36)}_${(uid++).toString(36)}`;

function world(scale: WorldConfig["scale"], w: number, detail: keyof typeof DETAIL_PRESETS): WorldConfig {
  const d = DETAIL_PRESETS[detail];
  return {
    scale,
    width: w,
    length: w,
    verticalExaggeration: w > 200000 ? 12 : w > 50000 ? 6 : w > 10000 ? 3 : 1.6,
    seaLevel: 0,
    detail,
    physicsRes: d.physics,
    terrainRes: d.terrain,
    renderRes: d.render,
  };
}

function defaultSource(w: number): SourceConfig {
  return {
    kind: "fault",
    fault: {
      magnitude: 8.8,
      rigidity: 3.0e10,
      ruptureVelocity: 2.5,
      ruptureDuration: 60,
      autoSlipFromMagnitude: true,
      segments: [
        {
          id: nextId("seg"),
          x: w * 0.22,
          y: w * 0.5,
          length: w * 0.5,
          width: Math.min(120000, w * 0.12),
          depth: 18,
          strike: 90,
          dip: 18,
          rake: 90,
          slip: 12,
          startTime: 2,
        },
      ],
    },
    asteroid: {
      diameter: 400,
      density: 3000,
      velocity: 20,
      angle: 45,
      x: w * 0.25,
      y: w * 0.5,
      couplingEfficiency: 0.15,
    },
    explosion: {
      yieldKt: 1000,
      depth: 100,
      x: w * 0.3,
      y: w * 0.5,
      burstType: "underwater",
      coupling: 0.5,
      radiusScale: 1,
    },
    custom: {
      shape: "gaussian",
      x: w * 0.3,
      y: w * 0.5,
      radius: w * 0.05,
      radiusB: w * 0.05,
      height: 6,
      rotation: 0,
      falloff: 0.5,
      duration: 0,
      applyToBed: false,
      conserveVolume: true,
    },
  };
}

function instruments(w: number, defs: [string, number, number, Instrument["type"]][]): Instrument[] {
  return defs.map(([name, fx, fy, type]) => ({
    id: nextId("ins"),
    name,
    type,
    x: fx * w,
    y: fy * w,
    series: [],
    firstArrival: -1,
    peak: 0,
  }));
}

function cities(w: number, defs: [string, number, number, number][]): City[] {
  return defs.map(([name, fx, fy, pop]) => ({ id: nextId("city"), name, x: fx * w, y: fy * w, population: pop }));
}

export function buildScenario(id: string): Scenario {
  switch (id) {
    case "openocean": {
      const w = 500000;
      const s = defaultSource(w);
      s.kind = "asteroid";
      s.asteroid = { ...s.asteroid, diameter: 600, velocity: 20, x: w * 0.35, y: w * 0.45 };
      return {
        id,
        name: "OPEN OCEAN IMPACT",
        description: "Deep-water basin, large offshore asteroid impact.",
        world: world("basin", w, "medium"),
        physics: { ...DEFAULT_PHYSICS, checkpointInterval: 60, maxTimestep: 8 },
        terrain: {
          ...DEFAULT_TERRAIN_PARAMS,
          seed: 4412,
          landFraction: 0.18,
          oceanBasinDepth: 5200,
          trenchDepth: 4000,
          islandFrequency: 0.5,
          shelfWidth: 0.1,
        },
        source: s,
        instruments: instruments(w, [
          ["DART-1", 0.5, 0.45, "buoy"],
          ["DART-2", 0.62, 0.3, "buoy"],
          ["COAST-A", 0.8, 0.5, "gauge"],
        ]),
        cities: cities(w, [["PORT ALDER", 0.83, 0.48, 240000]]),
      };
    }
    case "subduction": {
      const w = 100000;
      return {
        id,
        name: "SUBDUCTION EARTHQUAKE",
        description: "Mw 8.8 megathrust beneath the continental shelf.",
        world: world("regional", w, "high"),
        physics: { ...DEFAULT_PHYSICS },
        terrain: { ...DEFAULT_TERRAIN_PARAMS, seed: 20260114 },
        source: defaultSource(w),
        instruments: instruments(w, [
          ["BUOY-N", 0.35, 0.25, "buoy"],
          ["BUOY-S", 0.35, 0.75, "buoy"],
          ["SHELF GAUGE", 0.58, 0.5, "gauge"],
          ["HARBOUR GAUGE", 0.66, 0.42, "gauge"],
        ]),
        cities: cities(w, [
          ["NEW HAVENPORT", 0.7, 0.42, 480000],
          ["CAPE MILLER", 0.72, 0.72, 62000],
        ]),
      };
    }
    case "explosion": {
      const w = 25000;
      const s = defaultSource(w);
      s.kind = "explosion";
      s.explosion = { ...s.explosion, yieldKt: 500, depth: 60, x: w * 0.4, y: w * 0.5 };
      return {
        id,
        name: "COASTAL EXPLOSION",
        description: "Localized offshore displacement near a populated shore.",
        world: world("local", w, "high"),
        physics: { ...DEFAULT_PHYSICS, checkpointInterval: 15, maxTimestep: 1.5 },
        terrain: {
          ...DEFAULT_TERRAIN_PARAMS,
          seed: 991,
          landFraction: 0.4,
          oceanBasinDepth: 900,
          trenchDepth: 0,
          shelfWidth: 0.45,
          maxElevation: 420,
          islandFrequency: 0.15,
        },
        source: s,
        instruments: instruments(w, [
          ["NEARSHORE", 0.5, 0.5, "buoy"],
          ["PIER GAUGE", 0.6, 0.45, "gauge"],
        ]),
        cities: cities(w, [["BAYSIDE", 0.66, 0.46, 88000]]),
      };
    }
    case "island": {
      const w = 100000;
      const s = defaultSource(w);
      s.kind = "custom";
      s.custom = { ...s.custom, shape: "ring", radius: w * 0.08, height: 8, x: w * 0.2, y: w * 0.5 };
      return {
        id,
        name: "ISLAND BASIN",
        description: "Complex archipelago — refraction and wave trapping.",
        world: world("regional", w, "high"),
        physics: { ...DEFAULT_PHYSICS },
        terrain: {
          ...DEFAULT_TERRAIN_PARAMS,
          seed: 31337,
          landFraction: 0.12,
          islandFrequency: 0.95,
          oceanBasinDepth: 2600,
          trenchDepth: 1500,
          maxElevation: 1200,
          shelfWidth: 0.2,
        },
        source: s,
        instruments: instruments(w, [
          ["ISL-N", 0.45, 0.3, "buoy"],
          ["ISL-S", 0.5, 0.72, "buoy"],
        ]),
        cities: cities(w, []),
      };
    }
    case "bay": {
      const w = 25000;
      const s = defaultSource(w);
      s.kind = "fault";
      s.fault.segments = [
        {
          id: nextId("seg"),
          x: w * 0.15,
          y: w * 0.5,
          length: w * 0.6,
          width: 12000,
          depth: 8,
          strike: 90,
          dip: 25,
          rake: 90,
          slip: 6,
          startTime: 1,
        },
      ];
      return {
        id,
        name: "NARROW BAY",
        description: "Funnel geometry producing strong coastal amplification.",
        world: world("local", w, "high"),
        physics: { ...DEFAULT_PHYSICS, checkpointInterval: 15, maxTimestep: 1.5 },
        terrain: {
          ...DEFAULT_TERRAIN_PARAMS,
          seed: 5150,
          landFraction: 0.45,
          bayStrength: 1.6,
          coastalSlope: 0.25,
          oceanBasinDepth: 700,
          trenchDepth: 0,
          shelfWidth: 0.5,
          maxElevation: 700,
          islandFrequency: 0.1,
        },
        source: s,
        instruments: instruments(w, [
          ["BAY MOUTH", 0.52, 0.5, "gauge"],
          ["BAY HEAD", 0.68, 0.5, "gauge"],
          ["OFFSHORE", 0.3, 0.5, "buoy"],
        ]),
        cities: cities(w, [["INNER BAY TOWN", 0.7, 0.5, 34000]]),
      };
    }
    case "citycoast": {
      const w = 50000;
      const s = defaultSource(w);
      s.kind = "fault";
      s.fault.segments = [
        {
          id: nextId("seg"),
          x: w * 0.18,
          y: w * 0.4,
          length: w * 0.45,
          width: 30000,
          depth: 12,
          strike: 95,
          dip: 20,
          rake: 90,
          slip: 9,
          startTime: 2,
        },
        {
          id: nextId("seg"),
          x: w * 0.22,
          y: w * 0.72,
          length: w * 0.3,
          width: 24000,
          depth: 14,
          strike: 80,
          dip: 20,
          rake: 90,
          slip: 5,
          startTime: 22,
        },
      ];
      return {
        id,
        name: "CITY COAST",
        description: "Low coastal plain with dense settlement markers.",
        world: world("custom", w, "high"),
        physics: { ...DEFAULT_PHYSICS, checkpointInterval: 20, maxTimestep: 2.5 },
        terrain: {
          ...DEFAULT_TERRAIN_PARAMS,
          seed: 8080,
          landFraction: 0.4,
          coastalSlope: 0.15,
          maxElevation: 600,
          shelfWidth: 0.3,
          oceanBasinDepth: 2400,
          trenchDepth: 1200,
        },
        source: s,
        instruments: instruments(w, [
          ["OFFSHORE BUOY", 0.35, 0.5, "buoy"],
          ["PORT GAUGE", 0.63, 0.45, "gauge"],
          ["PLAIN SENSOR", 0.74, 0.55, "sensor"],
        ]),
        cities: cities(w, [
          ["MERIDIAN CITY", 0.66, 0.45, 1250000],
          ["LOWFIELD", 0.72, 0.6, 210000],
          ["NORTH QUAY", 0.63, 0.28, 95000],
        ]),
      };
    }
    case "lab":
    default: {
      const w = 5000;
      const s = defaultSource(w);
      s.kind = "custom";
      s.custom = { ...s.custom, shape: "gaussian", radius: 300, radiusB: 300, height: 4, x: w * 0.4, y: w * 0.5 };
      return {
        id: "lab",
        name: "CUSTOM LAB",
        description: "Flat experimental basin — blank slate for testing.",
        world: world("micro", w, "high"),
        physics: { ...DEFAULT_PHYSICS, checkpointInterval: 5, maxTimestep: 0.5 },
        terrain: {
          ...DEFAULT_TERRAIN_PARAMS,
          seed: 1,
          landFraction: 0.25,
          oceanBasinDepth: 120,
          trenchDepth: 0,
          seafloorRoughness: 0.05,
          maxElevation: 80,
          islandFrequency: 0,
          shelfWidth: 0.6,
          coastalSlope: 0.3,
        },
        source: s,
        instruments: instruments(w, [["LAB GAUGE", 0.7, 0.5, "gauge"]]),
        cities: [],
      };
    }
  }
}

export const SCENARIO_LIST = [
  { id: "subduction", name: "SUBDUCTION EARTHQUAKE" },
  { id: "openocean", name: "OPEN OCEAN IMPACT" },
  { id: "explosion", name: "COASTAL EXPLOSION" },
  { id: "island", name: "ISLAND BASIN" },
  { id: "bay", name: "NARROW BAY" },
  { id: "citycoast", name: "CITY COAST" },
  { id: "lab", name: "CUSTOM LAB" },
];
