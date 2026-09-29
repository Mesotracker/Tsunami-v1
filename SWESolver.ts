/**
 * Depth-averaged non-linear shallow-water equation solver.
 *
 * Arakawa C-grid, explicit forward-backward (leapfrog-trapezoidal) time
 * integration — the classic scheme used by long-wave tsunami models
 * (e.g. TUNAMI-N2 / COMCOT family).
 *
 *   Continuity :  d(eta)/dt + d(M)/dx + d(N)/dy = 0
 *   Momentum   :  d(M)/dt + d(M^2/D)/dx + d(MN/D)/dy
 *                   + g D d(eta)/dx + g n^2 M |V| / D^(7/3) = 0
 *
 * where D = eta - zb is the total water depth, M = D*u, N = D*v are the
 * depth-integrated volume fluxes.  Mass is conserved exactly by the
 * flux-form continuity equation (up to wetting/drying clipping, which is
 * accounted for in `massError`).
 */

export type BoundaryType = "open" | "reflective" | "periodic" | "absorbing";

export interface SolverConfig {
  nx: number;
  ny: number;
  dx: number; // m
  dy: number; // m
  gravity: number; // m/s^2
  manning: number; // Manning roughness n
  minDepth: number; // m, wet/dry threshold
  cfl: number;
  boundary: BoundaryType;
  nonlinear: boolean;
  maxTimestep: number;
  spongeCells: number;
  activeRegion: boolean;
  velocityClamp: number; // m/s
}

export interface SolverState {
  eta: Float32Array;
  M: Float32Array;
  N: Float32Array;
  maxEta: Float32Array;
  maxDepth: Float32Array;
  maxSpeed: Float32Array;
  arrival: Float32Array;
  time: number;
  step: number;
  massError: number;
}

export interface SolverDiagnostics {
  dt: number;
  cflNumber: number;
  maxDepthGlobal: number;
  nanCount: number;
  clampCount: number;
  activeCells: number;
  totalCells: number;
  steps: number;
  massError: number;
  volume: number;
  energy: number;
}

const ARRIVAL_THRESHOLD = 0.05; // m
/** Depth (m) below which non-linear advection and bottom friction are active. */
const SHALLOW_LIMIT = 1000;

export class SWESolver {
  cfg: SolverConfig;
  nx: number;
  ny: number;

  zb: Float32Array; // bed elevation (m)
  eta: Float32Array; // free-surface elevation (m)
  M: Float32Array; // x flux at face (i+1/2, j)
  N: Float32Array; // y flux at face (i, j+1/2)

  // recorded maxima / event fields
  maxEta: Float32Array;
  maxDepth: Float32Array;
  maxSpeed: Float32Array;
  arrival: Float32Array; // s, -1 = never

  private etaN: Float32Array;
  private sponge: Float32Array;

  time = 0;
  step = 0;
  massError = 0;
  initialVolume = 0;
  seaLevel = 0;

  diag: SolverDiagnostics;

  // activity bounding box (cell indices)
  private ax0 = 0;
  private ay0 = 0;
  private ax1 = 0;
  private ay1 = 0;

  constructor(cfg: SolverConfig, zb: Float32Array, seaLevel = 0) {
    this.cfg = { ...cfg };
    this.nx = cfg.nx;
    this.ny = cfg.ny;
    const n = cfg.nx * cfg.ny;
    this.zb = zb;
    this.seaLevel = seaLevel;
    this.eta = new Float32Array(n);
    this.M = new Float32Array(n);
    this.N = new Float32Array(n);
    this.etaN = new Float32Array(n);
    this.maxEta = new Float32Array(n);
    this.maxDepth = new Float32Array(n);
    this.maxSpeed = new Float32Array(n);
    this.arrival = new Float32Array(n).fill(-1);
    this.sponge = new Float32Array(n).fill(1);
    this.diag = {
      dt: 0,
      cflNumber: 0,
      maxDepthGlobal: 0,
      nanCount: 0,
      clampCount: 0,
      activeCells: 0,
      totalCells: n,
      steps: 0,
      massError: 0,
      volume: 0,
      energy: 0,
    };
    this.reset();
  }

  /** Reset water to a flat ocean at sea level, clear statistics. */
  reset() {
    const { nx, ny } = this;
    for (let k = 0; k < nx * ny; k++) {
      this.eta[k] = Math.max(this.seaLevel, this.zb[k]);
    }
    this.M.fill(0);
    this.N.fill(0);
    this.maxEta.fill(0);
    this.maxDepth.fill(0);
    this.maxSpeed.fill(0);
    this.arrival.fill(-1);
    this.time = 0;
    this.step = 0;
    this.massError = 0;
    this.buildSponge();
    this.initialVolume = this.computeVolume();
    this.ax0 = 0;
    this.ay0 = 0;
    this.ax1 = nx - 1;
    this.ay1 = ny - 1;
  }

  setBed(zb: Float32Array) {
    this.zb = zb;
  }

  buildSponge() {
    const { nx, ny } = this;
    const w = Math.max(0, Math.min(this.cfg.spongeCells, Math.floor(Math.min(nx, ny) / 3)));
    this.sponge.fill(1);
    if (this.cfg.boundary !== "absorbing" || w === 0) return;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const d = Math.min(i, j, nx - 1 - i, ny - 1 - j);
        if (d < w) {
          const t = d / w;
          // gentle damping ramp
          this.sponge[j * nx + i] = 1 - 0.06 * Math.pow(1 - t, 2);
        }
      }
    }
  }

  depthAt(k: number) {
    const d = this.eta[k] - this.zb[k];
    return d > 0 ? d : 0;
  }

  computeVolume() {
    const { nx, ny, cfg } = this;
    const cellArea = cfg.dx * cfg.dy;
    let v = 0;
    for (let k = 0; k < nx * ny; k++) {
      const d = this.eta[k] - this.zb[k];
      if (d > 0) v += d;
    }
    return v * cellArea;
  }

  computeEnergy() {
    const { nx, ny, cfg } = this;
    const cellArea = cfg.dx * cfg.dy;
    const g = cfg.gravity;
    let e = 0;
    for (let k = 0; k < nx * ny; k++) {
      const D = this.eta[k] - this.zb[k];
      if (D <= cfg.minDepth) continue;
      const disp = this.eta[k] - Math.max(this.seaLevel, this.zb[k]);
      const pe = 0.5 * 1025 * g * disp * disp;
      const u = this.M[k] / D;
      const v = this.N[k] / D;
      const ke = 0.5 * 1025 * D * (u * u + v * v);
      e += (pe + ke) * cellArea;
    }
    return e;
  }

  /** Maximum stable timestep from the CFL condition. */
  stableTimestep(): number {
    const { nx, ny, cfg } = this;
    let dmax = 0;
    for (let k = 0; k < nx * ny; k++) {
      const d = this.eta[k] - this.zb[k];
      if (d > dmax) dmax = d;
    }
    this.diag.maxDepthGlobal = dmax;
    const c = Math.sqrt(cfg.gravity * Math.max(dmax, 0.1));
    const dmin = Math.min(cfg.dx, cfg.dy);
    const dt = (cfg.cfl * dmin) / (c * Math.SQRT2);
    return Math.min(dt, cfg.maxTimestep);
  }

  private updateActiveBox() {
    if (!this.cfg.activeRegion) {
      this.ax0 = 0;
      this.ay0 = 0;
      this.ax1 = this.nx - 1;
      this.ay1 = this.ny - 1;
      return;
    }
    const { nx, ny } = this;
    let x0 = nx,
      y0 = ny,
      x1 = -1,
      y1 = -1;
    const eps = 0.002;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const k = row + i;
        const rest = Math.max(this.seaLevel, this.zb[k]);
        if (Math.abs(this.eta[k] - rest) > eps || Math.abs(this.M[k]) > eps || Math.abs(this.N[k]) > eps) {
          if (i < x0) x0 = i;
          if (i > x1) x1 = i;
          if (j < y0) y0 = j;
          if (j > y1) y1 = j;
        }
      }
    }
    if (x1 < 0) {
      this.ax0 = 0;
      this.ay0 = 0;
      this.ax1 = -1;
      this.ay1 = -1;
      return;
    }
    const m = 4;
    this.ax0 = Math.max(0, x0 - m);
    this.ay0 = Math.max(0, y0 - m);
    this.ax1 = Math.min(nx - 1, x1 + m);
    this.ay1 = Math.min(ny - 1, y1 + m);
  }

  /** Advance the solution by dt seconds. Returns actual dt used. */
  advance(dt: number): number {
    const { nx, ny, cfg } = this;
    const g = cfg.gravity;
    const dx = cfg.dx,
      dy = cfg.dy;
    const hmin = cfg.minDepth;
    const eta = this.eta,
      M = this.M,
      N = this.N,
      zb = this.zb;
    const periodic = cfg.boundary === "periodic";
    const reflective = cfg.boundary === "reflective";
    let clampCount = 0;

    if (this.step % 12 === 0) this.updateActiveBox();
    const x0 = this.ax0,
      x1 = this.ax1,
      y0 = this.ay0,
      y1 = this.ay1;
    if (x1 < x0) {
      this.time += dt;
      this.step++;
      return dt;
    }

    const nManning2 = cfg.manning * cfg.manning;
    const vmax = cfg.velocityClamp;

    // ---------------- MOMENTUM ----------------
    for (let j = y0; j <= y1; j++) {
      const row = j * nx;
      for (let i = x0; i <= x1; i++) {
        const k = row + i;

        // ---- x-face flux M[i+1/2, j] ----
        {
          let kp = k + 1;
          let valid = true;
          if (i === nx - 1) {
            if (periodic) kp = row;
            else valid = false;
          }
          if (!valid) {
            M[k] = this.boundaryFlux(k, eta, zb, g, +1, reflective);
          } else {
            const e1 = eta[k],
              e2 = eta[kp];
            const b1 = zb[k],
              b2 = zb[kp];
            const D = Math.max(e1, e2) - Math.max(b1, b2);
            if (D <= hmin) {
              M[k] = 0;
            } else {
              let m = M[k];
              // pressure gradient / bed slope (combined via free-surface gradient)
              m -= dt * g * D * (e2 - e1) / dx;
              // Non-linear advection and bottom friction are negligible in deep
              // water (u ~ cm/s, D^(4/3) enormous); they are evaluated only where
              // they matter, which is also a large performance win.
              if (D < SHALLOW_LIMIT) {
                if (cfg.nonlinear) m -= dt * this.advX(i, j, k, kp, D, dx, dy);
                if (nManning2 > 0) {
                  const jm = j > 0 ? nx : 0;
                  const nAvg = 0.25 * (N[k] + N[kp] + N[k - jm] + N[kp - jm]);
                  const vel = Math.sqrt(m * m + nAvg * nAvg) / D;
                  const fr = (g * nManning2 * vel) / (D * Math.cbrt(D));
                  m /= 1 + dt * fr;
                }
              }
              // clamp velocity
              const u = m / D;
              if (u > vmax) {
                m = vmax * D;
                clampCount++;
              } else if (u < -vmax) {
                m = -vmax * D;
                clampCount++;
              }
              M[k] = isFinite(m) ? m : 0;
            }
          }
        }

        // ---- y-face flux N[i, j+1/2] ----
        {
          let kp = k + nx;
          let valid = true;
          if (j === ny - 1) {
            if (periodic) kp = i;
            else valid = false;
          }
          if (!valid) {
            N[k] = this.boundaryFlux(k, eta, zb, g, +1, reflective);
          } else {
            const e1 = eta[k],
              e2 = eta[kp];
            const D = Math.max(e1, e2) - Math.max(zb[k], zb[kp]);
            if (D <= hmin) {
              N[k] = 0;
            } else {
              let n = N[k];
              n -= dt * g * D * (e2 - e1) / dy;
              if (D < SHALLOW_LIMIT) {
                if (cfg.nonlinear) n -= dt * this.advY(i, j, k, kp, D, dx, dy);
                if (nManning2 > 0) {
                  const im = i > 0 ? 1 : 0;
                  const mAvg = 0.25 * (M[k] + M[kp] + M[k - im] + M[kp - im]);
                  const vel = Math.sqrt(n * n + mAvg * mAvg) / D;
                  const fr = (g * nManning2 * vel) / (D * Math.cbrt(D));
                  n /= 1 + dt * fr;
                }
              }
              const v = n / D;
              if (v > vmax) {
                n = vmax * D;
                clampCount++;
              } else if (v < -vmax) {
                n = -vmax * D;
                clampCount++;
              }
              N[k] = isFinite(n) ? n : 0;
            }
          }
        }
      }
    }

    // ---------------- CONTINUITY ----------------
    const etaN = this.etaN;
    for (let j = y0; j <= y1; j++) {
      const row = j * nx;
      for (let i = x0; i <= x1; i++) {
        const k = row + i;
        let mW: number, nS: number;
        if (i > 0) mW = M[k - 1];
        else mW = periodic ? M[row + nx - 1] : reflective ? 0 : -M[k];
        if (j > 0) nS = N[k - nx];
        else nS = periodic ? N[(ny - 1) * nx + i] : reflective ? 0 : -N[k];

        const div = (M[k] - mW) / dx + (N[k] - nS) / dy;
        let e = eta[k] - dt * div;
        const bed = zb[k];
        if (!isFinite(e)) {
          e = Math.max(this.seaLevel, bed);
          clampCount++;
        }
        if (e - bed < 0) {
          // never allow negative water depth; account for the clipped mass
          this.massError -= (e - bed) * dx * dy;
          e = bed;
          M[k] = 0;
          N[k] = 0;
        } else if (e - bed < hmin) {
          // sub-threshold film: cell is hydraulically dry (no momentum) but
          // the water is retained so that inundation can accumulate.
          M[k] = 0;
          N[k] = 0;
        }
        etaN[k] = e;
      }
    }

    // ---- apply sponge damping + write back, collect statistics ----
    const sponge = this.sponge;
    const vmaxStat = cfg.velocityClamp;
    const absorbing = cfg.boundary === "absorbing";
    for (let j = y0; j <= y1; j++) {
      const row = j * nx;
      for (let i = x0; i <= x1; i++) {
        const k = row + i;
        let e = etaN[k];
        const rest = Math.max(this.seaLevel, zb[k]);
        if (absorbing) {
          const s = sponge[k];
          if (s < 1) {
            e = rest + (e - rest) * s;
            M[k] *= s;
            N[k] *= s;
          }
        }
        eta[k] = e;

        const D = e - zb[k];
        const disp = e - rest;
        if (disp > this.maxEta[k]) this.maxEta[k] = disp;
        if (D > hmin) {
          if (zb[k] > this.seaLevel && D > this.maxDepth[k]) this.maxDepth[k] = D;
          else if (zb[k] <= this.seaLevel && D - (this.seaLevel - zb[k]) > this.maxDepth[k])
            this.maxDepth[k] = Math.max(this.maxDepth[k], disp);
          const u = M[k] / D,
            v = N[k] / D;
          let sp = Math.sqrt(u * u + v * v);
          if (sp > vmaxStat) sp = vmaxStat;
          if (sp > this.maxSpeed[k]) this.maxSpeed[k] = sp;
        }
        if (this.arrival[k] < 0 && Math.abs(disp) > ARRIVAL_THRESHOLD) {
          this.arrival[k] = this.time;
        }
      }
    }

    this.time += dt;
    this.step++;
    this.diag.dt = dt;
    this.diag.clampCount = clampCount;
    this.diag.steps = this.step;
    this.diag.activeCells = (x1 - x0 + 1) * (y1 - y0 + 1);
    return dt;
  }

  /** Radiation / reflective boundary flux for the outermost face. */
  private boundaryFlux(
    k: number,
    eta: Float32Array,
    zb: Float32Array,
    g: number,
    sign: number,
    reflective: boolean
  ) {
    if (reflective) return 0;
    const D = eta[k] - zb[k];
    if (D <= this.cfg.minDepth) return 0;
    const rest = Math.max(this.seaLevel, zb[k]);
    // Sommerfeld radiation: outgoing flux = eta * sqrt(g*D)
    return sign * (eta[k] - rest) * Math.sqrt(g * D);
  }

  private advX(i: number, j: number, k: number, kp: number, D: number, dx: number, dy: number) {
    const { nx, ny, M, N, eta, zb, cfg } = this;
    const hmin = cfg.minDepth;
    const m = M[k];
    const dW = i > 0 ? Math.max(eta[k - 1], eta[k]) - Math.max(zb[k - 1], zb[k]) : D;
    const dE = i < nx - 2 ? Math.max(eta[kp], eta[kp + 1]) - Math.max(zb[kp], zb[kp + 1]) : D;
    const mW = i > 0 ? M[k - 1] : m;
    const mE = i < nx - 2 ? M[k + 1] : m;
    if (dW <= hmin || dE <= hmin) return 0;
    // upwind d(M^2/D)/dx
    const fC = (m * m) / D;
    let dFdx: number;
    if (m > 0) dFdx = (fC - (mW * mW) / dW) / dx;
    else dFdx = ((mE * mE) / dE - fC) / dx;
    // d(MN/D)/dy, centred/upwind hybrid
    const nAvg = 0.25 * (N[k] + N[kp] + (j > 0 ? N[k - nx] : N[k]) + (j > 0 ? N[kp - nx] : N[kp]));
    let dGdy = 0;
    if (j > 0 && j < ny - 1) {
      const mS = M[k - nx],
        mN = M[k + nx];
      const dS = Math.max(eta[k - nx], eta[kp - nx]) - Math.max(zb[k - nx], zb[kp - nx]);
      const dN = Math.max(eta[k + nx], eta[kp + nx]) - Math.max(zb[k + nx], zb[kp + nx]);
      if (dS > hmin && dN > hmin) {
        const gC = (m * nAvg) / D;
        if (nAvg > 0) dGdy = (gC - (mS * nAvg) / dS) / dy;
        else dGdy = ((mN * nAvg) / dN - gC) / dy;
      }
    }
    const r = dFdx + dGdy;
    return isFinite(r) ? r : 0;
  }

  private advY(i: number, j: number, k: number, kp: number, D: number, dx: number, dy: number) {
    const { nx, ny, M, N, eta, zb, cfg } = this;
    const hmin = cfg.minDepth;
    const n = N[k];
    const dS = j > 0 ? Math.max(eta[k - nx], eta[k]) - Math.max(zb[k - nx], zb[k]) : D;
    const dN = j < ny - 2 ? Math.max(eta[kp], eta[kp + nx]) - Math.max(zb[kp], zb[kp + nx]) : D;
    const nS = j > 0 ? N[k - nx] : n;
    const nN = j < ny - 2 ? N[k + nx] : n;
    if (dS <= hmin || dN <= hmin) return 0;
    const fC = (n * n) / D;
    let dFdy: number;
    if (n > 0) dFdy = (fC - (nS * nS) / dS) / dy;
    else dFdy = ((nN * nN) / dN - fC) / dy;
    const mAvg = 0.25 * (M[k] + M[kp] + (i > 0 ? M[k - 1] : M[k]) + (i > 0 ? M[kp - 1] : M[kp]));
    let dGdx = 0;
    if (i > 0 && i < nx - 1) {
      const nW = N[k - 1],
        nE = N[k + 1];
      const dW = Math.max(eta[k - 1], eta[kp - 1]) - Math.max(zb[k - 1], zb[kp - 1]);
      const dE = Math.max(eta[k + 1], eta[kp + 1]) - Math.max(zb[k + 1], zb[kp + 1]);
      if (dW > hmin && dE > hmin) {
        const gC = (n * mAvg) / D;
        if (mAvg > 0) dGdx = (gC - (nW * mAvg) / dW) / dx;
        else dGdx = ((nE * mAvg) / dE - gC) / dx;
      }
    }
    const r = dFdy + dGdx;
    return isFinite(r) ? r : 0;
  }

  /** Scan for NaN / Inf and repair. Returns number of bad cells found. */
  sanitize(): number {
    const n = this.nx * this.ny;
    let bad = 0;
    for (let k = 0; k < n; k++) {
      if (!isFinite(this.eta[k])) {
        this.eta[k] = Math.max(this.seaLevel, this.zb[k]);
        bad++;
      }
      if (!isFinite(this.M[k])) {
        this.M[k] = 0;
        bad++;
      }
      if (!isFinite(this.N[k])) {
        this.N[k] = 0;
        bad++;
      }
    }
    this.diag.nanCount = bad;
    return bad;
  }

  // ---------------- state capture ----------------
  captureState(): SolverState {
    return {
      eta: this.eta.slice(),
      M: this.M.slice(),
      N: this.N.slice(),
      maxEta: this.maxEta.slice(),
      maxDepth: this.maxDepth.slice(),
      maxSpeed: this.maxSpeed.slice(),
      arrival: this.arrival.slice(),
      time: this.time,
      step: this.step,
      massError: this.massError,
    };
  }

  restoreState(s: SolverState) {
    this.eta.set(s.eta);
    this.M.set(s.M);
    this.N.set(s.N);
    this.maxEta.set(s.maxEta);
    this.maxDepth.set(s.maxDepth);
    this.maxSpeed.set(s.maxSpeed);
    this.arrival.set(s.arrival);
    this.time = s.time;
    this.step = s.step;
    this.massError = s.massError;
    this.ax0 = 0;
    this.ay0 = 0;
    this.ax1 = this.nx - 1;
    this.ay1 = this.ny - 1;
  }

  static stateBytes(nx: number, ny: number) {
    return nx * ny * 4 * 7;
  }
}
