import { useRef, useState } from "react";
import { Btn, NumField, Panel, Readout, Row, Select, Slider, Tabs, Toggle, fmtBytes, fmtDist, fmtNum } from "./controls";
import { Ctx } from "./types";
import { DETAIL_PRESETS, DetailLevel, WORLD_SCALES, WorldScale } from "../core/SimulationEngine";
import { PALETTES, paletteCss } from "../render/palettes";
import { VizMode } from "../render/Viewport";
import { asteroidMetrics, explosionMetrics, magnitudeFromMoment, momentFromFault, slipFromMagnitude } from "../sources";
import { BrushTool } from "../terrain/TerrainEditor";
import { clampField, invertField, normalizeField, scaleField, smoothWhole } from "../terrain/TerrainEditor";
import { heightfieldPreview, loadHeightmapFile } from "../terrain/HeightmapLoader";
import { Heightfield } from "../terrain/TerrainGenerator";
import { exportTerrainCSV, exportTerrainJSON, exportDisplacementCSV, exportSensorCSV, exportTimelineCSV, download } from "../data/ImportExport";
import { SCENARIO_LIST, nextId } from "../data/scenarios";

type Tab = "world" | "source" | "physics" | "terrain" | "view" | "data";

export function LeftPanel({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<Tab>("world");
  return (
    <div className="flex flex-col h-full min-h-0">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "world", label: "World" },
          { id: "source", label: "Source" },
          { id: "physics", label: "Physics" },
          { id: "terrain", label: "Terrain" },
          { id: "view", label: "View" },
          { id: "data", label: "Data" },
        ]}
      />
      <div className="flex-1 overflow-y-auto p-1.5 tsu-scroll">
        {tab === "world" && <WorldTab ctx={ctx} />}
        {tab === "source" && <SourceTab ctx={ctx} />}
        {tab === "physics" && <PhysicsTab ctx={ctx} />}
        {tab === "terrain" && <TerrainTab ctx={ctx} />}
        {tab === "view" && <ViewTab ctx={ctx} />}
        {tab === "data" && <DataTab ctx={ctx} />}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── WORLD
function WorldTab({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const w = e.world;
  const [pending, setPending] = useState(false);
  const set = (p: Partial<typeof w>) => {
    Object.assign(e.world, p);
    setPending(true);
    ctx.refresh();
  };
  const mem = e.memoryEstimate();
  const cells = w.physicsRes * w.physicsRes;
  const dx = w.width / w.physicsRes;
  const dtEst = (0.45 * dx) / (Math.sqrt(9.81 * 5000) * Math.SQRT2);
  const cost = (cells / Math.max(dtEst, 0.01) / 1e6).toFixed(1);
  return (
    <>
      <Panel title="Scenario">
        <Row label="Preset">
          <Select
            value={ctx.scenario.id}
            onChange={(v) => ctx.actions.loadScenario(v)}
            options={SCENARIO_LIST.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Row>
        <p className="text-[9px] text-[#80858b] mt-1 leading-tight">{ctx.scenario.description}</p>
      </Panel>

      <Panel title="World Scale">
        <Row label="Scale">
          <Select
            value={w.scale}
            onChange={(v: WorldScale) => {
              if (v === "custom") set({ scale: v });
              else set({ scale: v, width: WORLD_SCALES[v].w, length: WORLD_SCALES[v].w });
            }}
            options={[
              ...Object.entries(WORLD_SCALES).map(([k, v]) => ({ value: k as WorldScale, label: v.label })),
              { value: "custom" as WorldScale, label: "CUSTOM — user defined" },
            ]}
          />
        </Row>
        <Row label="Width">
          <NumField value={w.width} onChange={(v) => set({ width: Math.max(500, v), scale: "custom" })} step={1000} unit="m" />
        </Row>
        <Row label="Length">
          <NumField value={w.length} onChange={(v) => set({ length: Math.max(500, v), scale: "custom" })} step={1000} unit="m" />
        </Row>
        <Slider label="Vert. Exag." value={w.verticalExaggeration} onChange={(v) => { set({ verticalExaggeration: v }); ctx.setViz({ exaggeration: v }); }} min={0.5} max={40} step={0.1} unit="×" />
        <Slider label="Sea Level" value={w.seaLevel} onChange={(v) => set({ seaLevel: v })} min={-200} max={200} step={1} unit="m" />
      </Panel>

      <Panel title="Simulation Detail">
        <Row label="Detail">
          <Select
            value={w.detail}
            onChange={(v: DetailLevel) => {
              if (v === "custom") set({ detail: v });
              else {
                const d = DETAIL_PRESETS[v];
                set({ detail: v, physicsRes: d.physics, terrainRes: d.terrain, renderRes: d.render });
              }
            }}
            options={[
              { value: "preview", label: "PREVIEW" },
              { value: "low", label: "LOW" },
              { value: "medium", label: "MEDIUM" },
              { value: "high", label: "HIGH" },
              { value: "ultra", label: "ULTRA" },
              { value: "extreme", label: "EXTREME" },
              { value: "custom", label: "CUSTOM" },
            ]}
          />
        </Row>
        <Slider label="Physics grid" value={w.physicsRes} onChange={(v) => set({ physicsRes: Math.round(v), detail: "custom" })} min={48} max={640} step={16} unit="²" hint="Solver resolution — the authoritative simulation grid" />
        <Slider label="Terrain grid" value={w.terrainRes} onChange={(v) => set({ terrainRes: Math.round(v), detail: "custom" })} min={64} max={1024} step={32} unit="²" hint="Elevation data resolution" />
        <Slider label="Render grid" value={w.renderRes} onChange={(v) => set({ renderRes: Math.round(v), detail: "custom" })} min={64} max={768} step={32} unit="²" hint="Mesh tessellation — visual only" />
        <div className="mt-1 border border-[#3a3d42]">
          <Readout label="Cell size" value={fmtDist(dx, ctx.ui.units === "imperial")} accent />
          <Readout label="Grid" value={`${w.physicsRes} × ${w.physicsRes}`} />
          <Readout label="Cells" value={cells.toLocaleString()} />
          <Readout label="Est. memory" value={fmtBytes(mem.total)} />
          <Readout label="Est. Δt (5 km deep)" value={dtEst.toFixed(2)} unit="s" />
          <Readout label="Sim cost index" value={cost} unit="Mcell/s·simS" />
        </div>
        {w.physicsRes > 400 && (
          <p className="text-[9px] text-[#d79a8f] mt-1">
            WARNING: grids above 400² run the CPU solver slowly. Reduce detail or use accelerated playback.
          </p>
        )}
        <div className="flex gap-1 mt-1.5">
          <Btn wide active={pending} onClick={() => { ctx.actions.rebuildWorld(); setPending(false); }}>
            {pending ? "Apply & Rebuild World *" : "Rebuild World"}
          </Btn>
        </div>
      </Panel>

      <Panel title="Ocean Initialization">
        <Slider label="Water density" value={e.physics.waterDensity} onChange={(v) => { e.physics.waterDensity = v; ctx.refresh(); }} min={950} max={1100} step={1} unit="kg/m³" />
        <Slider label="Gravity" value={e.physics.gravity} onChange={(v) => { e.physics.gravity = v; e.applyPhysicsConfig(); ctx.refresh(); }} min={0.5} max={30} step={0.01} unit="m/s²" />
        <Slider label="Bottom friction" value={e.physics.manning} onChange={(v) => { e.physics.manning = v; e.applyPhysicsConfig(); ctx.refresh(); }} min={0} max={0.1} step={0.001} unit="n" />
        <Readout label="Equilibrium volume" value={fmtNum(e.solver.initialVolume / 1e9)} unit="km³" />
        <Readout label="Current volume" value={fmtNum(e.stats.volume / 1e9)} unit="km³" />
        <Readout label="Volume error" value={fmtNum(e.stats.volumeError / 1e6)} unit="×10⁶ m³" accent />
      </Panel>
    </>
  );
}

// ───────────────────────────────────────────────────────────── SOURCE
function SourceTab({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const s = e.source;
  const up = () => ctx.refresh();
  const pick = (target: "source") => {
    ctx.setUI({ tool: "place-source" });
    void target;
  };
  return (
    <>
      <Panel title="Displacement Source">
        <Row label="Mechanism">
          <Select
            value={s.kind}
            onChange={(v) => {
              s.kind = v as typeof s.kind;
              up();
            }}
            options={[
              { value: "fault", label: "1 · EARTHQUAKE / FAULT" },
              { value: "asteroid", label: "2 · ASTEROID IMPACT" },
              { value: "explosion", label: "3 · EXPLOSION" },
              { value: "custom", label: "4 · CUSTOM DISPLACEMENT" },
            ]}
          />
        </Row>
        <div className="flex gap-1 mt-1">
          <Btn wide onClick={() => ctx.actions.applySource()} active>
            Apply Source
          </Btn>
          <Btn onClick={() => ctx.actions.clearSource()}>Clear</Btn>
        </div>
        <div className="flex gap-1 mt-1">
          <Btn small onClick={() => ctx.setViz({ mode: "displacement" })}>Displacement map</Btn>
          <Btn small active={ctx.ui.tool === "place-source"} onClick={() => pick("source")}>
            Pick location
          </Btn>
        </div>
        <div className="flex gap-1 mt-1">
          <Btn small active={ctx.ui.previewBeforeAfter === "before"} onClick={() => ctx.setUI({ previewBeforeAfter: "before" })}>Before</Btn>
          <Btn small active={ctx.ui.previewBeforeAfter === "after"} onClick={() => ctx.setUI({ previewBeforeAfter: "after" })}>After</Btn>
          <span className="text-[9px] text-[#80858b] self-center">initial condition preview</span>
        </div>
      </Panel>

      {s.kind === "fault" && <FaultEditor ctx={ctx} />}
      {s.kind === "asteroid" && <AsteroidEditor ctx={ctx} />}
      {s.kind === "explosion" && <ExplosionEditor ctx={ctx} />}
      {s.kind === "custom" && <CustomEditor ctx={ctx} />}
    </>
  );
}

function FaultEditor({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const f = e.source.fault;
  const up = () => ctx.refresh();
  let m0 = 0;
  for (const seg of f.segments) m0 += momentFromFault(seg, f.rigidity);
  return (
    <>
      <Panel title="Fault Parameters">
        <Slider label="Target Mw" value={f.magnitude} onChange={(v) => { f.magnitude = v; if (f.autoSlipFromMagnitude) { const area = f.segments.reduce((a, s) => a + s.length * s.width, 0); const slip = slipFromMagnitude(v, area, f.rigidity); f.segments.forEach((s) => (s.slip = slip)); } up(); }} min={6} max={9.6} step={0.05} />
        <Toggle label="Auto slip from Mw" value={f.autoSlipFromMagnitude} onChange={(v) => { f.autoSlipFromMagnitude = v; up(); }} />
        <Slider label="Rigidity" value={f.rigidity / 1e10} onChange={(v) => { f.rigidity = v * 1e10; up(); }} min={0.5} max={8} step={0.1} unit="×10¹⁰ Pa" />
        <Slider label="Rupture vel." value={f.ruptureVelocity} onChange={(v) => { f.ruptureVelocity = v; up(); }} min={0.5} max={5} step={0.1} unit="km/s" />
        <Slider label="Rupture dur." value={f.ruptureDuration} onChange={(v) => { f.ruptureDuration = v; up(); }} min={1} max={400} step={1} unit="s" />
        <div className="border border-[#3a3d42] mt-1">
          <Readout label="Seismic moment" value={m0.toExponential(2)} unit="N·m" />
          <Readout label="Computed Mw" value={magnitudeFromMoment(m0).toFixed(2)} accent />
          <Readout label="Segments" value={f.segments.length} />
        </div>
      </Panel>
      {f.segments.map((seg, i) => (
        <Panel
          key={seg.id}
          title={`Segment ${i + 1}`}
          collapsible
          defaultOpen={i === 0}
          right={
            <Btn small danger onClick={() => { f.segments.splice(i, 1); up(); }} title="Remove segment">
              ✕
            </Btn>
          }
        >
          <Row label="X"><NumField value={seg.x} onChange={(v) => { seg.x = v; up(); }} step={1000} unit="m" /></Row>
          <Row label="Y"><NumField value={seg.y} onChange={(v) => { seg.y = v; up(); }} step={1000} unit="m" /></Row>
          <Slider label="Length" value={seg.length / 1000} onChange={(v) => { seg.length = v * 1000; up(); }} min={1} max={Math.max(50, e.world.width / 1000)} step={0.5} unit="km" />
          <Slider label="Width" value={seg.width / 1000} onChange={(v) => { seg.width = v * 1000; up(); }} min={1} max={300} step={0.5} unit="km" />
          <Slider label="Top depth" value={seg.depth} onChange={(v) => { seg.depth = v; up(); }} min={0} max={70} step={0.5} unit="km" />
          <Slider label="Strike" value={seg.strike} onChange={(v) => { seg.strike = v; up(); }} min={0} max={360} step={1} unit="°" />
          <Slider label="Dip" value={seg.dip} onChange={(v) => { seg.dip = v; up(); }} min={1} max={89} step={1} unit="°" />
          <Slider label="Rake" value={seg.rake} onChange={(v) => { seg.rake = v; up(); }} min={-180} max={180} step={1} unit="°" />
          <Slider label="Slip" value={seg.slip} onChange={(v) => { seg.slip = v; up(); }} min={0} max={60} step={0.1} unit="m" />
          <Slider label="Start time" value={seg.startTime} onChange={(v) => { seg.startTime = v; up(); }} min={0} max={300} step={0.5} unit="s" />
        </Panel>
      ))}
      <Btn wide onClick={() => {
        const last = f.segments[f.segments.length - 1];
        f.segments.push({ ...(last ?? { x: 0, y: 0, length: 40000, width: 20000, depth: 15, strike: 90, dip: 20, rake: 90, slip: 5, startTime: 0 }), id: nextId("seg"), y: (last?.y ?? 0) + (last?.width ?? 20000), startTime: (last?.startTime ?? 0) + 20 });
        ctx.refresh();
      }}>+ Add Segment (segmented rupture)</Btn>
    </>
  );
}

function AsteroidEditor({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const a = e.source.asteroid;
  const up = () => ctx.refresh();
  const wd = Math.max(0, e.world.seaLevel - e.bedAtWorld(a.x, a.y));
  const m = asteroidMetrics(a, wd, e.physics.gravity);
  return (
    <Panel title="Asteroid Impact">
      <Slider label="Diameter" value={a.diameter} onChange={(v) => { a.diameter = v; up(); }} min={10} max={10000} step={10} unit="m" log />
      <Slider label="Density" value={a.density} onChange={(v) => { a.density = v; up(); }} min={500} max={8000} step={50} unit="kg/m³" />
      <Slider label="Velocity" value={a.velocity} onChange={(v) => { a.velocity = v; up(); }} min={5} max={72} step={0.5} unit="km/s" />
      <Slider label="Impact angle" value={a.angle} onChange={(v) => { a.angle = v; up(); }} min={5} max={90} step={1} unit="°" />
      <Slider label="Coupling" value={a.couplingEfficiency} onChange={(v) => { a.couplingEfficiency = v; up(); }} min={0.01} max={1} step={0.01} hint="Fraction of kinetic energy coupled into the water column" />
      <Row label="X"><NumField value={a.x} onChange={(v) => { a.x = v; up(); }} step={500} unit="m" /></Row>
      <Row label="Y"><NumField value={a.y} onChange={(v) => { a.y = v; up(); }} step={500} unit="m" /></Row>
      <div className="border border-[#3a3d42] mt-1">
        <Readout label="Local water depth" value={wd.toFixed(0)} unit="m" />
        <Readout label="Impactor mass" value={m.mass.toExponential(2)} unit="kg" />
        <Readout label="Coupled energy" value={m.energy.toExponential(2)} unit="J" />
        <Readout label="Energy" value={fmtNum(m.energyMt)} unit="Mt TNT" accent />
        <Readout label="Impulse" value={m.impulse.toExponential(2)} unit="N·s" />
        <Readout label="Cavity radius" value={fmtDist(m.cavityRadius)} accent />
        <Readout label="Cavity depth" value={fmtDist(m.cavityDepth)} />
        <Readout label="Displaced volume" value={fmtNum(m.displacedVolume / 1e9)} unit="km³" />
        <Readout label="Impact regime" value={m.onLand ? "LAND / CRATERING" : wd < m.cavityRadius ? "SHALLOW WATER" : "DEEP WATER"} accent />
      </div>
    </Panel>
  );
}

function ExplosionEditor({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const x = e.source.explosion;
  const up = () => ctx.refresh();
  const wd = Math.max(0, e.world.seaLevel - e.bedAtWorld(x.x, x.y));
  const m = explosionMetrics(x, wd, e.physics.gravity);
  return (
    <Panel title="Explosion Source">
      <Slider label="Yield" value={x.yieldKt} onChange={(v) => { x.yieldKt = v; up(); }} min={0.01} max={100000} step={0.01} unit="kt" log />
      <Slider label="Burst depth" value={x.depth} onChange={(v) => { x.depth = v; up(); }} min={0} max={3000} step={1} unit="m" />
      <Row label="Burst type">
        <Select value={x.burstType} onChange={(v) => { x.burstType = v; up(); }} options={[{ value: "underwater", label: "UNDERWATER" }, { value: "surface", label: "SURFACE" }, { value: "airburst", label: "AIRBURST" }]} />
      </Row>
      <Slider label="Coupling" value={x.coupling} onChange={(v) => { x.coupling = v; up(); }} min={0.01} max={1} step={0.01} />
      <Slider label="Radius scale" value={x.radiusScale} onChange={(v) => { x.radiusScale = v; up(); }} min={0.2} max={3} step={0.05} hint="Scales the initial displacement radius (physics)" />
      <Row label="X"><NumField value={x.x} onChange={(v) => { x.x = v; up(); }} step={500} unit="m" /></Row>
      <Row label="Y"><NumField value={x.y} onChange={(v) => { x.y = v; up(); }} step={500} unit="m" /></Row>
      <div className="border border-[#3a3d42] mt-1">
        <Readout label="Total energy" value={m.energy.toExponential(2)} unit="J" />
        <Readout label="Effective coupling" value={(m.couplingEff * 100).toFixed(1)} unit="%" />
        <Readout label="Water depth" value={wd.toFixed(0)} unit="m" />
        <Readout label="Cavity radius" value={fmtDist(m.cavityRadius)} accent />
        <Readout label="Displaced volume" value={fmtNum(m.displacedVolume / 1e6)} unit="×10⁶ m³" />
      </div>
      <Slider label="Visual gain" value={ctx.viz.waveAmplify} onChange={(v) => ctx.setViz({ waveAmplify: v })} min={0.2} max={20} step={0.1} unit="×" hint="Exaggerates the rendered wave only — physics unchanged" />
    </Panel>
  );
}

function CustomEditor({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const c = e.source.custom;
  const up = () => ctx.refresh();
  return (
    <Panel title="Custom Displacement">
      <Row label="Shape">
        <Select value={c.shape} onChange={(v) => { c.shape = v; up(); }} options={[{ value: "circle", label: "CIRCLE" }, { value: "ellipse", label: "ELLIPSE" }, { value: "rectangle", label: "RECTANGLE" }, { value: "gaussian", label: "GAUSSIAN" }, { value: "ring", label: "RING" }]} />
      </Row>
      <Slider label="Radius A" value={c.radius} onChange={(v) => { c.radius = v; up(); }} min={50} max={e.world.width / 2} step={50} unit="m" log />
      <Slider label="Radius B" value={c.radiusB} onChange={(v) => { c.radiusB = v; up(); }} min={50} max={e.world.width / 2} step={50} unit="m" log />
      <Slider label="Height" value={c.height} onChange={(v) => { c.height = v; up(); }} min={-100} max={100} step={0.1} unit="m" />
      <Slider label="Rotation" value={c.rotation} onChange={(v) => { c.rotation = v; up(); }} min={0} max={360} step={1} unit="°" />
      <Slider label="Falloff" value={c.falloff} onChange={(v) => { c.falloff = v; up(); }} min={0.05} max={1} step={0.01} />
      <Slider label="Duration" value={c.duration} onChange={(v) => { c.duration = v; up(); }} min={0} max={600} step={1} unit="s" />
      <Row label="X"><NumField value={c.x} onChange={(v) => { c.x = v; up(); }} step={100} unit="m" /></Row>
      <Row label="Y"><NumField value={c.y} onChange={(v) => { c.y = v; up(); }} step={100} unit="m" /></Row>
      <Toggle label="Apply to seafloor" value={c.applyToBed} onChange={(v) => { c.applyToBed = v; up(); }} hint="Off = direct water-surface displacement" />
      <Toggle label="Conserve volume" value={c.conserveVolume} onChange={(v) => { c.conserveVolume = v; up(); }} />
      <div className="mt-1">
        <Btn wide active={ctx.ui.tool === "paint-displacement"} onClick={() => ctx.setUI({ tool: ctx.ui.tool === "paint-displacement" ? "orbit" : "paint-displacement" })}>
          {ctx.ui.tool === "paint-displacement" ? "Painting: click map to stamp" : "Paint displacement on grid"}
        </Btn>
      </div>
    </Panel>
  );
}

// ───────────────────────────────────────────────────────────── PHYSICS
function PhysicsTab({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const p = e.physics;
  const up = () => { e.applyPhysicsConfig(); ctx.refresh(); };
  const d = e.solver.diag;
  return (
    <>
      <Panel title="Solver">
        <Slider label="Gravity" value={p.gravity} onChange={(v) => { p.gravity = v; up(); }} min={0.5} max={30} step={0.01} unit="m/s²" />
        <Slider label="Manning n" value={p.manning} onChange={(v) => { p.manning = v; up(); }} min={0} max={0.1} step={0.001} />
        <Slider label="CFL number" value={p.cfl} onChange={(v) => { p.cfl = v; up(); }} min={0.05} max={0.9} step={0.01} hint="Courant number used for the adaptive timestep" />
        <Slider label="Max Δt" value={p.maxTimestep} onChange={(v) => { p.maxTimestep = v; up(); }} min={0.05} max={20} step={0.05} unit="s" />
        <Slider label="Min depth" value={p.minDepth} onChange={(v) => { p.minDepth = v; up(); }} min={0.001} max={1} step={0.001} unit="m" hint="Wetting/drying threshold — below this h = 0" />
        <Slider label="Velocity clamp" value={p.velocityClamp} onChange={(v) => { p.velocityClamp = v; up(); }} min={5} max={200} step={1} unit="m/s" />
        <Toggle label="Non-linear terms" value={p.nonlinear} onChange={(v) => { p.nonlinear = v; up(); }} hint="Advective momentum terms — off = linear long-wave theory" />
        <Toggle label="Active region only" value={p.activeRegion} onChange={(v) => { p.activeRegion = v; up(); }} hint="Skip quiescent cells. Disable for strict scientific comparison." />
      </Panel>
      <Panel title="Boundary Conditions">
        <Row label="Type">
          <Select value={p.boundary} onChange={(v) => { p.boundary = v; up(); }} options={[{ value: "open", label: "OPEN (radiating)" }, { value: "absorbing", label: "ABSORBING (sponge)" }, { value: "reflective", label: "REFLECTIVE (wall)" }, { value: "periodic", label: "PERIODIC" }]} />
        </Row>
        <Slider label="Sponge cells" value={p.spongeCells} onChange={(v) => { p.spongeCells = Math.round(v); up(); }} min={0} max={40} step={1} />
      </Panel>
      <Panel title="Checkpoints">
        <Slider label="Interval" value={p.checkpointInterval} onChange={(v) => { p.checkpointInterval = v; ctx.refresh(); }} min={1} max={300} step={1} unit="sim s" />
        <Slider label="Max stored" value={p.maxCheckpoints} onChange={(v) => { p.maxCheckpoints = Math.round(v); ctx.refresh(); }} min={4} max={400} step={1} />
        <div className="border border-[#3a3d42] mt-1">
          <Readout label="Checkpoints" value={e.checkpoints.length} />
          <Readout label="Cache size" value={fmtBytes(e.checkpointBytes())} accent />
          <Readout label="Per state" value={fmtBytes(e.solver.nx * e.solver.ny * 4 * 8)} />
        </div>
      </Panel>
      <Panel title="Solver Status">
        <Readout label="Timestep Δt" value={d.dt.toFixed(3)} unit="s" accent />
        <Readout label="Max depth" value={d.maxDepthGlobal.toFixed(0)} unit="m" />
        <Readout label="Wave speed √(gh)" value={Math.sqrt(p.gravity * Math.max(d.maxDepthGlobal, 0.01)).toFixed(1)} unit="m/s" />
        <Readout label="Active cells" value={`${d.activeCells.toLocaleString()} / ${d.totalCells.toLocaleString()}`} />
        <Readout label="Clamped cells" value={d.clampCount} />
        <Readout label="NaN repaired" value={d.nanCount} />
        <Readout label="Steps" value={d.steps.toLocaleString()} />
        <Readout label="Status" value={e.warnings.length ? "WARNINGS" : "STABLE"} accent />
      </Panel>
    </>
  );
}

// ───────────────────────────────────────────────────────────── TERRAIN
function TerrainTab({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const t = e.terrainParams;
  const up = () => ctx.refresh();
  const st = e.terrain.stats();
  const [imp, setImp] = useState<{ hf: Heightfield; preview: string; info: string } | null>(null);
  const [impErr, setImpErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [opts, setOpts] = useState({ elevMin: -4000, elevMax: 2000, invert: false, flipY: false, units: "m" as "m" | "ft", targetRes: 512, seaLevelOffset: 0 });

  return (
    <>
      <Panel title="Procedural Generator">
        <Row label="Seed">
          <div className="flex gap-1">
            <NumField value={t.seed} onChange={(v) => { t.seed = Math.round(v); up(); }} step={1} />
            <Btn small onClick={() => { t.seed = Math.floor(Math.random() * 1e6); ctx.actions.regenTerrain(); }}>Rnd</Btn>
          </div>
        </Row>
        <Slider label="Land fraction" value={t.landFraction} onChange={(v) => { t.landFraction = v; up(); }} min={0} max={0.8} step={0.01} />
        <Slider label="Continental" value={t.continentalScale} onChange={(v) => { t.continentalScale = v; up(); }} min={0.2} max={4} step={0.05} />
        <Slider label="Mountain scale" value={t.mountainScale} onChange={(v) => { t.mountainScale = v; up(); }} min={0.2} max={8} step={0.05} />
        <Slider label="Ridge strength" value={t.ridgeStrength} onChange={(v) => { t.ridgeStrength = v; up(); }} min={0} max={2} step={0.01} />
        <Slider label="Valley strength" value={t.valleyStrength} onChange={(v) => { t.valleyStrength = v; up(); }} min={0} max={2} step={0.01} />
        <Slider label="Coastal slope" value={t.coastalSlope} onChange={(v) => { t.coastalSlope = v; up(); }} min={0} max={1} step={0.01} />
        <Slider label="Bay strength" value={t.bayStrength} onChange={(v) => { t.bayStrength = v; up(); }} min={0} max={3} step={0.01} />
        <Slider label="Island freq." value={t.islandFrequency} onChange={(v) => { t.islandFrequency = v; up(); }} min={0} max={1} step={0.01} />
        <Slider label="Basin depth" value={t.oceanBasinDepth} onChange={(v) => { t.oceanBasinDepth = v; up(); }} min={50} max={9000} step={10} unit="m" />
        <Slider label="Seafloor rough." value={t.seafloorRoughness} onChange={(v) => { t.seafloorRoughness = v; up(); }} min={0} max={2} step={0.01} />
        <Slider label="Trench depth" value={t.trenchDepth} onChange={(v) => { t.trenchDepth = v; up(); }} min={0} max={9000} step={50} unit="m" />
        <Slider label="Shelf width" value={t.shelfWidth} onChange={(v) => { t.shelfWidth = v; up(); }} min={0.01} max={0.8} step={0.01} />
        <Slider label="Erosion" value={t.erosion} onChange={(v) => { t.erosion = v; up(); }} min={0} max={1} step={0.01} />
        <Slider label="Smoothing" value={t.smoothing} onChange={(v) => { t.smoothing = v; up(); }} min={0} max={1} step={0.01} />
        <Slider label="Max elevation" value={t.maxElevation} onChange={(v) => { t.maxElevation = v; up(); }} min={50} max={9000} step={10} unit="m" />
        <Slider label="Min depth clamp" value={t.minDepth} onChange={(v) => { t.minDepth = v; up(); }} min={100} max={12000} step={100} unit="m" />
        <Slider label="Orientation" value={t.orientation} onChange={(v) => { t.orientation = v; up(); }} min={0} max={360} step={1} unit="°" />
        <Btn wide onClick={() => ctx.actions.regenTerrain()}>Regenerate Terrain</Btn>
        <div className="border border-[#3a3d42] mt-1">
          <Readout label="Min elevation" value={st.min.toFixed(0)} unit="m" />
          <Readout label="Max elevation" value={st.max.toFixed(0)} unit="m" accent />
          <Readout label="Land area" value={(st.landFraction * 100).toFixed(1)} unit="%" />
        </div>
      </Panel>

      <Panel title="Terrain Editor">
        <Toggle label="Edit mode" value={ctx.ui.tool === "terrain-edit"} onChange={(v) => ctx.setUI({ tool: v ? "terrain-edit" : "orbit" })} hint="Click-drag on the terrain to sculpt. Bathymetry updates live." />
        <Row label="Tool">
          <Select
            value={ctx.ui.brush.tool}
            onChange={(v: BrushTool) => ctx.setUI({ brush: { ...ctx.ui.brush, tool: v } })}
            options={["raise", "lower", "flatten", "smooth", "roughen", "mountain", "valley", "trench", "island", "basin", "shelf", "coastal"].map((x) => ({ value: x as BrushTool, label: x.toUpperCase() }))}
          />
        </Row>
        <Row label="Shape">
          <Select value={ctx.ui.brush.shape} onChange={(v) => ctx.setUI({ brush: { ...ctx.ui.brush, shape: v } })} options={[{ value: "round", label: "ROUND" }, { value: "square", label: "SQUARE" }, { value: "gauss", label: "GAUSSIAN" }]} />
        </Row>
        <Slider label="Radius" value={ctx.ui.brush.radius} onChange={(v) => ctx.setUI({ brush: { ...ctx.ui.brush, radius: v } })} min={e.world.width / 200} max={e.world.width / 3} step={10} unit="m" log />
        <Slider label="Strength" value={ctx.ui.brush.strength} onChange={(v) => ctx.setUI({ brush: { ...ctx.ui.brush, strength: v } })} min={1} max={500} step={1} unit="m" />
        <Slider label="Falloff" value={ctx.ui.brush.falloff} onChange={(v) => ctx.setUI({ brush: { ...ctx.ui.brush, falloff: v } })} min={0.05} max={1} step={0.01} />
        <Slider label="Pressure" value={ctx.ui.brush.pressure} onChange={(v) => ctx.setUI({ brush: { ...ctx.ui.brush, pressure: v } })} min={0.02} max={1} step={0.01} />
      </Panel>

      <Panel title="Field Operations" collapsible defaultOpen={false}>
        <div className="grid grid-cols-2 gap-1">
          <Btn small onClick={() => { normalizeField(e.terrain, -e.terrainParams.oceanBasinDepth, e.terrainParams.maxElevation); ctx.actions.refreshTerrainRender(); }}>Normalize</Btn>
          <Btn small onClick={() => { clampField(e.terrain, -e.terrainParams.minDepth, e.terrainParams.maxElevation); ctx.actions.refreshTerrainRender(); }}>Clamp</Btn>
          <Btn small onClick={() => { invertField(e.terrain); ctx.actions.refreshTerrainRender(); }}>Invert</Btn>
          <Btn small onClick={() => { smoothWhole(e.terrain, 2, 0.5); ctx.actions.refreshTerrainRender(); }}>Smooth</Btn>
          <Btn small onClick={() => { scaleField(e.terrain, 1.15); ctx.actions.refreshTerrainRender(); }}>Scale ×1.15</Btn>
          <Btn small onClick={() => { scaleField(e.terrain, 1 / 1.15); ctx.actions.refreshTerrainRender(); }}>Scale ÷1.15</Btn>
          <Btn small onClick={() => { e.terrain = e.terrain.resample(Math.min(1024, e.terrain.nx * 2), Math.min(1024, e.terrain.ny * 2)); e.world.terrainRes = e.terrain.nx; ctx.actions.refreshTerrainRender(); }}>Resample ×2</Btn>
          <Btn small onClick={() => { e.terrain = e.terrain.resample(Math.max(32, e.terrain.nx >> 1), Math.max(32, e.terrain.ny >> 1)); e.world.terrainRes = e.terrain.nx; ctx.actions.refreshTerrainRender(); }}>Resample ÷2</Btn>
        </div>
      </Panel>

      <Panel title="Import Heightmap" collapsible defaultOpen={false}>
        <input
          ref={fileRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.csv,.txt,.json,.raw,.r16,.tif,.tiff"
          className="text-[10px] text-[#a8adb3] w-full"
          onChange={async (ev) => {
            const f = ev.target.files?.[0];
            if (!f) return;
            setImpErr(null);
            try {
              const r = await loadHeightmapFile(f, {
                worldWidth: e.world.width,
                worldLength: e.world.length,
                elevMin: opts.elevMin,
                elevMax: opts.elevMax,
                invert: opts.invert,
                seaLevelOffset: opts.seaLevelOffset,
                targetRes: opts.targetRes,
                units: opts.units,
                flipY: opts.flipY,
              });
              setImp({ hf: r.heightfield, preview: heightfieldPreview(r.heightfield), info: `${r.format} ${r.sourceWidth}×${r.sourceHeight} → ${r.heightfield.nx}²  [${r.min.toFixed(0)} … ${r.max.toFixed(0)} m]` });
            } catch (err) {
              setImp(null);
              setImpErr((err as Error).message);
            }
          }}
        />
        <Row label="Elev min"><NumField value={opts.elevMin} onChange={(v) => setOpts({ ...opts, elevMin: v })} step={100} unit="m" /></Row>
        <Row label="Elev max"><NumField value={opts.elevMax} onChange={(v) => setOpts({ ...opts, elevMax: v })} step={100} unit="m" /></Row>
        <Row label="Datum shift"><NumField value={opts.seaLevelOffset} onChange={(v) => setOpts({ ...opts, seaLevelOffset: v })} step={10} unit="m" /></Row>
        <Row label="Target res"><NumField value={opts.targetRes} onChange={(v) => setOpts({ ...opts, targetRes: Math.round(v) })} step={64} /></Row>
        <Row label="Units"><Select value={opts.units} onChange={(v) => setOpts({ ...opts, units: v })} options={[{ value: "m", label: "METRES" }, { value: "ft", label: "FEET" }]} /></Row>
        <Toggle label="Invert" value={opts.invert} onChange={(v) => setOpts({ ...opts, invert: v })} />
        <Toggle label="Flip Y axis" value={opts.flipY} onChange={(v) => setOpts({ ...opts, flipY: v })} />
        {impErr && <p className="text-[9px] text-[#e08a7a] mt-1">IMPORT ERROR — {impErr}</p>}
        {imp && (
          <div className="mt-1">
            <img src={imp.preview} alt="terrain preview" className="w-full border border-[#4a4e54]" />
            <p className="text-[9px] text-[#a8adb3] mt-0.5 font-mono">{imp.info}</p>
            <Btn wide active onClick={() => {
              e.world.terrainRes = imp.hf.nx;
              imp.hf.wx = e.world.width;
              imp.hf.wy = e.world.length;
              e.rebuildTerrain(imp.hf);
              ctx.actions.refreshTerrainRender();
              ctx.actions.notify("Imported terrain applied to world.", "info");
            }}>Apply imported terrain</Btn>
          </div>
        )}
      </Panel>

      <Panel title="Terrain Export" collapsible defaultOpen={false}>
        <div className="grid grid-cols-2 gap-1">
          <Btn small onClick={() => download("terrain.json", exportTerrainJSON(e))}>JSON</Btn>
          <Btn small onClick={() => download("terrain.csv", exportTerrainCSV(e), "text/csv")}>CSV</Btn>
        </div>
      </Panel>
    </>
  );
}

// ───────────────────────────────────────────────────────────── VIEW
function ViewTab({ ctx }: { ctx: Ctx }) {
  const v = ctx.viz;
  const modes: { id: VizMode; label: string }[] = [
    { id: "realistic", label: "REALISTIC" },
    { id: "scientific", label: "SCIENTIFIC" },
    { id: "bathymetry", label: "BATHYMETRY" },
    { id: "waveheight", label: "WAVE HEIGHT" },
    { id: "velocity", label: "VELOCITY" },
    { id: "inundation", label: "INUNDATION" },
    { id: "arrival", label: "ARRIVAL TIME" },
    { id: "maxdepth", label: "MAX DEPTH" },
    { id: "maxvelocity", label: "MAX VELOCITY" },
    { id: "displacement", label: "DISPLACEMENT" },
    { id: "energy", label: "ENERGY" },
  ];
  return (
    <>
      <Panel title="Visualization Mode">
        <div className="grid grid-cols-2 gap-1">
          {modes.map((m) => (
            <Btn key={m.id} small active={v.mode === m.id} onClick={() => ctx.setViz({ mode: m.id })}>
              {m.label}
            </Btn>
          ))}
        </div>
      </Panel>
      <Panel title="Colour Scale">
        <Row label="Wave palette"><Select value={v.paletteWave} onChange={(x) => ctx.setViz({ paletteWave: x })} options={Object.values(PALETTES).map((p) => ({ value: p.id, label: p.name }))} /></Row>
        <Row label="Depth palette"><Select value={v.paletteDepth} onChange={(x) => ctx.setViz({ paletteDepth: x })} options={Object.values(PALETTES).map((p) => ({ value: p.id, label: p.name }))} /></Row>
        <Row label="Elev palette"><Select value={v.paletteElev} onChange={(x) => { ctx.setViz({ paletteElev: x }); ctx.actions.refreshTerrainRender(); }} options={Object.values(PALETTES).map((p) => ({ value: p.id, label: p.name }))} /></Row>
        <div className="h-3 border border-[#4a4e54] my-1" style={{ background: paletteCss(PALETTES[v.paletteWave] ?? PALETTES.wave) }} />
        <Toggle label="Auto range" value={v.autoRange} onChange={(x) => ctx.setViz({ autoRange: x })} />
        {!v.autoRange && (
          <>
            <Row label="Range min"><NumField value={v.rangeMin} onChange={(x) => ctx.setViz({ rangeMin: x })} step={0.1} /></Row>
            <Row label="Range max"><NumField value={v.rangeMax} onChange={(x) => ctx.setViz({ rangeMax: x })} step={0.1} /></Row>
          </>
        )}
      </Panel>
      <Panel title="Overlays">
        <Toggle label="Water surface" value={v.showWater} onChange={(x) => ctx.setViz({ showWater: x })} />
        <Toggle label="Terrain materials" value={v.materials} onChange={(x) => { ctx.setViz({ materials: x }); ctx.actions.refreshTerrainRender(); }} hint="Off = scientific elevation colours" />
        <Toggle label="Foam / breaking" value={v.showFoam} onChange={(x) => ctx.setViz({ showFoam: x })} />
        <Toggle label="Grid overlay" value={v.showGrid} onChange={(x) => ctx.setViz({ showGrid: x })} />
        <Toggle label="Velocity vectors" value={v.showVectors} onChange={(x) => ctx.setViz({ showVectors: x })} />
        <Toggle label="Wavefront contour" value={v.showContours} onChange={(x) => ctx.setViz({ showContours: x })} />
        <Row label="Front thresh.">
          <Select value={String(v.contourThreshold)} onChange={(x) => ctx.setViz({ contourThreshold: parseFloat(x) })} options={["0.1", "0.5", "1", "2", "5", "10"].map((s) => ({ value: s, label: s + " m" }))} />
        </Row>
        <Toggle label="Wireframe water" value={v.wireframe} onChange={(x) => ctx.setViz({ wireframe: x })} />
        <Slider label="Vert. exag." value={v.exaggeration} onChange={(x) => { ctx.setViz({ exaggeration: x }); ctx.engine.world.verticalExaggeration = x; ctx.actions.refreshTerrainRender(); }} min={0.5} max={60} step={0.1} unit="×" />
        <Slider label="Wave gain" value={v.waveAmplify} onChange={(x) => ctx.setViz({ waveAmplify: x })} min={0.2} max={50} step={0.1} unit="×" hint="Rendering only — the solver is unaffected" />
      </Panel>
      <Panel title="Camera">
        <div className="grid grid-cols-2 gap-1">
          <Btn small onClick={() => ctx.viewport?.resetCamera()}>Reset camera</Btn>
          <Btn small onClick={() => ctx.viewport?.topDown()}>Top-down</Btn>
          <Btn small onClick={() => { const e = ctx.engine; const s = e.source; const pos = s.kind === "fault" ? s.fault.segments[0] : s.kind === "asteroid" ? s.asteroid : s.kind === "explosion" ? s.explosion : s.custom; if (pos) ctx.actions.focus(pos.x, pos.y); }}>Frame source</Btn>
          <Btn small onClick={() => { const i = ctx.engine.instruments[0]; if (i) ctx.actions.focus(i.x, i.y); }}>Frame instrument</Btn>
        </div>
        <Toggle label="Minimap" value={ctx.ui.showMinimap} onChange={(x) => ctx.setUI({ showMinimap: x })} />
        <Toggle label="Cross-section" value={ctx.ui.showCross} onChange={(x) => ctx.setUI({ showCross: x })} />
        <Toggle label="Event log" value={ctx.ui.showLog} onChange={(x) => ctx.setUI({ showLog: x })} />
        <Toggle label="Debug panel" value={ctx.ui.showDebug} onChange={(x) => ctx.setUI({ showDebug: x })} />
        <Row label="Units">
          <Select value={ctx.ui.units} onChange={(x) => ctx.setUI({ units: x })} options={[{ value: "metric", label: "SI / METRIC" }, { value: "imperial", label: "IMPERIAL DISPLAY" }]} />
        </Row>
      </Panel>
    </>
  );
}

// ───────────────────────────────────────────────────────────── DATA
function DataTab({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Panel title="Project">
        <div className="grid grid-cols-2 gap-1">
          <Btn small onClick={() => ctx.actions.saveProject()}>Save .tsunami.json</Btn>
          <Btn small onClick={() => fileRef.current?.click()}>Load project</Btn>
          <Btn small onClick={() => ctx.actions.duplicateScenario()}>Duplicate scenario</Btn>
          <Btn small danger onClick={() => ctx.actions.resetScenario()}>Reset scenario</Btn>
        </div>
        <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={(ev) => { const f = ev.target.files?.[0]; if (f) ctx.actions.loadProjectFile(f); }} />
      </Panel>
      <Panel title="Export">
        <div className="grid grid-cols-2 gap-1">
          <Btn small onClick={() => download("sensors.csv", exportSensorCSV(e), "text/csv")}>Sensor CSV</Btn>
          <Btn small onClick={() => download("timeline.csv", exportTimelineCSV(e), "text/csv")}>Timeline CSV</Btn>
          <Btn small onClick={() => { const c = exportDisplacementCSV(e); if (!c) return ctx.actions.notify("No source applied — nothing to export.", "warning"); download("displacement.csv", c, "text/csv"); }}>Displacement</Btn>
          <Btn small onClick={() => { const d = ctx.viewport?.screenshot(); if (d) { const a = document.createElement("a"); a.href = d; a.download = "tsunami-lab.png"; a.click(); } }}>Screenshot PNG</Btn>
        </div>
      </Panel>
      <Panel title="Instruments">
        <div className="grid grid-cols-3 gap-1 mb-1">
          <Btn small active={ctx.ui.tool === "add-buoy"} onClick={() => ctx.setUI({ tool: "add-buoy" })}>+ Buoy</Btn>
          <Btn small active={ctx.ui.tool === "add-gauge"} onClick={() => ctx.setUI({ tool: "add-gauge" })}>+ Gauge</Btn>
          <Btn small active={ctx.ui.tool === "add-sensor"} onClick={() => ctx.setUI({ tool: "add-sensor" })}>+ Sensor</Btn>
        </div>
        {e.instruments.map((i) => (
          <div key={i.id} className={`flex items-center gap-1 px-1 py-[2px] border-l-2 ${ctx.ui.selectedInstrument === i.id ? "border-[#c69063] bg-[#241c14]" : "border-transparent"}`}>
            <button className="text-[10px] text-[#dfe2e5] flex-1 text-left truncate hover:text-[#e2b07a]" onClick={() => { ctx.setUI({ selectedInstrument: i.id }); ctx.actions.focus(i.x, i.y); }}>
              {i.name} <span className="text-[9px] text-[#80858b]">{i.type}</span>
            </button>
            <span className="text-[9px] font-mono text-[#a8adb3]">{i.peak.toFixed(2)} m</span>
            <Btn small danger onClick={() => ctx.actions.removeInstrument(i.id)}>✕</Btn>
          </div>
        ))}
        {!e.instruments.length && <p className="text-[9px] text-[#80858b]">No instruments placed.</p>}
      </Panel>
      <Panel title="Comparison">
        <p className="text-[9px] text-[#80858b] mb-1 leading-tight">Capture the current run as a baseline, change the source, run again and compare maxima.</p>
        <div className="grid grid-cols-2 gap-1">
          <Btn small onClick={() => ctx.actions.captureBaseline()}>Capture baseline</Btn>
          <Btn small active={ctx.ui.compareMode} disabled={!ctx.ui.baseline} onClick={() => ctx.setUI({ compareMode: !ctx.ui.compareMode })}>Difference mode</Btn>
        </div>
        {ctx.ui.baseline && (
          <div className="border border-[#3a3d42] mt-1">
            <Readout label="Baseline" value={ctx.ui.baseline.name} mono={false} />
            <Readout label="Δ max wave" value={(e.stats.maxWaveHeight - ctx.ui.baseline.stats.maxWaveHeight).toFixed(2)} unit="m" accent />
            <Readout label="Δ max velocity" value={(e.stats.maxVelocity - ctx.ui.baseline.stats.maxVelocity).toFixed(2)} unit="m/s" />
            <Readout label="Δ inundated area" value={((e.stats.maxInundationArea - ctx.ui.baseline.stats.maxInundationArea) / 1e6).toFixed(2)} unit="km²" />
            <Readout label="Δ first arrival" value={(e.stats.firstArrivalTime - ctx.ui.baseline.stats.firstArrivalTime).toFixed(1)} unit="s" />
          </div>
        )}
      </Panel>
    </>
  );
}
