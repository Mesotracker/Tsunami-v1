import { useEffect, useRef } from "react";
import { Btn, Panel, Readout, fmtBytes, fmtDist, fmtNum, fmtTime } from "./controls";
import { Ctx } from "./types";

export function RightPanel({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const s = e.stats;
  const imp = ctx.ui.units === "imperial";
  const sel = e.instruments.find((i) => i.id === ctx.ui.selectedInstrument) ?? e.instruments[0];
  const city = e.cities.find((c) => c.id === ctx.ui.selectedCity);
  return (
    <div className="h-full overflow-y-auto p-1.5 tsu-scroll">
      <Panel title="Live Data">
        <Readout label="Sim time" value={fmtTime(e.solver.time, true)} accent />
        <Readout label="Real elapsed" value={fmtTime(ctx.ui.realElapsed)} />
        <Readout label="Speed" value={ctx.ui.speed + "×"} />
        <Readout label="Physics Δt" value={e.solver.diag.dt.toFixed(3)} unit="s" />
        <Readout label="Max wave η" value={s.maxWaveHeight.toFixed(2)} unit="m" accent />
        <Readout label="Max velocity" value={s.maxVelocity.toFixed(2)} unit="m/s" />
        <Readout label="Peak water level" value={s.peakWaterLevel.toFixed(2)} unit="m" />
        <Readout label="First arrival" value={fmtTime(s.firstArrivalTime, true)} />
        <Readout label="Inundated area" value={(s.maxInundationArea / 1e6).toFixed(2)} unit="km²" />
        <Readout label="Inland penetration" value={fmtDist(s.maxInundationDistance, imp)} />
        <Readout label="Wet cells" value={s.wetCells.toLocaleString()} />
      </Panel>

      {ctx.ui.probe && (
        <Panel title="Probe" right={<Btn small onClick={() => ctx.setUI({ probe: null })}>✕</Btn>}>
          <Readout label="X" value={fmtDist(ctx.ui.probe.x, imp)} />
          <Readout label="Y" value={fmtDist(ctx.ui.probe.y, imp)} />
          <Readout label="Bed elevation" value={ctx.ui.probe.bed.toFixed(1)} unit="m" accent />
          <Readout label="Surface η" value={ctx.ui.probe.eta.toFixed(3)} unit="m" />
          <Readout label="Water depth" value={ctx.ui.probe.depth.toFixed(2)} unit="m" />
          <Readout label="Flow speed" value={ctx.ui.probe.speed.toFixed(2)} unit="m/s" />
          <Readout label="Arrival" value={fmtTime(ctx.ui.probe.arrival, true)} />
          <Readout label="Max η here" value={ctx.ui.probe.maxEta.toFixed(2)} unit="m" />
          <Readout label="Max depth here" value={ctx.ui.probe.maxDepth.toFixed(2)} unit="m" />
        </Panel>
      )}

      {ctx.ui.measureA && ctx.ui.measureB && (
        <Panel title="Distance Measurement">
          <Readout label="From" value={`${(ctx.ui.measureA.x / 1000).toFixed(2)}, ${(ctx.ui.measureA.y / 1000).toFixed(2)} km`} />
          <Readout label="To" value={`${(ctx.ui.measureB.x / 1000).toFixed(2)}, ${(ctx.ui.measureB.y / 1000).toFixed(2)} km`} />
          <Readout label="Distance" value={fmtDist(Math.hypot(ctx.ui.measureB.x - ctx.ui.measureA.x, ctx.ui.measureB.y - ctx.ui.measureA.y), imp)} accent />
          <Readout label="Est. travel time √(gh)" value={estTravel(ctx)} />
        </Panel>
      )}

      {sel && (
        <Panel title={`Instrument · ${sel.name}`}>
          <Readout label="Type" value={sel.type.toUpperCase()} />
          <Readout label="Position" value={`${(sel.x / 1000).toFixed(1)}, ${(sel.y / 1000).toFixed(1)} km`} />
          <Readout label="Bed" value={e.bedAtWorld(sel.x, sel.y).toFixed(1)} unit="m" />
          <Readout label="First arrival" value={fmtTime(sel.firstArrival, true)} accent />
          <Readout label="Peak η" value={sel.peak.toFixed(3)} unit="m" />
          <Readout label="Samples" value={sel.series.length} />
          <Sparkline series={sel.series} />
        </Panel>
      )}

      <Panel title="Cities / Structures" collapsible defaultOpen>
        {e.cities.map((c) => {
          const g = e.grid;
          const i = Math.min(g.nx - 1, Math.floor(c.x / g.dx));
          const j = Math.min(g.ny - 1, Math.floor(c.y / g.dy));
          const k = j * g.nx + i;
          return (
            <button key={c.id} onClick={() => { ctx.setUI({ selectedCity: c.id }); ctx.actions.focus(c.x, c.y); }} className={`w-full text-left px-1 py-[2px] border-l-2 ${ctx.ui.selectedCity === c.id ? "border-[#c69063] bg-[#241c14]" : "border-transparent hover:bg-[#1d2023]"}`}>
              <div className="flex justify-between text-[10px]">
                <span className="text-[#dfe2e5]">{c.name}</span>
                <span className="font-mono text-[#a8adb3]">{e.solver.maxDepth[k] > 0.05 ? e.solver.maxDepth[k].toFixed(1) + " m" : "dry"}</span>
              </div>
            </button>
          );
        })}
        {!e.cities.length && <p className="text-[9px] text-[#80858b]">No city markers in this scenario.</p>}
        {city && (
          <div className="border border-[#3a3d42] mt-1">
            {(() => {
              const g = e.grid;
              const i = Math.min(g.nx - 1, Math.floor(city.x / g.dx));
              const j = Math.min(g.ny - 1, Math.floor(city.y / g.dy));
              const k = j * g.nx + i;
              return (
                <>
                  <Readout label="Population" value={city.population.toLocaleString()} />
                  <Readout label="Elevation" value={e.bedAtWorld(city.x, city.y).toFixed(1)} unit="m" />
                  <Readout label="Arrival" value={fmtTime(e.solver.arrival[k], true)} accent />
                  <Readout label="Max depth" value={e.solver.maxDepth[k].toFixed(2)} unit="m" />
                  <Readout label="Max velocity" value={e.solver.maxSpeed[k].toFixed(2)} unit="m/s" />
                  <Readout label="Max η" value={e.solver.maxEta[k].toFixed(2)} unit="m" />
                </>
              );
            })()}
          </div>
        )}
      </Panel>

      {ctx.ui.showStats && (
        <Panel title="Simulation Statistics">
          <Readout label="Max wave height" value={s.maxWaveHeight.toFixed(3)} unit="m" accent />
          <Readout label="Max water velocity" value={s.maxVelocity.toFixed(3)} unit="m/s" />
          <Readout label="Max inundated area" value={(s.maxInundationArea / 1e6).toFixed(3)} unit="km²" />
          <Readout label="Max inundation dist." value={fmtDist(s.maxInundationDistance, imp)} />
          <Readout label="Max coastal elevation" value={s.maxCoastalElevationReached.toFixed(1)} unit="m" />
          <Readout label="Time to first arrival" value={fmtTime(s.firstArrivalTime, true)} />
          <Readout label="Time to peak" value={fmtTime(s.timeToPeak, true)} />
          <Readout label="Total water volume" value={fmtNum(s.volume / 1e9)} unit="km³" />
          <Readout label="Volume drift" value={fmtNum(s.volumeError)} unit="m³" />
          <Readout label="Total energy" value={s.energy.toExponential(2)} unit="J" />
          <Readout label="Duration simulated" value={fmtTime(e.solver.time, true)} />
        </Panel>
      )}

      {ctx.ui.showDebug && (
        <Panel title="Debug / Developer">
          <Readout label="FPS" value={ctx.ui.fps.toFixed(0)} accent />
          <Readout label="Frame time" value={(1000 / Math.max(ctx.ui.fps, 0.01)).toFixed(1)} unit="ms" />
          <Readout label="Physics time" value={e.physicsMsAvg.toFixed(2)} unit="ms" />
          <Readout label="Render time" value={(ctx.viewport?.gpuFrameMs ?? 0).toFixed(2)} unit="ms" />
          <Readout label="Triangles" value={(ctx.viewport?.triangles ?? 0).toLocaleString()} />
          <Readout label="Draw calls" value={ctx.viewport?.drawCalls ?? 0} />
          <Readout label="Grid" value={`${e.solver.nx} × ${e.solver.ny}`} />
          <Readout label="Active/total cells" value={`${e.solver.diag.activeCells.toLocaleString()} / ${e.solver.diag.totalCells.toLocaleString()}`} />
          <Readout label="Solver steps" value={e.solver.step.toLocaleString()} />
          <Readout label="CFL number" value={e.physics.cfl.toFixed(2)} />
          <Readout label="Current Δt" value={e.solver.diag.dt.toFixed(4)} unit="s" />
          <Readout label="NaN repaired" value={e.solver.diag.nanCount} />
          <Readout label="Clamped (last step)" value={e.solver.diag.clampCount} />
          <Readout label="Checkpoint cache" value={fmtBytes(e.checkpointBytes())} />
          <Readout label="Throttled" value={e.throttled ? "YES" : "no"} />
          <Readout label="Renderer" value={ctx.viewport?.capabilities.webgl2 ? "WebGL2" : "WebGL1"} />
          <p className="text-[8px] text-[#6d7278] mt-1 break-words">{ctx.viewport?.capabilities.renderer}</p>
        </Panel>
      )}
    </div>
  );
}

function estTravel(ctx: Ctx) {
  const a = ctx.ui.measureA!,
    b = ctx.ui.measureB!;
  const e = ctx.engine;
  const n = 40;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n;
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    const d = Math.max(1, e.world.seaLevel - e.bedAtWorld(x, y));
    const c = Math.sqrt(e.physics.gravity * d);
    t += Math.hypot(b.x - a.x, b.y - a.y) / n / c;
  }
  return fmtTime(t, true);
}

function Sparkline({ series }: { series: { t: number; eta: number }[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx2 = c.getContext("2d");
    if (!ctx2) return;
    const w = (c.width = c.clientWidth * 2);
    const h = (c.height = 120);
    ctx2.fillStyle = "#0f1113";
    ctx2.fillRect(0, 0, w, h);
    if (series.length < 2) return;
    let lo = Infinity,
      hi = -Infinity;
    for (const s of series) {
      lo = Math.min(lo, s.eta);
      hi = Math.max(hi, s.eta);
    }
    const m = Math.max(Math.abs(lo), Math.abs(hi), 0.05);
    ctx2.strokeStyle = "#3a3d42";
    ctx2.beginPath();
    ctx2.moveTo(0, h / 2);
    ctx2.lineTo(w, h / 2);
    ctx2.stroke();
    ctx2.strokeStyle = "#e2b07a";
    ctx2.lineWidth = 2;
    ctx2.beginPath();
    const t0 = series[0].t,
      t1 = series[series.length - 1].t;
    series.forEach((s, i) => {
      const x = ((s.t - t0) / Math.max(1e-6, t1 - t0)) * w;
      const y = h / 2 - (s.eta / m) * (h / 2 - 4);
      i === 0 ? ctx2.moveTo(x, y) : ctx2.lineTo(x, y);
    });
    ctx2.stroke();
    ctx2.fillStyle = "#80858b";
    ctx2.font = "16px monospace";
    ctx2.fillText(`±${m.toFixed(2)} m`, 6, 18);
  }, [series, series.length]);
  return <canvas ref={ref} className="w-full h-[60px] border border-[#3a3d42] mt-1" />;
}
