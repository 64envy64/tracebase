"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { ActionPill } from "@/components/dashboard/primitives/Buttons";
import {
  IconActivity,
  IconBook,
  IconPattern,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import type {
  DemoCodebase,
  DemoPattern,
  DemoPatternTier,
} from "@/lib/demo/data-infra-fixture";

/**
 * Patterns view — the reasoning library. Two cuts:
 *
 *   tier:  standing | common | tip
 *     The competitor calls this "e3 / e2 / e1"; we call it by what
 *     it means in plain language. Standing rules are universal
 *     guardrails the team always wants applied; common patterns
 *     fire often but are situational; tips are smaller nudges with
 *     a much narrower triggering surface.
 *
 *   scope: universal | codebase
 *     Universal patterns apply anywhere; codebase-scoped patterns
 *     only fire when the agent is editing the named repo.
 *
 * Codebase filter only filters codebase-scoped patterns — universal
 * patterns always show because by definition they apply everywhere.
 */

const TIER_LABEL: Record<DemoPatternTier, string> = {
  standing: "Standing rules",
  common: "Common patterns",
  tip: "Tips",
};

const TIER_HINT: Record<DemoPatternTier, string> = {
  standing: "Universal guardrails. Run before any tool call.",
  common: "Distilled from repeat incidents. Fired when a similar situation comes up.",
  tip: "Smaller nudges with narrow triggers. Lighter touch.",
};

const TIER_ORDER: DemoPatternTier[] = ["standing", "common", "tip"];

export function PatternsView({
  patterns,
  codebases,
  demo = false,
}: {
  patterns: DemoPattern[];
  codebases: DemoCodebase[];
  demo?: boolean;
}) {
  const [tierFilter, setTierFilter] = useState<DemoPatternTier | "all">("all");
  const [scopeFilter, setScopeFilter] = useState<"all" | "universal" | "codebase">("all");
  const [codebaseFilter, setCodebaseFilter] = useState<string>("all");
  const href = (path: string) => (demo ? `${path}?demo=1` : path);

  const visible = useMemo(() => {
    return patterns
      .filter((p) => (tierFilter === "all" ? true : p.tier === tierFilter))
      .filter((p) => (scopeFilter === "all" ? true : p.scope === scopeFilter))
      .filter((p) => {
        if (codebaseFilter === "all") return true;
        // Universal patterns always pass — they apply to every codebase.
        if (p.scope === "universal") return true;
        return p.codebase === codebaseFilter;
      });
  }, [patterns, tierFilter, scopeFilter, codebaseFilter]);

  const grouped = useMemo(() => {
    const out: Record<DemoPatternTier, DemoPattern[]> = {
      standing: [],
      common: [],
      tip: [],
    };
    for (const p of visible) out[p.tier].push(p);
    return out;
  }, [visible]);

  const counts = useMemo(() => {
    const all = patterns.length;
    const byTier = patterns.reduce<Record<DemoPatternTier, number>>(
      (acc, p) => {
        acc[p.tier] += 1;
        return acc;
      },
      { standing: 0, common: 0, tip: 0 },
    );
    return { all, ...byTier };
  }, [patterns]);

  return (
    <section className="space-y-7" aria-label="Patterns">
      <PageHeader
        title="Patterns + standing rules"
        subtitle={
          patterns.length === 0
            ? "Nothing here yet"
            : `${patterns.length} pattern${patterns.length === 1 ? "" : "s"} across this workspace`
        }
        actions={
          <>
            <ActionPill href={href("/dashboard/runs")} icon={<IconActivity />}>
              Runs
            </ActionPill>
            <ActionPill href={href("/dashboard/memory")} icon={<IconBook />}>
              Memory
            </ActionPill>
            <ActionPill href={href("/dashboard")} icon={<IconRocket />}>
              Overview
            </ActionPill>
          </>
        }
      />

      <div
        className="rounded-lg border px-4 py-4"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <FilterRow
          label="Tier"
          options={[
            { key: "all", label: "All", count: counts.all },
            { key: "standing", label: "Standing", count: counts.standing },
            { key: "common", label: "Common", count: counts.common },
            { key: "tip", label: "Tip", count: counts.tip },
          ]}
          value={tierFilter}
          onChange={(v) => setTierFilter(v as DemoPatternTier | "all")}
        />
        <FilterRow
          label="Scope"
          options={[
            { key: "all", label: "All" },
            { key: "universal", label: "Universal" },
            { key: "codebase", label: "Codebase-scoped" },
          ]}
          value={scopeFilter}
          onChange={(v) => setScopeFilter(v as "all" | "universal" | "codebase")}
        />
        {codebases.length > 0 ? (
          <FilterRow
            label="Codebase"
            options={[
              { key: "all", label: "All" },
              ...codebases.map((c) => ({ key: c.name, label: c.name })),
            ]}
            value={codebaseFilter}
            onChange={(v) => setCodebaseFilter(v)}
          />
        ) : null}
      </div>

      {patterns.length === 0 ? (
        <EmptyState
          title="No patterns yet"
          body="Patterns are distilled by the Stop hook after an agent successfully resolves a non-trivial task. Once your team runs a few sessions with TraceBase attached, the library fills up here."
          artSrc="/octopus.svg"
          artAlt="TraceBase octopus"
        />
      ) : (
        TIER_ORDER.filter((tier) => grouped[tier].length > 0).map((tier) => (
          <TierBlock
            key={tier}
            tier={tier}
            patterns={grouped[tier]}
            codebases={codebases}
          />
        ))
      )}

      {patterns.length > 0 && visible.length === 0 ? (
        <div
          className="rounded-lg border px-4 py-6 text-center text-[12px] font-light"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface)",
            color: "var(--text-tertiary)",
          }}
        >
          No patterns match the current filters.
        </div>
      ) : null}
    </section>
  );
}

function TierBlock({
  tier,
  patterns,
  codebases,
}: {
  tier: DemoPatternTier;
  patterns: DemoPattern[];
  codebases: DemoCodebase[];
}) {
  return (
    <section aria-label={TIER_LABEL[tier]} className="space-y-3">
      <header className="flex flex-col gap-1 px-1">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {TIER_LABEL[tier]} · {patterns.length}
        </p>
        <p className="text-[12px] font-light" style={{ color: "var(--text-secondary)" }}>
          {TIER_HINT[tier]}
        </p>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        {patterns.map((p) => (
          <PatternCard key={p.id} pattern={p} codebases={codebases} />
        ))}
      </div>
    </section>
  );
}

function PatternCard({
  pattern,
  codebases,
}: {
  pattern: DemoPattern;
  codebases: DemoCodebase[];
}) {
  const codebaseLabel = pattern.codebase
    ? codebases.find((c) => c.name === pattern.codebase)?.name ?? pattern.codebase
    : null;
  return (
    <article
      className="flex flex-col gap-3 rounded-lg border px-4 py-4"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={pattern.scope} />
        {codebaseLabel ? <CodebaseBadge label={codebaseLabel} /> : null}
        <span
          className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          used {pattern.usedCount}×
        </span>
      </div>
      <p className="text-[13px] font-normal leading-snug tracking-tight">
        <IconPattern className="mr-1.5 inline-block align-text-bottom" />
        {pattern.title}
      </p>
      <p
        className="text-[12px] font-light leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        {pattern.body}
      </p>
      <p
        className="font-mono text-[10px]"
        style={{ color: "var(--text-tertiary)" }}
      >
        id: {pattern.id}
        {pattern.sourceRunId ? ` · from run ${pattern.sourceRunId}` : ""}
      </p>
    </article>
  );
}

function ScopeBadge({ scope }: { scope: "universal" | "codebase" }) {
  const isUniversal = scope === "universal";
  return (
    <span
      className="inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em]"
      style={{
        background: isUniversal
          ? "rgba(255, 122, 92, 0.08)"
          : "rgba(232, 217, 184, 0.06)",
        color: isUniversal ? "var(--accent)" : "var(--text-secondary)",
        borderColor: isUniversal
          ? "rgba(255, 122, 92, 0.28)"
          : "var(--border)",
      }}
    >
      {isUniversal ? "Universal" : "Codebase"}
    </span>
  );
}

function CodebaseBadge({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-mono normal-case tracking-normal"
      style={{
        borderColor: "var(--border)",
        color: "var(--text-tertiary)",
      }}
    >
      {label}
    </span>
  );
}

function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ key: string; label: string; count?: number }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <span
        className="min-w-[72px] text-[10px] font-mono uppercase tracking-[0.22em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        {label}
      </span>
      {options.map((option) => {
        const active = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            className="inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-[11px] font-light transition-[background-color,color]"
            style={{
              background: active ? "var(--text)" : "transparent",
              color: active ? "var(--bg)" : "var(--text-secondary)",
              borderColor: active ? "var(--text)" : "var(--border)",
            }}
            aria-pressed={active}
          >
            <span>{option.label}</span>
            {option.count !== undefined ? (
              <span
                className="font-mono text-[10px]"
                style={{ color: active ? "var(--bg)" : "var(--text-tertiary)" }}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
