#!/usr/bin/env tsx
/**
 * Supply miner — discover MORE real bug-fix candidates from the high-yield
 * repos beyond the file-memory pilot's pool (it capped at the 60 most-recent
 * fix commits / 24 months / source LOC ≤20). Same deterministic git-metadata
 * filter; relaxed window + cap; excludes commits already in the known pool so
 * box-4c never re-checks a known task. NO installs, NO test runs here.
 *
 *   TB_REPOS=~/file-memory-real-repos/repos \
 *   tsx mine-candidates.ts > /dev/null   # writes mined-candidates.json
 *
 * Env: TB_REPOS (clones dir), TB_TARGETS (csv repo list), TB_SINCE_MONTHS (48),
 *   TB_SLICE (250), TB_SRC_MAX (25), TB_KNOWN_POOL (candidate-pool.json),
 *   TB_OUT (mined-candidates.json on the worktree).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPOS_DIR = process.env.TB_REPOS ?? join(process.env.HOME ?? ROOT, "file-memory-real-repos", "repos");
const SINCE_MONTHS = parseInt(process.env.TB_SINCE_MONTHS ?? "48", 10);
const SLICE = parseInt(process.env.TB_SLICE ?? "250", 10);
const SRC_MAX = parseInt(process.env.TB_SRC_MAX ?? "25", 10);
// Comma-separated list so a later pass can exclude BOTH the original pool and
// the first mining batch (no re-checking already-known/already-mined commits).
const KNOWN_POOLS = (process.env.TB_KNOWN_POOLS ?? process.env.TB_KNOWN_POOL ?? join(ROOT, "bench-runs", "file-memory-real-repos", "candidate-pool.json")).split(",").map((s) => s.trim()).filter(Boolean);
const OUT = process.env.TB_OUT ?? join(ROOT, "bench-runs", "file-memory-real-repos", "mined-candidates.json");

interface RepoCfg { name: string; dir: string; sourceExts: string[]; testPatterns: RegExp[]; }
const REPOS: Record<string, RepoCfg> = {
  "colinhacks/zod": { name: "colinhacks/zod", dir: "colinhacks-zod", sourceExts: ["ts", "tsx", "js", "mjs"], testPatterns: [/\.test\.(ts|tsx|js)$/, /^src\/.*\/tests?\//] },
  "josdejong/mathjs": { name: "josdejong/mathjs", dir: "josdejong-mathjs", sourceExts: ["js", "mjs"], testPatterns: [/^test\//, /\.test\.(js|mjs)$/] },
  "Textualize/rich": { name: "Textualize/rich", dir: "Textualize-rich", sourceExts: ["py"], testPatterns: [/^tests\//, /\/test_/, /^test_/] },
  "psf/black": { name: "psf/black", dir: "psf-black", sourceExts: ["py"], testPatterns: [/^tests\//, /\/test_/, /^test_/] },
  "axios/axios": { name: "axios/axios", dir: "axios-axios", sourceExts: ["js", "mjs", "cjs"], testPatterns: [/^tests?\//, /\.test\.(js|mjs)$/, /\.spec\.js$/] },
  "pallets/werkzeug": { name: "pallets/werkzeug", dir: "pallets-werkzeug", sourceExts: ["py"], testPatterns: [/^tests\//, /\/test_/, /^test_/] },
};
const TARGETS = (process.env.TB_TARGETS ?? "colinhacks/zod,josdejong/mathjs,Textualize/rich").split(",").map((s) => s.trim()).filter(Boolean);

function git(cwd: string, args: string[]): string {
  try { return execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch { return ""; }
}

const known = new Set<string>();
for (const kp of KNOWN_POOLS) {
  if (existsSync(kp)) { try { for (const c of JSON.parse(readFileSync(kp, "utf-8")).candidates ?? []) known.add(c.pr_commit); } catch { /* */ } }
}

const since = new Date(Date.now() - SINCE_MONTHS * 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const candidates: any[] = [];
const stats: Record<string, any> = {};

for (const t of TARGETS) {
  const cfg = REPOS[t];
  if (!cfg) { console.error(`unknown target ${t}`); continue; }
  const dir = join(REPOS_DIR, cfg.dir);
  if (!existsSync(dir)) { console.error(`MISSING ${dir}`); continue; }
  const raw = git(dir, ["log", "--first-parent", `--since=${since}`, "--grep=fix", "--grep=bug", "-i", "--format=%H%x09%s"]);
  const lines = raw.split("\n").filter((l) => l.includes("\t")).slice(0, SLICE);
  let kept = 0, exKnown = 0, exShape = 0;
  for (const line of lines) {
    const i = line.indexOf("\t");
    const sha = line.slice(0, i); const title = line.slice(i + 1);
    if (known.has(sha)) { exKnown++; continue; }
    const parent = git(dir, ["rev-parse", `${sha}~1`]);
    if (!parent) continue;
    const numstat = git(dir, ["diff", "--numstat", parent, sha]);
    if (!numstat) continue;
    const test: string[] = [], source: string[] = [];
    let srcAdded = 0, srcRemoved = 0;
    for (const row of numstat.split("\n")) {
      const m = row.split("\t"); if (m.length < 3) continue;
      const add = parseInt(m[0], 10) || 0, rem = parseInt(m[1], 10) || 0, path = m[2];
      const ext = (path.split(".").pop() ?? "").toLowerCase();
      if (cfg.testPatterns.some((re) => re.test(path))) test.push(path);
      else if (cfg.sourceExts.includes(ext)) { source.push(path); srcAdded += add; srcRemoved += rem; }
    }
    const srcNet = srcAdded + srcRemoved;
    if (test.length >= 1 && srcNet > 0 && srcNet <= SRC_MAX && source.length > 0) {
      candidates.push({ repo: cfg.name, pr_commit: sha, parent_commit: parent, title: title.slice(0, 200), test_files_touched: test, source_files_touched: source, source_loc_added: srcAdded, source_loc_removed: srcRemoved, source_loc_net: srcNet, discovered_status: "MINED" });
      kept++;
    } else exShape++;
  }
  stats[t] = { scanned: lines.length, kept, excluded_known: exKnown, excluded_shape: exShape };
  console.error(`${t}: scanned ${lines.length}, kept ${kept}, known ${exKnown}, shape ${exShape}`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ phase: "supply mining (relaxed)", since, slice: SLICE, srcMax: SRC_MAX, targets: TARGETS, stats, candidates }, null, 2));
console.error(`\nMINED ${candidates.length} new candidates → ${OUT}`);
