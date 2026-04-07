"use client";

import { useState, useCallback } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <button
      onClick={copy}
      className="text-xs transition-opacity duration-150 cursor-pointer"
      style={{ color: "var(--text-tertiary)" }}
      aria-label="Copy to clipboard"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [command]);

  return (
    <button
      onClick={copy}
      className="group flex items-center gap-3 px-5 py-3 font-mono text-sm border rounded-md transition-colors duration-150 cursor-pointer"
      style={{
        borderColor: "var(--border)",
        color: "var(--text-secondary)",
        background: "var(--surface)",
      }}
    >
      <span style={{ color: "var(--text-tertiary)" }}>$</span>
      <span>{command}</span>
      <span
        className="ml-auto text-xs opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        style={{ color: "var(--text-tertiary)" }}
      >
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
