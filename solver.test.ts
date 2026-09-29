import { SWESolver, SolverConfig } from "../src/core/SWESolver";
import { generateTerrain, DEFAULT_TERRAIN_PARAMS } from "../src/terrain/TerrainGenerator";
import { buildFaultSource } from "../src/sources";

const N = 128;
const W = 100000;
const hf = generateTerrain(N, N, W, W, DEFAULT_TERRAIN_PARAMS);
const st = hf.stats();
console.log("terrain min/max/land%", st.min.toFixed(0), st.max.toFixed(0), (st.landFraction * 100).toFixed(1));

const cfg: SolverConfig = {
  nx: N, ny: N, dx: W / N, dy: W / N,
  gravity: 9.81, manning: 0.025, minDepth: 0.05, cfl: 0.45,
  boundary: "absorbing", nonlinear: true, maxTimestep: 4, spongeCells: 12,
  activeRegion: true, velocityClamp: 45,
};
const s = new SWESolver(cfg, hf.data.slice(), 0);
console.log("initial volume km3", (s.initialVolume / 1e9).toFixed(3));

const disp = buildFaultSource(
  { nx: N, ny: N, dx: W / N, dy: W / N },
  {
    magnitude: 8.8, rigidity: 3e10, ruptureVelocity: 2.5, ruptureDuration: 60,
    autoSlipFromMagnitude: false,
    segments: [{ id: "a", x: W * 0.22, y: W * 0.5, length: W * 0.5, width: 120000 * 0.5, depth: 18, strike: 90, dip: 18, rake: 90, slip: 12, startTime: 0 }],
  }
);
let dmin = 0, dmax = 0;
for (let k = 0; k < N * N; k++) { dmin = Math.min(dmin, disp.bed[k]); dmax = Math.max(dmax, disp.bed[k]); }
console.log("seafloor displacement min/max m", dmin.toFixed(2), dmax.toFixed(2));

// apply instantly
for (let k = 0; k < N * N; k++) {
  s.zb[k] += disp.bed[k];
  if (s.eta[k] - s.zb[k] > cfg.minDepth) s.eta[k] += disp.bed[k];
  else s.eta[k] = Math.max(s.eta[k], s.zb[k]);
}

let t = 0, steps = 0;
const t0 = Date.now();
while (t < 3600) {
  const dt = s.stableTimestep();
  s.advance(dt);
  t += dt;
  steps++;
  if (steps % 400 === 0) {
    let maxEta = 0, maxSpd = 0, nan = 0;
    for (let k = 0; k < N * N; k++) {
      const rest = Math.max(0, s.zb[k]);
      const d = s.eta[k] - rest;
      if (!isFinite(d)) nan++;
      if (Math.abs(d) > maxEta) maxEta = Math.abs(d);
      const D = s.eta[k] - s.zb[k];
      if (D > cfg.minDepth) maxSpd = Math.max(maxSpd, Math.hypot(s.M[k], s.N[k]) / D);
    }
    const vol = s.computeVolume();
    console.log(
      `t=${t.toFixed(0)}s dt=${dt.toFixed(2)} maxEta=${maxEta.toFixed(3)} maxSpd=${maxSpd.toFixed(2)} volErr=${((vol - s.initialVolume) / s.initialVolume * 100).toExponential(2)}% nan=${nan}`
    );
  }
}
console.log("steps", steps, "wall ms", Date.now() - t0, "ms/step", ((Date.now() - t0) / steps).toFixed(2));
let inund = 0;
for (let k = 0; k < N * N; k++) if (hf.data[k] > 0 && s.maxDepth[k] > 0.05) inund++;
console.log("inundated land cells", inund);
