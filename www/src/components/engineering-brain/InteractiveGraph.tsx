"use client";

/**
 * Interactive Engineering Brain graph.
 *
 * Replaces the previous static SVG layout. Users can:
 *   - drag any node to a new position (positions persist for the session)
 *   - pan the canvas by dragging the empty area
 *   - zoom with the wheel / pinch-trackpad
 *   - hover a node for a soft tooltip
 *   - click a node to open the side panel (parent component owns that)
 *
 * Design intent: minimalist, matches the landing palette (var(--bg)/
 * var(--surface)/var(--border)/var(--accent)), no dep on react-flow or
 * d3 — just pointer events + a transform attribute on the canvas group.
 *
 * Layout: a deterministic ring layout seeds the initial positions; the
 * layout itself is stable across re-renders so toggling filters does
 * not cause nodes to jump. User-initiated drags override the seed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildGraphFromState,
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
} from "@/components/engineering-brain/graph-data";
import type {
  AgentRecord,
  AgentRunRecord,
  GithubItemRecord,
  MemoryEventRecord,
  MemoryStatusRecord,
} from "@/lib/control-plane/types";

interface Props {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  githubItems: GithubItemRecord[];
  memoryStatuses: MemoryStatusRecord[];
  memoryEvents: MemoryEventRecord[];
  /** Optional override; useful for the demo route. */
  fixture?: { nodes: GraphNode[]; edges: GraphEdge[] };
  /** Called when the user clicks a node — parent renders details. */
  onSelect?: (nodeId: string | null) => void;
  /** Currently-selected node id, controlled from the parent. */
  selectedId?: string | null;
  /** Subset of node ids to highlight (story-mode). Others fade. */
  highlightedIds?: ReadonlySet<string>;
  /** Visual height for the canvas. */
  height?: number;
}

interface Vec2 {
  x: number;
  y: number;
}

const DEFAULT_HEIGHT = 540;
const SVG_VIEW_WIDTH = 1200;
const SVG_VIEW_HEIGHT = 700;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

const COLOR_BY_KIND: Record<GraphNodeKind, { fill: string; stroke: string; text: string }> = {
  issue: { fill: "#162033", stroke: "#7a92cc", text: "#dde6ff" },
  pr: { fill: "#1a1b2e", stroke: "#b292ec", text: "#ece1ff" },
  ci_failure: { fill: "#2a1414", stroke: "#ef6e6e", text: "#fbd9d9" },
  agent_run: { fill: "#0d2723", stroke: "#5fd2a4", text: "#cdfcdb" },
  memory: { fill: "#231f0d", stroke: "#f3bd5e", text: "#fff0c9" },
  file: { fill: "#161616", stroke: "#7a7a7a", text: "#e2e2e2" },
  owner: { fill: "#101521", stroke: "#9aa6c1", text: "#e8eef8" },
};

const KIND_LABEL: Record<GraphNodeKind, string> = {
  issue: "Issue",
  pr: "Pull request",
  ci_failure: "CI failure",
  agent_run: "Agent run",
  memory: "Lesson learned",
  file: "File",
  owner: "Person",
};

const FILTER_OPTIONS: GraphNodeKind[] = [
  "issue",
  "pr",
  "ci_failure",
  "agent_run",
  "memory",
  "file",
  "owner",
];

interface LaidOutNode extends GraphNode {
  x: number;
  y: number;
}

export function InteractiveGraph({
  agents,
  runs,
  githubItems,
  memoryStatuses,
  memoryEvents,
  fixture,
  onSelect,
  selectedId,
  highlightedIds,
  height,
}: Props) {
  const built = useMemo(() => {
    if (fixture) return fixture;
    return buildGraphFromState({
      agents,
      runs,
      githubItems,
      memoryStatuses,
      memoryEvents,
    });
  }, [agents, runs, githubItems, memoryStatuses, memoryEvents, fixture]);

  const [active, setActive] = useState<Set<GraphNodeKind>>(() => new Set(FILTER_OPTIONS));

  const visibleNodes = useMemo(
    () => built.nodes.filter((n) => active.has(n.kind)),
    [built.nodes, active],
  );
  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map((n) => n.id)),
    [visibleNodes],
  );
  const visibleEdges = useMemo(
    () => built.edges.filter((e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to)),
    [built.edges, visibleNodeIds],
  );

  // Layout is the seed; user drags override per-node positions.
  const layout = useMemo(() => layoutNodes(visibleNodes), [visibleNodes]);
  const [overrides, setOverrides] = useState<Record<string, Vec2>>({});

  // Positions for nodes filtered out are read only when those nodes
  // come back, so stale entries are harmless — and dropping them
  // preserves the user's drag work when they toggle filters off and
  // back on. We rely on this implicit retention.
  const positionMap = useMemo(() => {
    const map = new Map<string, LaidOutNode>();
    for (const node of layout) {
      const o = overrides[node.id];
      map.set(node.id, o ? { ...node, x: o.x, y: o.y } : node);
    }
    return map;
  }, [layout, overrides]);

  // Pan + zoom of the canvas group.
  const [pan, setPan] = useState<Vec2>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState<number>(1);
  const [panStart, setPanStart] = useState<{ origin: Vec2; pan: Vec2 } | null>(null);

  // Per-node drag state. nodeOrigin keeps the click offset so the
  // cursor stays at the same spot on the node while dragging.
  const [drag, setDrag] = useState<{
    nodeId: string;
    pointerId: number;
    nodeOrigin: Vec2;
    pointerStart: Vec2;
  } | null>(null);

  const [hovered, setHovered] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Convert client-space → svg-viewbox-space (so drags survive zoom).
  const svgPointFromClient = useCallback((clientX: number, clientY: number): Vec2 => {
    const svg = svgRef.current;
    if (!svg) return { x: clientX, y: clientY };
    const rect = svg.getBoundingClientRect();
    const xRel = (clientX - rect.left) / rect.width;
    const yRel = (clientY - rect.top) / rect.height;
    return {
      x: xRel * SVG_VIEW_WIDTH,
      y: yRel * SVG_VIEW_HEIGHT,
    };
  }, []);

  const beginNodeDrag = useCallback(
    (event: React.PointerEvent<SVGGElement>, node: LaidOutNode) => {
      event.stopPropagation();
      const point = svgPointFromClient(event.clientX, event.clientY);
      // Convert to world (un-zoom + un-pan) so drag math stays linear.
      const world = {
        x: (point.x - pan.x) / zoom,
        y: (point.y - pan.y) / zoom,
      };
      setDrag({
        nodeId: node.id,
        pointerId: event.pointerId,
        nodeOrigin: { x: node.x, y: node.y },
        pointerStart: world,
      });
      (event.target as Element).setPointerCapture?.(event.pointerId);
    },
    [pan, zoom, svgPointFromClient],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (drag) {
        const point = svgPointFromClient(event.clientX, event.clientY);
        const world = {
          x: (point.x - pan.x) / zoom,
          y: (point.y - pan.y) / zoom,
        };
        const dx = world.x - drag.pointerStart.x;
        const dy = world.y - drag.pointerStart.y;
        setOverrides((prev) => ({
          ...prev,
          [drag.nodeId]: {
            x: drag.nodeOrigin.x + dx,
            y: drag.nodeOrigin.y + dy,
          },
        }));
        return;
      }
      if (panStart) {
        const point = svgPointFromClient(event.clientX, event.clientY);
        setPan({
          x: panStart.pan.x + (point.x - panStart.origin.x),
          y: panStart.pan.y + (point.y - panStart.origin.y),
        });
      }
    },
    [drag, panStart, pan, zoom, svgPointFromClient],
  );

  const onPointerUp = useCallback(() => {
    setDrag(null);
    setPanStart(null);
  }, []);

  const onCanvasPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (drag) return;
      const point = svgPointFromClient(event.clientX, event.clientY);
      setPanStart({ origin: point, pan });
    },
    [drag, pan, svgPointFromClient],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<SVGSVGElement>) => {
      // Stop default page scroll only when the gesture targets us.
      event.preventDefault();
      const delta = -event.deltaY * 0.0015;
      setZoom((prev) => {
        const next = clamp(prev * (1 + delta), ZOOM_MIN, ZOOM_MAX);
        return next;
      });
    },
    [],
  );

  // Wheel events from React are passive in some browsers; bind manually
  // so we can call preventDefault reliably.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      const delta = -event.deltaY * 0.0015;
      setZoom((prev) => clamp(prev * (1 + delta), ZOOM_MIN, ZOOM_MAX));
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, []);

  const resetView = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setOverrides({});
  }, []);

  function toggle(kind: GraphNodeKind) {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  if (built.nodes.length === 0) {
    return (
      <div
        className="flex flex-col items-start gap-3 rounded-sm border px-6 py-10 text-[13px] font-light"
        style={{
          background: "var(--surface)",
          borderColor: "var(--border)",
          color: "var(--text-secondary)",
        }}
      >
        <p className="text-[14px]" style={{ color: "var(--text)" }}>
          Nothing to graph yet
        </p>
        <p className="max-w-[42rem]">
          Connect a repo and let an agent run a task. The graph fills in as
          work flows.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_OPTIONS.map((kind) => {
          const enabled = active.has(kind);
          const c = COLOR_BY_KIND[kind];
          return (
            <button
              key={kind}
              type="button"
              onClick={() => toggle(kind)}
              className="rounded-sm border px-3 py-1.5 text-[11px] font-light"
              style={{
                background: enabled ? c.fill : "transparent",
                color: enabled ? c.text : "var(--text-secondary)",
                borderColor: enabled ? c.stroke : "var(--border)",
              }}
              aria-pressed={enabled}
            >
              {KIND_LABEL[kind]}
            </button>
          );
        })}
        <span aria-hidden className="mx-1 text-[var(--text-tertiary)]">·</span>
        <button
          type="button"
          onClick={resetView}
          className="rounded-sm border px-3 py-1.5 text-[11px] font-light"
          style={{
            background: "transparent",
            color: "var(--text-secondary)",
            borderColor: "var(--border)",
          }}
        >
          Reset view
        </button>
        <span
          className="ml-auto text-[10px] font-mono uppercase tracking-[0.18em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          drag a node · drag empty space to pan · scroll to zoom
        </span>
      </div>

      <div
        className="relative overflow-hidden rounded-sm border"
        style={{
          background: "var(--bg)",
          borderColor: "var(--border)",
          height: height ?? DEFAULT_HEIGHT,
        }}
      >
        <svg
          ref={svgRef}
          role="img"
          aria-label="Engineering Brain interactive graph"
          viewBox={`0 0 ${SVG_VIEW_WIDTH} ${SVG_VIEW_HEIGHT}`}
          className="block h-full w-full select-none"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={onWheel}
          style={{
            cursor: panStart ? "grabbing" : drag ? "grabbing" : "grab",
            touchAction: "none",
          }}
        >
          <defs>
            <pattern
              id="graph-dot-grid"
              x="0"
              y="0"
              width="32"
              height="32"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="1" cy="1" r="0.8" fill="rgba(255,255,255,0.05)" />
            </pattern>
            <marker
              id="graph-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(200,200,210,0.55)" />
            </marker>
          </defs>

          <rect
            x="0"
            y="0"
            width={SVG_VIEW_WIDTH}
            height={SVG_VIEW_HEIGHT}
            fill="url(#graph-dot-grid)"
            opacity={0.55}
          />

          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {visibleEdges.map((edge, idx) => {
              const a = positionMap.get(edge.from);
              const b = positionMap.get(edge.to);
              if (!a || !b) return null;
              const muted =
                highlightedIds &&
                !(highlightedIds.has(edge.from) && highlightedIds.has(edge.to));
              return (
                <line
                  key={`${edge.from}-${edge.to}-${idx}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={muted ? "rgba(160,160,170,0.18)" : "rgba(190,200,220,0.45)"}
                  strokeWidth={1.4}
                  strokeDasharray={edge.kind === "memory_supersede" ? "4 3" : undefined}
                  markerEnd="url(#graph-arrow)"
                />
              );
            })}

            {Array.from(positionMap.values()).map((node) => {
              const c = COLOR_BY_KIND[node.kind];
              const isSelected = node.id === selectedId;
              const isHovered = node.id === hovered;
              const isHighlighted =
                !highlightedIds || highlightedIds.has(node.id);
              const opacity = isHighlighted ? 1 : 0.32;

              // Owner nodes get a richer person-card render: bigger,
              // with an initials avatar. Everyone else gets the
              // standard pill.
              if (node.kind === "owner") {
                const w = 200;
                const h = 60;
                const initials = personInitials(node.label);
                return (
                  <g
                    key={node.id}
                    transform={`translate(${node.x - w / 2}, ${node.y - h / 2})`}
                    onPointerDown={(event) => beginNodeDrag(event, node)}
                    onPointerEnter={() => setHovered(node.id)}
                    onPointerLeave={() => setHovered((prev) => (prev === node.id ? null : prev))}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect?.(node.id);
                    }}
                    className="cursor-grab active:cursor-grabbing"
                    opacity={opacity}
                  >
                    {(isSelected || isHovered) ? (
                      <rect
                        x={-4}
                        y={-4}
                        width={w + 8}
                        height={h + 8}
                        rx={12}
                        ry={12}
                        fill="none"
                        stroke={isSelected ? "#ffffff" : c.stroke}
                        strokeOpacity={isSelected ? 0.9 : 0.6}
                        strokeWidth={1.4}
                      />
                    ) : null}
                    <rect
                      width={w}
                      height={h}
                      rx={10}
                      ry={10}
                      fill={c.fill}
                      stroke={c.stroke}
                      strokeWidth={isSelected ? 2.2 : 1.4}
                    />
                    {/* avatar */}
                    <circle cx={28} cy={h / 2} r={18} fill={c.stroke} fillOpacity={0.18} />
                    <circle cx={28} cy={h / 2} r={18} fill="none" stroke={c.stroke} strokeWidth={1.1} />
                    <text
                      x={28}
                      y={h / 2 + 5}
                      textAnchor="middle"
                      fontSize={13}
                      fontFamily="ui-sans-serif, system-ui"
                      fill={c.text}
                      style={{ fontWeight: 500 }}
                    >
                      {initials}
                    </text>
                    {/* role + name */}
                    <text
                      x={56}
                      y={h / 2 - 6}
                      fontSize={9}
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      fill={c.text}
                      opacity={0.55}
                      style={{ textTransform: "uppercase", letterSpacing: "0.14em" }}
                    >
                      Person
                    </text>
                    <text
                      x={56}
                      y={h / 2 + 12}
                      fontSize={13}
                      fontFamily="ui-sans-serif, system-ui"
                      fill={c.text}
                    >
                      {truncate(node.label, 18)}
                    </text>
                  </g>
                );
              }

              const labelChars = node.label.length;
              const w = Math.max(140, Math.min(240, labelChars * 7 + 28));
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x - w / 2}, ${node.y - 22})`}
                  onPointerDown={(event) => beginNodeDrag(event, node)}
                  onPointerEnter={() => setHovered(node.id)}
                  onPointerLeave={() => setHovered((prev) => (prev === node.id ? null : prev))}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect?.(node.id);
                  }}
                  className="cursor-grab active:cursor-grabbing"
                  opacity={opacity}
                >
                  {(isSelected || isHovered) ? (
                    <rect
                      x={-3}
                      y={-3}
                      width={w + 6}
                      height={50}
                      rx={9}
                      ry={9}
                      fill="none"
                      stroke={isSelected ? "#ffffff" : c.stroke}
                      strokeOpacity={isSelected ? 0.9 : 0.6}
                      strokeWidth={1.2}
                    />
                  ) : null}
                  <rect
                    width={w}
                    height={44}
                    rx={8}
                    ry={8}
                    fill={c.fill}
                    stroke={c.stroke}
                    strokeWidth={isSelected ? 2 : 1.2}
                  />
                  <circle
                    cx={14}
                    cy={22}
                    r={4}
                    fill={c.stroke}
                  />
                  <text
                    x={26}
                    y={20}
                    fontSize={10}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    fill={c.text}
                    opacity={0.55}
                    style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}
                  >
                    {KIND_LABEL[node.kind]}
                  </text>
                  <text
                    x={26}
                    y={34}
                    fontSize={12}
                    fontFamily="ui-sans-serif, system-ui"
                    fill={c.text}
                  >
                    {truncate(node.label, 30)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Hover tooltip — outside the SVG so it can use HTML rendering */}
        {hovered ? <HoverTooltip node={positionMap.get(hovered)} pan={pan} zoom={zoom} /> : null}

        {/* Mini-legend in corner */}
        <div
          className="pointer-events-none absolute bottom-2 right-3 flex items-center gap-2 rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.18em]"
          style={{
            background: "rgba(15, 17, 21, 0.7)",
            backdropFilter: "blur(4px)",
            color: "var(--text-tertiary)",
            borderColor: "var(--border)",
          }}
        >
          zoom {Math.round(zoom * 100)}%
        </div>
      </div>
    </div>
  );
}

function HoverTooltip({
  node,
  pan,
  zoom,
}: {
  node: LaidOutNode | undefined;
  pan: Vec2;
  zoom: number;
}) {
  if (!node) return null;
  // Project world coords to screen percent via the same transform.
  const screenX = (node.x * zoom + pan.x) / SVG_VIEW_WIDTH * 100;
  const screenY = (node.y * zoom + pan.y) / SVG_VIEW_HEIGHT * 100;
  return (
    <div
      className="pointer-events-none absolute max-w-[280px] rounded-sm border px-3 py-2 text-[11px] font-light"
      style={{
        left: `calc(${screenX}% + 18px)`,
        top: `calc(${screenY}% - 6px)`,
        background: "rgba(15, 17, 21, 0.92)",
        backdropFilter: "blur(6px)",
        color: "var(--text)",
        borderColor: "var(--border)",
      }}
    >
      <p className="text-[13px] font-light leading-tight">{node.label}</p>
      {node.meta ? (
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-secondary)" }}>
          {node.meta}
        </p>
      ) : null}
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/**
 * Same deterministic ring layout as before. Stays stable when filters
 * toggle so nodes don't jump; user drag positions live in `overrides`
 * on top of this seed.
 */
function layoutNodes(nodes: GraphNode[]): LaidOutNode[] {
  const buckets: Record<GraphNodeKind, GraphNode[]> = {
    issue: [],
    pr: [],
    ci_failure: [],
    agent_run: [],
    memory: [],
    file: [],
    owner: [],
  };
  for (const node of nodes) buckets[node.kind].push(node);

  const ringOrder: GraphNodeKind[] = [
    "owner",
    "agent_run",
    "issue",
    "pr",
    "ci_failure",
    "memory",
    "file",
  ];

  const cx = SVG_VIEW_WIDTH / 2;
  const cy = SVG_VIEW_HEIGHT / 2;
  const ringStep = 110;
  const out: LaidOutNode[] = [];

  ringOrder.forEach((kind, ringIndex) => {
    const list = buckets[kind];
    if (list.length === 0) return;
    const radius = 90 + ringIndex * ringStep;
    list.forEach((node, idx) => {
      const angle =
        (idx / Math.max(1, list.length)) * Math.PI * 2 + ringIndex * 0.18;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius * 0.7;
      out.push({ ...node, x, y });
    });
  });
  return out;
}
