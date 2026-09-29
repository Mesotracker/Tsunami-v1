import { useEffect, useRef } from "react";
import { Btn, fmtTime } from "./controls";
import { Ctx } from "./types";
import { PALETTES, paletteCss, samplePalette } from "../render/palettes";

// ─────────────────────────────────────────────── MINIMAP
export function Minimap({ ctx }: { ctx: Ctx }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<{ img: ImageData | null; key: string }>({ img: null, key: "" });
  const e = ctx.engine;
  const SIZE = 168;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g2 = c.getContext("2d");
    if (!g2) return;
    const g = e.grid;
    const key = `${g.nx}x${g.ny}:${e.terrainParams.seed}:${e.world.width}:${e.terrain.data.length}`;
    if (baseRef.current.key !== key || !baseRef.current.img) {
      const img = g2.createImageData(SIZE, SIZE);
      for (let j = 0; j < SIZE; j++) {
        for (let i = 0; i < SIZE; i++) {
          const el = e.terrain.sampleUV(i / (SIZE - 1), j / (SIZE - 1));
          const k = (j * SIZE + i) * 4;
          let c3: [number, number, number];
          if (el < e.world.seaLevel) {
            const t = Math.min(1, (e.world.seaLevel - el) / 4000);
            c3 = [20 + 20 * (1 - t), 50 + 60 * (1 - t), 80 + 70 * (1 - t)];
          } else {
            const t = Math.min(1, el / 1500);
            c3 = [90 + 110 * t, 105 + 90 * t, 70 + 100 * t];
          }
          img.data[k] = c3[0];
          img.data[k + 1] = c3[1];
          img.data[k + 2] = c3[2];
          img.data[k + 3] = 255;
        }
      }
      baseRef.current = { img, key };
    }
    g2.putImageData(baseRef.current.img!, 0, 0);
    // wave field
    const sv = e.solver;
    const ov = g2.getImageData(0, 0, SIZE, SIZE);
    for (let j = 0; j < SIZE; j++) {
      const gj = Math.min(g.ny - 1, Math.floor((j / SIZE) * g.ny));
      for (let i = 0; i < SIZE; i++) {
        const gi = Math.min(g.nx - 1, Math.floor((i / SIZE) * g.nx));
        const k = gj * g.nx + gi;
        const rest = Math.max(e.world.seaLevel, sv.zb[k]);
        const d = sv.eta[k] - rest;
        const a = Math.min(1, Math.abs(d) / 2.0);
        if (a > 0.02) {
          const col = samplePalette(PALETTES.wave, Math.min(1, Math.abs(d) / 5));
          const o = (j * SIZE + i) * 4;
          ov.data[o] = ov.data[o] * (1 - a) + col[0] * a;
          ov.data[o + 1] = ov.data[o + 1] * (1 - a) + col[1] * a;
          ov.data[o + 2] = ov.data[o + 2] * (1 - a) + col[2] * a;
        }
        // max inundation on land
        if (e.bedOriginal[k] > e.world.seaLevel && sv.maxDepth[k] > 0.05) {
          const o = (j * SIZE + i) * 4;
          ov.data[o] = ov.data[o] * 0.4 + 220 * 0.6;
          ov.data[o + 1] = ov.data[o + 1] * 0.4 + 90 * 0.6;
          ov.data[o + 2] = ov.data[o + 2] * 0.4 + 50 * 0.6;
        }
      }
    }
    g2.putImageData(ov, 0, 0);
    // markers
    const toPx = (x: number, y: number) => [(x / e.world.width) * SIZE, (y / e.world.length) * SIZE];
    g2.lineWidth = 1;
    for (const ins of e.instruments) {
      const [x, y] = toPx(ins.x, ins.y);
      g2.strokeStyle = "#e2b07a";
      g2.strokeRect(x - 2, y - 2, 4, 4);
    }
    for (const ci of e.cities) {
      const [x, y] = toPx(ci.x, ci.y);
      g2.fillStyle = "#f0d6b0";
      g2.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    const s = e.source;
    const sp = s.kind === "fault" ? s.fault.segments[0] : s.kind === "asteroid" ? s.asteroid : s.kind === "explosion" ? s.explosion : s.custom;
    if (sp) {
      const [x, y] = toPx(sp.x, sp.y);
      g2.strokeStyle = "#d2542c";
      g2.beginPath();
      g2.arc(x, y, 5, 0, Math.PI * 2);
      g2.stroke();
      g2.beginPath();
      g2.moveTo(x - 7, y);
      g2.lineTo(x + 7, y);
      g2.moveTo(x, y - 7);
      g2.lineTo(x, y + 7);
      g2.stroke();
    }
    // camera
    const vp = ctx.viewport;
    if (vp) {
      const cam = vp.sceneToWorld(vp.camera.position);
      const tgt = vp.sceneToWorld(vp.controls.target);
      const [cx, cy] = toPx(cam.x, cam.y);
      const [tx, ty] = toPx(tgt.x, tgt.y);
      g2.strokeStyle = "#9fe0ff";
      g2.beginPath();
      g2.moveTo(cx, cy);
      g2.lineTo(tx, ty);
      g2.stroke();
      g2.fillStyle = "#9fe0ff";
      g2.fillRect(cx - 2, cy - 2, 4, 4);
    }
  });

  return (
    <div className="border border-[#4a4e54] bg-[#141618] pointer-events-auto">
      <div className="flex items-center justify-between px-1 py-[2px] bg-[#232629] border-b border-[#4a4e54]">
        <span className="text-[9px] tracking-[0.18em] text-[#c69063] uppercase">Map</span>
        <Btn small onClick={() => ctx.setUI({ showMinimap: false })}>✕</Btn>
      </div>
      <canvas
        ref={ref}
        width={SIZE}
        height={SIZE}
        className="block cursor-crosshair"
        onClick={(ev) => {
          const r = (ev.target as HTMLCanvasElement).getBoundingClientRect();
          const x = ((ev.clientX - r.left) / r.width) * e.world.width;
          const y = ((ev.clientY - r.top) / r.height) * e.world.length;
          ctx.actions.focus(x, y);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────── CROSS SECTION
export function CrossSection({ ctx }: { ctx: Ctx }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const e = ctx.engine;
  const a = ctx.ui.crossA ?? { x: 0, y: e.world.length / 2 };
  const b = ctx.ui.crossB ?? { x: e.world.width, y: e.world.length / 2 };

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g2 = c.getContext("2d");
    if (!g2) return;
    const W = (c.width = c.clientWidth * 2);
    const H = (c.height = c.clientHeight * 2);
    g2.fillStyle = "#0f1113";
    g2.fillRect(0, 0, W, H);
    const N = 320;
    const grid = e.grid;
    const sv = e.solver;
    const bed: number[] = [],
      surf: number[] = [],
      mx: number[] = [];
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1);
      const x = a.x + (b.x - a.x) * f;
      const y = a.y + (b.y - a.y) * f;
      const gi = Math.min(grid.nx - 1, Math.max(0, Math.floor(x / grid.dx)));
      const gj = Math.min(grid.ny - 1, Math.max(0, Math.floor(y / grid.dy)));
      const k = gj * grid.nx + gi;
      bed.push(sv.zb[k]);
      surf.push(sv.eta[k]);
      mx.push(Math.max(e.world.seaLevel, sv.zb[k]) + sv.maxEta[k]);
    }
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < N; i++) {
      lo = Math.min(lo, bed[i]);
      hi = Math.max(hi, bed[i], mx[i], surf[i]);
    }
    hi = Math.max(hi, e.world.seaLevel + 5);
    lo = Math.min(lo, e.world.seaLevel - 5);
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const yOf = (v: number) => H - ((v - lo) / (hi - lo)) * H;
    const xOf = (i: number) => (i / (N - 1)) * W;

    // sea level line
    g2.strokeStyle = "#3f5a68";
    g2.setLineDash([8, 8]);
    g2.lineWidth = 2;
    g2.beginPath();
    g2.moveTo(0, yOf(e.world.seaLevel));
    g2.lineTo(W, yOf(e.world.seaLevel));
    g2.stroke();
    g2.setLineDash([]);

    // water body
    g2.fillStyle = "rgba(60,130,170,0.45)";
    g2.beginPath();
    g2.moveTo(0, yOf(bed[0]));
    for (let i = 0; i < N; i++) g2.lineTo(xOf(i), yOf(Math.max(surf[i], bed[i])));
    for (let i = N - 1; i >= 0; i--) g2.lineTo(xOf(i), yOf(bed[i]));
    g2.closePath();
    g2.fill();

    // max envelope
    g2.strokeStyle = "#d2542c";
    g2.lineWidth = 2;
    g2.beginPath();
    for (let i = 0; i < N; i++) (i === 0 ? g2.moveTo : g2.lineTo).call(g2, xOf(i), yOf(mx[i]));
    g2.stroke();

    // current surface
    g2.strokeStyle = "#8fd3e8";
    g2.lineWidth = 3;
    g2.beginPath();
    for (let i = 0; i < N; i++) (i === 0 ? g2.moveTo : g2.lineTo).call(g2, xOf(i), yOf(Math.max(surf[i], bed[i])));
    g2.stroke();

    // terrain
    g2.fillStyle = "#4a4438";
    g2.strokeStyle = "#a08a6a";
    g2.lineWidth = 3;
    g2.beginPath();
    g2.moveTo(0, H);
    for (let i = 0; i < N; i++) g2.lineTo(xOf(i), yOf(bed[i]));
    g2.lineTo(W, H);
    g2.closePath();
    g2.fill();
    g2.beginPath();
    for (let i = 0; i < N; i++) (i === 0 ? g2.moveTo : g2.lineTo).call(g2, xOf(i), yOf(bed[i]));
    g2.stroke();

    // axes labels
    g2.fillStyle = "#9aa0a6";
    g2.font = "18px ui-monospace,monospace";
    g2.fillText(`${hi.toFixed(0)} m`, 6, 20);
    g2.fillText(`${lo.toFixed(0)} m`, 6, H - 8);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    g2.fillText(`0`, 6, H - 30);
    g2.fillText(`${(dist / 1000).toFixed(1)} km`, W - 120, H - 30);
  });

  return (
    <div className="border border-[#4a4e54] bg-[#141618] pointer-events-auto w-[420px]">
      <div className="flex items-center justify-between px-1 py-[2px] bg-[#232629] border-b border-[#4a4e54]">
        <span className="text-[9px] tracking-[0.18em] text-[#c69063] uppercase">Cross-section</span>
        <div className="flex gap-1">
          <Btn small active={ctx.ui.tool === "cross-section"} onClick={() => ctx.setUI({ tool: ctx.ui.tool === "cross-section" ? "orbit" : "cross-section", crossA: null, crossB: null })}>
            Draw line
          </Btn>
          <Btn small onClick={() => ctx.setUI({ showCross: false })}>✕</Btn>
        </div>
      </div>
      <canvas ref={ref} className="block w-full h-[150px]" />
      <div className="flex justify-between px-1 py-[2px] text-[8px] font-mono text-[#80858b] border-t border-[#3a3d42]">
        <span>■ terrain</span>
        <span className="text-[#8fd3e8]">■ water surface</span>
        <span className="text-[#d2542c]">■ max envelope</span>
        <span className="text-[#3f5a68]">--- sea level</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────── LEGEND
export function Legend({ ctx }: { ctx: Ctx }) {
  const l = ctx.legend;
  if (!l) return null;
  const pal =
    PALETTES[
      ctx.viz.mode === "bathymetry"
        ? ctx.viz.paletteDepth
        : ctx.viz.mode === "velocity" || ctx.viz.mode === "maxvelocity"
        ? "velocity"
        : ctx.viz.mode === "arrival"
        ? "arrival"
        : ctx.viz.mode === "scientific" || ctx.viz.mode === "displacement"
        ? "diverging"
        : ctx.viz.paletteWave
    ] ?? PALETTES.wave;
  const isTime = ctx.viz.mode === "arrival";
  const mid = (l.min + l.max) / 2;
  return (
    <div className="border border-[#4a4e54] bg-[#141618]/95 px-2 py-1 pointer-events-auto w-[260px]">
      <div className="text-[9px] tracking-[0.18em] text-[#c69063] uppercase mb-1">{l.label}</div>
      <div className="h-3 border border-[#4a4e54]" style={{ background: paletteCss(pal) }} />
      <div className="flex justify-between text-[9px] font-mono text-[#a8adb3] mt-[2px]">
        <span>{isTime ? fmtTime(l.min) : l.min.toFixed(2)}</span>
        <span>{isTime ? fmtTime(mid) : mid.toFixed(2)}</span>
        <span>
          {isTime ? fmtTime(l.max) : l.max.toFixed(2)} {l.unit}
        </span>
      </div>
    </div>
  );
}
