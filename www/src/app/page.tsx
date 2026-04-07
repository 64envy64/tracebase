import { CodeBlock } from "@/components/CodeBlock";
import { CopyCommand } from "@/components/CopyButton";

const SETUP_CODE = `import OpenAI from "openai";
import { ReasoningLayer, wrapOpenAI } from "tracebase";

const layer = new ReasoningLayer();
const openai = wrapOpenAI(new OpenAI(), layer, {
  minScore: 0.72
});

// every call: recall → inject prior solution → call LLM → store
await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Fix the CORS error" }]
});`;

const MCP_CONFIG = `{
  "mcpServers": {
    "tracebase": {
      "command": "npx",
      "args": ["tracebase", "serve", "--mcp"]
    }
  }
}`;

const DIRECT_CODE = `const layer = new ReasoningLayer();

// store
layer.storeTrace({
  problem: { description: "ECONNREFUSED calling payment API", tags: [] },
  solution: { summary: "Restarted payment container", steps: [], outcome: "success" }
});

// recall
const results = layer.recall({ problem: "Connection refused payment service" });
console.log(results[0].signals);
// { fingerprint: 0, bm25: 0.72, jaccard: 0.45, structural: 0.38, cosine: 0 }

// feedback improves future recall
layer.feedback(results[0].trace.id, true);`;

const INTEGRATIONS = [
  "Claude Code", "Cursor", "Codex", "GitHub Copilot",
  "Amp", "Windsurf", "Continue", "Aider",
];

export default function Home() {
  return (
    <div className="min-h-screen">
      {/* Nav */}
      <nav
        className="fixed top-0 w-full z-50 border-b"
        style={{ borderColor: "var(--border)", background: "var(--bg)" }}
      >
        <div className="max-w-[1080px] mx-auto px-6 h-12 flex items-center justify-between">
          <span className="text-sm font-light tracking-wide" style={{ color: "var(--text)" }}>
            tracebase
          </span>
          <div className="flex items-center gap-8">
            <a href="#how" className="text-xs font-light" style={{ color: "var(--text-secondary)" }}>How it works</a>
            <a href="#setup" className="text-xs font-light" style={{ color: "var(--text-secondary)" }}>Setup</a>
            <a href="#pricing" className="text-xs font-light" style={{ color: "var(--text-secondary)" }}>Pricing</a>
            <a
              href="https://github.com/64envy64/tracebase"
              className="text-xs font-light"
              style={{ color: "var(--text-secondary)" }}
              target="_blank" rel="noopener noreferrer"
            >
              GitHub
            </a>
          </div>
        </div>
      </nav>

      <main className="max-w-[1080px] mx-auto px-6">
        {/* Hero */}
        <section className="pt-36 pb-24">
          <h1 className="text-[42px] sm:text-[56px] font-extralight leading-[1.1] tracking-tight mb-6">
            Agents that compound
            <br />
            their own intelligence.
          </h1>
          <p className="text-base font-light leading-relaxed max-w-xl mb-10" style={{ color: "var(--text-secondary)" }}>
            TraceBase captures every solved problem as a reasoning trace and
            feeds it back into future runs. Your agents don&apos;t just execute &mdash;
            they accumulate expertise. Every run is built on every run before it.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <CopyCommand command="npm install tracebase" />
          </div>
        </section>

        {/* Divider */}
        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* How it works */}
        <section className="py-24" id="how">
          <p className="text-xs font-light tracking-widest uppercase mb-8" style={{ color: "var(--text-tertiary)" }}>
            How it works
          </p>
          <h2 className="text-[32px] font-extralight tracking-tight mb-4">
            Install once. Save on every call.
          </h2>
          <p className="text-sm font-light leading-relaxed max-w-lg mb-16" style={{ color: "var(--text-secondary)" }}>
            The middleware sits between your code and the LLM. Before each call it checks
            memory. After each call it stores the result. No manual work.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px" style={{ background: "var(--border)" }}>
            {[
              { n: "01", title: "Recall", desc: "Check memory for similar problems solved before." },
              { n: "02", title: "Inject", desc: "Add prior solution to system prompt as a hint." },
              { n: "03", title: "Call", desc: "LLM solves faster with context. Fewer tokens." },
              { n: "04", title: "Store", desc: "New trace captured. Memory grows automatically." },
            ].map((s) => (
              <div key={s.n} className="p-6" style={{ background: "var(--bg)" }}>
                <span className="text-xs font-mono block mb-4" style={{ color: "var(--text-tertiary)" }}>{s.n}</span>
                <span className="text-base font-light block mb-2">{s.title}</span>
                <span className="text-xs font-light leading-relaxed block" style={{ color: "var(--text-secondary)" }}>{s.desc}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* Integrations */}
        <section className="py-24">
          <p className="text-xs font-light tracking-widest uppercase mb-8" style={{ color: "var(--text-tertiary)" }}>
            Integrations
          </p>
          <h2 className="text-[32px] font-extralight tracking-tight mb-4">
            Works with any agent.
          </h2>
          <p className="text-sm font-light leading-relaxed max-w-lg mb-12" style={{ color: "var(--text-secondary)" }}>
            MCP server for AI IDEs. SDK middleware for OpenAI and Anthropic. Generic wrapper for custom agents.
          </p>
          <div className="flex flex-wrap gap-3">
            {INTEGRATIONS.map((name) => (
              <span
                key={name}
                className="px-4 py-2 text-xs font-light border rounded-sm"
                style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
              >
                {name}
              </span>
            ))}
            <span
              className="px-4 py-2 text-xs font-light border rounded-sm"
              style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
            >
              + any MCP client
            </span>
          </div>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* Features */}
        <section className="py-24">
          <p className="text-xs font-light tracking-widest uppercase mb-8" style={{ color: "var(--text-tertiary)" }}>
            Under the hood
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-10">
            {[
              { title: "Multi-signal ranking", desc: "Fingerprint, BM25, Jaccard, structural, cosine. Two-stage retrieval." },
              { title: "Adaptive weights", desc: "Thompson Sampling learns optimal signal weights from your feedback." },
              { title: "Recall-before-call", desc: "Middleware recalls and injects prior solutions automatically." },
              { title: "Streaming", desc: "Full stream:true support. Traces captured after stream completes." },
              { title: "Local-first", desc: "SQLite with WAL. Sub-millisecond recall. Data stays on your machine." },
              { title: "Embeddings", desc: "Optional cosine similarity via OpenAI text-embedding-3-small." },
            ].map((f) => (
              <div key={f.title}>
                <h3 className="text-sm font-normal mb-2">{f.title}</h3>
                <p className="text-xs font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* Setup */}
        <section className="py-24" id="setup">
          <p className="text-xs font-light tracking-widest uppercase mb-8" style={{ color: "var(--text-tertiary)" }}>
            Setup
          </p>
          <h2 className="text-[32px] font-extralight tracking-tight mb-12">
            Three ways to use.
          </h2>

          {/* Tab 1: SDK */}
          <div className="mb-16">
            <h3 className="text-sm font-normal mb-1">SDK Middleware</h3>
            <p className="text-xs font-light mb-4" style={{ color: "var(--text-secondary)" }}>
              Wrap your OpenAI or Anthropic client. Every call is optimized.
            </p>
            <CodeBlock code={SETUP_CODE} filename="agent.ts" />
          </div>

          {/* Tab 2: MCP */}
          <div className="mb-16">
            <h3 className="text-sm font-normal mb-1">MCP Server</h3>
            <p className="text-xs font-light mb-4" style={{ color: "var(--text-secondary)" }}>
              For Claude Code, Cursor, and any MCP-compatible IDE.
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <CodeBlock code={MCP_CONFIG} filename="claude_desktop_config.json" />
              <div className="flex flex-col gap-4">
                <CopyCommand command="npx tracebase serve --mcp" />
                <p className="text-xs font-light leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
                  Claude Code gets two tools: recall (before solving) and store (after solving).
                  Memory accumulates across sessions automatically.
                </p>
              </div>
            </div>
          </div>

          {/* Tab 3: Direct */}
          <div>
            <h3 className="text-sm font-normal mb-1">Direct SDK</h3>
            <p className="text-xs font-light mb-4" style={{ color: "var(--text-secondary)" }}>
              Full control over when to store, recall, and provide feedback.
            </p>
            <CodeBlock code={DIRECT_CODE} filename="custom.ts" />
          </div>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* Pricing */}
        <section className="py-24" id="pricing">
          <p className="text-xs font-light tracking-widest uppercase mb-8" style={{ color: "var(--text-tertiary)" }}>
            Pricing
          </p>
          <h2 className="text-[32px] font-extralight tracking-tight mb-12">
            Open source. Free forever.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-px max-w-3xl" style={{ background: "var(--border)" }}>
            <div className="p-8" style={{ background: "var(--bg)" }}>
              <h3 className="text-sm font-normal mb-1">Self-hosted</h3>
              <p className="text-[28px] font-extralight mb-6">$0</p>
              <ul className="space-y-2.5">
                {[
                  "Local SQLite storage",
                  "Recall-before-call injection",
                  "Adaptive weight learning",
                  "MCP / HTTP / SDK",
                  "Streaming support",
                  "Embeddings (BYO key)",
                  "CLI tools",
                  "100K traces",
                ].map((f) => (
                  <li key={f} className="text-xs font-light" style={{ color: "var(--text-secondary)" }}>{f}</li>
                ))}
              </ul>
            </div>
            <div className="p-8" style={{ background: "var(--bg)" }}>
              <h3 className="text-sm font-normal mb-1">Cloud</h3>
              <p className="text-[28px] font-extralight mb-6" style={{ color: "var(--text-tertiary)" }}>Soon</p>
              <ul className="space-y-2.5">
                {[
                  "Everything in self-hosted",
                  "Cross-team sync",
                  "Encrypted backups",
                  "Analytics dashboard",
                  "Team management",
                  "Managed embeddings",
                  "Retention policies",
                  "Priority support",
                ].map((f) => (
                  <li key={f} className="text-xs font-light" style={{ color: "var(--text-tertiary)" }}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* CTA */}
        <section className="py-24">
          <h2 className="text-[28px] font-extralight tracking-tight mb-4">
            Stop paying for the same reasoning twice.
          </h2>
          <p className="text-sm font-light mb-8" style={{ color: "var(--text-secondary)" }}>
            One install. Agents that get better with every run.
          </p>
          <CopyCommand command="npm install tracebase" />
        </section>

        {/* Footer */}
        <footer
          className="border-t py-6 flex items-center justify-between"
          style={{ borderColor: "var(--border)" }}
        >
          <span className="text-xs font-light" style={{ color: "var(--text-tertiary)" }}>
            MIT &middot; tracebase
          </span>
          <div className="flex items-center gap-6">
            <a href="https://github.com/64envy64/tracebase" className="text-xs font-light" style={{ color: "var(--text-tertiary)" }} target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="https://www.npmjs.com/package/tracebase" className="text-xs font-light" style={{ color: "var(--text-tertiary)" }} target="_blank" rel="noopener noreferrer">npm</a>
          </div>
        </footer>
      </main>
    </div>
  );
}
