import type { EmbeddingProvider } from "../types.js";

/**
 * OpenAI embedding provider using text-embedding-3-small (or configurable model).
 *
 * Usage:
 *   import OpenAI from "openai";
 *   import { ReasoningLayer, createOpenAIEmbeddings } from "tracebase";
 *
 *   const openai = new OpenAI();
 *   const layer = new ReasoningLayer();
 *   layer.setEmbeddingProvider(createOpenAIEmbeddings(openai));
 *
 *   // Now storeTraceAsync/recallAsync use semantic embeddings
 *   const trace = await layer.storeTraceAsync({ ... });
 *   const results = await layer.recallAsync({ problem: "..." });
 */
export function createOpenAIEmbeddings(
  client: OpenAILike,
  opts?: { model?: string; dimensions?: number },
): EmbeddingProvider {
  const model = opts?.model ?? "text-embedding-3-small";
  const dimensions = opts?.dimensions ?? 1536;

  return {
    dimensions,

    async embed(text: string): Promise<number[]> {
      const resp = await client.embeddings.create({
        model,
        input: text,
      });
      return resp.data[0]!.embedding;
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      // OpenAI supports up to 2048 inputs per batch
      const resp = await client.embeddings.create({
        model,
        input: texts,
      });
      return resp.data
        .sort((a: EmbeddingObject, b: EmbeddingObject) => a.index - b.index)
        .map((d: EmbeddingObject) => d.embedding);
    },
  };
}

// Minimal type for OpenAI client — avoids hard dependency on 'openai' package
interface OpenAILike {
  embeddings: {
    create(params: {
      model: string;
      input: string | string[];
    }): Promise<{
      data: EmbeddingObject[];
    }>;
  };
}

interface EmbeddingObject {
  embedding: number[];
  index: number;
}
