/*
 * Independent foreground layer: two small "fish" built from the same visual
 * language as the container graph (small coloured dots + thin light edges) that
 * swim around the current viewport and wiggle their tails.
 *
 * This module has no top-level imports and its own Canvas 2D context + rAF loop.
 * It is deliberately separate from memory-point-cloud.ts: it never touches the
 * container camera, scroll growth or WebGL scene. It is lazily imported by
 * MemoryFishLayer.tsx so the main bundle stays lean.
 *
 * Swim technique: a travelling sine wave runs down the spine. Each spine
 * segment gets an angular offset whose amplitude is concentrated toward the
 * tail (`env(s)` stays near zero until ~15% back, then rises steeply) and whose
 * phase lags along the body (`phase - K*s`). The spine is rebuilt node-by-node
 * by accumulating those segment angles, so the body forms a smooth S-curve.
 * The body outline, dorsal/pectoral fins and the caudal fan ride the local
 * spine frame; the caudal fan also gets an extra swing so it sweeps widest.
 */

export interface MemoryFishHandle {
  setReduced(reduced: boolean): void;
  setPaused(paused: boolean): void;
  dispose(): void;
}

export interface MemoryFishOptions {
  reduced?: boolean;
}

interface Vec {
  x: number;
  y: number;
}

interface NodeDesc {
  /** Spine node this node is attached to. */
  attach: number;
  /** Offset along the spine tangent at the attachment (px). */
  t: number;
  /** Offset along the spine normal at the attachment (px). */
  n: number;
  /** Palette / edge colour index. */
  color: number;
  size: number;
  /** 1 for caudal-fin nodes, so they add the extra tail swing (default 0). */
  swing?: number;
}

interface FishSpec {
  length: number;
  height: number;
  speed: number;
  turnRate: number;
  palette: readonly string[];
  edge: string;
  /** Preferred horizontal band centre, 0..1 of the usable width. */
  side: number;
  sidePhase: number;
  /** Vertical band start and signed travel across the full scroll range. */
  vStart: number;
  vSpan: number;
  waveRate: number;
  waveK: number;
  waveAmp: number;
  /** Extra rotation (radians) applied to the caudal fan about the tail node. */
  tailSweep: number;
  gaitFreq: number;
  wanderFreq: number;
  wobble: number;
  turnSign: number;
  alpha: number;
  edgeAlpha: number;
}

interface Fish {
  spec: FishSpec;
  nodes: NodeDesc[];
  edges: readonly (readonly [number, number])[];
  pos: Vec;
  heading: number;
  target: Vec;
  wanderX: number;
  wanderY: number;
  wanderTimer: number;
  wobbleSeed: number;
  gaitPhase: number;
  wavePhase: number;
  amp: number;
  tailSwing: number;
  scale: number;
}

const TAU = Math.PI * 2;
const SPINE_SEGMENTS = 12;
const VIEWPORT_MARGIN = 64;
/** Hard cap of 10° per step on heading change, so a fish never turns sharply. */
const TURN_LIMIT = Math.PI / 18;
/** Max node distance from the fish origin, as a multiple of its length. */
const FISH_RADIUS = 1.38;
/** Reference viewport edge used to scale the fish down on small screens. */
const REFERENCE_EDGE = 1000;

const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value);

function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

const sAt = (index: number): number => index / (SPINE_SEGMENTS - 1);

/** Body half-height envelope (0..1): near-zero at the snout, widest ~35% back,
 * then a smooth taper to a thin caudal peduncle. Beta-like, normalised. */
const BODY_NORM = Math.pow(0.35, 1.4) * Math.pow(0.65, 2.6);
function bodyHalf(s: number): number {
  const k = clamp(s, 0, 1);
  return (Math.pow(k, 1.4) * Math.pow(1 - k, 2.6)) / BODY_NORM;
}

const SPEC_A: FishSpec = {
  length: 150,
  height: 30,
  speed: 64,
  turnRate: 1.15,
  palette: ['#0a84ff', '#3a5ccc', '#2440d0'],
  edge: '#3a5ccc',
  side: 0.24,
  sidePhase: 0.13,
  vStart: 0.24,
  vSpan: 0.52,
  waveRate: 5.2,
  waveK: 3.4,
  waveAmp: 0.3,
  tailSweep: 0.55,
  gaitFreq: 2.6,
  wanderFreq: 0.6,
  wobble: 0.32,
  turnSign: 1,
  alpha: 0.72,
  edgeAlpha: 0.16,
};

const SPEC_B: FishSpec = {
  length: 118,
  height: 25,
  speed: 52,
  turnRate: 1.3,
  palette: ['#067a52', '#a97600', '#7a3be0'],
  edge: '#067a52',
  side: 0.78,
  sidePhase: 0.11,
  vStart: 0.76,
  vSpan: -0.52,
  waveRate: 6.1,
  waveK: 3.8,
  waveAmp: 0.33,
  tailSweep: 0.62,
  gaitFreq: 3.0,
  wanderFreq: 0.7,
  wobble: 0.36,
  turnSign: -1,
  alpha: 0.84,
  edgeAlpha: 0.2,
};

/** Static topology: which nodes exist and how they connect. Built once.
 *
 * Layout (head at +x): a central spine node every 1/11 of the body; an upper
 * and lower outline rail at the same stations (sampled from `bodyHalf`, so the
 * rails form an elongated-ellipse silhouette that closes at a near-point nose);
 * a dorsal sail, a pectoral fin; and a forked caudal fan at the tail.
 */
function buildFish(spec: FishSpec): { nodes: NodeDesc[]; edges: Array<[number, number]> } {
  const nodes: NodeDesc[] = [];
  const edges: Array<[number, number]> = [];
  const H = spec.height;
  const seg = spec.length / (SPINE_SEGMENTS - 1);
  const last = SPINE_SEGMENTS - 1;

  const spine: number[] = [];
  for (let i = 0; i < SPINE_SEGMENTS; i++) {
    spine.push(nodes.length);
    nodes.push({ attach: i, t: 0, n: 0, color: i % 2, size: 2.05 });
  }
  for (let i = 0; i < last; i++) edges.push([spine[i], spine[i + 1]]);

  // Body outline rails, station 1..last-1 (station 0 is the nose at spine[0]).
  const up: number[] = [];
  const down: number[] = [];
  for (let i = 1; i <= last - 1; i++) {
    const h = bodyHalf(sAt(i)) * H;
    up[i] = nodes.length;
    nodes.push({ attach: i, t: 0, n: h, color: 0, size: 1.8 });
    down[i] = nodes.length;
    nodes.push({ attach: i, t: 0, n: -h, color: 1, size: 1.8 });
  }
  for (let i = 1; i <= last - 2; i++) {
    edges.push([up[i], up[i + 1]], [down[i], down[i + 1]]);
  }
  edges.push([spine[0], up[1]], [spine[0], down[1]]);
  for (const i of [2, 5, 8]) {
    edges.push([spine[i], up[i]], [spine[i], down[i]]);
  }

  // Mirrored fin pairs (top-down view): pectorals at the front, pelvics mid-body.
  // Both sides are exact mirrors so the silhouette stays left/right symmetric.
  const finPairs: Array<{ station: number; reach: number; back: number; size: number }> = [
    { station: 2, reach: 0.5, back: 0.3, size: 1.7 },
    { station: 5, reach: 0.34, back: 0.26, size: 1.55 },
  ];
  for (const fin of finPairs) {
    for (const sign of [1, -1]) {
      const base = sign > 0 ? up[fin.station] : down[fin.station];
      const color = sign > 0 ? 0 : 1;
      const outer = nodes.length;
      nodes.push({ attach: fin.station, t: -seg * fin.back, n: sign * (bodyHalf(sAt(fin.station)) * H + H * fin.reach), color, size: fin.size });
      const inner = nodes.length;
      nodes.push({ attach: fin.station, t: seg * fin.back, n: sign * (bodyHalf(sAt(fin.station)) * H + H * fin.reach * 0.78), color, size: fin.size });
      edges.push([base, outer], [base, inner], [outer, inner]);
    }
  }

  // Forked caudal fan, wider than the thin stalk, sweeping with the wave.
  const finLen = spec.length * 0.3;
  const finHalf = spec.height;
  const caudal: NodeDesc[] = [
    { attach: last, t: finLen * 0.18, n: finHalf * 0.38, color: 0, size: 1.85, swing: 1 },
    { attach: last, t: finLen * 0.18, n: -finHalf * 0.38, color: 1, size: 1.85, swing: 1 },
    { attach: last, t: finLen, n: finHalf, color: 0, size: 2.1, swing: 1 },
    { attach: last, t: finLen, n: -finHalf, color: 1, size: 2.1, swing: 1 },
    { attach: last, t: finLen * 0.58, n: 0, color: 1, size: 1.95, swing: 1 },
  ];
  const caudalIds = caudal.map((node) => {
    const id = nodes.length;
    nodes.push(node);
    return id;
  });
  edges.push(
    [spine[last], caudalIds[0]], [spine[last], caudalIds[1]],
    [caudalIds[0], caudalIds[2]], [caudalIds[1], caudalIds[3]],
    [caudalIds[0], caudalIds[4]], [caudalIds[1], caudalIds[4]],
    [caudalIds[2], caudalIds[4]], [caudalIds[3], caudalIds[4]],
  );

  return { nodes, edges };
}

/** Accumulate the waved spine in fish-local space: head at (0,0), body toward -x. */
function buildSpine(spec: FishSpec, phase: number, amp: number): Vec[] {
  const seg = spec.length / (SPINE_SEGMENTS - 1);
  const points: Vec[] = [{ x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  for (let i = 0; i < SPINE_SEGMENTS - 1; i++) {
    const s = sAt(i);
    const env = Math.pow(clamp((s - 0.15) / 0.85, 0, 1), 2.4);
    const theta = spec.waveAmp * amp * env * Math.sin(phase - spec.waveK * s);
    const angle = Math.PI + theta;
    x += seg * Math.cos(angle);
    y += seg * Math.sin(angle);
    points.push({ x, y });
  }
  return points;
}

/** Local tangent/normal frame at each spine node. */
function framesOf(spine: Vec[]): Array<{ t: Vec; n: Vec }> {
  const out: Array<{ t: Vec; n: Vec }> = [];
  for (let i = 0; i < SPINE_SEGMENTS; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(SPINE_SEGMENTS - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    out.push({ t: { x: tx, y: ty }, n: { x: -ty, y: tx } });
  }
  return out;
}

function makeFish(spec: FishSpec, options: { x: number; y: number; heading: number }): Fish {
  const { nodes, edges } = buildFish(spec);
  return {
    spec,
    nodes,
    edges,
    pos: { x: options.x, y: options.y },
    heading: options.heading,
    target: { x: options.x, y: options.y },
    wanderX: 0,
    wanderY: 0,
    wanderTimer: 0,
    wobbleSeed: Math.random() * TAU,
    gaitPhase: Math.random() * TAU,
    wavePhase: Math.random() * TAU,
    amp: 1,
    tailSwing: 0,
    scale: 1,
  };
}

export function startMemoryFish(host: HTMLElement, options: MemoryFishOptions = {}): MemoryFishHandle {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  const context = canvas.getContext('2d');
  if (!context) {
    return { setReduced() {}, setPaused() {}, dispose() {} };
  }
  host.appendChild(canvas);

  let view = { w: 0, h: 0, dpr: 1 };
  const fish: Fish[] = [];
  let reduced = options.reduced ?? false;
  let paused = false;
  let disposed = false;
  let raf = 0;
  let last = 0;
  let time = 0;

  const scrollProgress = (): number => {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    return max > 0 ? clamp(window.scrollY / max, 0, 1) : 0;
  };

  const currentScale = (): number => clamp(Math.min(view.w, view.h) / REFERENCE_EDGE, 0.45, 1);

  const resize = (): void => {
    const w = Math.max(1, host.clientWidth || window.innerWidth);
    const h = Math.max(1, host.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    view = { w, h, dpr };
    const scale = currentScale();
    for (const f of fish) {
      f.scale = scale;
      const pad = VIEWPORT_MARGIN + f.spec.length * FISH_RADIUS * scale;
      f.pos.x = clamp(f.pos.x, pad, Math.max(pad, w - pad));
      f.pos.y = clamp(f.pos.y, pad, Math.max(pad, h - pad));
    }
  };

  const seed = (): void => {
    fish.length = 0;
    fish.push(makeFish(SPEC_A, { x: view.w * 0.34, y: view.h * 0.36, heading: 0.5 }));
    fish.push(makeFish(SPEC_B, { x: view.w * 0.66, y: view.h * 0.64, heading: -2.4 }));
    const scale = currentScale();
    for (const f of fish) f.scale = scale;
  };

  const stepFish = (f: Fish, dt: number, progress: number): void => {
    const spec = f.spec;
    const pad = VIEWPORT_MARGIN + spec.length * FISH_RADIUS * f.scale;
    const loX = pad;
    const hiX = Math.max(pad + 1, view.w - pad);
    const loY = pad;
    const hiY = Math.max(pad + 1, view.h - pad);
    const usableW = hiX - loX;
    const usableH = hiY - loY;

    const bandX = loX + usableW * clamp(spec.side + 0.1 * Math.sin(time * spec.sidePhase), 0, 1);
    const bandY = loY + usableH * clamp(spec.vStart + spec.vSpan * progress, 0.04, 0.96);

    f.wanderTimer -= dt;
    if (f.wanderTimer <= 0) {
      f.wanderTimer = 3.5 + Math.random() * 4;
      f.wanderX = (Math.random() * 2 - 1) * usableW * 0.24;
      f.wanderY = (Math.random() * 2 - 1) * usableH * 0.22;
    }
    f.target.x = clamp(bandX + f.wanderX, loX, hiX);
    f.target.y = clamp(bandY + f.wanderY, loY, hiY);

    let dirX = f.target.x - f.pos.x;
    let dirY = f.target.y - f.pos.y;
    const dist = Math.hypot(dirX, dirY);
    let desired = Math.atan2(dirY, dirX);
    if (dist < 34) desired += f.spec.turnSign * Math.PI * 0.5;
    desired += spec.wobble * Math.sin(time * spec.wanderFreq + f.wobbleSeed);

    const maxTurn = Math.min(spec.turnRate * dt, TURN_LIMIT);
    const speed = spec.speed * f.scale;
    f.heading += clamp(angleDelta(f.heading, desired), -maxTurn, maxTurn);
    f.pos.x += Math.cos(f.heading) * speed * dt;
    f.pos.y += Math.sin(f.heading) * speed * dt;

    // Exiting the viewport re-enters from the opposite side; never turn back at an edge.
    const radius = spec.length * FISH_RADIUS * f.scale;
    if (f.pos.x - radius > view.w) f.pos.x = -radius;
    else if (f.pos.x + radius < 0) f.pos.x = view.w + radius;
    if (f.pos.y - radius > view.h) f.pos.y = -radius;
    else if (f.pos.y + radius < 0) f.pos.y = view.h + radius;

    // Burst/coast gait: the tail beats in gusts, then relaxes into a glide.
    f.gaitPhase += dt * spec.gaitFreq;
    const beat = Math.pow(0.5 + 0.5 * Math.sin(f.gaitPhase), 1.6);
    f.wavePhase += dt * spec.waveRate * (0.65 + 0.9 * beat);
    f.amp = 0.55 + 0.65 * beat;
    f.tailSwing = spec.tailSweep * f.amp * Math.sin(f.wavePhase - spec.waveK);
  };

  const transform = (f: Fish, p: Vec): Vec => {
    const cos = Math.cos(f.heading);
    const sin = Math.sin(f.heading);
    return {
      x: f.pos.x + (p.x * cos - p.y * sin) * f.scale,
      y: f.pos.y + (p.x * sin + p.y * cos) * f.scale,
    };
  };

  const drawFish = (f: Fish): void => {
    const spine = buildSpine(f.spec, f.wavePhase, f.amp);
    const frames = framesOf(spine);
    const screen: Vec[] = f.nodes.map((node) => {
      const s = spine[node.attach];
      const fr = frames[node.attach];
      let offT = node.t;
      let offN = node.n;
      if (node.swing) {
        const a = f.tailSwing * node.swing;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        offT = node.t * ca - node.n * sa;
        offN = node.t * sa + node.n * ca;
      }
      return transform(f, {
        x: s.x + fr.t.x * offT + fr.n.x * offN,
        y: s.y + fr.t.y * offT + fr.n.y * offN,
      });
    });

    context.globalAlpha = f.spec.edgeAlpha;
    context.strokeStyle = f.spec.edge;
    context.lineWidth = 0.9 * f.scale;
    context.beginPath();
    for (const [a, b] of f.edges) {
      context.moveTo(screen[a].x, screen[a].y);
      context.lineTo(screen[b].x, screen[b].y);
    }
    context.stroke();

    context.globalAlpha = f.spec.alpha;
    for (let i = 0; i < f.nodes.length; i++) {
      const node = f.nodes[i];
      context.fillStyle = f.spec.palette[node.color % f.spec.palette.length];
      context.beginPath();
      context.arc(screen[i].x, screen[i].y, node.size * f.scale, 0, TAU);
      context.fill();
    }
    context.globalAlpha = 1;
  };

  const render = (): void => {
    context.clearRect(0, 0, view.w, view.h);
    for (const f of fish) drawFish(f);
  };

  const loop = (now: number): void => {
    raf = 0;
    if (disposed || paused) return;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    if (!reduced) {
      time += dt;
      const progress = scrollProgress();
      for (const f of fish) stepFish(f, dt, progress);
    }
    render();
    if (!reduced) raf = requestAnimationFrame(loop);
  };

  const wake = (): void => {
    if (disposed || paused || raf) return;
    last = 0;
    raf = requestAnimationFrame(loop);
  };

  const onResize = (): void => {
    resize();
    if (reduced) render();
  };

  resize();
  seed();
  render();
  window.addEventListener('resize', onResize);
  wake();

  return {
    setReduced(next: boolean): void {
      if (disposed || next === reduced) return;
      reduced = next;
      if (reduced) {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        render();
      } else {
        last = 0;
        wake();
      }
    },
    setPaused(next: boolean): void {
      if (disposed || next === paused) return;
      paused = next;
      if (paused) {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
      } else {
        last = 0;
        wake();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      window.removeEventListener('resize', onResize);
      canvas.remove();
    },
  };
}
