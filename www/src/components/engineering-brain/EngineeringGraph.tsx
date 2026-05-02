"use client";

/**
 * Wrapper around the interactive graph that adds the page header and
 * the right-side details panel. The interactive surface itself lives
 * in `InteractiveGraph.tsx`; this component owns the high-level
 * composition and the selection state.
 */
import { useMemo, useState } from "react";
import {
  EmptyState,
  PageHeader,
  StatusPill,
  SurfaceCard,
} from "@/components/engineering-brain/shared";
import {
  buildGraphFromState,
  type GraphEdge,
  type GraphNode,
} from "@/components/engineering-brain/graph-data";
import { InteractiveGraph } from "@/components/engineering-brain/InteractiveGraph";
import type {
  AgentRecord,
  AgentRunRecord,
  GithubItemRecord,
  MemoryEventRecord,
  MemoryStatusRecord,
} from "@/lib/control-plane/types";

export { buildGraphFromState } from "@/components/engineering-brain/graph-data";
export type {
  GraphNode,
  GraphEdge,
  GraphNodeKind,
} from "@/components/engineering-brain/graph-data";

interface Props {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  githubItems: GithubItemRecord[];
  memoryStatuses: MemoryStatusRecord[];
  memoryEvents: MemoryEventRecord[];
  /** Optional override; useful for the demo route. */
  fixture?: { nodes: GraphNode[]; edges: GraphEdge[] };
}

const KIND_LABEL_HUMAN: Record<GraphNode["kind"], string> = {
  issue: "Issue",
  pr: "Pull request",
  ci_failure: "CI failure",
  agent_run: "Agent run",
  memory: "Lesson learned",
  file: "File",
  owner: "Person",
};

export function EngineeringGraph(props: Props) {
  const built = useMemo(() => {
    if (props.fixture) return props.fixture;
    return buildGraphFromState({
      agents: props.agents,
      runs: props.runs,
      githubItems: props.githubItems,
      memoryStatuses: props.memoryStatuses,
      memoryEvents: props.memoryEvents,
    });
  }, [props]);

  const [selected, setSelected] = useState<string | null>(null);
  const selectedNode = selected
    ? built.nodes.find((n) => n.id === selected) ?? null
    : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[2.1fr_1fr]">
      <SurfaceCard
        title="Graph"
        meta={`${built.nodes.length} nodes · ${built.edges.length} edges`}
      >
        <div className="px-3 py-3">
          {built.nodes.length === 0 ? (
            <EmptyState
              title="Nothing to graph yet"
              description="Connect a repo and let an agent run a task. The graph fills in as work flows."
            />
          ) : (
            <InteractiveGraph
              {...props}
              onSelect={setSelected}
              selectedId={selected}
              height={560}
            />
          )}
        </div>
      </SurfaceCard>

      <SurfaceCard title={selectedNode ? "Node details" : "Click a node"}>
        {selectedNode ? (
          <div className="flex flex-col gap-2 px-5 py-4">
            <div className="flex items-center gap-2">
              <StatusPill status={KIND_LABEL_HUMAN[selectedNode.kind]} />
              <p
                className="text-[13px] font-light"
                style={{ color: "var(--text)" }}
              >
                {selectedNode.label}
              </p>
            </div>
            {selectedNode.meta ? (
              <p
                className="text-[12px] font-light"
                style={{ color: "var(--text-secondary)" }}
              >
                {selectedNode.meta}
              </p>
            ) : null}
            {selectedNode.url ? (
              <a
                href={selectedNode.url}
                className="text-[12px] font-mono underline"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--text-tertiary)" }}
              >
                {selectedNode.url}
              </a>
            ) : null}
          </div>
        ) : (
          <EmptyState
            title="Inspect a node"
            description="Click any node to see its details. Drag nodes to rearrange. Drag empty space to pan. Scroll to zoom."
          />
        )}
      </SurfaceCard>
    </div>
  );
}

export function GraphPage(props: Props) {
  return (
    <section className="space-y-6" aria-label="Engineering Brain graph">
      <PageHeader
        eyebrow="Graph"
        title="How work flows"
        description={
          <>
            One picture of everything connecting your team to the work:
            issues, pull requests, agents, lessons learned, and the people
            who own them. Drag to rearrange. Click a node for details.
          </>
        }
      />
      <EngineeringGraph {...props} />
    </section>
  );
}
