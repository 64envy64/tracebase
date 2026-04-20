"use client";

import { useState, useCallback, useEffect, useRef } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const copy = useCallback(() => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    navigator.clipboard.writeText(text);
    setCopied(true);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, 1500);
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

export function CopyCommand({ command, onMedia }: { command: string; onMedia?: boolean }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const copy = useCallback(() => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    navigator.clipboard.writeText(command);
    setCopied(true);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, 1500);
  }, [command]);

  return (
    <button
      onClick={copy}
      className="group flex items-center gap-3 px-5 py-3 font-mono text-sm border rounded-md transition-colors duration-150 cursor-pointer"
      style={{
        borderColor: onMedia ? "rgba(255, 255, 255, 0.2)" : "var(--border)",
        color: onMedia ? "rgba(237, 236, 236, 0.88)" : "var(--text-secondary)",
        background: onMedia ? "rgba(0, 0, 0, 0.38)" : "var(--surface)",
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
