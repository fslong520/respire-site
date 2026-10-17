import { MEMORY_CLOUD_URL } from '../destinations';

/*
 * Container point-cloud + force-directed knowledge graph effect.
 * Ported from the mind3D demo5 single-file sample to the project's bundled
 * three. Only the demo's light "paper ink" branch is kept: a transparent
 * canvas over the paper background, normal blending, and a palette that dims
 * toward the paper colour instead of pure white.
 *
 * This module has no top-level `three` import: the caller lazy-loads three and
 * passes the namespace in, so the main bundle stays lean.
 */

type Three = typeof import('three');
type Renderer = InstanceType<Three['WebGLRenderer']>;
type Scene = InstanceType<Three['Scene']>;
type PerspectiveCamera = InstanceType<Three['PerspectiveCamera']>;
type BufferGeometry = InstanceType<Three['BufferGeometry']>;
type BufferAttribute = InstanceType<Three['BufferAttribute']>;
type LineSegments = InstanceType<Three['LineSegments']>;
type LineBasicMaterial = InstanceType<Three['LineBasicMaterial']>;
type ShaderMaterial = InstanceType<Three['ShaderMaterial']>;
type CanvasTexture = InstanceType<Three['CanvasTexture']>;
type Points = InstanceType<Three['Points']>;

export interface MemoryPointCloudHandle {
  wake(): void;
  setPaused(paused: boolean): void;
  setReduced(reduced: boolean): void;
  dispose(): void;
}

export interface MemoryPointCloudOptions {
  /** Called once the first frame has rendered, and again after a context
   * loss/restore cycle. `false` means the artwork fallback should show. */
  onReadyChange(ready: boolean): void;
  /** Final artwork-space coordinates for the narrative anchor, when it moved. */
  onAnchor(x: number, y: number): void;
  /** `new THREE.WebGLRenderer` threw. */
  onUnavailable(): void;
  /** Cloud asset load or scene setup failed. */
  onSetupError(): void;
  /** Measured pixel box the container must stay framed inside (the hero square). */
  heroBox?(): DOMRect | null;
}

const CLOUD_META = {
  count: 120000,
  min: [-649.4897, -522.4982, -620.9542] as const,
  scale: [0.01982116, 0.01594562, 0.01895031] as const,
};

const CFG = {
  MAX_NODES: 3000,
  ADD_INTERVAL_MS: 100,
  FOCUS_INTERVAL_MS: 2000,
  FOCUS_ROOTS: 5,
  FOCUS_LEVELS: 3,
  FOCUS_MAX_NODES: 15,
  RESET_PAUSE_MS: 400,
  RESOLUTION: 88,
  DILATE: 1,
  REF_POINT_SIZE: 4.2,
  REF_OPACITY: 0.5,
  TARGET_RADIUS: 700,
  LINK_REST: 70,
  SPRING: 0.02,
  REPULSION: 0.10,
  REP_RADIUS: 120,
  REP_MAX: 10,
  DAMPING: 0.86,
  MAX_SPEED: 2.0,
  ANCHOR: 0.04,
  PHYS_STEP: 1 / 60,
  MAX_SUBSTEPS: 3,
  ORBIT_DEG_PER_SEC: 5,
  EXT_MAX_NODES: 3400,
  EXT_MAX_EDGES: 3600,
  EXT_START_Z: 520,
  EXT_GEN_DEPTH: 34,
  EXT_SPREAD_NEAR: 120,
  EXT_SPREAD_WIDE: 2600,
  EXT_CLUSTER_MIN: 3,
  EXT_CLUSTER_MAX: 8,
  EXT_CLUSTER_RADIUS: 140,
  EXT_FOCUS_INTERVAL_MS: 2000,
  EXT_FOCUS_ROOTS: 4,
  EXT_FOCUS_LEVELS: 3,
  EXT_FOCUS_MAX_NODES: 22,
  EXT_SPRING: 0.02,
  EXT_REPULSION: 0.10,
  EXT_REP_RADIUS: 120,
  EXT_REP_MAX: 12,
  EXT_DAMPING: 0.86,
  EXT_MAX_SPEED: 2.0,
  EXT_ANCHOR: 0.04,
  EXT_ANCHOR_Z: 0.04,
} as const;

const PALETTE_NODE = ['#0a84ff', '#8b3dff', '#e5006d', '#00a06b', '#c98a00', '#3a5ccc', '#d94f16', '#2440d0'];
const DECAY = 0.60;
const REF_OPACITY_LIGHT = 0.25;
const LIGHT_DIM_T = 0.3;
const LIGHT_TINT_EDGE = 0.26;
const EXT_EDGE_DIM_TINT = 0.16;
const EXT_EDGE_LIT_BASE = 0.50;
const EXT_EDGE_LIT_SPAN = 0.28;
const FOV = 60;

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Linear value of the paper background `#f8f6f2`, mixed in when dimming. */
const PAPER: readonly [number, number, number] = [srgbToLinear(0xf8 / 255), srgbToLinear(0xf6 / 255), srgbToLinear(0xf2 / 255)];

const STOP_LOW = [0.13, 0.32, 0.82];
const STOP_MID = [0.02, 0.52, 0.62];
const STOP_HIGH = [0.44, 0.20, 0.86];

function heightRamp(t: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  const [a, b, f] = k < 0.5 ? [STOP_LOW, STOP_MID, k * 2] : [STOP_MID, STOP_HIGH, (k - 0.5) * 2];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

interface SpawnPoint { x: number; y: number; z: number }

interface SpawnVolume {
  mode: 'volume' | 'shell';
  size: number;
  nx: number;
  ny: number;
  nz: number;
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  contains(x: number, y: number, z: number): boolean;
  randomPoint(out?: SpawnPoint): SpawnPoint;
}

/** Voxelised container volume, mirroring the demo's `buildSpawnVolume`. */
function buildSpawnVolume(positions: Float32Array, count: number, opts: { resolution?: number; dilate?: number } = {}): SpawnVolume {
  const n = Math.max(1, count | 0);
  const clampInt = (v: number, lo: number, hi: number): number => {
    const k = Math.round(Number(v));
    if (!Number.isFinite(k)) return lo;
    return k < lo ? lo : k > hi ? hi : k;
  };

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 1; }
  const spanX = Math.max(1e-6, maxX - minX), spanY = Math.max(1e-6, maxY - minY), spanZ = Math.max(1e-6, maxZ - minZ);
  const cell = Math.max(spanX, spanY, spanZ) / clampInt(opts.resolution ?? CFG.RESOLUTION, 16, 200);
  const nx = Math.max(2, Math.floor(spanX / cell) + 1);
  const ny = Math.max(2, Math.floor(spanY / cell) + 1);
  const nz = Math.max(2, Math.floor(spanZ / cell) + 1);
  const cells = nx * ny * nz;
  const at = (x: number, y: number, z: number): number => (z * ny + y) * nx + x;
  const cx = (v: number): number => Math.min(nx - 1, Math.max(0, Math.floor((v - minX) / cell)));
  const cy = (v: number): number => Math.min(ny - 1, Math.max(0, Math.floor((v - minY) / cell)));
  const cz = (v: number): number => Math.min(nz - 1, Math.max(0, Math.floor((v - minZ) / cell)));

  const shell = new Uint8Array(cells);
  for (let i = 0; i < n; i++) shell[at(cx(positions[i * 3]), cy(positions[i * 3 + 1]), cz(positions[i * 3 + 2]))] = 1;

  const r = clampInt(opts.dilate ?? CFG.DILATE, 0, 3);
  let barrier = shell;
  if (r > 0) {
    barrier = new Uint8Array(cells);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const k = at(x, y, z);
      if (shell[k]) { barrier[k] = 1; continue; }
      let hit = false;
      for (let dz = -r; dz <= r && !hit; dz++) {
        const zz = z + dz; if (zz < 0 || zz >= nz) continue;
        for (let dy = -r; dy <= r && !hit; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= ny) continue;
          const rowBase = (zz * ny + yy) * nx;
          for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= nx) continue; if (shell[rowBase + xx]) { hit = true; break; } }
        }
      }
      if (hit) barrier[k] = 1;
    }
  }

  const exterior = new Uint8Array(cells);
  const queue = new Int32Array(cells);
  let qHead = 0, qTail = 0;
  const push = (k: number): void => { if (!barrier[k] && !exterior[k]) { exterior[k] = 1; queue[qTail++] = k; } };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { push(at(0, y, z)); push(at(nx - 1, y, z)); }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { push(at(x, 0, z)); push(at(x, ny - 1, z)); }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { push(at(x, y, 0)); push(at(x, y, nz - 1)); }
  const plane = nx * ny;
  while (qHead < qTail) {
    const k = queue[qHead++];
    const x = k % nx, y = ((k / nx) | 0) % ny;
    if (x > 0) push(k - 1);
    if (x < nx - 1) push(k + 1);
    if (y > 0) push(k - nx);
    if (y < ny - 1) push(k + nx);
    if (k >= plane) push(k - plane);
    if (k < cells - plane) push(k + plane);
  }

  const inVol = new Uint8Array(cells);
  let candCount = 0, interiorCells = 0;
  for (let k = 0; k < cells; k++) {
    if (shell[k]) { inVol[k] = 1; candCount++; }
    else if (!barrier[k] && !exterior[k]) { inVol[k] = 1; interiorCells++; candCount++; }
  }
  const candidates = new Uint32Array(Math.max(1, candCount));
  { let ci = 0; for (let k = 0; k < cells; k++) if (inVol[k]) candidates[ci++] = k; }

  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2, centerZ = (minZ + maxZ) / 2;

  return {
    mode: interiorCells > 0 ? 'volume' : 'shell',
    size: candCount, nx, ny, nz,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [centerX, centerY, centerZ],
    contains(x: number, y: number, z: number): boolean {
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) return false;
      return inVol[at(cx(x), cy(y), cz(z))] === 1;
    },
    randomPoint(out?: SpawnPoint): SpawnPoint {
      const o = out ?? { x: 0, y: 0, z: 0 };
      if (candCount === 0) { o.x = centerX; o.y = centerY; o.z = centerZ; return o; }
      const k = candidates[(Math.random() * candCount) | 0];
      const x = k % nx, y = ((k / nx) | 0) % ny, z = (k / (nx * ny)) | 0;
      const fx = x + 0.18 + Math.random() * 0.64;
      const fy = y + 0.18 + Math.random() * 0.64;
      const fz = z + 0.18 + Math.random() * 0.64;
      o.x = Math.min(maxX, Math.max(minX, minX + fx * cell));
      o.y = Math.min(maxY, Math.max(minY, minY + fy * cell));
      o.z = Math.min(maxZ, Math.max(minZ, minZ + fz * cell));
      return o;
    },
  };
}

/** Fetch the quantised container point cloud (Uint16 LE triplets) and expand it. */
async function loadCloud(url: string): Promise<Float32Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load memory cloud (${response.status})`);
  const buffer = await response.arrayBuffer();
  const q = new Uint16Array(buffer);
  const n = CLOUD_META.count;
  if (q.length < n * 3) throw new Error('Memory cloud is truncated');
  const out = new Float32Array(n * 3);
  const [mx, my, mz] = CLOUD_META.min;
  const [sx, sy, sz] = CLOUD_META.scale;
  for (let i = 0; i < n; i++) {
    out[i * 3] = mx + q[i * 3] * sx;
    out[i * 3 + 1] = my + q[i * 3 + 1] * sy;
    out[i * 3 + 2] = mz + q[i * 3 + 2] * sz;
  }
  return out;
}

function dotTexture(THREE: Three): CanvasTexture {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.65)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(cv);
}

interface LinkLayer {
  pos: Float32Array;
  col: Float32Array;
  geo: BufferGeometry;
  posAttr: BufferAttribute;
  colAttr: BufferAttribute;
  seg: LineSegments;
}

export async function startMemoryPointCloud(
  THREE: Three,
  host: HTMLDivElement,
  options: MemoryPointCloudOptions,
): Promise<MemoryPointCloudHandle | null> {
  const mobile = window.matchMedia('(max-width: 640px)').matches;

  let renderer: Renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    options.onUnavailable();
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);

  const teardownRenderer = (): void => {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };

  const scene: Scene = new THREE.Scene();
  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(FOV, 1, 1, 1000000);
  camera.up.set(0, 0, 1); // the brain's "crown" (+Z) is screen-up

  let camDist = 1;
  let azimuth = -Math.PI / 2;
  let pxPerUnit = 1;
  const ORBIT_STEP = THREE.MathUtils.degToRad(CFG.ORBIT_DEG_PER_SEC);
  const halfFov = THREE.MathUtils.degToRad(FOV / 2);
  const heroRect = (): DOMRect => options.heroBox?.() ?? host.getBoundingClientRect();

  // The container is framed by the hero square, not the full-viewport canvas:
  // its world radius maps to the same on-screen radius the hero used before.
  const fitCamera = (): void => {
    const rect = heroRect();
    const halfBox = Math.max(1, Math.min(rect.width, rect.height) / 2);
    const fit = (halfBox * Math.cos(halfFov)) / 1.12;
    pxPerUnit = fit / CFG.TARGET_RADIUS;
    const height = Math.max(1, host.clientHeight);
    camDist = (height / 2) / (Math.tan(halfFov) * pxPerUnit);
  };
  // Pan the whole camera (position and look-at) so the world origin lands on the
  // hero square's centre in viewport pixels; re-measured each frame so the graph
  // scrolls away with the page while the canvas stays fixed.
  const placeCamera = (): void => {
    const rect = heroRect();
    const height = Math.max(1, host.clientHeight);
    const width = Math.max(1, host.clientWidth);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const wx = (cx - width / 2) / pxPerUnit;
    const wy = (cy - height / 2) / pxPerUnit;
    const panX = wx * Math.sin(azimuth);
    const panY = -wx * Math.cos(azimuth);
    const panZ = wy;
    camera.position.set(camDist * Math.cos(azimuth) + panX, camDist * Math.sin(azimuth) + panY, panZ);
    camera.lookAt(panX, panY, panZ);
  };

  let uScale = 1;
  const drawBufferSize = new THREE.Vector2();
  const updateScale = (): void => {
    const hDraw = renderer.getDrawingBufferSize(drawBufferSize).y;
    uScale = (hDraw * 0.5) / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  };

  let dot: CanvasTexture | null = null;
  let refScaleUniform: { value: number } | null = null;
  let anchorLocal: InstanceType<Three['Vector3']> | null = null;
  let refPoints: Points | null = null;
  let spawnVolume!: SpawnVolume;

  try {
    const refPositions = await loadCloud(MEMORY_CLOUD_URL);
    const n = CLOUD_META.count;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { const y = refPositions[i * 3 + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const span = (maxY - minY) || 1;
    const refCol = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = heightRamp((refPositions[i * 3 + 1] - minY) / span);
      refCol[i * 3] = srgbToLinear(r); refCol[i * 3 + 1] = srgbToLinear(g); refCol[i * 3 + 2] = srgbToLinear(b);
    }
    dot = dotTexture(THREE);
    const refGeo = new THREE.BufferGeometry();
    refGeo.setAttribute('position', new THREE.BufferAttribute(refPositions, 3));
    refGeo.setAttribute('aColor', new THREE.BufferAttribute(refCol, 3));
    const refUniforms = {
      uScale: { value: uScale }, uSize: { value: CFG.REF_POINT_SIZE },
      uOpacity: { value: REF_OPACITY_LIGHT }, uMap: { value: dot },
    };
    const refMat: ShaderMaterial = new THREE.ShaderMaterial({
      uniforms: refUniforms,
      vertexShader: `
        attribute vec3 aColor; uniform float uScale; uniform float uSize; varying vec3 vColor;
        void main(){ vColor = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = uSize * uScale / max(0.001, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform float uOpacity; varying vec3 vColor;
        void main(){ float a = texture2D(uMap, gl_PointCoord).a; if(a<0.02) discard;
          gl_FragColor = vec4(vColor, a*uOpacity); }`,
      transparent: true, blending: THREE.NormalBlending, depthWrite: false,
    });
    refPoints = new THREE.Points(refGeo, refMat);
    refPoints.frustumCulled = false;
    refPoints.renderOrder = 1;
    scene.add(refPoints);
    refScaleUniform = refUniforms.uScale;

    spawnVolume = buildSpawnVolume(refPositions, n, { resolution: CFG.RESOLUTION, dilate: CFG.DILATE });

    // Anchor: the decoded container point with the smallest y (container floor).
    let bestY = Infinity, bestIndex = 0;
    for (let i = 0; i < n; i++) { const y = refPositions[i * 3 + 1]; if (y < bestY) { bestY = y; bestIndex = i; } }
    anchorLocal = new THREE.Vector3(refPositions[bestIndex * 3], refPositions[bestIndex * 3 + 1], refPositions[bestIndex * 3 + 2]);
  } catch {
    dot?.dispose();
    teardownRenderer();
    options.onSetupError();
    return null;
  }

  const MAXN = CFG.MAX_NODES;
  const nodePos = new Float32Array(MAXN * 3);
  const nodeCol = new Float32Array(MAXN * 3);
  const nodeSz = new Float32Array(MAXN);
  const nodeBaseR = new Float32Array(MAXN);
  const nodeBaseG = new Float32Array(MAXN);
  const nodeBaseB = new Float32Array(MAXN);
  const nodeBaseSize = new Float32Array(MAXN);
  const nodeTgt = new Float32Array(MAXN);
  const nodeCur = new Float32Array(MAXN);

  const nodeGeo = new THREE.BufferGeometry();
  const nodePosAttr = new THREE.BufferAttribute(nodePos, 3).setUsage(THREE.DynamicDrawUsage);
  const nodeColAttr = new THREE.BufferAttribute(nodeCol, 3).setUsage(THREE.DynamicDrawUsage);
  const nodeSzAttr = new THREE.BufferAttribute(nodeSz, 1).setUsage(THREE.DynamicDrawUsage);
  nodeGeo.setAttribute('position', nodePosAttr);
  nodeGeo.setAttribute('aColor', nodeColAttr);
  nodeGeo.setAttribute('aSize', nodeSzAttr);
  nodeGeo.setDrawRange(0, 0);

  const nodeUniforms = { uScale: { value: uScale }, uLight: { value: 1 } };
  const nodeMat: ShaderMaterial = new THREE.ShaderMaterial({
    uniforms: nodeUniforms,
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; uniform float uScale; varying vec3 vColor;
      void main(){ vColor = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = aSize * uScale / max(0.001, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `
      uniform float uLight; varying vec3 vColor;
      void main(){
        vec2 d = gl_PointCoord - 0.5; float r = length(d)*2.0; if(r>1.0) discard;
        float core = smoothstep(0.5, 0.0, r);
        float halo = smoothstep(1.0, 0.0, r);
        float a = (core*0.95 + halo*0.30) * (1.0 - 0.25*uLight);
        vec3 c = mix(vColor * (0.6 + 1.0*core), vColor, uLight);
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true, blending: THREE.NormalBlending, depthTest: true, depthWrite: false,
  });
  const nodePoints = new THREE.Points(nodeGeo, nodeMat);
  nodePoints.frustumCulled = false;
  nodePoints.renderOrder = 3;
  scene.add(nodePoints);

  const MAXE = MAXN;
  const LITMAX = 1500;
  const edgeA = new Int32Array(MAXE);
  const edgeB = new Int32Array(MAXE);
  const edgeTgt = new Float32Array(MAXE);
  const edgeCur = new Float32Array(MAXE);

  const makeLinkLayer = (capacity: number, material: LineBasicMaterial): LinkLayer => {
    const pos = new Float32Array(capacity * 2 * 3);
    const col = new Float32Array(capacity * 2 * 3);
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
    geo.setDrawRange(0, 0);
    const seg = new THREE.LineSegments(geo, material);
    seg.frustumCulled = false;
    return { pos, col, geo, posAttr, colAttr, seg };
  };
  const dimMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.62, depthWrite: false });
  const litMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.NormalBlending, depthWrite: false });
  const dimLayer = makeLinkLayer(MAXE, dimMaterial);
  const litLayer = makeLinkLayer(LITMAX, litMaterial);
  dimLayer.seg.renderOrder = 2;
  litLayer.seg.renderOrder = 4;
  scene.add(dimLayer.seg);
  scene.add(litLayer.seg);

  let nodeCount = 0;
  let edgeCount = 0;
  let focusActive = false;
  let resetPending = false;
  let pauseAcc = 0;
  const adj = new Map<number, number[]>();
  const edgeSeen = new Set<number>();
  const nodeVel = new Float32Array(MAXN * 3);
  const anchorX = new Float32Array(MAXN);
  const anchorY = new Float32Array(MAXN);
  const anchorZ = new Float32Array(MAXN);
  const physGrid = new Map<string, number[]>();
  let physAcc = 0;
  const tmpP: SpawnPoint = { x: 0, y: 0, z: 0 };

  const hexToLinear = (hex: string): [number, number, number] => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b];
  };

  const EXT_MAXN = CFG.EXT_MAX_NODES;
  const EXT_MAXE = CFG.EXT_MAX_EDGES;

  const extPos = new Float32Array(EXT_MAXN * 3);
  const extCol = new Float32Array(EXT_MAXN * 3);
  const extSz = new Float32Array(EXT_MAXN);
  const extBaseR = new Float32Array(EXT_MAXN);
  const extBaseG = new Float32Array(EXT_MAXN);
  const extBaseB = new Float32Array(EXT_MAXN);
  const extBaseSize = new Float32Array(EXT_MAXN);
  const extTgt = new Float32Array(EXT_MAXN);
  const extCur = new Float32Array(EXT_MAXN);
  const extVel = new Float32Array(EXT_MAXN * 3);
  const extAnchorX = new Float32Array(EXT_MAXN);
  const extAnchorY = new Float32Array(EXT_MAXN);
  const extAnchorZ = new Float32Array(EXT_MAXN);
  const extAdj: number[][] = Array.from({ length: EXT_MAXN }, () => [] as number[]);

  const extNodeGeo = new THREE.BufferGeometry();
  const extPosAttr = new THREE.BufferAttribute(extPos, 3).setUsage(THREE.DynamicDrawUsage);
  const extColAttr = new THREE.BufferAttribute(extCol, 3).setUsage(THREE.DynamicDrawUsage);
  const extSzAttr = new THREE.BufferAttribute(extSz, 1).setUsage(THREE.DynamicDrawUsage);
  extNodeGeo.setAttribute('position', extPosAttr);
  extNodeGeo.setAttribute('aColor', extColAttr);
  extNodeGeo.setAttribute('aSize', extSzAttr);
  extNodeGeo.setDrawRange(0, 0);
  const extPoints = new THREE.Points(extNodeGeo, nodeMat);
  extPoints.frustumCulled = false;
  extPoints.renderOrder = 3;
  scene.add(extPoints);

  const extDimMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.38, depthWrite: false });
  const extLitMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.58, blending: THREE.NormalBlending, depthWrite: false });
  const extDimLayer = makeLinkLayer(EXT_MAXE, extDimMaterial);
  const extLitLayer = makeLinkLayer(EXT_MAXE, extLitMaterial);
  extDimLayer.seg.frustumCulled = false;
  extLitLayer.seg.frustumCulled = false;
  extDimLayer.seg.renderOrder = 2;
  extLitLayer.seg.renderOrder = 4;
  scene.add(extDimLayer.seg);
  scene.add(extLitLayer.seg);

  const extEdgeA = new Int32Array(EXT_MAXE);
  const extEdgeB = new Int32Array(EXT_MAXE);
  const extEdgeTgt = new Float32Array(EXT_MAXE);
  const extEdgeCur = new Float32Array(EXT_MAXE);
  const extEdgeSeen = new Set<number>();
  const extGrid = new Map<string, number[]>();

  let extCount = 0;
  let extEdgeCount = 0;
  let extGen = 0;
  let extClock = 0;
  let extDepthWorld = 6000;
  let maxScrollBottom = 0;

  const mulberry32 = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const addExtNode = (x: number, y: number, z: number, rnd: () => number): number => {
    const i = extCount;
    if (i >= EXT_MAXN) return -1;
    extCount++;
    extPos[i * 3] = x; extPos[i * 3 + 1] = y; extPos[i * 3 + 2] = z;
    extAnchorX[i] = x; extAnchorY[i] = y; extAnchorZ[i] = z;
    const c = hexToLinear(PALETTE_NODE[Math.floor(rnd() * PALETTE_NODE.length)]);
    extBaseR[i] = c[0]; extBaseG[i] = c[1]; extBaseB[i] = c[2];
    extBaseSize[i] = (9.0 + Math.cbrt(0.6 + rnd() * 2.0) * 9.0) * 1.6;
    extTgt[i] = 0; extCur[i] = 0;
    extVel[i * 3] = 0; extVel[i * 3 + 1] = 0; extVel[i * 3 + 2] = 0;
    extPosAttr.needsUpdate = true;
    extNodeGeo.setDrawRange(0, extCount);
    return i;
  };

  const addExtEdge = (a: number, b: number): void => {
    if (a < 0 || b < 0 || a === b || extEdgeCount >= EXT_MAXE) return;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * EXT_MAXN + hi;
    if (extEdgeSeen.has(key)) return;
    extEdgeSeen.add(key);
    const e = extEdgeCount++;
    extEdgeA[e] = lo; extEdgeB[e] = hi;
    extEdgeTgt[e] = 0; extEdgeCur[e] = 0;
    extAdj[lo].push(hi); extAdj[hi].push(lo);
  };

  const spawnCluster = (g: number): void => {
    if (extCount >= EXT_MAXN) return;
    const rnd = mulberry32((0x9e3779b9 ^ Math.imul(g + 1, 0x85ebca6b)) >>> 0);
    const depth = CFG.EXT_START_Z + g * CFG.EXT_GEN_DEPTH + rnd() * CFG.EXT_GEN_DEPTH * 0.9;
    const frac = Math.min(1, depth / Math.max(1, extDepthWorld));
    const wide = Math.max(CFG.EXT_SPREAD_WIDE, (Math.max(1, host.clientWidth) * 0.5) / Math.max(1e-3, pxPerUnit));
    const spread = CFG.EXT_SPREAD_NEAR + frac * (wide - CFG.EXT_SPREAD_NEAR);
    const centerAngle = rnd() * Math.PI * 2;
    const centerRadius = spread * Math.sqrt(rnd());
    const cx = Math.cos(centerAngle) * centerRadius;
    const cy = Math.sin(centerAngle) * centerRadius;
    const cz = -depth;
    const localR = CFG.EXT_CLUSTER_RADIUS * (0.55 + 0.9 * rnd());
    const members = CFG.EXT_CLUSTER_MIN + Math.floor(rnd() * (CFG.EXT_CLUSTER_MAX - CFG.EXT_CLUSTER_MIN + 1));
    const idxs: number[] = [];
    for (let j = 0; j < members; j++) {
      if (extCount >= EXT_MAXN) break;
      const angle = rnd() * Math.PI * 2;
      const radius = j === 0 ? 0 : localR * Math.sqrt(rnd());
      const idx = addExtNode(
        cx + Math.cos(angle) * radius,
        cy + Math.sin(angle) * radius,
        cz + (rnd() * 2 - 1) * localR * 0.6,
        rnd,
      );
      if (idx < 0) break;
      idxs.push(idx);
    }
    for (let k = 1; k < idxs.length; k++) {
      const a = idxs[k];
      const ao = a * 3;
      let best = -1, bestD = Infinity, second = -1, secondD = Infinity;
      for (let m = 0; m < k; m++) {
        const b = idxs[m];
        const bo = b * 3;
        const dx = extPos[bo] - extPos[ao], dy = extPos[bo + 1] - extPos[ao + 1], dz = extPos[bo + 2] - extPos[ao + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) { secondD = bestD; second = best; bestD = d2; best = b; }
        else if (d2 < secondD) { secondD = d2; second = b; }
      }
      if (best >= 0) addExtEdge(best, a);
      if (second >= 0 && rnd() < 0.35) addExtEdge(second, a);
    }
  };

  const growExtension = (): void => {
    const rect = heroRect();
    const docHeight = Math.max(1, document.documentElement.scrollHeight);
    const sceneCenterDocY = rect.top + window.scrollY + rect.height / 2;
    extDepthWorld = Math.max(600, (docHeight - sceneCenterDocY) / Math.max(1e-3, pxPerUnit));
    maxScrollBottom = Math.max(maxScrollBottom, window.scrollY + window.innerHeight);
    const viewportBottomDocY = Math.min(docHeight, maxScrollBottom);
    const neededDepthWorld = Math.max(0, viewportBottomDocY - sceneCenterDocY) / Math.max(1e-3, pxPerUnit);
    const neededGen = Math.ceil(Math.max(0, neededDepthWorld - CFG.EXT_START_Z) / CFG.EXT_GEN_DEPTH);
    let budget = 12;
    while (extGen < neededGen && extCount < EXT_MAXN && budget-- > 0) {
      spawnCluster(extGen);
      extGen++;
    }
  };

  const applyExtFocus = (): void => {
    extTgt.fill(0, 0, extCount);
    extEdgeTgt.fill(0, 0, extEdgeCount);
    if (extCount === 0) return;
    const roots: number[] = [];
    const seen = new Set<number>();
    let guard = 0;
    const want = Math.min(CFG.EXT_FOCUS_ROOTS, extCount);
    while (roots.length < want && guard++ < want * 40) {
      const i = (Math.random() * extCount) | 0;
      if (!seen.has(i)) { seen.add(i); roots.push(i); }
    }
    const level = new Map<number, number>();
    let frontier: number[] = [];
    for (const r of roots) { level.set(r, 0); frontier.push(r); }
    for (let d = 1; d <= CFG.EXT_FOCUS_LEVELS; d++) {
      const next: number[] = [];
      for (const u of frontier) {
        const nb = extAdj[u];
        for (const v of nb) if (!level.has(v)) { level.set(v, d); next.push(v); }
      }
      if (!next.length) break;
      frontier = next;
    }
    let lit = level;
    if (level.size > CFG.EXT_FOCUS_MAX_NODES) {
      const arr = Array.from(level.entries()).sort((p, q) => p[1] - q[1]);
      lit = new Map<number, number>();
      for (let i = 0; i < CFG.EXT_FOCUS_MAX_NODES; i++) lit.set(arr[i][0], arr[i][1]);
    }
    for (const [id, lv] of lit) extTgt[id] = Math.pow(DECAY, lv);
    for (let i = 0; i < extEdgeCount; i++) {
      const la = lit.has(extEdgeA[i]) ? (lit.get(extEdgeA[i]) as number) : Infinity;
      const lb = lit.has(extEdgeB[i]) ? (lit.get(extEdgeB[i]) as number) : Infinity;
      const lv = Math.max(la, lb);
      if (lv <= CFG.EXT_FOCUS_LEVELS) extEdgeTgt[i] = Math.pow(DECAY, lv);
    }
  };

  const physicsExtStep = (): void => {
    const n = extCount;
    if (n < 2) return;
    for (let i = 0; i < extEdgeCount; i++) {
      const ao = extEdgeA[i] * 3, bo = extEdgeB[i] * 3;
      const dx = extPos[bo] - extPos[ao];
      const dy = extPos[bo + 1] - extPos[ao + 1];
      const dz = extPos[bo + 2] - extPos[ao + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
      const f = ((d - CFG.LINK_REST) * CFG.EXT_SPRING) / d;
      const fx = dx * f, fy = dy * f, fz = dz * f;
      extVel[ao] += fx; extVel[ao + 1] += fy; extVel[ao + 2] += fz;
      extVel[bo] -= fx; extVel[bo + 1] -= fy; extVel[bo + 2] -= fz;
    }

    const R = CFG.EXT_REP_RADIUS, R2 = R * R, cell = R, cap = CFG.EXT_REP_MAX;
    const gk = (ix: number, iy: number, iz: number): string => ix + ',' + iy + ',' + iz;
    extGrid.clear();
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const key = gk(Math.floor(extPos[o] / cell), Math.floor(extPos[o + 1] / cell), Math.floor(extPos[o + 2] / cell));
      const bucket = extGrid.get(key);
      if (bucket) bucket.push(i);
      else extGrid.set(key, [i]);
    }
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const ix = Math.floor(extPos[o] / cell), iy = Math.floor(extPos[o + 1] / cell), iz = Math.floor(extPos[o + 2] / cell);
      let used = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (used >= cap) break;
        const bucket = extGrid.get(gk(ix + dx, iy + dy, iz + dz));
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          if (used >= cap) break;
          const j = bucket[bi];
          if (j <= i) continue;
          const jo = j * 3;
          const ex = extPos[jo] - extPos[o], ey = extPos[jo + 1] - extPos[o + 1], ez = extPos[jo + 2] - extPos[o + 2];
          const dd = ex * ex + ey * ey + ez * ez;
          if (dd > R2 || dd < 1e-6) continue;
          const dist = Math.sqrt(dd);
          const f = (CFG.EXT_REPULSION * (1 - dist / R)) / dist;
          const fx = ex * f, fy = ey * f, fz = ez * f;
          extVel[o] -= fx; extVel[o + 1] -= fy; extVel[o + 2] -= fz;
          extVel[jo] += fx; extVel[jo + 1] += fy; extVel[jo + 2] += fz;
          used++;
        }
      }
    }

    const D = CFG.EXT_DAMPING, VMAX = CFG.EXT_MAX_SPEED, VMAX2 = VMAX * VMAX;
    const AXY = CFG.EXT_ANCHOR, AZ = CFG.EXT_ANCHOR_Z;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let vx = extVel[o] * D + (extAnchorX[i] - extPos[o]) * AXY;
      let vy = extVel[o + 1] * D + (extAnchorY[i] - extPos[o + 1]) * AXY;
      let vz = extVel[o + 2] * D + (extAnchorZ[i] - extPos[o + 2]) * AZ;
      const s2 = vx * vx + vy * vy + vz * vz;
      if (s2 > VMAX2) { const s = VMAX / Math.sqrt(s2); vx *= s; vy *= s; vz *= s; }
      extVel[o] = vx; extVel[o + 1] = vy; extVel[o + 2] = vz;
      extPos[o] += vx; extPos[o + 1] += vy; extPos[o + 2] += vz;
    }
    extPosAttr.needsUpdate = true;
  };

  const updateExtensionVisuals = (dt: number): void => {
    if (extCount === 0) return;
    extClock += dt;
    const k = 1 - Math.exp(-dt / 0.16);
    const sizeScale = Math.max(0.5, Math.min(1, Math.sqrt(320 / Math.max(60, nodeCount))));
    for (let i = 0; i < extCount; i++) {
      extCur[i] += (extTgt[i] - extCur[i]) * k;
      const tw = 0.05 * Math.sin(extClock * 1.3 + i * 2.399);
      const h = Math.max(0, Math.min(1.15, extCur[i] + tw));
      const t = 1 - (1 - LIGHT_DIM_T) * (1 - h);
      const o = i * 3;
      extCol[o] = extBaseR[i] * t + PAPER[0] * (1 - t);
      extCol[o + 1] = extBaseG[i] * t + PAPER[1] * (1 - t);
      extCol[o + 2] = extBaseB[i] * t + PAPER[2] * (1 - t);
      extSz[i] = extBaseSize[i] * sizeScale * (0.95 + 2.5 * h);
    }
    extColAttr.needsUpdate = true;
    extSzAttr.needsUpdate = true;

    let dn = 0, ln = 0;
    for (let i = 0; i < extEdgeCount; i++) {
      extEdgeCur[i] += (extEdgeTgt[i] - extEdgeCur[i]) * k;
      const h = extEdgeCur[i];
      const a = extEdgeA[i], b = extEdgeB[i];
      const ao = a * 3, bo = b * 3;
      const x1 = extPos[ao], y1 = extPos[ao + 1], z1 = extPos[ao + 2];
      const x2 = extPos[bo], y2 = extPos[bo + 1], z2 = extPos[bo + 2];
      if (h > 0.12) {
        const o = ln * 6;
        extLitLayer.pos[o] = x1; extLitLayer.pos[o + 1] = y1; extLitLayer.pos[o + 2] = z1;
        extLitLayer.pos[o + 3] = x2; extLitLayer.pos[o + 4] = y2; extLitLayer.pos[o + 5] = z2;
        const tr = EXT_EDGE_LIT_BASE + EXT_EDGE_LIT_SPAN * h, inv = 1 - tr;
        extLitLayer.col[o] = extBaseR[a] * tr + PAPER[0] * inv;
        extLitLayer.col[o + 1] = extBaseG[a] * tr + PAPER[1] * inv;
        extLitLayer.col[o + 2] = extBaseB[a] * tr + PAPER[2] * inv;
        extLitLayer.col[o + 3] = extBaseR[b] * tr + PAPER[0] * inv;
        extLitLayer.col[o + 4] = extBaseG[b] * tr + PAPER[1] * inv;
        extLitLayer.col[o + 5] = extBaseB[b] * tr + PAPER[2] * inv;
        ln++;
      } else {
        const o = dn * 6;
        extDimLayer.pos[o] = x1; extDimLayer.pos[o + 1] = y1; extDimLayer.pos[o + 2] = z1;
        extDimLayer.pos[o + 3] = x2; extDimLayer.pos[o + 4] = y2; extDimLayer.pos[o + 5] = z2;
        const g = EXT_EDGE_DIM_TINT, inv = 1 - g;
        extDimLayer.col[o] = extBaseR[a] * g + PAPER[0] * inv;
        extDimLayer.col[o + 1] = extBaseG[a] * g + PAPER[1] * inv;
        extDimLayer.col[o + 2] = extBaseB[a] * g + PAPER[2] * inv;
        extDimLayer.col[o + 3] = extBaseR[b] * g + PAPER[0] * inv;
        extDimLayer.col[o + 4] = extBaseG[b] * g + PAPER[1] * inv;
        extDimLayer.col[o + 5] = extBaseB[b] * g + PAPER[2] * inv;
        dn++;
      }
    }
    extDimLayer.geo.setDrawRange(0, dn * 2);
    extLitLayer.geo.setDrawRange(0, ln * 2);
    if (dn) { extDimLayer.posAttr.needsUpdate = true; extDimLayer.colAttr.needsUpdate = true; }
    if (ln) { extLitLayer.posAttr.needsUpdate = true; extLitLayer.colAttr.needsUpdate = true; }
  };

  function addNode(): void {
    if (resetPending) return;
    if (nodeCount >= MAXN) { triggerReset(); return; }
    const i = nodeCount++;
    spawnVolume.randomPoint(tmpP);
    nodePos[i * 3] = tmpP.x; nodePos[i * 3 + 1] = tmpP.y; nodePos[i * 3 + 2] = tmpP.z;
    anchorX[i] = tmpP.x; anchorY[i] = tmpP.y; anchorZ[i] = tmpP.z;

    const c = hexToLinear(PALETTE_NODE[i % PALETTE_NODE.length]);
    nodeBaseR[i] = c[0]; nodeBaseG[i] = c[1]; nodeBaseB[i] = c[2];
    nodeBaseSize[i] = (9.0 + Math.cbrt(0.6 + Math.random() * 2.0) * 9.0) * 1.0;
    nodeVel[i * 3] = 0; nodeVel[i * 3 + 1] = 0; nodeVel[i * 3 + 2] = 0;
    nodeTgt[i] = focusActive ? 0 : 1;
    nodeCur[i] = nodeTgt[i];
    adj.set(i, []);
    nodePosAttr.needsUpdate = true;
    nodeGeo.setDrawRange(0, nodeCount);
  }

  const NEAR_K = 6;
  const nearIdx = new Int32Array(NEAR_K);
  const nearD = new Float64Array(NEAR_K);

  function addEdge(): void {
    if (resetPending) return;
    if (nodeCount < 2 || edgeCount >= MAXE) return;

    const a = (Math.random() * nodeCount) | 0;
    const ao = a * 3;
    const ax = nodePos[ao], ay = nodePos[ao + 1], az = nodePos[ao + 2];

    let found = 0;
    for (let j = 0; j < nodeCount; j++) {
      if (j === a) continue;
      const jo = j * 3;
      const dx = nodePos[jo] - ax, dy = nodePos[jo + 1] - ay, dz = nodePos[jo + 2] - az;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (found < NEAR_K) {
        let k = found++;
        while (k > 0 && nearD[k - 1] > d2) { nearD[k] = nearD[k - 1]; nearIdx[k] = nearIdx[k - 1]; k--; }
        nearD[k] = d2; nearIdx[k] = j;
      } else if (d2 < nearD[NEAR_K - 1]) {
        let k = NEAR_K - 1;
        while (k > 0 && nearD[k - 1] > d2) { nearD[k] = nearD[k - 1]; nearIdx[k] = nearIdx[k - 1]; k--; }
        nearD[k] = d2; nearIdx[k] = j;
      }
    }
    if (!found) return;

    const start = (Math.random() * found) | 0;
    let b = -1;
    for (let t = 0; t < found; t++) {
      const cand = nearIdx[(start + t) % found];
      const lo = cand < a ? cand : a, hi = cand < a ? a : cand;
      if (!edgeSeen.has(lo * MAXN + hi)) { b = cand; break; }
    }
    if (b < 0) return;

    const lo = b < a ? b : a, hi = b < a ? a : b;
    edgeSeen.add(lo * MAXN + hi);

    const i = edgeCount++;
    edgeA[i] = lo; edgeB[i] = hi;
    adj.get(lo)?.push(hi); adj.get(hi)?.push(lo);
    edgeTgt[i] = 0; edgeCur[i] = 0;
  }

  function triggerReset(): void {
    resetPending = true;
    pauseAcc = 0;
  }

  function doReset(): void {
    nodeCount = 0; edgeCount = 0;
    focusActive = false;
    adj.clear(); edgeSeen.clear();
    nodeGeo.setDrawRange(0, 0);
    dimLayer.geo.setDrawRange(0, 0);
    litLayer.geo.setDrawRange(0, 0);
  }

  function pickRoots(n: number): number[] {
    const picked: number[] = [];
    const seen = new Set<number>();
    let guard = 0;
    while (picked.length < n && guard++ < n * 40) {
      const i = (Math.random() * nodeCount) | 0;
      if (!seen.has(i)) { seen.add(i); picked.push(i); }
    }
    return picked;
  }

  function applyFocus(): void {
    nodeTgt.fill(0, 0, nodeCount);
    edgeTgt.fill(0, 0, edgeCount);
    if (nodeCount === 0) { focusActive = false; return; }
    const roots = pickRoots(Math.min(CFG.FOCUS_ROOTS, nodeCount));

    const level = new Map<number, number>();
    let frontier: number[] = [];
    for (const r of roots) { level.set(r, 0); frontier.push(r); }
    for (let d = 1; d <= CFG.FOCUS_LEVELS; d++) {
      const next: number[] = [];
      for (const u of frontier) {
        const nb = adj.get(u);
        if (!nb) continue;
        for (const v of nb) if (!level.has(v)) { level.set(v, d); next.push(v); }
      }
      if (!next.length) break;
      frontier = next;
    }
    let lit = level;
    if (level.size > CFG.FOCUS_MAX_NODES) {
      const arr = Array.from(level.entries()).sort((p, q) => p[1] - q[1]);
      lit = new Map<number, number>();
      for (let i = 0; i < CFG.FOCUS_MAX_NODES; i++) lit.set(arr[i][0], arr[i][1]);
    }
    for (const [id, lv] of lit) nodeTgt[id] = Math.pow(DECAY, lv);

    for (let i = 0; i < edgeCount; i++) {
      const la = lit.has(edgeA[i]) ? (lit.get(edgeA[i]) as number) : Infinity;
      const lb = lit.has(edgeB[i]) ? (lit.get(edgeB[i]) as number) : Infinity;
      const lv = Math.max(la, lb);
      if (lv <= CFG.FOCUS_LEVELS) edgeTgt[i] = Math.pow(DECAY, lv);
    }
    focusActive = true;
  }

  function physicsStep(): void {
    const n = nodeCount;

    for (let i = 0; i < edgeCount; i++) {
      const ao = edgeA[i] * 3, bo = edgeB[i] * 3;
      const dx = nodePos[bo] - nodePos[ao];
      const dy = nodePos[bo + 1] - nodePos[ao + 1];
      const dz = nodePos[bo + 2] - nodePos[ao + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
      const f = ((d - CFG.LINK_REST) * CFG.SPRING) / d;
      const fx = dx * f, fy = dy * f, fz = dz * f;
      nodeVel[ao] += fx; nodeVel[ao + 1] += fy; nodeVel[ao + 2] += fz;
      nodeVel[bo] -= fx; nodeVel[bo + 1] -= fy; nodeVel[bo + 2] -= fz;
    }

    const R = CFG.REP_RADIUS, R2 = R * R, cell = R, cap = CFG.REP_MAX;
    const gk = (ix: number, iy: number, iz: number): string => ix + ',' + iy + ',' + iz;
    physGrid.clear();
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const key = gk(Math.floor(nodePos[o] / cell), Math.floor(nodePos[o + 1] / cell), Math.floor(nodePos[o + 2] / cell));
      const bucket = physGrid.get(key);
      if (bucket) bucket.push(i);
      else physGrid.set(key, [i]);
    }
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const ix = Math.floor(nodePos[o] / cell), iy = Math.floor(nodePos[o + 1] / cell), iz = Math.floor(nodePos[o + 2] / cell);
      let used = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (used >= cap) break;
        const bucket = physGrid.get(gk(ix + dx, iy + dy, iz + dz));
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          if (used >= cap) break;
          const j = bucket[bi];
          if (j <= i) continue;
          const jo = j * 3;
          const ex = nodePos[jo] - nodePos[o], ey = nodePos[jo + 1] - nodePos[o + 1], ez = nodePos[jo + 2] - nodePos[o + 2];
          const dd = ex * ex + ey * ey + ez * ez;
          if (dd > R2 || dd < 1e-6) continue;
          const dist = Math.sqrt(dd);
          const f = (CFG.REPULSION * (1 - dist / R)) / dist;
          const fx = ex * f, fy = ey * f, fz = ez * f;
          nodeVel[o] -= fx; nodeVel[o + 1] -= fy; nodeVel[o + 2] -= fz;
          nodeVel[jo] += fx; nodeVel[jo + 1] += fy; nodeVel[jo + 2] += fz;
          used++;
        }
      }
    }

    const D = CFG.DAMPING, VMAX = CFG.MAX_SPEED, VMAX2 = VMAX * VMAX;
    const A = CFG.ANCHOR;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let vx = nodeVel[o] * D + (anchorX[i] - nodePos[o]) * A;
      let vy = nodeVel[o + 1] * D + (anchorY[i] - nodePos[o + 1]) * A;
      let vz = nodeVel[o + 2] * D + (anchorZ[i] - nodePos[o + 2]) * A;
      const s2 = vx * vx + vy * vy + vz * vz;
      if (s2 > VMAX2) { const s = VMAX / Math.sqrt(s2); vx *= s; vy *= s; vz *= s; }
      const ox = nodePos[o], oy = nodePos[o + 1], oz = nodePos[o + 2];
      let x = ox + vx, y = oy + vy, z = oz + vz;
      if (!spawnVolume.contains(x, y, z)) {
        if (spawnVolume.contains(x, oy, oz)) { y = oy; z = oz; }
        else if (spawnVolume.contains(ox, y, oz)) { x = ox; z = oz; }
        else if (spawnVolume.contains(ox, oy, z)) { x = ox; y = oy; }
        else if (spawnVolume.contains(x, y, oz)) { z = oz; }
        else if (spawnVolume.contains(x, oy, z)) { y = oy; }
        else if (spawnVolume.contains(ox, y, z)) { x = ox; }
        else { x = ox; y = oy; z = oz; }
        vx *= 0.4; vy *= 0.4; vz *= 0.4;
      }
      nodeVel[o] = vx; nodeVel[o + 1] = vy; nodeVel[o + 2] = vz;
      nodePos[o] = x; nodePos[o + 1] = y; nodePos[o + 2] = z;
    }
    nodePosAttr.needsUpdate = true;
  }

  function animate(dt: number): void {
    const k = 1 - Math.exp(-dt / 0.16);
    const sizeScale = Math.max(0.5, Math.min(1, Math.sqrt(320 / Math.max(60, nodeCount))));

    for (let i = 0; i < nodeCount; i++) {
      nodeCur[i] += (nodeTgt[i] - nodeCur[i]) * k;
      const h = nodeCur[i];
      const t = 1 - (1 - LIGHT_DIM_T) * (1 - h);
      const o = i * 3;
      nodeCol[o] = nodeBaseR[i] * t + PAPER[0] * (1 - t);
      nodeCol[o + 1] = nodeBaseG[i] * t + PAPER[1] * (1 - t);
      nodeCol[o + 2] = nodeBaseB[i] * t + PAPER[2] * (1 - t);
      nodeSz[i] = nodeBaseSize[i] * sizeScale * (0.8 + 2.2 * h);
    }
    if (nodeCount) { nodeColAttr.needsUpdate = true; nodeSzAttr.needsUpdate = true; }

    let dn = 0, ln = 0;
    for (let i = 0; i < edgeCount; i++) {
      edgeCur[i] += (edgeTgt[i] - edgeCur[i]) * k;
      const h = edgeCur[i];
      const a = edgeA[i], b = edgeB[i];
      const ao = a * 3, bo = b * 3;
      const x1 = nodePos[ao], y1 = nodePos[ao + 1], z1 = nodePos[ao + 2];
      const x2 = nodePos[bo], y2 = nodePos[bo + 1], z2 = nodePos[bo + 2];
      if (h > 0.12) {
        if (ln >= LITMAX) continue;
        const o = ln * 6;
        litLayer.pos[o] = x1; litLayer.pos[o + 1] = y1; litLayer.pos[o + 2] = z1;
        litLayer.pos[o + 3] = x2; litLayer.pos[o + 4] = y2; litLayer.pos[o + 5] = z2;
        const tr = 0.75 + 0.25 * h, inv = 1 - tr;
        litLayer.col[o] = nodeBaseR[a] * tr + PAPER[0] * inv;
        litLayer.col[o + 1] = nodeBaseG[a] * tr + PAPER[1] * inv;
        litLayer.col[o + 2] = nodeBaseB[a] * tr + PAPER[2] * inv;
        litLayer.col[o + 3] = nodeBaseR[b] * tr + PAPER[0] * inv;
        litLayer.col[o + 4] = nodeBaseG[b] * tr + PAPER[1] * inv;
        litLayer.col[o + 5] = nodeBaseB[b] * tr + PAPER[2] * inv;
        ln++;
      } else {
        const o = dn * 6;
        dimLayer.pos[o] = x1; dimLayer.pos[o + 1] = y1; dimLayer.pos[o + 2] = z1;
        dimLayer.pos[o + 3] = x2; dimLayer.pos[o + 4] = y2; dimLayer.pos[o + 5] = z2;
        const g = LIGHT_TINT_EDGE, inv = 1 - g;
        dimLayer.col[o] = nodeBaseR[a] * g + PAPER[0] * inv;
        dimLayer.col[o + 1] = nodeBaseG[a] * g + PAPER[1] * inv;
        dimLayer.col[o + 2] = nodeBaseB[a] * g + PAPER[2] * inv;
        dimLayer.col[o + 3] = nodeBaseR[b] * g + PAPER[0] * inv;
        dimLayer.col[o + 4] = nodeBaseG[b] * g + PAPER[1] * inv;
        dimLayer.col[o + 5] = nodeBaseB[b] * g + PAPER[2] * inv;
        dn++;
      }
    }
    dimLayer.geo.setDrawRange(0, dn * 2);
    litLayer.geo.setDrawRange(0, ln * 2);
    if (dn) { dimLayer.posAttr.needsUpdate = true; dimLayer.colAttr.needsUpdate = true; }
    if (ln) { litLayer.posAttr.needsUpdate = true; litLayer.colAttr.needsUpdate = true; }
  }

  let frameHandle = 0;
  let previous = 0;
  let visible = true;
  let lost = false;
  let ready = false;
  let disposed = false;
  let paused = false;
  let reduced = false;
  let running = true;
  let addAcc = 0, edgeAcc = 0, focusAcc = CFG.FOCUS_INTERVAL_MS - 1200, extFocusAcc = CFG.EXT_FOCUS_INTERVAL_MS - 900;

  const anchorWorld = new THREE.Vector3();
  const projected = new THREE.Vector3();
  // Anchor once at ready and on resize only: re-dispatching per orbit frame would
  // rebuild the narrative's whole node/edge chain every animation frame.
  let anchorPending = true;
  let anchorOutX = NaN, anchorOutY = NaN;

  function updateAnchor(): void {
    if (!anchorPending || !anchorLocal || !refPoints) return;
    refPoints.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    anchorWorld.copy(anchorLocal).applyMatrix4(refPoints.matrixWorld);
    projected.copy(anchorWorld).project(camera);
    const rect = heroRect();
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const sx = (projected.x * 0.5 + 0.5) * width;
    const sy = (0.5 - projected.y * 0.5) * height;
    const x = ((sx - rect.left) / Math.max(1, rect.width)) * 1000;
    const y = ((sy - rect.top) / Math.max(1, rect.height)) * 1000;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    anchorPending = false;
    if (Math.abs(x - anchorOutX) > .02 || Math.abs(y - anchorOutY) > .02 || !Number.isFinite(anchorOutX)) {
      anchorOutX = x; anchorOutY = y;
      options.onAnchor(x, y);
    }
  }

  function request(): void {
    if (!frameHandle && !disposed && visible && !document.hidden && !lost) frameHandle = requestAnimationFrame(frame);
  }
  function stop(): void {
    cancelAnimationFrame(frameHandle); frameHandle = 0; previous = 0;
  }

  function frame(now: number): void {
    frameHandle = 0;
    if (disposed || !visible || document.hidden || lost) return;
    const dt = previous ? Math.min(0.5, Math.max(0, (now - previous) / 1000)) : 0;
    previous = now;

    if (running) {
      if (resetPending) {
        pauseAcc += dt * 1000;
        if (pauseAcc >= CFG.RESET_PAUSE_MS) {
          doReset(); resetPending = false;
          addAcc = 0; edgeAcc = 0; focusAcc = CFG.FOCUS_INTERVAL_MS - 1200;
        }
      } else {
        addAcc += dt * 1000; edgeAcc += dt * 1000; focusAcc += dt * 1000; extFocusAcc += dt * 1000;
        let guard = 0;
        while (addAcc >= CFG.ADD_INTERVAL_MS && guard++ < 60) { addAcc -= CFG.ADD_INTERVAL_MS; addNode(); }
        while (edgeAcc >= CFG.ADD_INTERVAL_MS && guard++ < 120) { edgeAcc -= CFG.ADD_INTERVAL_MS; addEdge(); }
        while (focusAcc >= CFG.FOCUS_INTERVAL_MS && guard++ < 200) { focusAcc -= CFG.FOCUS_INTERVAL_MS; applyFocus(); }
        while (extFocusAcc >= CFG.EXT_FOCUS_INTERVAL_MS && guard++ < 200) { extFocusAcc -= CFG.EXT_FOCUS_INTERVAL_MS; applyExtFocus(); }
      }

      animate(dt);
      updateExtensionVisuals(dt);
      growExtension();
      physAcc += dt;
      let sub = 0;
      while (physAcc >= CFG.PHYS_STEP && sub < CFG.MAX_SUBSTEPS) { physAcc -= CFG.PHYS_STEP; physicsStep(); physicsExtStep(); sub++; }
      if (sub >= CFG.MAX_SUBSTEPS) physAcc = 0;
      azimuth += ORBIT_STEP * dt;
    }
    placeCamera();

    if (refScaleUniform) refScaleUniform.value = uScale;
    nodeUniforms.uScale.value = uScale;
    renderer.render(scene, camera);

    if (!ready && renderer.info.render.calls > 0) { ready = true; options.onReadyChange(true); }
    if (ready) updateAnchor();

    if (running) request();
  }

  const resize = (): void => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const resolutionCap = mobile ? 480 : 1024;
    const scale = Math.min(1, resolutionCap / Math.max(width, height));
    renderer.setSize(Math.round(width * scale), Math.round(height * scale), false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    updateScale();
    fitCamera();
    placeCamera();
    anchorPending = true;
    request();
  };

  const visibility = (): void => { if (document.hidden) stop(); else request(); };
  const contextLost = (event: Event): void => { event.preventDefault(); lost = true; stop(); ready = false; options.onReadyChange(false); };
  const contextRestored = (): void => { lost = false; request(); };

  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) request(); else stop();
  }, { threshold: .02 });
  intersection.observe(host);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  document.addEventListener('visibilitychange', visibility);
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  renderer.domElement.addEventListener('webglcontextrestored', contextRestored);
  const scroll = (): void => { if (!running) request(); };
  window.addEventListener('scroll', scroll, { passive: true });

  const handle: MemoryPointCloudHandle = {
    wake(): void { previous = 0; request(); },
    setPaused(next: boolean): void {
      if (paused === next) return;
      paused = next; running = !paused && !reduced; previous = 0; request();
    },
    setReduced(next: boolean): void {
      if (reduced === next) return;
      reduced = next; running = !paused && !reduced; previous = 0; request();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop();
      intersection.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('scroll', scroll);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', contextRestored);
      nodeGeo.dispose(); nodeMat.dispose();
      extNodeGeo.dispose();
      dimLayer.geo.dispose(); litLayer.geo.dispose();
      extDimLayer.geo.dispose(); extLitLayer.geo.dispose();
      dimMaterial.dispose(); litMaterial.dispose();
      extDimMaterial.dispose(); extLitMaterial.dispose();
      if (refPoints) { refPoints.geometry.dispose(); (refPoints.material as ShaderMaterial).dispose(); }
      dot?.dispose();
      teardownRenderer();
    },
  };

  applyFocus();
  applyExtFocus();
  resize();
  return handle;
}



