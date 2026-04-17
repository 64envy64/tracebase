"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SESSION_COOKIE = "tb_session=admin; path=/; max-age=86400; samesite=lax";

const fieldClassName =
  "h-11 w-full rounded-md border px-3 font-mono text-sm outline-none transition-[border-color] " +
  "focus-visible:border-[rgba(237,236,236,0.22)]";

const fieldStyle = {
  borderColor: "var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
} as const;

export function LoginForm({ nextPath = "/dashboard" }: { nextPath?: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    if (username === "admin" && password === "admin") {
      document.cookie = SESSION_COOKIE;
      router.push(nextPath);
      router.refresh();
      return;
    }

    setLoading(false);
    setError("Invalid credentials");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <div className="space-y-2">
        <label
          htmlFor="username"
          className="text-[11px] font-mono uppercase tracking-[0.18em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          Username
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className={fieldClassName}
          style={fieldStyle}
        />
      </div>

      <div className="space-y-2">
        <label
          htmlFor="password"
          className="text-[11px] font-mono uppercase tracking-[0.18em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={fieldClassName}
          style={fieldStyle}
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border px-3 py-2 text-sm font-light"
          style={{
            borderColor: "rgba(242, 197, 114, 0.22)",
            background: "var(--warning-soft)",
            color: "var(--warning)",
          }}
        >
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={loading}
        className="flex h-11 w-full items-center justify-center rounded-md border px-4 font-mono text-sm transition-[opacity] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
        }}
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>

    </form>
  );
}