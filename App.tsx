import { useCallback, useEffect, useRef, useState } from "react";
import { SimulationEngine } from "./core/SimulationEngine";
import { RenderOptions, Viewport } from "./render/Viewport";
import { Scenario, buildScenario } from "./data/scenarios";
import { Ctx, ProbeResult, UIState } from "./ui/types";
import { LeftPanel } from "./ui/LeftPanel";
import { RightPanel } from "./ui/RightPanel";
import { BottomBar, PlayByPlay } from "./ui/BottomBar";
import { CrossSection, Legend, Minimap } from "./ui/Overlays";
import { Btn, fmtTime } from "./ui/controls";
import { applyBrush } from "./terrain/TerrainEditor";
import { buildCustomSource } from "./sources";
import { download, parseProject, serializeProject } from "./data/ImportExport";

const DEFAULT_VIZ: RenderOptions = {
  mode: "realistic",
  paletteWave: "wave",
  paletteDepth: "depth",
  paletteElev: "elevation",
  rangeMin: 0,
  rangeMax: 5,
  autoRange: true,
  showGrid: false,
  showVectors: false,
  showContours: false,
  contourThreshold: 0.5,
  showWater: true,
  wireframe: false,
  exaggeration: 6,
  showFoam: true,
  materials: true,
  waveAmplify: 20,
};

function defaultUI(): UIState {
  return {
    playing: false,
    speed: 10,
    tool: "orbit",
    units: "metric",
    showMinimap: true,
    showCross: true,
    showDebug: false,
    showLog: true,
    showStats: true,
    showLeft: true,
    showRight: true,
    brush: { tool: "raise", radius: 4000, strength: 60, falloff: 0.5, shape: "round", pressure: 0.6 },
    measureA: null,
    measureB: null,
    crossA: null,
    crossB: null,
    probe: null,
    selectedInstrument: null,
    selectedCity: null,
    previewBeforeAfter: "after",
    loopStart: 0,
    loopEnd: 600,
    loopEnabled: false,
    baseline: null,
    compareMode: false,
    realElapsed: 0,
    fps: 0,
    maxSimTime: 3600,
  };
}

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SimulationEngine | null>(null);
  const vpRef = useRef<Viewport | null>(null);
  const vizRef = useRef<RenderOptions>({ ...DEFAULT_VIZ });
  const uiRef = useRef<UIState>(defaultUI());
  const legendRef = useRef<Ctx["legend"]>(null);
  const [, setTick] = useState(0);
  const [scenario, setScenario] = useState<Scenario>(() => buildScenario("subduction"));
  const [fatal, setFatal] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [toast, setToast] = useState<{ msg: string; sev: string } | null>(null);
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;

  const refresh = useCallback(() => setTick((t) => (t + 1) & 0xffff), []);
  const setUI = useCallback((p: Partial<UIState>) => {
    uiRef.current = { ...uiRef.current, ...p };
    refresh();
  }, [refresh]);
  const setViz = useCallback((p: Partial<RenderOptions>) => {
    vizRef.current = { ...vizRef.current, ...p };
    refresh();
  }, [refresh]);

  const notify = useCallback((msg: string, sev: "info" | "warning" | "critical" = "info") => {
    setToast({ msg, sev });
    setTimeout(() => setToast(null), 4200);
  }, []);

  // ───────────────────────────── boot
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let vp: Viewport;
    try {
      vp = new Viewport(mount);
    } catch (err) {
      setFatal(
        "RENDERER INITIALIZATION FAILED — WebGL2/WebGL could not be created on this device.\n" +
          (err as Error).message +
          "\n\nThe shallow-water solver requires a GPU-backed canvas for 3D display. Try a different browser, enable hardware acceleration, or reduce display scaling."
      );
      return;
    }
    vpRef.current = vp;
    const sc = scenarioRef.current;
    const eng = new SimulationEngine(sc.world, sc.physics, sc.terrain, sc.source);
    eng.instruments = sc.instruments.map((i) => ({ ...i, series: [] }));
    eng.cities = sc.cities.map((c) => ({ ...c }));
    eng.armSource();
    eng.resetSimulation();
    engineRef.current = eng;
    vizRef.current.exaggeration = eng.world.verticalExaggeration;
    vp.setEngine(eng);
    vp.updateTerrainGeometry(vizRef.current);
    vp.updateMarkers(vizRef.current);
    setBooted(true);

    const ro = new ResizeObserver(() => vp.resize());
    ro.observe(mount);

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let frames = 0;
    let fpsT = last;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dtReal = Math.min(0.1, (now - last) / 1000);
      last = now;
      const ui = uiRef.current;
      const e = engineRef.current!;
      if (ui.playing) {
        ui.realElapsed += dtReal;
        const budget = dtReal * ui.speed;
        e.advance(budget, 900);
        if (e.throttled) e.pushWarning("Solver throttled — requested speed exceeds available CPU time.", "warning");
        if (ui.loopEnabled && e.solver.time >= ui.loopEnd) {
          e.seek(Math.max(0, ui.loopStart));
        }
        if (e.solver.time >= ui.maxSimTime) {
          ui.playing = false;
          e.addEvent(e.solver.time, "End of timeline reached", "info");
        }
      }
      const viz = vizRef.current;
      try {
        vp.updateWater(viz);
        legendRef.current = vp.updateOverlay(viz);
        vp.updateVectors(viz);
        vp.setGrid(viz.showGrid, 32);
        vp.render();
      } catch (err) {
        e.pushWarning("Render error: " + (err as Error).message, "critical");
      }
      frames++;
      if (now - fpsT > 500) {
        ui.fps = (frames * 1000) / (now - fpsT);
        frames = 0;
        fpsT = now;
      }
      acc += dtReal;
      if (acc > 0.14) {
        acc = 0;
        e.updateStats();
        setTick((t) => (t + 1) & 0xffff);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      vp.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ───────────────────────────── actions
  const actions: Ctx["actions"] = {
    play: () => setUI({ playing: true }),
    pause: () => setUI({ playing: false }),
    togglePlay: () => setUI({ playing: !uiRef.current.playing }),
    step: () => {
      engineRef.current?.singleStep();
      refresh();
    },
    reset: () => {
      const e = engineRef.current!;
      e.resetSimulation();
      uiRef.current.realElapsed = 0;
      uiRef.current.playing = false;
      refresh();
      notify("Simulation reset — terrain and source preserved.");
    },
    resetScenario: () => {
      actions.loadScenario(scenarioRef.current.id);
      notify("Scenario restored to preset state.", "warning");
    },
    seek: (t) => {
      const e = engineRef.current!;
      const ok = e.seek(Math.max(0, Math.min(t, uiRef.current.maxSimTime)), 40000);
      if (!ok) notify("Seek failed — no checkpoint available.", "warning");
      refresh();
    },
    toEnd: () => {
      const e = engineRef.current!;
      const target = uiRef.current.maxSimTime;
      const t0 = performance.now();
      while (e.solver.time < target && performance.now() - t0 < 8000) e.advance(Math.min(30, target - e.solver.time), 4000);
      if (e.solver.time < target) notify("Fast-forward stopped after 8 s of compute — press END again to continue.", "warning");
      refresh();
    },
    setSpeed: (v) => setUI({ speed: v }),
    applySource: () => {
      const e = engineRef.current!;
      e.resetSimulation();
      e.armSource();
      e.resetSimulation();
      uiRef.current.playing = false;
      uiRef.current.realElapsed = 0;
      refresh();
      notify(`${e.source.kind.toUpperCase()} source armed — press PLAY to release.`, "info");
    },
    clearSource: () => {
      const e = engineRef.current!;
      e.clearSource();
      e.resetSimulation();
      refresh();
      notify("Source cleared — ocean returned to equilibrium.");
    },
    regenTerrain: () => {
      const e = engineRef.current!;
      e.rebuildTerrain();
      if (e.displacement) e.armSource();
      e.resetSimulation();
      vpRef.current?.rebuild();
      vpRef.current?.updateTerrainGeometry(vizRef.current);
      vpRef.current?.updateMarkers(vizRef.current);
      refresh();
    },
    rebuildWorld: () => {
      const e = engineRef.current!;
      const cells = e.world.physicsRes * e.world.physicsRes;
      if (cells > 640 * 640) {
        notify("Grid too large — physics resolution limited to 640².", "critical");
        e.world.physicsRes = 640;
      }
      e.rebuildTerrain();
      if (e.displacement) e.armSource();
      e.resetSimulation();
      vizRef.current.exaggeration = e.world.verticalExaggeration;
      vpRef.current?.rebuild();
      vpRef.current?.updateTerrainGeometry(vizRef.current);
      vpRef.current?.updateMarkers(vizRef.current);
      refresh();
      notify(`World rebuilt: ${e.world.physicsRes}² physics / ${e.world.terrainRes}² terrain / ${e.world.renderRes}² render.`);
    },
    loadScenario: (id) => {
      const sc = buildScenario(id);
      const eng = new SimulationEngine(sc.world, sc.physics, sc.terrain, sc.source);
      eng.instruments = sc.instruments.map((i) => ({ ...i, series: [] }));
      eng.cities = sc.cities.map((c) => ({ ...c }));
      eng.armSource();
      eng.resetSimulation();
      engineRef.current = eng;
      vizRef.current.exaggeration = eng.world.verticalExaggeration;
      uiRef.current = { ...uiRef.current, playing: false, realElapsed: 0, probe: null, measureA: null, measureB: null, crossA: null, crossB: null, baseline: null, compareMode: false };
      setScenario(sc);
      vpRef.current?.setEngine(eng);
      vpRef.current?.updateTerrainGeometry(vizRef.current);
      vpRef.current?.updateMarkers(vizRef.current);
      refresh();
      notify(`Scenario loaded: ${sc.name}`);
    },
    saveProject: () => {
      const e = engineRef.current!;
      const cam = vpRef.current ? vpRef.current.camera.position.toArray() : [0, 0, 0];
      download(`${scenarioRef.current.name.toLowerCase().replace(/\s+/g, "-")}.tsunami.json`, serializeProject(e, scenarioRef.current, vizRef.current, cam));
      notify("Project exported.");
    },
    loadProjectFile: async (f) => {
      try {
        const { json, heightfield } = parseProject(await f.text());
        const eng = new SimulationEngine(json.world, json.physics, json.terrainParams, json.source);
        eng.rebuildTerrain(heightfield);
        eng.instruments = (json.instruments ?? []).map((i: never) => ({ ...(i as object), series: [], firstArrival: -1, peak: 0 })) as typeof eng.instruments;
        eng.cities = json.cities ?? [];
        eng.armSource();
        eng.resetSimulation();
        engineRef.current = eng;
        vizRef.current = { ...vizRef.current, ...(json.visualization ?? {}) };
        setScenario({ ...scenarioRef.current, name: json.name ?? "IMPORTED PROJECT", description: "Imported project file." });
        vpRef.current?.setEngine(eng);
        vpRef.current?.updateTerrainGeometry(vizRef.current);
        vpRef.current?.updateMarkers(vizRef.current);
        refresh();
        notify("Project loaded.");
      } catch (err) {
        notify("PROJECT LOAD FAILED — " + (err as Error).message, "critical");
      }
    },
    duplicateScenario: () => {
      setScenario({ ...scenarioRef.current, name: scenarioRef.current.name + " (COPY)" });
      notify("Scenario duplicated in-session — original preset is untouched.");
    },
    captureBaseline: () => {
      const e = engineRef.current!;
      setUI({
        baseline: {
          name: `${e.source.kind.toUpperCase()} @ ${fmtTime(e.solver.time)}`,
          maxEta: e.solver.maxEta.slice(),
          maxDepth: e.solver.maxDepth.slice(),
          maxSpeed: e.solver.maxSpeed.slice(),
          arrival: e.solver.arrival.slice(),
          stats: { ...e.stats },
        },
      });
      notify("Baseline captured for comparison.");
    },
    refreshTerrainRender: () => {
      const e = engineRef.current!;
      e.syncTerrainToSolver();
      vpRef.current?.updateTerrainGeometry(vizRef.current);
      refresh();
    },
    addInstrument: (type, x, y) => {
      const e = engineRef.current!;
      e.instruments.push({
        id: "ins_" + Math.random().toString(36).slice(2, 8),
        type,
        name: `${type.toUpperCase()}-${e.instruments.length + 1}`,
        x,
        y,
        series: [],
        firstArrival: -1,
        peak: 0,
      });
      vpRef.current?.updateMarkers(vizRef.current);
      refresh();
    },
    removeInstrument: (id) => {
      const e = engineRef.current!;
      e.instruments = e.instruments.filter((i) => i.id !== id);
      vpRef.current?.updateMarkers(vizRef.current);
      refresh();
    },
    focus: (x, y) => {
      vpRef.current?.focusWorld(x, y, 60);
      refresh();
    },
    notify,
  };

  // ───────────────────────────── keyboard
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const e = engineRef.current;
      if (!e) return;
      const ui = uiRef.current;
      switch (ev.key) {
        case " ":
          ev.preventDefault();
          actions.togglePlay();
          break;
        case "r":
        case "R":
          actions.reset();
          break;
        case "f":
        case "F": {
          const s = e.source;
          const p = s.kind === "fault" ? s.fault.segments[0] : s.kind === "asteroid" ? s.asteroid : s.kind === "explosion" ? s.explosion : s.custom;
          if (p) actions.focus(p.x, p.y);
          break;
        }
        case "t":
        case "T":
          setUI({ tool: ui.tool === "terrain-edit" ? "orbit" : "terrain-edit" });
          break;
        case "w":
        case "W":
          setViz({ mode: "waveheight" });
          break;
        case "v":
        case "V":
          setViz({ mode: "velocity" });
          break;
        case "i":
        case "I":
          setViz({ mode: "inundation" });
          break;
        case "m":
        case "M":
          setUI({ tool: ui.tool === "measure-distance" ? "orbit" : "measure-distance", measureA: null, measureB: null });
          break;
        case "g":
        case "G":
          setViz({ showGrid: !vizRef.current.showGrid });
          break;
        case "c":
        case "C":
          vpRef.current?.resetCamera();
          break;
        case "[":
          actions.setSpeed(Math.max(0.1, ui.speed / 2));
          break;
        case "]":
          actions.setSpeed(Math.min(500, ui.speed * 2));
          break;
        case "ArrowLeft":
          ev.preventDefault();
          actions.seek(Math.max(0, e.solver.time - 10));
          break;
        case "ArrowRight":
          ev.preventDefault();
          actions.seek(e.solver.time + 10);
          break;
        case "Home":
          actions.seek(0);
          break;
        case "End":
          actions.toEnd();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ───────────────────────────── viewport interaction
  const painting = useRef(false);
  const onPointerDown = (ev: React.PointerEvent) => {
    const vp = vpRef.current,
      e = engineRef.current;
    if (!vp || !e) return;
    const ui = uiRef.current;
    if (ui.tool === "orbit") return;
    const hit = vp.pick(ev.clientX, ev.clientY);
    if (!hit) return;
    switch (ui.tool) {
      case "place-source": {
        const s = e.source;
        if (s.kind === "fault") s.fault.segments.forEach((g) => { g.x = hit.x; g.y = hit.y; });
        else if (s.kind === "asteroid") { s.asteroid.x = hit.x; s.asteroid.y = hit.y; }
        else if (s.kind === "explosion") { s.explosion.x = hit.x; s.explosion.y = hit.y; }
        else { s.custom.x = hit.x; s.custom.y = hit.y; }
        setUI({ tool: "orbit" });
        notify(`Source moved to X ${(hit.x / 1000).toFixed(1)} km / Y ${(hit.y / 1000).toFixed(1)} km — press APPLY SOURCE.`);
        break;
      }
      case "probe": {
        setUI({ probe: probeAt(e, hit.x, hit.y) });
        break;
      }
      case "measure-distance": {
        if (!ui.measureA || ui.measureB) setUI({ measureA: { x: hit.x, y: hit.y }, measureB: null });
        else setUI({ measureB: { x: hit.x, y: hit.y } });
        break;
      }
      case "cross-section": {
        if (!ui.crossA || ui.crossB) setUI({ crossA: { x: hit.x, y: hit.y }, crossB: null, showCross: true });
        else setUI({ crossB: { x: hit.x, y: hit.y }, tool: "orbit" });
        break;
      }
      case "add-buoy":
      case "add-gauge":
      case "add-sensor": {
        actions.addInstrument(ui.tool.replace("add-", "") as "buoy", hit.x, hit.y);
        setUI({ tool: "orbit" });
        break;
      }
      case "paint-displacement": {
        const g = e.grid;
        const f = buildCustomSource(g, { ...e.source.custom, x: hit.x, y: hit.y });
        const sv = e.solver;
        for (let k = 0; k < sv.nx * sv.ny; k++) {
          if (sv.eta[k] - sv.zb[k] > sv.cfg.minDepth) sv.eta[k] += f.water[k];
          sv.zb[k] += f.bed[k];
        }
        e.addEvent(sv.time, "Manual water disturbance painted", "warning");
        refresh();
        break;
      }
      case "terrain-edit": {
        painting.current = true;
        vp.controls.enabled = false;
        applyBrush(e.terrain, hit.x, hit.y, ui.brush, e.world.seaLevel);
        actions.refreshTerrainRender();
        break;
      }
    }
  };
  const onPointerMove = (ev: React.PointerEvent) => {
    if (!painting.current) return;
    const vp = vpRef.current,
      e = engineRef.current;
    if (!vp || !e) return;
    const hit = vp.pick(ev.clientX, ev.clientY);
    if (!hit) return;
    applyBrush(e.terrain, hit.x, hit.y, uiRef.current.brush, e.world.seaLevel);
    actions.refreshTerrainRender();
  };
  const onPointerUp = () => {
    if (painting.current) {
      painting.current = false;
      if (vpRef.current) vpRef.current.controls.enabled = true;
      engineRef.current?.addEvent(engineRef.current.solver.time, "Bathymetry edited — solver updated", "info");
    }
  };

  if (fatal) {
    return (
      <div className="w-screen h-screen bg-[#121416] text-[#dfe2e5] p-8 font-mono text-sm">
        <h1 className="text-[#e2b07a] text-lg tracking-[0.2em] mb-4">TSUNAMI LAB — DIAGNOSTIC</h1>
        <pre className="whitespace-pre-wrap border border-[#7a3b33] bg-[#1c1516] p-4 text-[#e59b86]">{fatal}</pre>
      </div>
    );
  }

  const engine = engineRef.current;
  const ctx: Ctx | null = engine
    ? {
        engine,
        viewport: vpRef.current,
        scenario,
        ui: uiRef.current,
        setUI,
        viz: vizRef.current,
        setViz,
        refresh,
        actions,
        legend: legendRef.current,
      }
    : null;
  const ui = uiRef.current;

  return (
    <div className="w-screen h-screen flex flex-col bg-[#121416] text-[#dfe2e5] overflow-hidden select-none">
      {/* TOP BAR */}
      <header className="flex items-center gap-3 px-3 py-1 bg-gradient-to-b from-[#2d3034] to-[#202326] border-b border-[#6b4a2c]">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] tracking-[0.3em] font-bold text-[#d99f5f]">TSUNAMI</span>
          <span className="text-[13px] tracking-[0.3em] font-light text-[#aeb3b8]">LAB</span>
          <span className="text-[9px] text-[#7d8288] tracking-widest">SWE SOLVER v1.0</span>
        </div>
        <div className="h-4 w-px bg-[#4a4e54]" />
        <span className="text-[10px] tracking-[0.15em] text-[#c9cdd1]">{scenario.name}</span>
        {engine && (
          <>
            <span
              className={`text-[9px] px-1.5 py-[1px] border tracking-[0.15em] ${
                ui.playing ? "border-[#7d9a4a] text-[#bcd98a] bg-[#1f2a17]" : "border-[#6a6f75] text-[#a8adb3] bg-[#1a1c1f]"
              }`}
            >
              {ui.playing ? "RUNNING" : "PAUSED"}
            </span>
            <span className="text-[9px] text-[#80858b] font-mono">
              {engine.solver.nx}×{engine.solver.ny} · Δt {engine.solver.diag.dt.toFixed(2)}s · {ui.fps.toFixed(0)} FPS
            </span>
            {engine.warnings.length > 0 && (
              <span className="text-[9px] px-1.5 py-[1px] border border-[#a06a2a] bg-[#2a2015] text-[#e5c77f] tracking-wider" title={engine.warnings.join("\n")}>
                ⚠ {engine.warnings.length} SOLVER WARNING{engine.warnings.length > 1 ? "S" : ""}
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Btn small active={ui.tool === "probe"} onClick={() => setUI({ tool: ui.tool === "probe" ? "orbit" : "probe" })} title="Probe elevation / depth / velocity">Probe</Btn>
          <Btn small active={ui.tool === "measure-distance"} onClick={() => setUI({ tool: ui.tool === "measure-distance" ? "orbit" : "measure-distance", measureA: null, measureB: null })}>Measure</Btn>
          <Btn small active={ui.tool === "cross-section"} onClick={() => setUI({ tool: ui.tool === "cross-section" ? "orbit" : "cross-section", crossA: null, crossB: null })}>Section</Btn>
          <Btn small active={ui.tool === "terrain-edit"} onClick={() => setUI({ tool: ui.tool === "terrain-edit" ? "orbit" : "terrain-edit" })}>Sculpt</Btn>
          <div className="w-px h-4 bg-[#4a4e54] mx-1" />
          <Btn small onClick={() => actions.saveProject()}>Save</Btn>
          <Btn small onClick={() => setUI({ showLeft: !ui.showLeft })}>◧</Btn>
          <Btn small onClick={() => setUI({ showRight: !ui.showRight })}>◨</Btn>
          <Btn small active={ui.showDebug} onClick={() => setUI({ showDebug: !ui.showDebug })}>Debug</Btn>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* LEFT */}
        {ui.showLeft && ctx && (
          <aside className="w-[280px] shrink-0 border-r border-[#4a4e54] bg-[#17191c] hidden md:block">
            <LeftPanel ctx={ctx} />
          </aside>
        )}

        {/* VIEWPORT */}
        <main className="flex-1 relative min-w-0">
          <div
            ref={mountRef}
            className="absolute inset-0"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            style={{ cursor: ui.tool === "orbit" ? "grab" : "crosshair" }}
          />
          {!booted && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#121416] text-[#a8adb3] text-[11px] tracking-[0.2em]">
              INITIALIZING SOLVER…
            </div>
          )}
          {ctx && (
            <>
              <div className="absolute top-2 left-2 flex flex-col gap-2 pointer-events-none">
                <Legend ctx={ctx} />
                {ui.tool !== "orbit" && (
                  <div className="border border-[#b5763c] bg-[#241c14]/95 px-2 py-1 text-[10px] text-[#e2b07a] tracking-wider pointer-events-auto">
                    TOOL: {ui.tool.replace("-", " ").toUpperCase()} — click in the viewport
                    <button className="ml-2 text-[#c9cdd1] underline" onClick={() => setUI({ tool: "orbit" })}>cancel</button>
                  </div>
                )}
              </div>
              <div className="absolute top-2 right-2 flex flex-col gap-2 items-end pointer-events-none">
                {ui.showMinimap && <Minimap ctx={ctx} />}
                {ui.showCross && <CrossSection ctx={ctx} />}
              </div>
              {ui.showLog && (
                <div className="absolute bottom-2 left-2 w-[420px] h-[158px] border border-[#4a4e54] bg-[#141618]/95">
                  <PlayByPlay ctx={ctx} />
                </div>
              )}
              {toast && (
                <div
                  className={`absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 text-[10px] tracking-wider border ${
                    toast.sev === "critical"
                      ? "border-[#a3453a] bg-[#2a1715] text-[#e59b86]"
                      : toast.sev === "warning"
                      ? "border-[#a06a2a] bg-[#2a2015] text-[#e5c77f]"
                      : "border-[#4a4e54] bg-[#1c1f22] text-[#c9cdd1]"
                  }`}
                >
                  {toast.msg}
                </div>
              )}
            </>
          )}
        </main>

        {/* RIGHT */}
        {ui.showRight && ctx && (
          <aside className="w-[250px] shrink-0 border-l border-[#4a4e54] bg-[#17191c] hidden lg:block">
            <RightPanel ctx={ctx} />
          </aside>
        )}
      </div>

      {ctx && <BottomBar ctx={ctx} />}
    </div>
  );
}

function probeAt(e: SimulationEngine, x: number, y: number): ProbeResult {
  const g = e.grid;
  const i = Math.min(g.nx - 1, Math.max(0, Math.floor(x / g.dx)));
  const j = Math.min(g.ny - 1, Math.max(0, Math.floor(y / g.dy)));
  const k = j * g.nx + i;
  const sv = e.solver;
  const D = Math.max(0, sv.eta[k] - sv.zb[k]);
  return {
    x,
    y,
    bed: sv.zb[k],
    eta: sv.eta[k] - Math.max(e.world.seaLevel, sv.zb[k]),
    depth: D,
    speed: D > sv.cfg.minDepth ? Math.hypot(sv.M[k], sv.N[k]) / D : 0,
    arrival: sv.arrival[k],
    maxEta: sv.maxEta[k],
    maxDepth: sv.maxDepth[k],
  };
}
