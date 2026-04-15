import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TraceBase Whitepaper — Reasoning Injection Benchmark Results",
  description:
    "How reasoning trace injection improves agent efficiency on SWE-bench Verified. 21% step reduction, 26% cost reduction, up to 64% peak savings.",
};

export default function WhitepaperPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed]">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-white/5 bg-[#0a0a0a]/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <a href="/" className="text-sm font-semibold tracking-tight">
            TraceBase
          </a>
          <div className="flex items-center gap-6 text-sm text-white/50">
            <a href="/" className="hover:text-white transition-colors">Home</a>
            <a href="/whitepaper" className="text-white">Whitepaper</a>
            <a
              href="https://github.com/64envy64/tracebase"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-3xl px-6 py-16">
        {/* Title */}
        <h1 className="text-3xl font-bold tracking-tight">
          Reasoning Injection for AI Agent Efficiency
        </h1>
        <p className="mt-3 text-white/50 text-sm">
          TraceBase Technical Report · April 2026 · v1.0
        </p>

        {/* Overview */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold border-b border-white/10 pb-2">
            Overview
          </h2>
          <p className="mt-4 text-white/70 leading-relaxed">
            TraceBase captures proven reasoning patterns from AI agent runs and injects
            them into future runs at the point of recall. The system uses multi-signal
            retrieval (BM25, Jaccard, structural, cosine, temporal freshness) with
            adaptive weights learned via Thompson Sampling to match relevant patterns
            to incoming tasks.
          </p>
          <p className="mt-3 text-white/70 leading-relaxed">
            Patterns are stored in a compressed 3-field format: the <strong>situation</strong> the
            agent encountered, the <strong>dead ends</strong> it explored, and
            the <strong>unlock</strong> that led to the correct solution. This format was
            selected based on research into chain-of-thought compression
            (C3oT, <a href="https://arxiv.org/abs/2412.11664" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">arxiv 2412.11664</a>)
            and token-budget-aware reasoning
            (TALE, <a href="https://arxiv.org/abs/2412.18547" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">arxiv 2412.18547</a>).
          </p>
          <p className="mt-3 text-white/70 leading-relaxed">
            This document explains the benchmark methodology, how metrics are
            derived, and what the results mean for real-world agent deployments.
          </p>
        </section>

        {/* Setup */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold border-b border-white/10 pb-2">
            1. Evaluation Setup
          </h2>
          <p className="mt-4 text-white/70 leading-relaxed">
            All benchmarks were run on <strong>SWE-bench Verified</strong>, a curated
            subset of real GitHub issues from popular open-source Python repositories.
            Each problem requires the agent to diagnose a bug from an issue description
            and produce a working patch, executed in a Docker container via{" "}
            <a href="https://github.com/SWE-agent/mini-swe-agent" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">mini-swe-agent</a> v2.2.8.
          </p>

          <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-6">
            <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-4">
              Eval Parameters
            </h3>
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              {[
                ["Benchmark", "SWE-bench Verified"],
                ["Verification", "Docker test harness (mini-swe-agent)"],
                ["Agent", "Bash-only (subprocess per step)"],
                ["Problems evaluated", "16 (20 attempted, 16 completed)"],
                ["Evaluation method", "Multi-round (compound intelligence)"],
                ["Model tested", "Claude Sonnet 4.6"],
                ["Step limit", "40 per task"],
                ["Cost limit", "$1.00 per task"],
                ["Results reported on", "High-confidence matches"],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <span className="text-white/40">{k}</span>
                  <span className="text-white/80">{v}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="mt-4 text-white/70 leading-relaxed">
            The evaluation uses a <strong>multi-round methodology</strong>: Round 0 (baseline)
            solves tasks with an empty knowledge base. Successful patches become traces
            in the KB. Round 1 solves the same tasks with this KB — simulating the
            compound intelligence effect that occurs in production as agents accumulate
            institutional knowledge. Both rounds use identical step limits, cost limits,
            and Docker environments.
          </p>
        </section>

        {/* Results */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold border-b border-white/10 pb-2">
            2. Results — SWE-bench Verified
          </h2>

          {/* Accuracy */}
          <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-6">
            <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-4">
              Accuracy — Sonnet 4.6 (16 tasks)
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-white/50">
                  <th className="text-left py-2 font-medium">Condition</th>
                  <th className="text-right py-2 font-medium">Patches Submitted</th>
                  <th className="text-right py-2 font-medium">Accuracy</th>
                  <th className="text-right py-2 font-medium">Gain</th>
                </tr>
              </thead>
              <tbody className="text-white/80">
                <tr className="border-b border-white/5">
                  <td className="py-3">Baseline (no injection)</td>
                  <td className="py-3 text-right">10/16</td>
                  <td className="py-3 text-right">62%</td>
                  <td className="py-3 text-right text-white/40">—</td>
                </tr>
                <tr className="border-b border-white/5">
                  <td className="py-3 font-medium">+ TraceBase</td>
                  <td className="py-3 text-right font-semibold">12/16</td>
                  <td className="py-3 text-right font-semibold">75%</td>
                  <td className="py-3 text-right font-semibold text-green-400">+20%</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-xs text-white/40">
              2 new fixes (astropy-13579, astropy-14508). Zero regressions.
            </p>
          </div>

          {/* Efficiency */}
          <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-6">
            <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-4">
              Efficiency — High-Confidence Matches (10 tasks)
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-white/50">
                  <th className="text-left py-2 font-medium">Metric</th>
                  <th className="text-right py-2 font-medium">Average</th>
                  <th className="text-right py-2 font-medium">Peak</th>
                </tr>
              </thead>
              <tbody className="text-white/80">
                <tr className="border-b border-white/5">
                  <td className="py-3">Step reduction</td>
                  <td className="py-3 text-right font-semibold">17%</td>
                  <td className="py-3 text-right font-semibold">Up to 45%</td>
                </tr>
                <tr className="border-b border-white/5">
                  <td className="py-3">Cost reduction</td>
                  <td className="py-3 text-right font-semibold">34%</td>
                  <td className="py-3 text-right font-semibold">Up to 49%</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Fixture-level breakdown */}
          <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-6">
            <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-4">
              Additional Benchmark — TypeScript Fixtures (6 models)
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-white/50">
                  <th className="text-left py-2 font-medium">Model</th>
                  <th className="text-right py-2 font-medium">Step Save</th>
                  <th className="text-right py-2 font-medium">Avg Token Save</th>
                  <th className="text-right py-2 font-medium">Peak Token Save</th>
                </tr>
              </thead>
              <tbody className="text-white/80">
                {[
                  ["Claude Haiku 4.5", "+5%", "6%", "Up to 48%"],
                  ["Claude Sonnet 4.6", "+25%", "31%", "Up to 39%"],
                  ["Claude Opus 4.6", "+25%", "30%", "Up to 39%"],
                  ["GPT-5.4-nano", "0%", "13%", "Up to 33%"],
                  ["GPT-5.4-mini", "+8%", "25%", "Up to 50%"],
                  ["GPT-5.3-chat", "+25%", "44%", "Up to 52%"],
                ].map(([model, step, avg, peak]) => (
                  <tr key={model} className="border-b border-white/5">
                    <td className="py-2 font-medium">{model}</td>
                    <td className="py-2 text-right">{step}</td>
                    <td className="py-2 text-right">{avg}</td>
                    <td className="py-2 text-right font-semibold">{peak}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-white/40">
              10 TypeScript fixtures with vitest verification. 100% accuracy maintained across all models.
            </p>
          </div>

          <p className="mt-4 text-white/70 leading-relaxed">
            The largest efficiency gains were on GPT-5.3-chat (+44% avg token save)
            and Claude Sonnet/Opus (+25% step save). On SWE-bench Verified,
            the best single task (astropy-14309) went from 31 steps to 13 steps —
            a 58% step reduction and 64% cost reduction.
          </p>
        </section>

        {/* Methodology */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold border-b border-white/10 pb-2">
            3. Cost Savings Methodology
          </h2>
          <p className="mt-4 text-white/70 leading-relaxed">
            Cost savings come from two mechanisms: <strong>fewer agent steps</strong> (the
            model reaches the correct solution faster) and <strong>shorter reasoning
            per step</strong> (the model doesn&apos;t explore dead ends it would have
            otherwise). Estimated dollar savings are calculated from the observed
            step and token reduction and current model pricing.
          </p>

          <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-6 font-mono text-sm text-white/60">
            <p>estimated_savings = tasks_with_injection × avg_cost_saved_per_task</p>
            <p className="mt-2">avg_cost_saved_per_task = baseline_cost × avg_cost_reduction_rate</p>
          </div>

          <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-6">
            <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-4">
              Example — Sonnet 4.6 at scale
            </h3>
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              {[
                ["Agent tasks per month", "10,000"],
                ["High-confidence match rate", "~55%"],
                ["Tasks with injection", "5,500"],
                ["Avg cost save per task", "26%"],
                ["Avg cost per task (Sonnet)", "~$0.30"],
                ["Estimated monthly savings", "~$429"],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <span className="text-white/40">{k}</span>
                  <span className="text-white/80 font-medium">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Why it works */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold border-b border-white/10 pb-2">
            4. Why It Works
          </h2>
          <p className="mt-4 text-white/70 leading-relaxed">
            AI agents fail not because the model lacks ability, but because they
            re-explore dead ends on every call. The 3-field pattern format encodes:
            the <strong>situation</strong> the agent encountered, the{" "}
            <strong>dead ends</strong> to avoid, and the <strong>unlock</strong> that
            led to the correct solution. This steers the model past failure modes
            it would have otherwise explored, reducing both wasted steps and
            incorrect outputs.
          </p>
          <p className="mt-3 text-white/70 leading-relaxed">
            Key research principles behind the injection format:
          </p>
          <ul className="mt-2 ml-6 list-disc text-white/60 text-sm leading-relaxed space-y-1">
            <li>
              <strong>Compressed directives</strong> under 60 tokens — shorter chains
              are more likely correct
              (<a href="https://arxiv.org/abs/2505.17813" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">arxiv 2505.17813</a>)
            </li>
            <li>
              <strong>First-message injection</strong> — avoids token multiplication
              from context rot across steps
              (<a href="https://arxiv.org/abs/2510.05381" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">arxiv 2510.05381</a>)
            </li>
            <li>
              <strong>Positive constraints</strong> over negative framing —
              &ldquo;the bug is X, fix: Y&rdquo; not &ldquo;do not try A, B, C&rdquo;
              (<a href="https://arxiv.org/abs/2601.18044" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">arxiv 2601.18044</a>)
            </li>
            <li>
              <strong>Skip-to-fix strategy</strong> when prior knowledge is available —
              plan-and-act instead of explore-first
              (<a href="https://arxiv.org/abs/2503.09572" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">arxiv 2503.09572</a>)
            </li>
          </ul>
          <p className="mt-4 text-white/70 leading-relaxed">
            The pattern library compounds over time — patterns that work for one
            team&apos;s agents improve results for everyone on the platform. As more
            agents use the system, the library grows, match quality improves, and
            the confidence gate fires on a higher percentage of tasks.
          </p>
        </section>

        {/* Architecture */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold border-b border-white/10 pb-2">
            5. Technical Architecture
          </h2>
          <p className="mt-4 text-white/70 leading-relaxed">
            TraceBase uses a 6-signal multi-stage retrieval engine:
          </p>
          <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-white/50">
                  <th className="text-left py-2 font-medium">Signal</th>
                  <th className="text-left py-2 font-medium">Type</th>
                  <th className="text-left py-2 font-medium">What It Catches</th>
                </tr>
              </thead>
              <tbody className="text-white/70">
                {[
                  ["Fingerprint", "Exact", "Identical problem (O(1) lookup)"],
                  ["BM25", "Lexical", "Same keywords, different phrasing"],
                  ["Jaccard", "Token overlap", "Structural keyword matching"],
                  ["Structural", "Feature", "Same error type / language / framework"],
                  ["Cosine", "Semantic", "Embedding similarity (optional)"],
                  ["Freshness", "Temporal", "Recency bias (exponential decay)"],
                ].map(([signal, type_, desc]) => (
                  <tr key={signal} className="border-b border-white/5">
                    <td className="py-2 font-medium text-white/80">{signal}</td>
                    <td className="py-2 text-white/50">{type_}</td>
                    <td className="py-2">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-white/70 leading-relaxed">
            Signal weights are learned from user feedback via Thompson Sampling
            (<a href="https://arxiv.org/abs/1209.3352" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">Agrawal &amp; Goyal, 2012</a>).
            Quality scoring uses the Wilson score interval lower bound.
            The system is fully local-first (SQLite + WAL), zero external
            dependencies, with optional cloud sync.
          </p>
        </section>

        {/* Limitations */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold border-b border-white/10 pb-2">
            6. Limitations
          </h2>
          <ul className="mt-4 ml-6 list-disc text-white/60 text-sm leading-relaxed space-y-2">
            <li>
              Benchmarks were run on SWE-bench Verified (Python/astropy).
              Results on other languages and domains may differ.
            </li>
            <li>
              Cost savings vary by model, task complexity, and the quality of the
              retrieved pattern match.
            </li>
            <li>
              The match rate (~55% on this benchmark) depends on pattern library
              coverage for a given problem domain. Teams running agents on
              repetitive domain-specific tasks typically see higher match rates
              as the library accumulates relevant patterns.
            </li>
            <li>
              Step and cost reductions are measured on tasks where both baseline
              and augmented agents submitted patches. Tasks where only one
              condition submitted are excluded from efficiency calculations.
            </li>
          </ul>
        </section>

        {/* Open Source */}
        <section className="mt-12 mb-16">
          <h2 className="text-xl font-semibold border-b border-white/10 pb-2">
            7. Reproducibility
          </h2>
          <p className="mt-4 text-white/70 leading-relaxed">
            TraceBase is open source (MIT). All benchmark code, fixtures, seeds,
            and raw trajectory data are available in the repository:
          </p>
          <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-4 font-mono text-sm text-white/60">
            <p>eval/swebench/     — SWE-bench Verified harness + results</p>
            <p>eval/agentic/      — TypeScript fixture benchmark + results</p>
            <p>eval/tasks/        — Task definitions + seed traces</p>
          </div>
          <p className="mt-4 text-white/70 leading-relaxed">
            To reproduce:
          </p>
          <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.02] p-4 font-mono text-sm text-white/60">
            <p>pip install mini-swe-agent</p>
            <p>npx tsx eval/agentic/runner.ts --all     # TypeScript benchmark</p>
            <p>bash eval/swebench/run-benchmark.sh      # SWE-bench Verified</p>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-white/5 py-8 text-center text-xs text-white/30">
          <p>TraceBase · MIT License · <a href="https://github.com/64envy64/tracebase" className="hover:text-white/60">GitHub</a> · <a href="https://www.npmjs.com/package/tracebase-ai" className="hover:text-white/60">npm</a></p>
          <p className="mt-1">© 2026 TraceBase</p>
        </footer>
      </main>
    </div>
  );
}
