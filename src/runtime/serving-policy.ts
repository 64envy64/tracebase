import type { BuildInjectionPayloadOptions } from "../core/build-injection-payload.js";
import type { FileHit } from "../core/file-indexer.js";
import type { ToolPatternSignal } from "../core/tool-loop-detect.js";

export type ServingProfile = "cost-saver" | "balanced" | "recall-heavy";

export interface ServingPlan
  extends Required<
    Pick<
      BuildInjectionPayloadOptions,
      "tokenBudget" | "maxBlocks" | "maxFacts" | "maxFiles" | "maxChunks"
    >
  > {
  profile: ServingProfile;
  fileHitsK: number;
  chunkHitsK: number;
  minFileNetTokens: number;
  minChunkNetTokens: number;
}

export interface ResolveServingPlanInput {
  profile?: ServingProfile | string | null;
  tokenBudget?: number;
  signalKind?: ToolPatternSignal["kind"];
  hasSession?: boolean;
}

export const DEFAULT_SERVING_PROFILE: ServingProfile = "cost-saver";
export const COST_SAVER_TOKEN_BUDGET = 350;
export const COST_SAVER_RECOVERY_TOKEN_BUDGET = 500;
export const COST_SAVER_MIN_FILE_NET_TOKENS = 32;
export const COST_SAVER_MIN_CHUNK_NET_TOKENS = 120;

const PROFILE_ENV = "TRACEBASE_SERVING_PROFILE";
const CHARS_PER_TOKEN = 4;
const FILE_LINE_MAX_CHARS = 220;

export function resolveServingProfile(
  raw: string | null | undefined = process.env[PROFILE_ENV],
): ServingProfile {
  const value = raw?.trim().toLowerCase();
  if (value === "balanced") return "balanced";
  if (value === "recall-heavy" || value === "recall_heavy" || value === "heavy") {
    return "recall-heavy";
  }
  if (value === "cost-saver" || value === "cost_saver" || value === "roi" || value === "") {
    return "cost-saver";
  }
  return DEFAULT_SERVING_PROFILE;
}

export function resolveServingPlan(input: ResolveServingPlanInput = {}): ServingPlan {
  const profile = resolveServingProfile(input.profile ?? undefined);
  const requestedBudget = saneBudget(input.tokenBudget);
  const recovering = input.signalKind !== undefined && input.signalKind !== "none";
  const hasSession = input.hasSession === true;

  if (profile === "recall-heavy") {
    return {
      profile,
      tokenBudget: requestedBudget ?? 1200,
      maxBlocks: 4,
      maxFacts: 4,
      maxFiles: 3,
      maxChunks: hasSession ? 3 : 0,
      fileHitsK: 3,
      chunkHitsK: hasSession ? 3 : 0,
      minFileNetTokens: 0,
      minChunkNetTokens: 0,
    };
  }

  if (profile === "balanced") {
    const cap = recovering ? 900 : 700;
    return {
      profile,
      tokenBudget: Math.min(requestedBudget ?? cap, cap),
      maxBlocks: recovering ? 3 : 2,
      maxFacts: 2,
      maxFiles: 2,
      maxChunks: hasSession ? 2 : 0,
      fileHitsK: 4,
      chunkHitsK: hasSession ? 3 : 0,
      minFileNetTokens: 12,
      minChunkNetTokens: 80,
    };
  }

  const cap = recovering ? COST_SAVER_RECOVERY_TOKEN_BUDGET : COST_SAVER_TOKEN_BUDGET;
  return {
    profile,
    tokenBudget: Math.min(requestedBudget ?? cap, cap),
    maxBlocks: recovering ? 2 : 1,
    maxFacts: 1,
    maxFiles: 1,
    maxChunks: hasSession ? 1 : 0,
    fileHitsK: 3,
    chunkHitsK: hasSession ? 2 : 0,
    minFileNetTokens: COST_SAVER_MIN_FILE_NET_TOKENS,
    minChunkNetTokens: COST_SAVER_MIN_CHUNK_NET_TOKENS,
  };
}

export function filterFileHitsForRoi(
  hits: readonly FileHit[],
  plan: Pick<ServingPlan, "minFileNetTokens" | "maxFiles">,
): FileHit[] {
  if (plan.maxFiles <= 0) return [];
  const minNet = Math.max(0, plan.minFileNetTokens);
  return hits
    .filter((hit) => minNet <= 0 || estimateFileNetTokens(hit) >= minNet)
    .slice(0, plan.maxFiles);
}

export function filterChunkHitsForRoi<T extends {
  tokensBefore: number;
  tokensAfter: number;
}>(
  hits: readonly T[],
  plan: Pick<ServingPlan, "minChunkNetTokens" | "maxChunks">,
): T[] {
  if (plan.maxChunks <= 0) return [];
  const minNet = Math.max(0, plan.minChunkNetTokens);
  return hits
    .filter((hit) => minNet <= 0 || hit.tokensBefore - hit.tokensAfter >= minNet)
    .slice(0, plan.maxChunks);
}

export function estimateFileNetTokens(hit: FileHit): number {
  const fullFileTokens = Math.ceil(Math.max(0, hit.sizeBytes ?? 0) / CHARS_PER_TOKEN);
  return fullFileTokens - estimateFileInjectionTokens(hit);
}

export function estimateFileInjectionTokens(hit: FileHit): number {
  const line = `* ${hit.relPath}: ${trimSentence(hit.summary)}`;
  const clamped = Math.min(line.length, FILE_LINE_MAX_CHARS);
  // Include a small share of the file_memory tag wrapper so tiny files do
  // not look artificially profitable.
  return Math.ceil((clamped + 32) / CHARS_PER_TOKEN);
}

function saneBudget(raw: number | undefined): number | null {
  if (raw === undefined) return null;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(Math.floor(raw), 2200);
}

function trimSentence(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
}
