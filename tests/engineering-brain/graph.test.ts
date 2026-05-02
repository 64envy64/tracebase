/**
 * Engineering Brain graph builder — pure-data assertions on the
 * (nodes, edges) shape produced from the demo fixture and from
 * synthesized inputs. This tests the *data* contract without
 * standing up React. The DemoView consumes this same builder, so a
 * regression here makes /dashboard/demo render badly.
 */
import { describe, it, expect } from "vitest";
import { getDemoFixture } from "@/components/engineering-brain/demo-fixture";
import { buildGraphFromState } from "@/components/engineering-brain/graph-data";

describe("buildGraphFromState (demo fixture)", () => {
  const fixture = getDemoFixture();
  const graph = buildGraphFromState({
    agents: fixture.brain.agents,
    runs: fixture.brain.agentRuns,
    githubItems: fixture.brain.githubItems,
    memoryStatuses: fixture.brain.memoryStatuses,
    memoryEvents: fixture.brain.memoryEvents,
  });

  it("includes one node per github item", () => {
    const ghIds = fixture.brain.githubItems.map((i) => `gh:${i.id}`);
    for (const id of ghIds) {
      expect(graph.nodes.find((n) => n.id === id)).toBeDefined();
    }
  });

  it("includes one node per active/non-deleted memory", () => {
    const memoryIds = fixture.brain.memoryStatuses
      .filter((m) => m.status !== "deleted")
      .map((m) => `memory:${m.memoryId}`);
    for (const id of memoryIds) {
      expect(graph.nodes.find((n) => n.id === id)).toBeDefined();
    }
  });

  it("links the resolved run from issue #217 to its memory", () => {
    const issueRunEdge = graph.edges.find(
      (e) => e.from === "gh:demo-issue-217" && e.to === "run:demo-run-1",
    );
    expect(issueRunEdge?.kind).toBe("task_to_run");

    const runMemEdge = graph.edges.find(
      (e) => e.from === "run:demo-run-1" && e.to === "memory:demo-mem-jwt-clock-skew-1",
    );
    expect(runMemEdge?.kind).toBe("run_to_memory");
  });

  it("ties owners to agent runs", () => {
    const owners = graph.nodes.filter((n) => n.kind === "owner");
    expect(owners.length).toBeGreaterThan(0);
    const ownerEdges = graph.edges.filter((e) => e.kind === "owner_to_run");
    expect(ownerEdges.length).toBeGreaterThan(0);
  });

  it("excludes deleted memories", () => {
    const deletedMemories = graph.nodes.filter(
      (n) => n.kind === "memory" && n.label.toLowerCase().includes("(deleted"),
    );
    expect(deletedMemories).toHaveLength(0);
  });
});

describe("buildGraphFromState (empty)", () => {
  it("returns no nodes or edges for an empty workspace", () => {
    const graph = buildGraphFromState({
      agents: [],
      runs: [],
      githubItems: [],
      memoryStatuses: [],
      memoryEvents: [],
    });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});
