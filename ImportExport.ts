import { SimulationEngine } from "../core/SimulationEngine";
import { Heightfield } from "../terrain/TerrainGenerator";
import { Scenario } from "./scenarios";

export function download(name: string, content: string | Blob, type = "application/json") {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function serializeProject(engine: SimulationEngine, scenario: Scenario, viz: unknown, camera: number[]) {
  return JSON.stringify(
    {
      format: "tsunami-lab-project",
      version: 1,
      savedAt: new Date().toISOString(),
      name: scenario.name,
      world: engine.world,
      physics: engine.physics,
      terrainParams: engine.terrainParams,
      source: engine.source,
      instruments: engine.instruments.map((i) => ({ ...i, series: [] })),
      cities: engine.cities,
      visualization: viz,
      camera,
      timeline: engine.events,
      terrain: {
        nx: engine.terrain.nx,
        ny: engine.terrain.ny,
        wx: engine.terrain.wx,
        wy: engine.terrain.wy,
        // rounded to decimetres to keep files reasonable
        data: Array.from(engine.terrain.data, (v) => Math.round(v * 10) / 10),
      },
    },
    null,
    1
  );
}

export function parseProject(text: string) {
  const j = JSON.parse(text);
  if (j.format !== "tsunami-lab-project") throw new Error("Not a .tsunami.json project file.");
  const t = j.terrain;
  const hf = new Heightfield(t.nx, t.ny, t.wx, t.wy, Float32Array.from(t.data));
  return { json: j, heightfield: hf };
}

export function exportTerrainJSON(engine: SimulationEngine) {
  const t = engine.terrain;
  return JSON.stringify({
    format: "tsunami-lab-terrain",
    width: t.nx,
    height: t.ny,
    worldWidth: t.wx,
    worldLength: t.wy,
    units: "m",
    data: Array.from(t.data, (v) => Math.round(v * 100) / 100),
  });
}

export function exportTerrainCSV(engine: SimulationEngine) {
  const t = engine.terrain;
  const lines: string[] = [];
  for (let j = 0; j < t.ny; j++) {
    const row: string[] = [];
    for (let i = 0; i < t.nx; i++) row.push(t.data[j * t.nx + i].toFixed(2));
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

export function exportDisplacementCSV(engine: SimulationEngine) {
  const d = engine.displacement;
  const g = engine.grid;
  if (!d) return "";
  const lines: string[] = [];
  for (let j = 0; j < g.ny; j++) {
    const row: string[] = [];
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      row.push((d.bed[k] + d.water[k]).toFixed(4));
    }
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

export function exportSensorCSV(engine: SimulationEngine) {
  const lines = ["instrument,type,x_m,y_m,time_s,eta_m,depth_m,speed_ms"];
  for (const ins of engine.instruments) {
    for (const s of ins.series) {
      lines.push(
        `${ins.name},${ins.type},${ins.x.toFixed(1)},${ins.y.toFixed(1)},${s.t.toFixed(2)},${s.eta.toFixed(
          4
        )},${s.depth.toFixed(3)},${s.speed.toFixed(4)}`
      );
    }
  }
  return lines.join("\n");
}

export function exportTimelineCSV(engine: SimulationEngine) {
  const lines = ["time_s,severity,event,detail"];
  for (const e of engine.events)
    lines.push(`${e.t.toFixed(2)},${e.severity},"${e.label}","${e.detail ?? ""}"`);
  return lines.join("\n");
}
