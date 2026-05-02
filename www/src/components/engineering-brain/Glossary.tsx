"use client";

import { useState } from "react";

/**
 * Inline term with a hover/focus tooltip definition. Lets us write
 * plain-English copy ("Lessons learned (memory)") while still keeping
 * the technical term searchable for engineering readers.
 */
export function Term({
  children,
  define,
}: {
  children: React.ReactNode;
  define: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="cursor-help border-b border-dotted px-0.5 text-left"
        style={{ borderColor: "var(--text-tertiary)", color: "inherit" }}
      >
        {children}
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute left-1/2 top-full z-10 mt-1 w-[260px] -translate-x-1/2 rounded-sm border px-3 py-2 text-[11px] font-light leading-relaxed"
          style={{
            background: "rgba(15, 17, 21, 0.96)",
            color: "var(--text)",
            borderColor: "var(--border)",
            backdropFilter: "blur(6px)",
          }}
        >
          {define}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Top-of-page jargon legend — small chip strip that decodes the
 * Engineering Brain vocabulary in one glance.
 */
export function GlossaryStrip() {
  const items: Array<{ word: string; meaning: string }> = [
    {
      word: "Memory",
      meaning:
        "A short, reusable note an agent saved after solving something. Think 'lesson learned'.",
    },
    {
      word: "Run",
      meaning:
        "One task an agent worked on, from prompt to result, with the count of files and lessons it pulled in.",
    },
    {
      word: "Brief",
      meaning:
        "A read-only background packet for an agent: cited issues, files, and prior lessons. Never commands.",
    },
    {
      word: "Owner",
      meaning:
        "A label tagging which person an agent is working for. Free-form, not a real account yet.",
    },
    {
      word: "Rollback",
      meaning:
        "Restore the previous state of a memory. We don't roll back code from here.",
    },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Term key={item.word} define={item.meaning}>
          <span
            className="rounded-sm border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em]"
            style={{
              background: "var(--surface)",
              color: "var(--text-secondary)",
              borderColor: "var(--border)",
            }}
          >
            {item.word}
          </span>
        </Term>
      ))}
    </div>
  );
}
