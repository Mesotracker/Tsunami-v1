import { SimulationEngine } from "../core/SimulationEngine";
import { RenderOptions, Viewport } from "../render/Viewport";
import { BrushParams } from "../terrain/TerrainEditor";
import { Scenario } from "../data/scenarios";

export type ToolMode =
  | "orbit"
  | "place-source"
  | "measure-distance"
  | "probe"
  | "cross-section"
  | "add-buoy"
  | "add-gauge"
  | "add-sensor"
  | "add-city"
  | "terrain-edit"
  | "paint-displacement";

export interface ProbeResult {
  x: number;
  y: number;
  bed: number;
  eta: number;
  depth: number;
  speed: number;
  arrival: number;
  maxEta: number;
  maxDepth: number;
}

export interface CompareSnapshot {
  name: string;
  maxEta: Float32Array;
  maxDepth: Float32Array;
  maxSpeed: Float32Array;
  arrival: Float32Array;
  stats: SimulationEngine["stats"];
}

export interface UIState {
  playing: boolean;
  speed: number;
  tool: ToolMode;
  units: "metric" | "imperial";
  showMinimap: boolean;
  showCross: boolean;
  showDebug: boolean;
  showLog: boolean;
  showStats: boolean;
  showLeft: boolean;
  showRight: boolean;
  brush: BrushParams;
  measureA: { x: number; y: number } | null;
  measureB: { x: number; y: number } | null;
  crossA: { x: number; y: number } | null;
  crossB: { x: number; y: number } | null;
  probe: ProbeResult | null;
  selectedInstrument: string | null;
  selectedCity: string | null;
  previewBeforeAfter: "before" | "after";
  loopStart: number;
  loopEnd: number;
  loopEnabled: boolean;
  baseline: CompareSnapshot | null;
  compareMode: boolean;
  realElapsed: number;
  fps: number;
  maxSimTime: number;
}

export interface Actions {
  play(): void;
  pause(): void;
  togglePlay(): void;
  step(): void;
  reset(): void;
  resetScenario(): void;
  seek(t: number): void;
  toEnd(): void;
  setSpeed(v: number): void;
  applySource(): void;
  clearSource(): void;
  regenTerrain(): void;
  rebuildWorld(): void;
  loadScenario(id: string): void;
  saveProject(): void;
  loadProjectFile(f: File): void;
  duplicateScenario(): void;
  captureBaseline(): void;
  refreshTerrainRender(): void;
  addInstrument(type: "buoy" | "gauge" | "sensor", x: number, y: number): void;
  removeInstrument(id: string): void;
  focus(x: number, y: number): void;
  notify(msg: string, sev?: "info" | "warning" | "critical"): void;
}

export interface Ctx {
  engine: SimulationEngine;
  viewport: Viewport | null;
  scenario: Scenario;
  ui: UIState;
  setUI: (p: Partial<UIState>) => void;
  viz: RenderOptions;
  setViz: (p: Partial<RenderOptions>) => void;
  refresh: () => void;
  actions: Actions;
  legend: { min: number; max: number; unit: string; label: string } | null;
}
