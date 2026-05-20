"use client";

import { useId, useState, type FormEvent } from "react";

type WaitlistFormProps = {
  onMedia?: boolean;
  size?: "default" | "large";
};

type Status = "idle" | "submitting" | "success" | "error";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WaitlistForm({ onMedia = false, size = "default" }: WaitlistFormProps) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const isLarge = size === "large";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setStatus("error");
      setMessage("Enter a valid email address.");
      return;
    }

    setStatus("submitting");
    setMessage(null);

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setStatus("error");
        setMessage(data.error ?? "Could not save your email. Try again.");
        return;
      }
      setStatus("success");
      setMessage("You're on the list. We'll be in touch.");
      setEmail("");
    } catch {
      setStatus("error");
      setMessage("Network error. Try again.");
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className={`waitlist-form group relative flex w-full max-w-[22rem] items-center rounded-full border transition-colors duration-200 ${
        isLarge ? "h-12 pl-5 pr-1.5 sm:h-[52px]" : "h-10 pl-4 pr-1"
      }`}
      style={{
        borderColor: onMedia ? "rgba(232, 217, 184, 0.22)" : "var(--border)",
        background: onMedia ? "rgba(6, 10, 13, 0.55)" : "var(--surface)",
      }}
      aria-label="Join the TraceBase waitlist"
    >
      <label htmlFor={`${id}-email`} className="sr-only">
        Email address
      </label>
      <input
        id={`${id}-email`}
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        placeholder="you@company.com"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (status === "error" || status === "success") {
            setStatus("idle");
            setMessage(null);
          }
        }}
        disabled={status === "submitting" || status === "success"}
        aria-invalid={status === "error"}
        aria-describedby={message ? `${id}-msg` : undefined}
        className={`flex-1 min-w-0 bg-transparent outline-none placeholder:opacity-60 disabled:opacity-70 ${
          isLarge ? "text-sm" : "text-[13px]"
        }`}
        style={{
          color: onMedia ? "rgba(232, 217, 184, 0.92)" : "var(--text)",
        }}
      />
      <button
        type="submit"
        disabled={status === "submitting" || status === "success"}
        className={`shrink-0 rounded-full font-medium tracking-tight transition-[background-color,border-color,color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-70 ${
          isLarge ? "h-9 px-4 text-[13px] sm:h-10 sm:px-5 sm:text-sm" : "h-8 px-3.5 text-[12.5px]"
        }`}
        style={{
          background: "var(--accent)",
          color: "#000",
          border: "1px solid var(--accent)",
        }}
      >
        {status === "submitting" ? "…" : status === "success" ? "Joined" : "Join waitlist"}
      </button>
      {message ? (
        <p
          id={`${id}-msg`}
          role={status === "error" ? "alert" : "status"}
          className="pointer-events-none absolute left-0 right-0 top-full mt-2 px-3 text-left font-mono text-[10.5px] uppercase tracking-[0.22em]"
          style={{
            color: status === "error" ? "var(--accent)" : onMedia ? "rgba(232, 217, 184, 0.75)" : "var(--text-secondary)",
          }}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}
