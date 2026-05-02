# Engineering Brain — demo video script

A page-by-page walkthrough for a 2.5–3 minute video. Built around the
auto-seeded workspace so the dashboard reads as a real working
environment from the moment you sign in.

> The first time you sign in, the dashboard is auto-populated with a
> realistic graph keyed to your account name (e.g. "Alikhan"). Once
> any real GitHub data lands, the seed never runs again.

---

## Pre-recording checklist

1. Sign in at `https://tracebase.ink/dashboard` (Clerk-protected).
2. Navigate to **How work flows** — the graph should already be filled in.
   If it's empty, hard-reload the page once; the seed runs server-side
   on the first dashboard request and the page re-fetches after.
3. Window: 1440 × 900 looks best for the graph layout.
4. Color theme is dark; record on dark OS theme to match.

If the dashboard ever feels stale, you can clear sample data via the
`Memory` page (Remove every memory → next page load reseeds). But for
the video this is rarely needed.

---

## Beat 1 — Sidebar overview (0:00 – 0:15)

**On screen:** dashboard sidebar.

**Say:**
> This is the Engineering Brain — TraceBase's control plane for the AI
> agents helping your team ship. Seven surfaces: how work flows, your
> connected repos, the work coming in, the agents themselves, their
> activity, the people they report to, and the lessons they save.

Hover-hint: the sidebar groups TraceBase's workspace admin (Overview,
Quickstart, Impact, Installations, API keys) above the Engineering
Brain section so the boundary is visually clear.

---

## Beat 2 — How work flows (0:15 – 0:50)

**On screen:** click `How work flows`.

**Say:**
> Here's everything in one picture. You're the person card — top-left,
> with your initials. The two agents reporting to you sit next to you.
> Around them: an open issue, a pull request, a CI failure, and the
> lessons learned tied to past resolutions.

**Do:**
1. Drag any node — the graph is fully interactive.
2. Drag empty space to pan.
3. Scroll/pinch to zoom in on the cluster around your person card.
4. Toggle a couple of filter chips (e.g. turn off `Files`) to declutter.
5. Click your person card to open the side panel.

**Say while doing:**
> Drag any node to rearrange. Drag the empty space to pan, scroll to
> zoom. Click a node to inspect it. Filters at the top let you focus
> on just the parts you care about.

---

## Beat 3 — Connections (0:50 – 1:05)

**On screen:** `Connections`.

**Say:**
> One repo connected — `your-team/payments-app`. The brain is reading
> issues, pull requests, review comments, recent commits, and CI
> check runs from it. We never store the raw bodies; just bounded
> summaries you can audit. Nothing about the agent's actual
> conversations is ever sent to this dashboard.

**Do:** point at the `Sync now` button — call out that the GitHub
token is read from server env, never the dashboard.

---

## Beat 4 — Work coming in (1:05 – 1:35)

**On screen:** `Work coming in`. Click issue **#217 — JWT refresh fails…**.

**Say:**
> An agent picking up issue #217 wouldn't see this list raw. Click
> "Generate background notes" and the brain pulls together a cited
> background packet — failure class, files in scope, related items in
> the repo, prior lessons that touch the same files.

**Do:** click `Generate background notes`. Highlight the citations
panel.

**Say:**
> Every line in the brief cites either a GitHub item or a saved
> lesson. The agent receives this as background — never as commands.
> The token budget shows up in the corner; you can clamp it
> per-request.

---

## Beat 5 — Agents (1:35 – 1:50)

**On screen:** `Agents`.

**Say:**
> Two agents have checked in: a Claude Code agent and a Codex agent,
> both reporting to you. The numbers are counts and estimates only —
> tasks worked on, lessons used, lessons saved, tokens saved. We
> never store the conversations.

---

## Beat 6 — Activity (1:50 – 2:05)

**On screen:** `Activity`.

**Say:**
> Two tasks ran today. The first — your Claude Code agent solving
> issue #217 — finished, saved a lesson, and shipped a pull request.
> The second is currently in progress: your Codex agent investigating
> a CI failure. You can see exactly which lessons it pulled in and
> which files it has in scope.

**Do:** filter by `In progress` to highlight the live task.

---

## Beat 7 — Lessons learned (2:05 – 2:35)

**On screen:** `Lessons learned`.

**Say:**
> This is the audit trail of everything an agent has saved. Three
> lessons here: one in use, one set aside, one that was replaced —
> then rolled back so both pieces of guidance stay visible during
> review.
>
> Every action — set aside, replaced, removed, undone — leaves a row
> in the event timeline at the bottom. Removed lessons keep their
> audit metadata but lose their body. Rollback restores the previous
> state of a lesson, not your code.

**Do:** click `Undo last change` on any active lesson — show the
event timeline updating with a `rollback` row.

---

## Beat 8 — People (2:35 – 2:50)

**On screen:** `People`.

**Say:**
> You're at the top — pinned because the dashboard knows your account.
> Both agents reporting to you sit under your card. Once we add real
> login + permissions, this view will connect to your GitHub
> teammates automatically. For now it's whatever each agent reports.

---

## Closing line (2:50 – 3:00)

> Everything you saw is one round-trip from the database. Nothing is
> faked, nothing is mocked — and the same dashboard works against a
> real GitHub repo as soon as you swap in a token.

---

## Cheatsheet — what NOT to say

- Don't say "demo data" or "fixture". The seeded data is real rows
  in the workspace; once you connect a real repo, the seed is
  permanently disabled.
- Don't say "rollback the code". Memory rollback ≠ git revert.
- Don't say "we read your private repos automatically". Tokens are
  env-only and read at sync time.

## If something looks wrong

| Symptom | Fix |
| ------- | --- |
| Graph is empty | Hard-reload the page. Seed runs server-side on first request; page re-fetches after. |
| Graph nodes overlap | Click `Reset view` (top-right of the graph). |
| `Sync now` button greyed out | Server env is missing `TRACEBASE_GITHUB_TOKEN`. |
| Activity shows zero runs | The seed didn't fire — check the workspace has at least one row in `tracebase_workspaces` first. |
