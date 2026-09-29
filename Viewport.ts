import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SimulationEngine } from "../core/SimulationEngine";
import { PALETTES, samplePalette, terrainMaterialColor } from "./palettes";

export type VizMode =
  | "realistic"
  | "scientific"
  | "bathymetry"
  | "waveheight"
  | "velocity"
  | "inundation"
  | "arrival"
  | "maxdepth"
  | "maxvelocity"
  | "displacement"
  | "energy";

export interface RenderOptions {
  mode: VizMode;
  paletteWave: string;
  paletteDepth: string;
  paletteElev: string;
  rangeMin: number;
  rangeMax: number;
  autoRange: boolean;
  showGrid: boolean;
  showVectors: boolean;
  showContours: boolean;
  contourThreshold: number;
  showWater: boolean;
  wireframe: boolean;
  exaggeration: number;
  showFoam: boolean;
  materials: boolean;
  waveAmplify: number;
}

export const SCENE_SIZE = 200;

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  container: HTMLElement;
  engine: SimulationEngine | null = null;

  terrainMesh: THREE.Mesh | null = null;
  waterMesh: THREE.Mesh | null = null;
  overlayTex: THREE.DataTexture | null = null;
  overlayData: Uint8Array = new Uint8Array(4);
  vectorLines: THREE.LineSegments | null = null;
  markerGroup = new THREE.Group();
  sunDir = new THREE.Vector3(0.45, 0.72, 0.35).normalize();

  terrainRes = 0;
  waterRes = 0;
  capabilities = { webgl2: false, renderer: "unknown" };
  lastError: string | null = null;
  triangles = 0;
  drawCalls = 0;
  gpuFrameMs = 0;

  private fieldScratch: Float32Array | null = null;
  private raycaster = new THREE.Raycaster();
  private tmpV = new THREE.Vector3();
  private disposed = false;

  constructor(container: HTMLElement) {
    this.container = container;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch (e) {
      this.lastError = "WebGL context could not be created: " + (e as Error).message;
      throw e;
    }
    this.renderer = renderer;
    const gl = renderer.getContext();
    this.capabilities.webgl2 = renderer.capabilities.isWebGL2;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    this.capabilities.renderer = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : "WebGL device";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x0d0f11, 1);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    container.appendChild(renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(48, container.clientWidth / container.clientHeight, 0.5, 6000);
    this.camera.position.set(0, 120, 190);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 1400;

    this.scene.fog = new THREE.FogExp2(0x9aa3a8, 0.0016);
    this.scene.add(this.markerGroup);
    this.buildSky();
  }

  buildSky() {
    const geo = new THREE.SphereGeometry(2600, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uSun: { value: this.sunDir } },
      vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
      fragmentShader: `
        varying vec3 vP; uniform vec3 uSun;
        void main(){
          float h = clamp(vP.y*0.5+0.5, 0.0, 1.0);
          vec3 horizon = vec3(0.72,0.72,0.70);
          vec3 zenith = vec3(0.30,0.40,0.50);
          vec3 c = mix(horizon, zenith, pow(h,0.8));
          float s = max(dot(normalize(vP), normalize(uSun)),0.0);
          c += vec3(1.0,0.92,0.78) * pow(s, 220.0) * 1.4;
          c += vec3(0.9,0.82,0.7) * pow(s, 8.0) * 0.10;
          gl_FragColor = vec4(c,1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  setEngine(engine: SimulationEngine) {
    this.engine = engine;
    this.rebuild();
  }

  get scaleXZ() {
    return this.engine ? SCENE_SIZE / this.engine.world.width : 1;
  }

  worldToScene(x: number, y: number, elevM: number, exaggeration: number) {
    const s = this.scaleXZ;
    return new THREE.Vector3(
      x * s - SCENE_SIZE / 2,
      elevM * s * exaggeration,
      y * (SCENE_SIZE / (this.engine?.world.length ?? 1)) - SCENE_SIZE / 2
    );
  }

  sceneToWorld(p: THREE.Vector3) {
    const e = this.engine!;
    return {
      x: ((p.x + SCENE_SIZE / 2) / SCENE_SIZE) * e.world.width,
      y: ((p.z + SCENE_SIZE / 2) / SCENE_SIZE) * e.world.length,
    };
  }

  /** Rebuild all geometry for a new world/resolution. */
  rebuild() {
    const e = this.engine;
    if (!e) return;
    this.disposeMesh(this.terrainMesh);
    this.disposeMesh(this.waterMesh);
    this.terrainMesh = null;
    this.waterMesh = null;

    const tr = Math.max(16, Math.min(e.world.renderRes, 768));
    const wr = Math.max(16, Math.min(e.world.renderRes, 512));
    this.terrainRes = tr;
    this.waterRes = wr;

    // ---------- terrain ----------
    const tgeo = this.makeGrid(tr);
    tgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(tr * tr * 3), 3));
    const tmat = new THREE.ShaderMaterial({
      uniforms: {
        uOverlay: { value: null },
        uOverlayMix: { value: 0 },
        uSun: { value: this.sunDir },
        uFog: { value: new THREE.Color(0xa7b0b4) },
        uGrid: { value: 0 },
        uGridN: { value: 32 },
      },
      vertexShader: `
        varying vec3 vColor; varying vec2 vUv; varying vec3 vPos;
        attribute vec3 color;
        void main(){ vColor=color; vUv=uv; vec4 wp = modelMatrix*vec4(position,1.0); vPos=wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `
        precision highp float;
        varying vec3 vColor; varying vec2 vUv; varying vec3 vPos;
        uniform sampler2D uOverlay; uniform float uOverlayMix; uniform vec3 uSun; uniform vec3 uFog;
        uniform float uGrid; uniform float uGridN;
        void main(){
          vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
          if(n.y < 0.0) n = -n;
          float diff = max(dot(n, normalize(uSun)), 0.0);
          float amb = 0.38 + 0.22*n.y;
          vec3 base = vColor;
          if(uOverlayMix > 0.001){
            vec4 o = texture2D(uOverlay, vUv);
            base = mix(base, o.rgb, uOverlayMix * o.a);
          }
          vec3 c = base * (amb + diff*0.85);
          if(uGrid > 0.5){
            vec2 g = fract(vUv*uGridN);
            float l = min(min(g.x,g.y), min(1.0-g.x,1.0-g.y));
            float w = fwidth(vUv.x*uGridN)*1.2;
            c = mix(vec3(0.75,0.55,0.35), c, smoothstep(0.0, w, l));
          }
          float d = length(vPos - cameraPosition);
          float f = 1.0 - exp(-pow(d*0.0016,2.0));
          c = mix(c, uFog, clamp(f,0.0,0.85));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.terrainMesh = new THREE.Mesh(tgeo, tmat);
    this.scene.add(this.terrainMesh);

    // ---------- water ----------
    const wgeo = this.makeGrid(wr);
    wgeo.setAttribute("wdata", new THREE.BufferAttribute(new Float32Array(wr * wr * 3), 3)); // depth, speed, dry
    const wmat = new THREE.ShaderMaterial({
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms: {
        uOverlay: { value: null },
        uOverlayMix: { value: 0 },
        uSun: { value: this.sunDir },
        uFog: { value: new THREE.Color(0xa7b0b4) },
        uFoam: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: `
        attribute vec3 wdata;
        varying vec3 vW; varying vec2 vUv; varying vec3 vPos;
        void main(){ vW=wdata; vUv=uv; vec4 wp = modelMatrix*vec4(position,1.0); vPos=wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `
        precision highp float;
        varying vec3 vW; varying vec2 vUv; varying vec3 vPos;
        uniform sampler2D uOverlay; uniform float uOverlayMix; uniform vec3 uSun; uniform vec3 uFog;
        uniform float uFoam; uniform float uTime;
        void main(){
          if(vW.z > 0.5) discard;              // dry cell
          float depth = vW.x; float speed = vW.y;
          vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
          if(n.y < 0.0) n = -n;
          vec3 V = normalize(cameraPosition - vPos);
          vec3 L = normalize(uSun);
          float fres = pow(1.0 - max(dot(n,V),0.0), 3.5);
          vec3 shallow = vec3(0.22,0.46,0.48);
          vec3 deep = vec3(0.035,0.09,0.17);
          float dn = clamp(depth/260.0, 0.0, 1.0);
          vec3 base = mix(shallow, deep, pow(dn,0.45));
          vec3 sky = vec3(0.62,0.68,0.72);
          vec3 c = mix(base, sky, clamp(fres,0.0,0.75));
          vec3 H = normalize(L+V);
          c += vec3(1.0,0.96,0.88) * pow(max(dot(n,H),0.0), 160.0) * 0.9;
          float foam = 0.0;
          if(uFoam > 0.5){
            float shoreF = 1.0 - smoothstep(0.0, 6.0, depth);
            float turb = smoothstep(2.0, 9.0, speed);
            foam = clamp(shoreF*0.7 + turb*0.8, 0.0, 1.0);
            c = mix(c, vec3(0.92,0.94,0.95), foam*0.75);
          }
          float alpha = mix(0.55, 0.93, clamp(dn*3.0,0.0,1.0));
          alpha = max(alpha, foam*0.9);
          if(uOverlayMix > 0.001){
            vec4 o = texture2D(uOverlay, vUv);
            c = mix(c, o.rgb, uOverlayMix * o.a);
            alpha = max(alpha, uOverlayMix*o.a*0.96);
          }
          float d = length(vPos - cameraPosition);
          float f = 1.0 - exp(-pow(d*0.0016,2.0));
          c = mix(c, uFog, clamp(f,0.0,0.85));
          gl_FragColor = vec4(c, alpha);
        }`,
    });
    this.waterMesh = new THREE.Mesh(wgeo, wmat);
    this.waterMesh.renderOrder = 2;
    this.waterMesh.frustumCulled = false;
    this.scene.add(this.waterMesh);

    // ---------- overlay texture ----------
    const g = e.grid;
    this.overlayData = new Uint8Array(g.nx * g.ny * 4);
    this.overlayTex?.dispose();
    this.overlayTex = new THREE.DataTexture(this.overlayData, g.nx, g.ny, THREE.RGBAFormat);
    this.overlayTex.needsUpdate = true;
    this.overlayTex.minFilter = THREE.LinearFilter;
    this.overlayTex.magFilter = THREE.LinearFilter;
    (this.terrainMesh.material as THREE.ShaderMaterial).uniforms.uOverlay.value = this.overlayTex;
    (this.waterMesh.material as THREE.ShaderMaterial).uniforms.uOverlay.value = this.overlayTex;

    // ---------- velocity vectors ----------
    if (this.vectorLines) {
      this.scene.remove(this.vectorLines);
      this.vectorLines.geometry.dispose();
    }
    const VN = 32;
    const vgeo = new THREE.BufferGeometry();
    vgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(VN * VN * 2 * 3), 3));
    this.vectorLines = new THREE.LineSegments(
      vgeo,
      new THREE.LineBasicMaterial({ color: 0xe0a96d, transparent: true, opacity: 0.85 })
    );
    this.vectorLines.visible = false;
    this.vectorLines.frustumCulled = false;
    this.scene.add(this.vectorLines);

    this.updateTerrainGeometry({ exaggeration: e.world.verticalExaggeration, materials: true } as RenderOptions);
    this.resetCamera();
  }

  private makeGrid(res: number) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(res * res * 3);
    const uv = new Float32Array(res * res * 2);
    const idx = new Uint32Array((res - 1) * (res - 1) * 6);
    let p = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const u = i / (res - 1),
          v = j / (res - 1);
        pos[p * 3] = (u - 0.5) * SCENE_SIZE;
        pos[p * 3 + 1] = 0;
        pos[p * 3 + 2] = (v - 0.5) * SCENE_SIZE;
        uv[p * 2] = u;
        uv[p * 2 + 1] = v;
        p++;
      }
    }
    let t = 0;
    for (let j = 0; j < res - 1; j++) {
      for (let i = 0; i < res - 1; i++) {
        const a = j * res + i,
          b = a + 1,
          c = a + res,
          d = c + 1;
        idx[t++] = a;
        idx[t++] = c;
        idx[t++] = b;
        idx[t++] = b;
        idx[t++] = c;
        idx[t++] = d;
      }
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  /** Rebuild terrain heights + vertex colours (call after terrain edits). */
  updateTerrainGeometry(opts: Partial<RenderOptions>) {
    const e = this.engine;
    if (!e || !this.terrainMesh) return;
    const res = this.terrainRes;
    const geo = this.terrainMesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const s = this.scaleXZ;
    const ex = (opts.exaggeration ?? e.world.verticalExaggeration) * s;
    const useMat = opts.materials !== false;
    const sci = PALETTES[opts.paletteElev ?? "elevation"] ?? PALETTES.elevation;
    const st = e.terrain.stats();
    const maxEl = Math.max(100, st.max);
    const minEl = Math.min(-100, st.min);
    const dxm = e.world.width / res;
    for (let j = 0; j < res; j++) {
      const v = j / (res - 1);
      for (let i = 0; i < res; i++) {
        const u = i / (res - 1);
        const k = j * res + i;
        const h = e.terrain.sampleUV(u, v);
        (pos.array as Float32Array)[k * 3 + 1] = h * ex;
        const hx = e.terrain.sampleUV(u + 1 / res, v) - e.terrain.sampleUV(u - 1 / res, v);
        const hy = e.terrain.sampleUV(u, v + 1 / res) - e.terrain.sampleUV(u, v - 1 / res);
        const slope = Math.hypot(hx, hy) / (2 * dxm);
        let c: [number, number, number];
        if (useMat) c = terrainMaterialColor(h, slope, e.world.seaLevel, maxEl);
        else {
          const t = (h - minEl) / (maxEl - minEl || 1);
          c = samplePalette(sci, t);
        }
        (col.array as Float32Array)[k * 3] = c[0] / 255;
        (col.array as Float32Array)[k * 3 + 1] = c[1] / 255;
        (col.array as Float32Array)[k * 3 + 2] = c[2] / 255;
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeBoundingSphere();
  }

  /** Per-frame update of the water surface from the solver state. */
  updateWater(opts: RenderOptions) {
    const e = this.engine;
    if (!e || !this.waterMesh) return;
    const res = this.waterRes;
    const geo = this.waterMesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const wd = geo.getAttribute("wdata") as THREE.BufferAttribute;
    const pa = pos.array as Float32Array;
    const wa = wd.array as Float32Array;
    const s = this.scaleXZ;
    const ex = opts.exaggeration * s;
    const sv = e.solver;
    const g = e.grid;
    const hmin = sv.cfg.minDepth;
    const amp = opts.waveAmplify;
    const sea = e.world.seaLevel;
    for (let j = 0; j < res; j++) {
      const v = (j / (res - 1)) * (g.ny - 1);
      const j0 = Math.min(g.ny - 1, Math.floor(v));
      const j1 = Math.min(g.ny - 1, j0 + 1);
      const fy = v - j0;
      for (let i = 0; i < res; i++) {
        const u = (i / (res - 1)) * (g.nx - 1);
        const i0 = Math.min(g.nx - 1, Math.floor(u));
        const i1 = Math.min(g.nx - 1, i0 + 1);
        const fx = u - i0;
        const k00 = j0 * g.nx + i0,
          k10 = j0 * g.nx + i1,
          k01 = j1 * g.nx + i0,
          k11 = j1 * g.nx + i1;
        const w00 = (1 - fx) * (1 - fy),
          w10 = fx * (1 - fy),
          w01 = (1 - fx) * fy,
          w11 = fx * fy;
        const eta = sv.eta[k00] * w00 + sv.eta[k10] * w10 + sv.eta[k01] * w01 + sv.eta[k11] * w11;
        const bed = sv.zb[k00] * w00 + sv.zb[k10] * w10 + sv.zb[k01] * w01 + sv.zb[k11] * w11;
        const depth = eta - bed;
        const k = j * res + i;
        const dry = depth <= hmin ? 1 : 0;
        const disp = eta - Math.max(sea, bed);
        pa[k * 3 + 1] = (Math.max(sea, bed) + disp * amp) * ex;
        let speed = 0;
        if (!dry) {
          const M = sv.M[k00] * w00 + sv.M[k10] * w10 + sv.M[k01] * w01 + sv.M[k11] * w11;
          const N = sv.N[k00] * w00 + sv.N[k10] * w10 + sv.N[k01] * w01 + sv.N[k11] * w11;
          speed = Math.hypot(M, N) / Math.max(depth, hmin);
        }
        wa[k * 3] = depth;
        wa[k * 3 + 1] = speed;
        wa[k * 3 + 2] = dry;
      }
    }
    pos.needsUpdate = true;
    wd.needsUpdate = true;
    this.waterMesh.visible = opts.showWater;
    const mat = this.waterMesh.material as THREE.ShaderMaterial;
    mat.uniforms.uFoam.value = opts.showFoam ? 1 : 0;
    mat.wireframe = opts.wireframe;
  }

  /** Fill the overlay data texture for the active visualisation mode. */
  updateOverlay(opts: RenderOptions): { min: number; max: number; unit: string; label: string } | null {
    const e = this.engine;
    if (!e || !this.overlayTex) return null;
    const g = e.grid;
    const sv = e.solver;
    const data = this.overlayData;
    const n = g.nx * g.ny;
    const modeInfo: Record<string, { label: string; unit: string; pal: string }> = {
      scientific: { label: "SURFACE ELEVATION", unit: "m", pal: "diverging" },
      bathymetry: { label: "BATHYMETRY / ELEVATION", unit: "m", pal: opts.paletteDepth },
      waveheight: { label: "WAVE HEIGHT (η)", unit: "m", pal: opts.paletteWave },
      velocity: { label: "FLOW SPEED", unit: "m/s", pal: "velocity" },
      inundation: { label: "INUNDATION DEPTH", unit: "m", pal: opts.paletteWave },
      arrival: { label: "ARRIVAL TIME", unit: "s", pal: "arrival" },
      maxdepth: { label: "MAX WATER DEPTH", unit: "m", pal: opts.paletteWave },
      maxvelocity: { label: "MAX VELOCITY", unit: "m/s", pal: "velocity" },
      displacement: { label: "SOURCE DISPLACEMENT", unit: "m", pal: "diverging" },
      energy: { label: "ENERGY DENSITY", unit: "kJ/m²", pal: opts.paletteWave },
    };
    if (opts.mode === "realistic") {
      (this.terrainMesh!.material as THREE.ShaderMaterial).uniforms.uOverlayMix.value = 0;
      (this.waterMesh!.material as THREE.ShaderMaterial).uniforms.uOverlayMix.value = 0;
      return null;
    }
    const info = modeInfo[opts.mode] ?? modeInfo.scientific;
    const pal = PALETTES[info.pal] ?? PALETTES.wave;
    if (!this.fieldScratch || this.fieldScratch.length !== n) this.fieldScratch = new Float32Array(n);
    const field = this.fieldScratch;
    const diverging = opts.mode === "scientific" || opts.mode === "displacement";
    const disp = e.displacement;
    for (let k = 0; k < n; k++) {
      switch (opts.mode) {
        case "scientific":
          field[k] = sv.eta[k] - Math.max(e.world.seaLevel, sv.zb[k]);
          break;
        case "bathymetry":
          field[k] = sv.zb[k];
          break;
        case "waveheight": {
          const d = sv.eta[k] - Math.max(e.world.seaLevel, sv.zb[k]);
          field[k] = Math.abs(d);
          break;
        }
        case "velocity": {
          const D = sv.eta[k] - sv.zb[k];
          field[k] = D > sv.cfg.minDepth ? Math.hypot(sv.M[k], sv.N[k]) / D : 0;
          break;
        }
        case "inundation":
          field[k] = e.bedOriginal[k] > e.world.seaLevel ? Math.max(0, sv.eta[k] - sv.zb[k]) : 0;
          break;
        case "arrival":
          field[k] = sv.arrival[k];
          break;
        case "maxdepth":
          field[k] = sv.maxDepth[k];
          break;
        case "maxvelocity":
          field[k] = sv.maxSpeed[k];
          break;
        case "displacement":
          field[k] = disp ? disp.bed[k] + disp.water[k] : 0;
          break;
        case "energy": {
          const D = sv.eta[k] - sv.zb[k];
          if (D > sv.cfg.minDepth) {
            const d = sv.eta[k] - Math.max(e.world.seaLevel, sv.zb[k]);
            const u = sv.M[k] / D,
              v = sv.N[k] / D;
            field[k] = (0.5 * 1025 * e.physics.gravity * d * d + 0.5 * 1025 * D * (u * u + v * v)) / 1000;
          } else field[k] = 0;
          break;
        }
      }
    }
    let lo = opts.rangeMin,
      hi = opts.rangeMax;
    if (opts.autoRange) {
      lo = Infinity;
      hi = -Infinity;
      for (let k = 0; k < n; k++) {
        const f = field[k];
        if (!isFinite(f) || f < -1e12) continue;
        if (opts.mode === "arrival" && f < 0) continue;
        if (f < lo) lo = f;
        if (f > hi) hi = f;
      }
      if (!isFinite(lo)) {
        lo = 0;
        hi = 1;
      }
      if (diverging) {
        const m = Math.max(Math.abs(lo), Math.abs(hi), 0.01);
        lo = -m;
        hi = m;
      }
      if (hi - lo < 1e-6) hi = lo + 1;
    }
    const inv = 1 / (hi - lo);
    for (let k = 0; k < n; k++) {
      let f = field[k];
      let a = 255;
      if (opts.mode === "arrival" && f < 0) a = 0;
      if ((opts.mode === "inundation" || opts.mode === "maxdepth") && f <= sv.cfg.minDepth) a = 0;
      if (opts.mode === "displacement" && Math.abs(f) < 1e-3) a = 0;
      const t = (f - lo) * inv;
      const c = samplePalette(pal, t);
      data[k * 4] = c[0];
      data[k * 4 + 1] = c[1];
      data[k * 4 + 2] = c[2];
      data[k * 4 + 3] = a;
    }
    // wavefront contour
    if (opts.showContours) {
      const th = opts.contourThreshold;
      for (let j = 1; j < g.ny - 1; j++) {
        for (let i = 1; i < g.nx - 1; i++) {
          const k = j * g.nx + i;
          const a = Math.abs(sv.eta[k] - Math.max(e.world.seaLevel, sv.zb[k]));
          const b = Math.abs(sv.eta[k + 1] - Math.max(e.world.seaLevel, sv.zb[k + 1]));
          const c2 = Math.abs(sv.eta[k + g.nx] - Math.max(e.world.seaLevel, sv.zb[k + g.nx]));
          if ((a - th) * (b - th) < 0 || (a - th) * (c2 - th) < 0) {
            data[k * 4] = 245;
            data[k * 4 + 1] = 240;
            data[k * 4 + 2] = 232;
            data[k * 4 + 3] = 255;
          }
        }
      }
    }
    this.overlayTex.needsUpdate = true;
    const mix = 0.92;
    (this.terrainMesh!.material as THREE.ShaderMaterial).uniforms.uOverlayMix.value =
      opts.mode === "bathymetry" || opts.mode === "arrival" || opts.mode === "inundation" || opts.mode === "maxdepth"
        ? mix
        : opts.mode === "scientific"
        ? 0.35
        : 0.25;
    (this.waterMesh!.material as THREE.ShaderMaterial).uniforms.uOverlayMix.value = mix;
    return { min: lo, max: hi, unit: info.unit, label: info.label };
  }

  updateVectors(opts: RenderOptions) {
    const e = this.engine;
    if (!e || !this.vectorLines) return;
    this.vectorLines.visible = opts.showVectors;
    if (!opts.showVectors) return;
    const VN = 32;
    const g = e.grid;
    const sv = e.solver;
    const arr = (this.vectorLines.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const s = this.scaleXZ;
    const ex = opts.exaggeration * s;
    const lenScale = (SCENE_SIZE / VN) * 0.9;
    let p = 0;
    for (let j = 0; j < VN; j++) {
      for (let i = 0; i < VN; i++) {
        const gi = Math.floor(((i + 0.5) / VN) * g.nx);
        const gj = Math.floor(((j + 0.5) / VN) * g.ny);
        const k = gj * g.nx + gi;
        const D = sv.eta[k] - sv.zb[k];
        const x = ((i + 0.5) / VN - 0.5) * SCENE_SIZE;
        const z = ((j + 0.5) / VN - 0.5) * SCENE_SIZE;
        const y = sv.eta[k] * ex + 0.25;
        let u = 0,
          v = 0;
        if (D > sv.cfg.minDepth) {
          u = sv.M[k] / D;
          v = sv.N[k] / D;
        }
        const m = Math.hypot(u, v);
        const f = m > 0 ? Math.min(1, m / 6) / m : 0;
        arr[p++] = x;
        arr[p++] = y;
        arr[p++] = z;
        arr[p++] = x + u * f * lenScale;
        arr[p++] = y;
        arr[p++] = z + v * f * lenScale;
      }
    }
    (this.vectorLines.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  setGrid(show: boolean, n: number) {
    if (this.terrainMesh) {
      const m = this.terrainMesh.material as THREE.ShaderMaterial;
      m.uniforms.uGrid.value = show ? 1 : 0;
      m.uniforms.uGridN.value = n;
    }
  }

  /** Update marker meshes for instruments / cities / source. */
  updateMarkers(opts: RenderOptions) {
    const e = this.engine;
    if (!e) return;
    while (this.markerGroup.children.length) {
      const c = this.markerGroup.children.pop() as THREE.Mesh;
      c.geometry?.dispose();
      (c.material as THREE.Material)?.dispose();
    }
    const s = this.scaleXZ;
    const ex = opts.exaggeration * s;
    const add = (x: number, y: number, color: number, h: number, r: number) => {
      const bed = e.bedAtWorld(x, y);
      const base = Math.max(bed, e.world.seaLevel);
      const geo = new THREE.ConeGeometry(r, h, 8);
      const mat = new THREE.MeshBasicMaterial({ color });
      const m = new THREE.Mesh(geo, mat);
      const p = this.worldToScene(x, y, base, opts.exaggeration);
      m.position.set(p.x, p.y + h / 2, p.z);
      this.markerGroup.add(m);
      return m;
    };
    for (const ins of e.instruments) add(ins.x, ins.y, ins.type === "buoy" ? 0xe0a96d : 0xc9cdd1, 2.2, 0.7);
    for (const c of e.cities) add(c.x, c.y, 0xb5763c, 1.6, 0.9);
    void ex;
  }

  /**
   * Ray-march pick against the heightfield.  Far cheaper and more robust than
   * brute-force triangle raycasting on a million-triangle terrain mesh.
   */
  pick(clientX: number, clientY: number): { x: number; y: number; elev: number } | null {
    const e = this.engine;
    if (!e) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(mouse, this.camera);
    const ray = this.raycaster.ray;
    const s = this.scaleXZ;
    const ex = e.world.verticalExaggeration * s;
    const half = SCENE_SIZE / 2;
    const surfaceAt = (px: number, pz: number) => {
      const u = (px + half) / SCENE_SIZE;
      const v = (pz + half) / SCENE_SIZE;
      if (u < 0 || v < 0 || u > 1 || v > 1) return -Infinity;
      const bed = e.terrain.sampleUV(u, v);
      const top = this.waterMesh?.visible ? Math.max(bed, e.world.seaLevel) : bed;
      return top * ex;
    };
    const maxT = 4000;
    let t = 0;
    let prevT = 0;
    let prevDiff = ray.origin.y - surfaceAt(ray.origin.x, ray.origin.z);
    const step = SCENE_SIZE / 240;
    const p = new THREE.Vector3();
    while (t < maxT) {
      t += step * (1 + t / (SCENE_SIZE * 0.5));
      p.copy(ray.direction).multiplyScalar(t).add(ray.origin);
      const h = surfaceAt(p.x, p.z);
      if (h === -Infinity) {
        if (p.y < -SCENE_SIZE) break;
        prevT = t;
        continue;
      }
      const diff = p.y - h;
      if (diff <= 0 && prevDiff > 0) {
        // bisect between prevT and t
        let a = prevT,
          b = t;
        for (let i = 0; i < 24; i++) {
          const m = (a + b) * 0.5;
          p.copy(ray.direction).multiplyScalar(m).add(ray.origin);
          const hh = surfaceAt(p.x, p.z);
          if (p.y - hh > 0) a = m;
          else b = m;
        }
        p.copy(ray.direction).multiplyScalar((a + b) * 0.5).add(ray.origin);
        const w = this.sceneToWorld(p);
        if (w.x < 0 || w.y < 0 || w.x > e.world.width || w.y > e.world.length) return null;
        return { x: w.x, y: w.y, elev: e.bedAtWorld(w.x, w.y) };
      }
      prevDiff = diff;
      prevT = t;
    }
    return null;
  }

  resetCamera() {
    this.camera.position.set(-SCENE_SIZE * 0.55, SCENE_SIZE * 0.55, SCENE_SIZE * 0.85);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  topDown() {
    this.camera.position.set(0, SCENE_SIZE * 1.15, 0.001);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  focusWorld(x: number, y: number, dist = 40) {
    const e = this.engine;
    if (!e) return;
    const p = this.worldToScene(x, y, Math.max(0, e.bedAtWorld(x, y)), e.world.verticalExaggeration);
    this.controls.target.copy(p);
    const dir = this.camera.position.clone().sub(p).normalize().multiplyScalar(dist);
    this.camera.position.copy(p.clone().add(dir));
    this.controls.update();
  }

  projectToScreen(x: number, y: number, elevM: number, exaggeration: number) {
    const p = this.worldToScene(x, y, elevM, exaggeration);
    this.tmpV.copy(p).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((this.tmpV.x + 1) / 2) * rect.width,
      y: ((1 - this.tmpV.y) / 2) * rect.height,
      visible: this.tmpV.z < 1,
    };
  }

  resize() {
    if (this.disposed) return;
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    if (this.disposed) return;
    const t0 = performance.now();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.gpuFrameMs = this.gpuFrameMs * 0.9 + (performance.now() - t0) * 0.1;
    this.triangles = this.renderer.info.render.triangles;
    this.drawCalls = this.renderer.info.render.calls;
  }

  screenshot(): string {
    this.render();
    return this.renderer.domElement.toDataURL("image/png");
  }

  private disposeMesh(m: THREE.Mesh | null) {
    if (!m) return;
    this.scene.remove(m);
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }

  dispose() {
    this.disposed = true;
    this.disposeMesh(this.terrainMesh);
    this.disposeMesh(this.waterMesh);
    this.overlayTex?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container)
      this.container.removeChild(this.renderer.domElement);
  }
}
