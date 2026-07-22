import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { GraphNode, GraphEdge } from '../lib/types';
import { spatialHashPairs, type HashedPoint } from '../lib/spatialHash';

export interface NotePreview {
  title: string;
  folder: string;
  summary: string;
  excerpt: string;
  links: number;
  backlinks: number;
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId?: string | null;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onNew: () => void;
  onLink: (sourceId: string, targetId: string) => void;
  fetchPreview: (id: string) => Promise<NotePreview | null>;
}

interface Pt {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

// Logical layout space; the SVG scales this to fit the panel via viewBox.
const W = 1200;
const H = 760;
const CX = W / 2;
const CY = H / 2;
const PAD = 40;

// Folder → colour (Obsidian-style coloured clusters). Root notes are muted.
const FOLDER_COLORS = ['#d97757', '#6ea8fe', '#63e6be', '#ffa94d', '#b197fc', '#f783ac', '#ffd43b', '#74c0fc'];
function folderColor(folder: string): string {
  if (!folder) return '#9a9488';
  let h = 0;
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) >>> 0;
  return FOLDER_COLORS[h % FOLDER_COLORS.length];
}

// Grid cell size for the repulsion spatial hash. Derived from the existing
// `rep = 3200 / d2` force formula: force drops to ~0.5 (negligible next to
// the ~1-5 unit centering/damping forces applied per tick) at d = sqrt(3200
// / 0.5) ≈ 80; cell size is 1.5x that distance so each node's 3x3
// neighborhood comfortably covers every pair still worth computing.
const REPULSION_CELL_SIZE = 120;

export default function BrainGraph({ nodes, edges, selectedId, onOpen, onEdit, onNew, onLink, fetchPreview }: Props) {
  const posRef = useRef<Map<string, Pt>>(new Map());
  const alphaRef = useRef(1);
  const rafRef = useRef(0);
  const runningRef = useRef(false);
  const stepRef = useRef<() => void>(() => {});
  const dragRef = useRef<string | null>(null);
  const draggedRef = useRef(false);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clickPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [preview, setPreview] = useState<{ id: string; x: number; y: number; data: NotePreview | null; loading: boolean } | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const linkRef = useRef<{ source: string; x: number; y: number } | null>(null); // in-progress link (x,y = cursor in graph coords)

  const openPreview = (id: string) => {
    setPreview({ id, ...clickPosRef.current, data: null, loading: true });
    void fetchPreview(id).then((data) => setPreview((p) => (p && p.id === id ? { ...p, data, loading: false } : p)));
  };
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [viewT, setViewT] = useState({ k: 1, tx: 0, ty: 0 });

  const degree = useMemo(() => {
    const d: Record<string, number> = {};
    for (const e of edges) {
      d[e.source] = (d[e.source] ?? 0) + 1;
      d[e.target] = (d[e.target] ?? 0) + 1;
    }
    return d;
  }, [edges]);

  const adj = useMemo(() => {
    const a: Record<string, Set<string>> = {};
    for (const e of edges) {
      (a[e.source] ??= new Set()).add(e.target);
      (a[e.target] ??= new Set()).add(e.source);
    }
    return a;
  }, [edges]);

  // (Re)seed positions when the node set changes; keep existing positions stable.
  useEffect(() => {
    const m = new Map<string, Pt>();
    const n = nodes.length || 1;
    nodes.forEach((node, i) => {
      const prev = posRef.current.get(node.id);
      if (prev) {
        m.set(node.id, prev);
        return;
      }
      const a = (i / n) * Math.PI * 2;
      m.set(node.id, {
        x: CX + Math.cos(a) * 240 + (Math.random() - 0.5) * 60,
        y: CY + Math.sin(a) * 240 + (Math.random() - 0.5) * 60,
        vx: 0,
        vy: 0,
      });
    });
    posRef.current = m;
    alphaRef.current = 1;
  }, [nodes]);

  // Force simulation loop.
  useEffect(() => {
    const ids = nodes.map((n) => n.id);
    const step = () => {
      const pos = posRef.current;
      const alpha = alphaRef.current;

      const hashPoints: HashedPoint[] = [];
      for (const id of ids) {
        const p = pos.get(id);
        if (p) hashPoints.push({ id, x: p.x, y: p.y });
      }
      for (const [idA, idB] of spatialHashPairs(hashPoints, REPULSION_CELL_SIZE)) {
        const a = pos.get(idA);
        const b = pos.get(idB);
        if (!a || !b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const rep = 3200 / d2;
        const fx = (dx / d) * rep;
        const fy = (dy / d) * rep;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      const L = 110;
      const K = 0.03;
      for (const e of edges) {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = K * (d - L);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      for (const id of ids) {
        const p = pos.get(id);
        if (!p) continue;
        if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
        p.vx += (CX - p.x) * 0.003;
        p.vy += (CY - p.y) * 0.003;
        p.vx *= 0.84;
        p.vy *= 0.84;
        p.x += p.vx * alpha;
        p.y += p.vy * alpha;
        p.x = Math.max(PAD, Math.min(W - PAD, p.x));
        p.y = Math.max(PAD, Math.min(H - PAD, p.y));
      }

      alphaRef.current = Math.max(0, alpha * 0.99 - 0.001);
      setTick((t) => (t + 1) % 1_000_000);
      if (alphaRef.current > 0.015 || dragRef.current) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        runningRef.current = false;
      }
    };
    stepRef.current = step;
    runningRef.current = true;
    rafRef.current = requestAnimationFrame(step);
    return () => { runningRef.current = false; cancelAnimationFrame(rafRef.current); };
  }, [nodes, edges]);

  const kick = () => {
    if (!runningRef.current) {
      runningRef.current = true;
      rafRef.current = requestAnimationFrame(() => stepRef.current());
    }
  };

  // Client px → viewBox coords (root CTM: viewBox scaling only, ignores pan/zoom).
  const toViewBox = (cx: number, cy: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = cx; pt.y = cy;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };
  // Client px → graph coords (inner group CTM: includes pan + zoom).
  const toGraph = (cx: number, cy: number) => {
    const g = gRef.current;
    if (!g) return { x: 0, y: 0 };
    const pt = (svgRef.current as SVGSVGElement).createSVGPoint();
    pt.x = cx; pt.y = cy;
    const ctm = g.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  // Wheel zoom (non-passive so we can preventDefault the page scroll).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const P = toViewBox(e.clientX, e.clientY);
      setViewT((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const k = Math.min(4, Math.max(0.25, v.k * factor));
        const r = k / v.k;
        return { k, tx: P.x - (P.x - v.tx) * r, ty: P.y - (P.y - v.ty) * r };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const reheat = () => { alphaRef.current = Math.max(alphaRef.current, 0.5); kick(); };

  const onNodeDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    // In link mode, start drawing a connector instead of moving the node.
    if (linkMode) {
      const g = toGraph(e.clientX, e.clientY);
      linkRef.current = { source: id, x: g.x, y: g.y };
      setTick((t) => (t + 1) % 1_000_000);
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = id;
    draggedRef.current = false;
    // Remember where (container-relative) the click landed, to anchor the popover.
    const rect = containerRef.current?.getBoundingClientRect();
    clickPosRef.current = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    const p = posRef.current.get(id);
    if (p) p.fixed = true;
    kick();
  };

  // Release on a node while drawing a connector → create the link.
  const onNodeUp = (id: string) => {
    if (linkRef.current && linkRef.current.source !== id) onLink(linkRef.current.source, id);
    linkRef.current = null;
    setTick((t) => (t + 1) % 1_000_000);
  };

  const onBgDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    panRef.current = toViewBox(e.clientX, e.clientY);
    setPreview(null); // clicking empty space dismisses the popover
  };

  const onMove = (e: React.PointerEvent) => {
    if (linkRef.current) {
      const g = toGraph(e.clientX, e.clientY);
      linkRef.current = { ...linkRef.current, x: g.x, y: g.y };
      setTick((t) => (t + 1) % 1_000_000);
      return;
    }
    if (dragRef.current) {
      const p = posRef.current.get(dragRef.current);
      if (!p) return;
      const g = toGraph(e.clientX, e.clientY);
      p.x = Math.max(PAD, Math.min(W - PAD, g.x));
      p.y = Math.max(PAD, Math.min(H - PAD, g.y));
      draggedRef.current = true;
      setTick((t) => (t + 1) % 1_000_000);
      return;
    }
    if (panRef.current) {
      const now = toViewBox(e.clientX, e.clientY);
      const dx = now.x - panRef.current.x;
      const dy = now.y - panRef.current.y;
      // Recompute start in the *new* frame so panning tracks the cursor 1:1.
      setViewT((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
      panRef.current = toViewBox(e.clientX, e.clientY);
    }
  };

  const onUp = () => {
    if (dragRef.current) {
      const p = posRef.current.get(dragRef.current);
      if (p) p.fixed = false;
      dragRef.current = null;
      reheat();
    }
    panRef.current = null;
    // Released on empty space while linking → cancel.
    if (linkRef.current) { linkRef.current = null; setTick((t) => (t + 1) % 1_000_000); }
  };

  const resetView = () => setViewT({ k: 1, tx: 0, ty: 0 });

  if (nodes.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-ink-500 bg-ink-900">
        <div className="text-4xl mb-2">🕸️</div>
        <p className="text-cream-300">No notes to graph yet</p>
        <p className="text-sm">Create notes and connect them with [[wikilinks]] to see the web.</p>
        <button onClick={onNew} className="mt-4 px-3 py-1.5 rounded-lg bg-clay text-white text-sm font-medium hover:bg-clay-400 transition-colors">+ New note</button>
      </div>
    );
  }

  const pos = posRef.current;
  const active = hover;
  const isDim = (id: string) => active != null && id !== active && !adj[active]?.has(id);
  const k = viewT.k;
  const showLabel = (id: string) => id === active || id === selectedId || k >= 1.15 || nodes.length <= 28;

  return (
    <div ref={containerRef} className="h-full relative bg-ink-900 overflow-hidden">
      <div className="absolute top-3 left-4 z-10 flex items-center gap-3 text-xs text-ink-500 pointer-events-none">
        <span>{nodes.length} notes</span><span className="text-ink-700">·</span><span>{edges.length} links</span>
      </div>
      <div className="absolute top-3 right-4 z-10 flex items-center gap-1">
        <button onClick={() => setLinkMode((m) => !m)} title="Link mode: drag from one note to another to connect them"
          className={clsx('h-7 px-2.5 rounded-lg text-[11px] font-medium backdrop-blur mr-1 border', linkMode ? 'bg-clay text-white border-clay' : 'bg-ink-800/80 border-ink-700 text-cream-300 hover:border-clay')}>
          🔗 Link
        </button>
        <button onClick={onNew} title="New note" className="h-7 px-2.5 rounded-lg bg-clay/90 text-white text-[11px] font-medium hover:bg-clay backdrop-blur mr-1">+ New note</button>
        <button onClick={() => setViewT((v) => ({ ...v, k: Math.min(4, v.k * 1.25) }))} className="w-7 h-7 rounded-lg bg-ink-800/80 border border-ink-700 text-cream-300 hover:border-clay backdrop-blur">+</button>
        <button onClick={() => setViewT((v) => ({ ...v, k: Math.max(0.25, v.k / 1.25) }))} className="w-7 h-7 rounded-lg bg-ink-800/80 border border-ink-700 text-cream-300 hover:border-clay backdrop-blur">−</button>
        <button onClick={resetView} title="Reset view" className="h-7 px-2 rounded-lg bg-ink-800/80 border border-ink-700 text-cream-400 hover:border-clay text-[11px] backdrop-blur">Reset</button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={clsx('w-full h-full touch-none select-none', linkMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing')}
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      >
        <g ref={gRef} transform={`translate(${viewT.tx} ${viewT.ty}) scale(${k})`}>
          {/* edges */}
          <g style={{ pointerEvents: 'none' }}>
            {edges.map((e, i) => {
              const a = pos.get(e.source);
              const b = pos.get(e.target);
              if (!a || !b) return null;
              const lit = active != null && (e.source === active || e.target === active);
              return (
                <line
                  key={i}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={lit ? '#d97757' : '#403d33'}
                  strokeOpacity={active != null && !lit ? 0.2 : lit ? 0.9 : 0.55}
                  strokeWidth={(lit ? 1.8 : 1) / k}
                />
              );
            })}
          </g>
          {/* nodes */}
          {nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const r = 5 + Math.min(11, (degree[n.id] ?? 0) * 1.7);
            const dim = isDim(n.id);
            const sel = n.id === selectedId;
            const lit = n.id === active || sel;
            const color = folderColor(n.folder);
            return (
              <g
                key={n.id}
                transform={`translate(${p.x} ${p.y})`}
                className="cursor-pointer"
                opacity={dim ? 0.28 : 1}
                onPointerDown={(e) => onNodeDown(e, n.id)}
                onPointerUp={() => onNodeUp(n.id)}
                onClick={() => { if (!draggedRef.current && !linkMode) openPreview(n.id); }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
              >
                {/* glow halo */}
                <circle r={r * (lit ? 2.6 : 1.9)} fill={color} opacity={lit ? 0.28 : 0.12} />
                <circle
                  r={r}
                  fill={color}
                  stroke={sel ? '#f4efe4' : lit ? '#f4efe4' : '#1a1915'}
                  strokeWidth={(sel ? 2.5 : 1.5) / k}
                />
                {showLabel(n.id) && (
                  <text
                    y={r + 11 / k}
                    textAnchor="middle"
                    className="pointer-events-none"
                    fill={lit ? '#f4efe4' : '#b8b2a4'}
                    fontSize={11 / k}
                    style={{ paintOrder: 'stroke', stroke: '#12110e', strokeWidth: 3 / k, strokeLinejoin: 'round' }}
                  >
                    {n.title}
                  </text>
                )}
              </g>
            );
          })}

          {/* In-progress connector (link mode) */}
          {linkRef.current && (() => {
            const src = pos.get(linkRef.current.source);
            if (!src) return null;
            return <line x1={src.x} y1={src.y} x2={linkRef.current.x} y2={linkRef.current.y}
              stroke="#d97757" strokeWidth={2 / k} strokeDasharray={`${6 / k} ${4 / k}`} style={{ pointerEvents: 'none' }} />;
          })()}
        </g>
      </svg>

      {linkMode && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-lg bg-ink-800/90 border border-clay/50 text-xs text-cream-300 backdrop-blur pointer-events-none">
          Drag from one note to another to link them
        </div>
      )}

      {/* Node preview popover */}
      {preview && (
        <div
          className="absolute z-20 w-72 bg-ink-800 border border-ink-600 rounded-xl shadow-2xl animate-fade-in overflow-hidden"
          style={{
            left: Math.min(preview.x + 14, (containerRef.current?.clientWidth ?? 9999) - 300),
            top: Math.min(preview.y + 8, (containerRef.current?.clientHeight ?? 9999) - 220),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {preview.loading || !preview.data ? (
            <div className="p-4 text-sm text-ink-500 animate-pulse">Loading…</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-ink-700">
                {preview.data.folder && <div className="text-[10px] uppercase tracking-wide text-clay/80 mb-0.5">{preview.data.folder}</div>}
                <div className="text-sm font-semibold text-cream-50">{preview.data.title}</div>
                {preview.data.summary && <div className="text-xs text-cream-400 italic mt-1">{preview.data.summary}</div>}
              </div>
              {preview.data.excerpt && (
                <div className="px-4 py-2.5 text-xs text-cream-300 leading-relaxed max-h-28 overflow-hidden">
                  {preview.data.excerpt}{preview.data.excerpt.length >= 220 ? '…' : ''}
                </div>
              )}
              <div className="flex items-center gap-3 px-4 py-2 border-t border-ink-700 text-[11px] text-ink-500">
                <span>↗ {preview.data.links} links</span>
                <span>🔗 {preview.data.backlinks} backlinks</span>
                <button onClick={() => { const id = preview.id; setPreview(null); onEdit(id); }}
                  className="ml-auto text-cream-300 hover:text-cream-100 font-medium">Edit</button>
                <button onClick={() => { const id = preview.id; setPreview(null); onOpen(id); }}
                  className="text-clay hover:text-clay-400 font-medium">Open →</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
