import { normalize } from "./stage1.js";
import { validate } from "./stage2.js";
import { transform } from "./stage3.js";
import { emit } from "./stage4.js";

export interface PipelineInput {
  rows: Array<{ raw: string }>;
}

export interface PipelineOutput {
  rejected: number;
  emitted: string[];
}

export function runPipeline(input: PipelineInput): PipelineOutput {
  const normed = normalize(input.rows);
  if (!validate(normed)) {
    return { rejected: normed.length, emitted: [] };
  }
  const xformed = transform(normed);
  return { rejected: 0, emitted: emit(xformed) };
}
