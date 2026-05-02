/**
 * Pure data builder for the Engineering Brain graph.
 *
 * Lives in its own .ts (not .tsx) module so unit tests can exercise
 * it without pulling React. The component (`EngineeringGraph.tsx`)
 * imports from here for runtime use.
 */
import type {
  AgentRecord,
  AgentRunRecord,
  GithubItemRecord,
  MemoryEventRecord,
  MemoryStatusRecord,
} from "@/lib/control-plane/types";

export type GraphNodeKind =
  | "issue"
  | "pr"
  | "ci_failure"
  | "agent_run"
  | "memory"
  | "file"
  | "owner";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  meta?: string;
  url?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind:
    | "task_to_run"
    | "run_to_memory"
    | "run_to_file"
    | "memory_supersede"
    | "ci_to_run"
    | "owner_to_run";
}

interface BuildArgs {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  githubItems: GithubItemRecord[];
  memoryStatuses: MemoryStatusRecord[];
  memoryEvents: MemoryEventRecord[];
}

export function buildGraphFromState({
  agents,
  runs,
  githubItems,
  memoryStatuses,
  memoryEvents,
}: BuildArgs): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileNodes = new Map<string, GraphNode>();

  for (const item of githubItems) {
    const kind: GraphNodeKind =
      item.kind === "check_run" && item.state === "failure"
        ? "ci_failure"
        : item.kind === "pull_request"
          ? "pr"
          : item.kind === "issue"
            ? "issue"
            : "issue";
    nodes.push({
      id: `gh:${item.id}`,
      kind,
      label:
        item.number !== undefined
          ? `#${item.number} ${item.title ?? item.kind}`
          : item.title ?? item.kind,
      meta: `${item.repoFullName} · ${item.kind}${item.state ? ` · ${item.state}` : ""}`,
      url: item.url,
    });
    for (const file of item.linkedFiles.slice(0, 6)) {
      const fileId = `file:${file}`;
      if (!fileNodes.has(fileId)) {
        fileNodes.set(fileId, { id: fileId, kind: "file", label: file });
      }
    }
  }

  for (const node of fileNodes.values()) nodes.push(node);

  const ownerSeen = new Set<string>();
  for (const agent of agents) {
    if (!agent.ownerLabel) continue;
    if (!ownerSeen.has(agent.ownerLabel)) {
      nodes.push({ id: `owner:${agent.ownerLabel}`, kind: "owner", label: agent.ownerLabel });
      ownerSeen.add(agent.ownerLabel);
    }
  }

  for (const run of runs) {
    const runNodeId = `run:${run.id}`;
    nodes.push({
      id: runNodeId,
      kind: "agent_run",
      label: run.taskTitle ?? `run ${run.sessionId.slice(0, 6)}`,
      meta: `status ${run.status} · ${run.recalledPatternsCount} patterns · ${run.recalledFilesCount} files`,
    });
    if (
      run.taskSourceId &&
      (run.taskSourceKind === "github_issue" || run.taskSourceKind === "pull_request")
    ) {
      edges.push({
        from: `gh:${run.taskSourceId}`,
        to: runNodeId,
        kind: "task_to_run",
      });
    }
    if (run.taskSourceId && run.taskSourceKind === "ci_failure") {
      edges.push({ from: `gh:${run.taskSourceId}`, to: runNodeId, kind: "ci_to_run" });
    }
    const owner = agents.find((a) => a.id === run.agentId)?.ownerLabel;
    if (owner) {
      edges.push({ from: `owner:${owner}`, to: runNodeId, kind: "owner_to_run" });
    }
  }

  for (const memory of memoryStatuses) {
    if (memory.status === "deleted") continue;
    nodes.push({
      id: `memory:${memory.memoryId}`,
      kind: "memory",
      label: memory.trigSituation ?? memory.memoryId,
      meta: `status ${memory.status} · provenance ${memory.provenanceKind ?? "—"}`,
    });
  }

  for (const event of memoryEvents) {
    if (
      event.action !== "used" &&
      event.action !== "created" &&
      event.action !== "superseded"
    )
      continue;
    if (!event.sourceRunId) continue;
    if (event.action === "superseded") {
      // Memory→memory edge requires a link table we don't model yet.
      continue;
    }
    edges.push({
      from: `run:${event.sourceRunId}`,
      to: `memory:${event.memoryId}`,
      kind: "run_to_memory",
    });
  }

  return { nodes, edges };
}
