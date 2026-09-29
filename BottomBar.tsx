import { useRef } from "react";
import { Btn, NumField, fmtTime } from "./controls";
import { Ctx } from "./types";

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 50, 100];

export function BottomBar({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const tMax = ctx.ui.maxSimTime;

  const seekFromEvent = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    ctx.actions.seek(f * tMax);
  };

  return (
    <div className="border-t border-[#4a4e54] bg-[#141618]">
      <div className="flex items-center gap-1.5 px-2 py-1 flex-wrap">
        <Btn onClick={() => ctx.actions.togglePlay()} active={ctx.ui.playing} title="Space">
          {ctx.ui.playing ? "▮▮ Pause" : "▶ Play"}
        </Btn>
        <Btn onClick={() => ctx.actions.step()} title="Single solver step (→)">⏭ Step</Btn>
        <Btn onClick={() => ctx.actions.seek(Math.max(0, e.solver.time - 10))} title="Back 10 s (←)">⏪ −10s</Btn>
        <Btn onClick={() => ctx.actions.seek(e.solver.time + 10)} title="Forward 10 s">⏩ +10s</Btn>
        <Btn onClick={() => ctx.actions.seek(0)} title="HOME">⏮ Start</Btn>
        <Btn onClick={() => ctx.actions.toEnd()} title="END — run to end of timeline">⏭ End</Btn>
        <Btn danger onClick={() => ctx.actions.reset()} title="R — reset simulation (terrain kept)">⟲ Reset Sim</Btn>

        <div className="flex items-center gap-1 ml-2">
          <span className="text-[9px] uppercase tracking-wider text-[#80858b]">Speed</span>
          {SPEEDS.map((s) => (
            <Btn key={s} small active={ctx.ui.speed === s} onClick={() => ctx.actions.setSpeed(s)}>
              {s}×
            </Btn>
          ))}
          <div className="w-[64px]">
            <NumField value={ctx.ui.speed} onChange={(v) => ctx.actions.setSpeed(Math.max(0.01, v))} step={1} unit="×" />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[15px] text-[#e2b07a] tabular-nums tracking-tight border border-[#4a4e54] bg-[#0f1113] px-2 py-[1px]">
            [ {fmtTime(e.solver.time, true)} ]
          </span>
          <div className="flex items-center gap-1">
            <span className="text-[9px] uppercase text-[#80858b]">Span</span>
            <div className="w-[80px]">
              <NumField value={tMax} onChange={(v) => ctx.setUI({ maxSimTime: Math.max(60, v) })} step={600} unit="s" />
            </div>
          </div>
          <Btn small active={ctx.ui.loopEnabled} onClick={() => ctx.setUI({ loopEnabled: !ctx.ui.loopEnabled })} title="Loop the selected interval">Loop</Btn>
          <div className="w-[70px]"><NumField value={ctx.ui.loopStart} onChange={(v) => ctx.setUI({ loopStart: v })} step={10} unit="s" /></div>
          <div className="w-[70px]"><NumField value={ctx.ui.loopEnd} onChange={(v) => ctx.setUI({ loopEnd: v })} step={10} unit="s" /></div>
        </div>
      </div>

      {/* timeline */}
      <div className="px-2 pb-1.5">
        <div
          ref={barRef}
          tabIndex={0}
          role="slider"
          aria-label="simulation timeline"
          aria-valuenow={Math.round(e.solver.time)}
          aria-valuemin={0}
          aria-valuemax={tMax}
          className="relative h-10 bg-[#0f1113] border border-[#4a4e54] cursor-crosshair select-none"
          onPointerDown={(ev) => {
            dragging.current = true;
            (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
            seekFromEvent(ev.clientX);
          }}
          onPointerMove={(ev) => dragging.current && seekFromEvent(ev.clientX)}
          onPointerUp={() => (dragging.current = false)}
          onKeyDown={(ev) => {
            if (ev.key === "ArrowLeft") ctx.actions.seek(Math.max(0, e.solver.time - 10));
            if (ev.key === "ArrowRight") ctx.actions.seek(e.solver.time + 10);
          }}
        >
          {/* checkpoint ticks */}
          {e.checkpoints.map((c, i) => (
            <div key={i} className="absolute bottom-0 w-px h-2 bg-[#3f4a52]" style={{ left: `${(c.time / tMax) * 100}%` }} />
          ))}
          {/* loop region */}
          {ctx.ui.loopEnabled && (
            <div
              className="absolute top-0 bottom-0 bg-[#6d431f]/25 border-x border-[#b5763c]"
              style={{ left: `${(ctx.ui.loopStart / tMax) * 100}%`, width: `${((ctx.ui.loopEnd - ctx.ui.loopStart) / tMax) * 100}%` }}
            />
          )}
          {/* simulated extent */}
          <div className="absolute top-0 bottom-0 bg-[#1d2a30]/60" style={{ width: `${Math.min(100, (maxSimulated(ctx) / tMax) * 100)}%` }} />
          {/* events */}
          {e.events.map((ev, i) => (
            <button
              key={i}
              title={`${fmtTime(ev.t, true)} — ${ev.label}${ev.detail ? " · " + ev.detail : ""}`}
              onClick={(m) => { m.stopPropagation(); ctx.actions.seek(ev.t); }}
              onPointerDown={(m) => m.stopPropagation()}
              className={`absolute top-1 w-[3px] h-5 hover:h-7 transition-all ${
                ev.severity === "critical" ? "bg-[#d2542c]" : ev.severity === "warning" ? "bg-[#d9a021]" : "bg-[#6f8d9a]"
              }`}
              style={{ left: `${(ev.t / tMax) * 100}%` }}
            />
          ))}
          {/* playhead */}
          <div className="absolute top-0 bottom-0 w-[2px] bg-[#f0d6b0] pointer-events-none" style={{ left: `${Math.min(100, (e.solver.time / tMax) * 100)}%` }}>
            <div className="absolute -top-0 -left-[4px] w-[10px] h-[6px] bg-[#f0d6b0]" />
          </div>
          {/* time ruler */}
          {Array.from({ length: 11 }, (_, i) => (
            <div key={i} className="absolute bottom-0 text-[8px] font-mono text-[#5f646a] pl-[2px]" style={{ left: `${i * 10}%` }}>
              {fmtTime((i * tMax) / 10)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function maxSimulated(ctx: Ctx) {
  const cps = ctx.engine.checkpoints;
  return Math.max(ctx.engine.solver.time, cps.length ? cps[cps.length - 1].time : 0);
}

export function PlayByPlay({ ctx }: { ctx: Ctx }) {
  const e = ctx.engine;
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-2 py-1 bg-gradient-to-b from-[#2b2e32] to-[#212427] border-b border-[#4a4e54]">
        <h3 className="text-[10px] tracking-[0.18em] font-semibold text-[#c69063] uppercase">Play-by-play · Event Log</h3>
        <div className="flex gap-1 items-center">
          <span className="text-[9px] font-mono text-[#8d9298]">{e.events.length} EVENTS</span>
          <Btn small onClick={() => ctx.setUI({ showLog: false })}>✕</Btn>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto tsu-scroll font-mono text-[10px]">
        {e.events.slice().reverse().map((ev, i) => (
          <button
            key={i}
            onClick={() => ctx.actions.seek(ev.t)}
            className="w-full text-left px-2 py-[2px] hover:bg-[#23262a] flex gap-2 items-baseline border-b border-[#1d2023]"
          >
            <span className="text-[#7f858b] tabular-nums">{fmtTime(ev.t, true)}</span>
            <span
              className={`px-1 text-[8px] tracking-wider ${
                ev.severity === "critical"
                  ? "bg-[#4a1f18] text-[#e59b86]"
                  : ev.severity === "warning"
                  ? "bg-[#4a3a15] text-[#e5c77f]"
                  : "bg-[#1f2c33] text-[#8fb4c4]"
              }`}
            >
              {ev.severity.toUpperCase()}
            </span>
            <span className="text-[#d8dce0] flex-1">{ev.label}</span>
            {ev.detail && <span className="text-[#80858b]">{ev.detail}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
