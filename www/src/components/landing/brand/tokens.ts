/**
 * Brand tokens for tracebase.ink. Single source of truth — every component
 * in /components/landing pulls hex values and capability metadata from here.
 */

/**
 * Strict brand palette for tracebase.ink — ink/bone/ember with two warm
 * accents. No teals, no mauves. Every coloured surface on the landing is
 * built from this set.
 */
export const INK = {
  ink: "#0a1014",
  inkDeep: "#060a0d",
  abyss: "#15232a",
  shoal: "#1f3942",
  bone: "#e8d9b8",
  pearl: "#f5ecd6",
  sand: "#c8b58e",
  ember: "#ff7a5c",
  emberSoft: "#ffa083",
  coral: "#b84f38",
  amber: "#e0b458",
} as const;

export type ChipTone = "ember" | "coral" | "amber" | "sand" | "neutral";

export const CHIP_COLORS: Record<ChipTone, { fill: string; text: string; border: string }> = {
  ember: { fill: "rgba(255,122,92,0.18)", text: INK.ember, border: "rgba(255,122,92,0.42)" },
  coral: { fill: "rgba(184,79,56,0.20)", text: "#ef8a74", border: "rgba(184,79,56,0.48)" },
  amber: { fill: "rgba(224,180,88,0.18)", text: INK.amber, border: "rgba(224,180,88,0.44)" },
  sand: { fill: "rgba(200,181,142,0.16)", text: INK.sand, border: "rgba(200,181,142,0.36)" },
  neutral: { fill: "rgba(232,217,184,0.08)", text: "rgba(232,217,184,0.78)", border: "rgba(232,217,184,0.22)" },
};

export type CapabilityId = "recall" | "gist" | "loop" | "guard" | "fold";

export type Capability = {
  id: CapabilityId;
  number: string;
  name: string;
  title: string;
  line: string;
  tone: ChipTone;
};

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "recall",
    number: "01",
    name: "Recall",
    title: "Reasoning reuse",
    line: "Surfaces past solutions when a similar problem returns.",
    tone: "ember",
  },
  {
    id: "gist",
    number: "02",
    name: "Gist",
    title: "Semantic file memory",
    line: "Recalls what a file means without re-reading it.",
    tone: "sand",
  },
  {
    id: "loop",
    number: "03",
    name: "Loop",
    title: "Loop detection",
    line: "Catches doom loops mid-run and injects a redirect.",
    tone: "coral",
  },
  {
    id: "guard",
    number: "04",
    name: "Guard",
    title: "Tool supervision",
    line: "Spots redundant fetches before they compound on the bill.",
    tone: "amber",
  },
  {
    id: "fold",
    number: "05",
    name: "Fold",
    title: "Context compression",
    line: "Folds older turns into summaries so long horizons stay coherent.",
    tone: "neutral",
  },
] as const;
