import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildGraph } from './graphModel.js';
import { graphWindow, GRAPH_PAGE_SIZE } from './graphWindow.js';
import { t } from './i18n.js';

// Handwritten force layout for at most 300 visible nodes: O(n²) pair repulsion stays cheap at
// this scale, so no d3-force (it would ride along in the single-file build).
// Alpha decays linearly to zero; the rAF loop then stops until a drag or a
// data change reheats it. Velocity damping plus a per-tick step cap keep the
// end of the run free of visible jitter.
const REPULSE = 1300; // k² in F = k² / dist
const REST_LENGTH = 64; // spring rest length in px
const STIFFNESS = 0.055;
const CENTER_PULL = 0.055;
const DAMPING = 0.85; // velocity kept per tick
const ALPHA_STEP = 0.012;
const ALPHA_MIN = 0.01;
const MAX_STEP = 14; // px cap per tick, prevents jitter
const REHEAT_DRAG = 0.45;
const DRAG_THRESHOLD = 3; // px of movement that turns a node tap into a drag
const GOLDEN_ANGLE = 2.39996;

function spiralPosition(i) {
  // Deterministic in-browser seeding around the origin; the view transform
  // centers it. Golden-angle spirals keep initial overlap low without a seed.
  const r = 14 * Math.sqrt(i + 1);
  return { x: Math.cos(i * GOLDEN_ANGLE) * r, y: Math.sin(i * GOLDEN_ANGLE) * r };
}

/** One force tick: repulsion, springs, center pull, then damped integration. */
function step(sim, alpha) {
  const bodies = [...sim.bodies.values()];
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = i % 2 ? 0.5 : -0.5; dy = j % 2 ? 0.5 : -0.5; d2 = 0.5; }
      const d = Math.sqrt(d2);
      const f = (REPULSE / d2) * alpha;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
  }
  sim.links.forEach(({ source, target }) => {
    const a = sim.bodies.get(source);
    const b = sim.bodies.get(target);
    if (!a || !b) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - REST_LENGTH) * STIFFNESS * alpha;
    a.vx += (dx / d) * f;
    a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f;
    b.vy -= (dy / d) * f;
  });
  bodies.forEach((p) => {
    p.vx += (sim.cx - p.x) * CENTER_PULL * alpha;
    p.vy += (sim.cy - p.y) * CENTER_PULL * alpha;
  });
  bodies.forEach((p) => {
    if (p.fx != null) {
      p.x = p.fx;
      p.y = p.fy;
      p.vx = 0;
      p.vy = 0;
      return;
    }
    p.vx *= DAMPING;
    p.vy *= DAMPING;
    const disp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    const cap = Math.min(disp, MAX_STEP) / (disp || 1);
    p.x += p.vx * cap;
    p.y += p.vy * cap;
  });
}

function fitView(sim, size) {
  if (!size?.w || !sim?.bodies.size) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of sim.bodies.values()) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const k = Math.min(2, Math.max(0.25, Math.min(
    (size.w - 60) / Math.max(maxX - minX, 1),
    (size.h - 60) / Math.max(maxY - minY, 1),
  )));
  return { k, tx: size.w / 2 - (minX + maxX) / 2 * k, ty: size.h / 2 - (minY + maxY) / 2 * k };
}

/** Force-directed graph of the parent_id network, rendered as SVG. */
export default function GraphView({ items, onOpen }) {
  const fullGraph = useMemo(() => buildGraph(items), [items]);
  const [page, setPage] = useState(0);
  const graph = useMemo(() => graphWindow(fullGraph, page), [fullGraph, page]);
  const [selectedId, setSelectedId] = useState(null);
  const [relationPage, setRelationPage] = useState(0);
  const nodeById = useMemo(() => new Map(fullGraph.nodes.map(n => [n.id, n])), [fullGraph]);
  useEffect(() => { setRelationPage(0); }, [selectedId]);
  useEffect(() => { setPage(graph.page); }, [graph.page]);
  // Content signature: the 4s sync poll replaces the items array (and thus
  // the graph model) even when nothing changed, and only node/link content
  // may reheat the layout — not a fresh identity.
  const signature = useMemo(
    () => JSON.stringify([graph.nodes.map((n) => n.id), graph.links]),
    [graph],
 );
  // Adjacency for hover highlighting; each set contains the node itself so
  // the hovered node never dims.
  const adjacency = useMemo(() => {
    const adj = new Map();
    graph.nodes.forEach((n) => adj.set(n.id, new Set([n.id])));
    graph.links.forEach(({ source, target }) => {
      adj.get(source)?.add(target);
      adj.get(target)?.add(source);
    });
    return adj;
  }, [graph]);

  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const simRef = useRef(null); // { bodies: Map<id, {x,y,vx,vy,fx,fy}>, links, cx, cy }
  const alphaRef = useRef(0);
  const rafRef = useRef(0);
  const wakeRef = useRef(null);
  const dragRef = useRef(null);
  const sizeRef = useRef(null);
  const userMovedRef = useRef(false); // viewport owned by the user: no auto-fit
  const [, setFrame] = useState(0);
  const [view, setView] = useState({ tx: null, ty: null, k: 1 });
  const [hoverId, setHoverId] = useState(null);
  const [size, setSize] = useState(null);
  sizeRef.current = size;

  const center = () => ({ x: (size?.w || 800) / 2, y: (size?.h || 480) / 2 });

  // The rAF loop is installed before the graph effect below so its first
  // wake() on mount finds the hook in place.
  useEffect(() => {
    const tick = () => {
      rafRef.current = 0;
      const sim = simRef.current;
      if (!sim) return;
      step(sim, alphaRef.current);
      alphaRef.current = Math.max(0, alphaRef.current - ALPHA_STEP);
      setFrame((f) => f + 1);
      if (alphaRef.current > ALPHA_MIN) {
        rafRef.current = requestAnimationFrame(tick);
      } else if (!userMovedRef.current && sim.bodies.size) {
        // Settled: fit the whole graph once, until a pan or zoom takes over.
        const fitted = fitView(sim, sizeRef.current);
        if (fitted) setView(fitted);
      }
    };
    wakeRef.current = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
    };
    // Resume a hot simulation after StrictMode's double mount or any
    // remount: the rAF scheduled before cleanup was cancelled with it.
    if (simRef.current && alphaRef.current > ALPHA_MIN) wakeRef.current();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      wakeRef.current = null;
    };
  }, []);

  // (Re)build simulation bodies when the graph content or viewport changes,
  // keeping positions and pins of known nodes; reheat and resume the layout.
  // Content-identical rebuilds keep the settled simulation untouched.
  useEffect(() => {
    const prevSim = simRef.current;
    if (prevSim && prevSim.sig === signature) {
      return;
    }
    dragRef.current = null;
    const prev = prevSim?.bodies || new Map();
    const bodies = new Map();
    graph.nodes.forEach((n, i) => {
      const old = prev.get(n.id);
      if (old) { bodies.set(n.id, old); return; }
      const p = spiralPosition(i);
      bodies.set(n.id, { id: n.id, x: p.x, y: p.y, vx: 0, vy: 0, fx: null, fy: null });
    });
    simRef.current = { bodies, links: graph.links, cx: 0, cy: 0, sig: signature };
    alphaRef.current = 1;
    wakeRef.current?.();
  }, [graph, signature, size]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((prev) => (prev && prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [graph.nodes.length > 0]);

  useEffect(() => {
    if (!userMovedRef.current && alphaRef.current <= ALPHA_MIN) {
      const fitted = fitView(simRef.current, size);
      if (fitted) setView(fitted);
    }
  }, [size]);

  // React attaches wheel listeners passively; zoom needs preventDefault, so
  // bind natively. Zoom keeps the point under the cursor fixed.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      userMovedRef.current = true;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const tx0 = v.tx == null ? rect.width / 2 : v.tx;
        const ty0 = v.ty == null ? rect.height / 2 : v.ty;
        const k = Math.min(4, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.0016)));
        return { k, tx: px - (px - tx0) * (k / v.k), ty: py - (py - ty0) * (k / v.k) };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [graph.nodes.length > 0]);

  const toGraph = (clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect();
    const c = center();
    const tx = view.tx == null ? c.x : view.tx;
    const ty = view.ty == null ? c.y : view.ty;
    return { x: (clientX - rect.left - tx) / view.k, y: (clientY - rect.top - ty) / view.k };
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || dragRef.current || e.isPrimary === false) return;
    const id = e.target.getAttribute?.('data-node');
    svgRef.current.setPointerCapture(e.pointerId);
    if (id) dragRef.current = { type: 'node', pointerId: e.pointerId, id, sx: e.clientX, sy: e.clientY, moved: false };
    else {
      const c = center();
      dragRef.current = { type: 'pan', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, tx0: view.tx == null ? c.x : view.tx, ty0: view.ty == null ? c.y : view.ty };
    }
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.type === 'node') {
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > DRAG_THRESHOLD) d.moved = true;
      if (!d.moved) return;
      userMovedRef.current = true;
      const p = toGraph(e.clientX, e.clientY);
      const b = simRef.current?.bodies.get(d.id);
      if (!b) return;
      b.fx = p.x;
      b.fy = p.y;
      alphaRef.current = Math.max(alphaRef.current, REHEAT_DRAG);
      wakeRef.current?.();
    } else {
      userMovedRef.current = true;
      setView((v) => ({ k: v.k, tx: d.tx0 + (e.clientX - d.sx), ty: d.ty0 + (e.clientY - d.sy) }));
    }
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (d?.type === 'node') {
      if (!d.moved) onOpen(d.id);
      // fx/fy stay: a dragged node keeps its place, Obsidian-style.
    }
  };

  const cancelGesture = (e) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };
  const changePage = (next) => {
    dragRef.current = null;
    userMovedRef.current = false;
    setView({ tx: null, ty: null, k: 1 });
    setHoverId(null);
    setSelectedId(null);
    setPage(next);
  };

  if (!graph.nodes.length) {
    return (
      <div className="memory-graph is-empty" ref={boxRef}>
        <p className="graph-empty">{t('graphEmptyImportant')}</p>
      </div>
    );
  }

  const relationCount = graph.external.get(selectedId)?.length || 0;
  const currentRelationPage = Math.min(relationPage, Math.max(0, Math.ceil(relationCount / 50) - 1));
  const near = hoverId ? adjacency.get(hoverId) : null;
  const dimmedNode = (id) => (near && !near.has(id) ? ' dimmed' : '');
  const hovered = hoverId ? graph.nodes.find((n) => n.id === hoverId) : null;
  const c = center();
  const tx = view.tx == null ? c.x : view.tx;
  const ty = view.ty == null ? c.y : view.ty;

  return (
    <section className="graph-section">
      <div className="graph-controls">
        <p role="status">{t('graphWindow', { first: graph.page * GRAPH_PAGE_SIZE + 1, last: graph.page * GRAPH_PAGE_SIZE + graph.nodes.length, total: graph.total })}</p>
        {graph.pages > 1 && <nav aria-label={t('pager')}>
          <button disabled={graph.page === 0} onClick={() => changePage(graph.page - 1)}>{t('graphPrevious')}</button>
          <span>{t('pageOf', { n: graph.page + 1, total: graph.pages })}</span>
          <button disabled={graph.page + 1 === graph.pages} onClick={() => changePage(graph.page + 1)}>{t('graphNext')}</button>
        </nav>}
      </div>
      {graph.pages > 1 && <p className="graph-window-hint">{t('graphWindowHint')}</p>}
      <div className="memory-graph" ref={boxRef}>
      <svg aria-label={t('memoryGraph')}
        role="group"
        ref={svgRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={cancelGesture}
        onPointerLeave={() => setHoverId(null)}
      >
        <g transform={`translate(${tx},${ty}) scale(${view.k})`}>
          {graph.links.map(({ source, target }) => {
            const a = simRef.current?.bodies.get(source);
            const b = simRef.current?.bodies.get(target);
            if (!a || !b) return null;
            const dim = near && !near.has(source) && !near.has(target) ? ' dimmed' : '';
            return <line key={`${source}->${target}`} className={`graph-link${dim}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
          {graph.nodes.map((n) => {
            const p = simRef.current?.bodies.get(n.id);
            if (!p) return null;
            const r = Math.min(28, 5 + Math.sqrt(graph.subtreeSizes.get(n.id) || 1) * 2);
            return (
              <circle
                key={n.id}
                data-node={n.id}
                data-kind={n.kind}
                data-external={graph.external.has(n.id) ? 'true' : undefined}
                tabIndex={0}
                role="button"
                aria-label={n.title + (graph.external.has(n.id) ? ` (${t('graphOutside', { n: graph.external.get(n.id).length })})` : '')}
                onFocus={() => { setHoverId(n.id); setSelectedId(n.id); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(n.id); } }}
                className={`graph-node${dimmedNode(n.id)}`}
                cx={p.x}
                cy={p.y}
                r={r}
                fill="var(--card-accent)"
                onPointerEnter={() => { setHoverId(n.id); setSelectedId(n.id); }}
                onPointerLeave={() => setHoverId((cur) => (cur === n.id ? null : cur))}
              />
            );
          })}
          {hovered ? (() => {
            const p = simRef.current?.bodies.get(hovered.id);
            const r = Math.min(28, 5 + Math.sqrt(graph.subtreeSizes.get(hovered.id) || 1) * 2);
            if (!p) return null;
            return (
              <text className="graph-label" x={p.x} y={p.y - r - 7} textAnchor="middle">
                {hovered.title}
              </text>
            );
          })() : null}
        </g>
      </svg>
      </div>
      {graph.external.size > 0 && <label className="graph-relations-picker">{t('graphRelations')}
        <select aria-label={t('graphRelations')} value={graph.external.has(selectedId) ? selectedId : ''} onChange={e => { setSelectedId(e.target.value); setRelationPage(0); }}>
          <option value="">{t('graphChooseNode')}</option>
          {graph.nodes.filter(n => graph.external.has(n.id)).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}
        </select>
      </label>}
      {selectedId && graph.external.has(selectedId) && <details className="graph-external" key={selectedId}>
        <summary>{t('graphOutside', { n: graph.external.get(selectedId).length })}</summary>
        <ul>{graph.external.get(selectedId).slice(currentRelationPage * 50, (currentRelationPage + 1) * 50).map(({ id, direction }) => <li key={`${direction}:${id}`}>
          {t(direction === 'parent' ? 'graphParent' : 'graphChild')}: <button onClick={() => onOpen(id)}>{nodeById.get(id)?.title || id}</button>
        </li>)}</ul>
        {graph.external.get(selectedId).length > 50 && <nav aria-label={t('pager')}>
          <button disabled={currentRelationPage === 0} onClick={() => setRelationPage(currentRelationPage - 1)}>{t('graphPrevious')}</button>
          <span>{t('pageOf', { n: currentRelationPage + 1, total: Math.ceil(graph.external.get(selectedId).length / 50) })}</span>
          <button disabled={(currentRelationPage + 1) * 50 >= graph.external.get(selectedId).length} onClick={() => setRelationPage(currentRelationPage + 1)}>{t('graphNext')}</button>
        </nav>}
      </details>}
    </section>
  );
}
