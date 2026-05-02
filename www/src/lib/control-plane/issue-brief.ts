/**
 * Issue Brief — cited background for an agent that's about to start
 * work from a GitHub issue or PR.
 *
 * The brief is **never** delivered to the agent as commands. It is a
 * read-only background packet, presented in the dashboard for
 * inspection before a run. The same JSON is exposed via
 * `GET /api/engineering-brain/issue-brief?itemId=...` so other tools
 * can consume it deterministically. A future runtime hook can wrap
 * this brief in a `<github_context source="github" issue="#123">…`
 * tag at recall time — that integration is intentionally deferred so
 * the SDK boundary doesn't churn this release.
 *
 * Token budget: callers can clamp via `tokenBudget`; the brief
 * trims body summaries (already bounded by ingest) and the memory
 * preview list to stay under it. Default is 1500 "approximate
 * tokens" (chars / 4).
 */
import type {
  EngineeringBrainStore,
} from "@/lib/control-plane/engineering-brain";
import type {
  GithubItemRecord,
  MemoryStatusRecord,
} from "@/lib/control-plane/types";

export interface IssueBriefInput {
  workspaceId: string;
  itemId: string;
  store: EngineeringBrainStore;
  tokenBudget?: number;
}

export interface IssueBriefCitation {
  kind: "github_item" | "memory";
  id: string;
  label: string;
  url?: string;
}

export interface IssueBriefSection {
  heading: string;
  body: string[];
  citations: IssueBriefCitation[];
}

export interface IssueBrief {
  itemId: string;
  itemKind: GithubItemRecord["kind"];
  title: string;
  url: string;
  generatedAt: string;
  failureClass: string;
  sections: IssueBriefSection[];
  /**
   * Citation set deduplicated and sorted; this is the canonical list
   * an agent runtime would attach as `<citations>…</citations>`.
   */
  citations: IssueBriefCitation[];
  approxTokens: number;
  truncated: boolean;
}

const DEFAULT_TOKEN_BUDGET = 1500;
const APPROX_CHARS_PER_TOKEN = 4;

const FAILURE_CLASS_KEYWORDS: Array<{ class: string; words: RegExp }> = [
  { class: "auth", words: /\b(401|403|auth|jwt|token|oauth)\b/i },
  { class: "rate-limit", words: /\b(429|rate.?limit|throttle)\b/i },
  { class: "schema-migration", words: /\b(migration|alter table|schema|drop column)\b/i },
  { class: "concurrency", words: /\b(race|deadlock|lock|concurrent)\b/i },
  { class: "build-config", words: /\b(tsconfig|webpack|vite|tsup|next config|build|bundler)\b/i },
  { class: "ci-failure", words: /\b(ci.?fail|workflow|github.?actions|test failure)\b/i },
  { class: "perf", words: /\b(slow|p50|p99|latency|memory leak|oom)\b/i },
  { class: "data", words: /\b(null|undefined|missing field|encoding|utf|unicode)\b/i },
];

export async function buildIssueBrief(input: IssueBriefInput): Promise<IssueBrief | null> {
  const { workspaceId, itemId, store } = input;
  const item = await store.getGithubItemById(workspaceId, itemId);
  if (!item) return null;

  const budget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const failureClass = classifyFailure(item);
  const sections: IssueBriefSection[] = [];
  const citationSet = new Map<string, IssueBriefCitation>();
  const addCitation = (c: IssueBriefCitation) => {
    citationSet.set(`${c.kind}:${c.id}`, c);
  };
  addCitation({
    kind: "github_item",
    id: item.id,
    label: itemDisplayLabel(item),
    url: item.url,
  });

  // Section: failure class + body summary
  const summarySection: IssueBriefSection = {
    heading: "Likely failure class",
    body: [
      `Classified as **${failureClass}** based on title, body, and labels.`,
      ...(item.bodySummary ? [`Original summary (bounded): "${item.bodySummary}"`] : []),
    ],
    citations: [
      {
        kind: "github_item",
        id: item.id,
        label: itemDisplayLabel(item),
        url: item.url,
      },
    ],
  };
  sections.push(summarySection);

  // Section: linked files
  if (item.linkedFiles.length > 0) {
    sections.push({
      heading: "Files in scope",
      body: [
        `${item.linkedFiles.length} file(s) referenced by this item:`,
        ...item.linkedFiles.slice(0, 24).map((f) => `- \`${f}\``),
      ],
      citations: [],
    });
  }

  // Section: related GitHub items by repo + heuristics
  const related = await store.listGithubItems(workspaceId, {
    repoFullName: item.repoFullName,
    limit: 250,
  });
  const relatedRanked = rankRelatedItems(item, related).slice(0, 6);
  if (relatedRanked.length > 0) {
    sections.push({
      heading: "Related work in this repo",
      body: relatedRanked.map((r) => formatRelatedLine(r)),
      citations: relatedRanked.map(
        (r): IssueBriefCitation => ({
          kind: "github_item",
          id: r.id,
          label: itemDisplayLabel(r),
          url: r.url,
        }),
      ),
    });
    relatedRanked.forEach((r) =>
      addCitation({
        kind: "github_item",
        id: r.id,
        label: itemDisplayLabel(r),
        url: r.url,
      }),
    );
  }

  // Section: prior memories (status filtered to active/superseded)
  const memoryStatuses = await store.listMemoryStatuses(workspaceId);
  const relevantMemories = rankMemories(item, memoryStatuses).slice(0, 5);
  if (relevantMemories.length > 0) {
    sections.push({
      heading: "Prior memories worth checking",
      body: relevantMemories.map(
        (m) =>
          `- *${m.trigSituation ?? "(no trigger preview)"}* — status \`${m.status}\``,
      ),
      citations: relevantMemories.map(
        (m): IssueBriefCitation => ({
          kind: "memory",
          id: m.memoryId,
          label: m.trigSituation ?? m.memoryId,
        }),
      ),
    });
    relevantMemories.forEach((m) =>
      addCitation({
        kind: "memory",
        id: m.memoryId,
        label: m.trigSituation ?? m.memoryId,
      }),
    );
  }

  // Section: cautions
  const cautions = buildCautions(item, related);
  if (cautions.length > 0) {
    sections.push({
      heading: "Cautions / known dead ends",
      body: cautions,
      citations: [],
    });
  }

  // Trim sections to fit token budget
  const { sections: clipped, truncated, approxTokens } = clampToBudget(
    sections,
    budget,
  );

  return {
    itemId: item.id,
    itemKind: item.kind,
    title: itemDisplayLabel(item),
    url: item.url,
    generatedAt: new Date().toISOString(),
    failureClass,
    sections: clipped,
    citations: Array.from(citationSet.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    ),
    approxTokens,
    truncated,
  };
}

export function classifyFailure(item: GithubItemRecord): string {
  const haystack = [
    item.title ?? "",
    item.bodySummary ?? "",
    ...item.labels,
  ].join(" ");
  for (const rule of FAILURE_CLASS_KEYWORDS) {
    if (rule.words.test(haystack)) return rule.class;
  }
  if (item.kind === "check_run") return "ci-failure";
  if (item.kind === "pull_request") return "code-change";
  return "general";
}

function rankRelatedItems(
  primary: GithubItemRecord,
  pool: GithubItemRecord[],
): GithubItemRecord[] {
  const primaryFiles = new Set(primary.linkedFiles);
  const primaryLabels = new Set(primary.labels);
  return pool
    .filter((r) => r.id !== primary.id)
    .map((r) => {
      let score = 0;
      // Shared files: strong signal of related work.
      score += r.linkedFiles.filter((f) => primaryFiles.has(f)).length * 4;
      score += r.labels.filter((l) => primaryLabels.has(l)).length * 2;
      // Same kind, same author: weaker signal.
      if (r.kind === primary.kind) score += 1;
      if (primary.authorLogin && r.authorLogin === primary.authorLogin) score += 1;
      return { item: r, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

function rankMemories(
  item: GithubItemRecord,
  pool: MemoryStatusRecord[],
): MemoryStatusRecord[] {
  const haystack = [item.title ?? "", item.bodySummary ?? "", ...item.labels]
    .join(" ")
    .toLowerCase();
  // Deleted memories are never injected.
  return pool
    .filter((m) => m.status !== "deleted")
    .map((m) => {
      const trig = (m.trigSituation ?? "").toLowerCase();
      let score = 0;
      if (!trig) return { m, score };
      const tokens = trig.split(/\s+/).filter((t) => t.length >= 4);
      for (const t of tokens) {
        if (haystack.includes(t)) score += 1;
      }
      if (m.status === "active") score += 0.5;
      return { m, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.m);
}

function buildCautions(
  item: GithubItemRecord,
  related: GithubItemRecord[],
): string[] {
  const cautions: string[] = [];
  const failingChecks = related.filter(
    (r) => r.kind === "check_run" && (r.state === "failure" || r.state === "timed_out"),
  );
  if (failingChecks.length > 0) {
    cautions.push(
      `${failingChecks.length} CI failure(s) in this repo recently — verifier commands may be the same suite.`,
    );
  }
  if (item.labels.includes("regression")) {
    cautions.push("Labelled `regression` — confirm the change set you're about to make has not been tried before.");
  }
  if (item.labels.includes("good first issue")) {
    cautions.push("Labelled `good first issue` — interpretation of scope tends to drift; pin acceptance.");
  }
  return cautions;
}

function clampToBudget(
  sections: IssueBriefSection[],
  budget: number,
): { sections: IssueBriefSection[]; truncated: boolean; approxTokens: number } {
  const charBudget = budget * APPROX_CHARS_PER_TOKEN;
  let charsUsed = 0;
  let truncated = false;
  const out: IssueBriefSection[] = [];
  for (const section of sections) {
    const sectionChars =
      section.heading.length +
      section.body.reduce((acc, line) => acc + line.length, 0);
    if (charsUsed + sectionChars > charBudget) {
      truncated = true;
      break;
    }
    out.push(section);
    charsUsed += sectionChars;
  }
  return {
    sections: out,
    truncated,
    approxTokens: Math.ceil(charsUsed / APPROX_CHARS_PER_TOKEN),
  };
}

function formatRelatedLine(item: GithubItemRecord): string {
  const numberPart =
    item.number !== undefined ? `#${item.number}` : item.kind.toUpperCase();
  const stateBit = item.state ? ` · ${item.state}` : "";
  return `- ${numberPart} ${item.title ?? "(no title)"}${stateBit}`;
}

function itemDisplayLabel(item: GithubItemRecord): string {
  const numberPart =
    item.number !== undefined ? `#${item.number}` : item.kind.toUpperCase();
  return `${numberPart} ${item.title ?? item.kind}`;
}

/**
 * Render a brief as a single string with a clear `<github_context>`
 * tag — the SDK runtime can persist this verbatim. Kept stable so
 * future hooks can pipe it directly into recall payloads.
 */
export function renderIssueBriefAsContext(brief: IssueBrief): string {
  const lines: string[] = [];
  lines.push(
    `<github_context source="github" item="${brief.title}" url="${brief.url}">`,
  );
  lines.push(`Failure class: ${brief.failureClass}`);
  for (const section of brief.sections) {
    lines.push("");
    lines.push(`## ${section.heading}`);
    for (const body of section.body) lines.push(body);
  }
  lines.push("");
  lines.push("## Citations");
  for (const c of brief.citations) {
    lines.push(`- ${c.kind}:${c.id} — ${c.label}${c.url ? ` (${c.url})` : ""}`);
  }
  lines.push("</github_context>");
  return lines.join("\n");
}
