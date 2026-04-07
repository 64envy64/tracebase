"use client";

import { CopyButton } from "./CopyButton";

export function CodeBlock({
  code,
  filename,
}: {
  code: string;
  filename?: string;
}) {
  return (
    <div
      className="rounded-md overflow-hidden border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      {filename && (
        <div
          className="px-4 py-2.5 text-xs flex items-center justify-between border-b"
          style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
        >
          <span>{filename}</span>
          <CopyButton text={code} />
        </div>
      )}
      <pre className="px-4 py-4 text-[13px] leading-[1.7] overflow-x-auto">
        <code style={{ color: "var(--text-secondary)" }}>{code}</code>
      </pre>
    </div>
  );
}
