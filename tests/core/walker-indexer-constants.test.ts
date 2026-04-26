/**
 * Locked-constants regression — file-walker.ts vs file-indexer.ts
 * (PLAN-0.7 §rc.2 hardening follow-up, called out at rc.2 review).
 *
 * The walker (BFS path) and the single-file indexer (exact-file
 * path) BOTH apply the same exclusion-suffix list and null-byte
 * sniff threshold. Pre-rc.3 those constants were duplicated
 * literally; if a future commit added (say) `.tsbuildinfo` to the
 * walker's list but forgot the indexer's, the two paths would
 * silently diverge and a write-tool-touched .tsbuildinfo would
 * land in indexed_files via the drain path while never being
 * surfaced via a fresh init walk.
 *
 * This test pins both lists + the null-sniff threshold to be
 * byte-identical until they're physically deduped before 0.7.0
 * stable. Replacing the duplication with one shared module is
 * the right long-term fix; this test is the forcing function
 * that keeps the two paths honest in the meantime.
 */
import { describe, it, expect } from "vitest";
import {
  EXCLUDED_SUFFIXES as WALKER_SUFFIXES,
  DEFAULT_MAX_BYTES as WALKER_MAX_BYTES,
  NULL_SNIFF_BYTES as WALKER_NULL_SNIFF,
} from "../../src/core/file-walker.js";
import {
  SINGLE_EXCLUDED_SUFFIXES as INDEXER_SUFFIXES,
  PER_FILE_MAX_BYTES as INDEXER_MAX_BYTES,
  NULL_SNIFF_BYTES as INDEXER_NULL_SNIFF,
} from "../../src/core/file-indexer.js";

describe("walker / indexer constants — locked identity", () => {
  it("excluded-suffix sets are byte-identical", () => {
    const walker = [...WALKER_SUFFIXES].sort();
    const indexer = [...INDEXER_SUFFIXES].sort();
    expect(walker).toEqual(indexer);
  });

  it("walker has every suffix the indexer lists, and vice versa", () => {
    // Symmetric containment, asserted explicitly so a missing
    // entry in either direction surfaces with a clear failure.
    for (const s of WALKER_SUFFIXES) {
      expect(INDEXER_SUFFIXES.has(s), `indexer missing ${s}`).toBe(true);
    }
    for (const s of INDEXER_SUFFIXES) {
      expect(WALKER_SUFFIXES.has(s), `walker missing ${s}`).toBe(true);
    }
  });

  it("size cap is the same on both paths", () => {
    expect(INDEXER_MAX_BYTES).toBe(WALKER_MAX_BYTES);
    expect(WALKER_MAX_BYTES).toBe(256 * 1024);
  });

  it("null-byte sniff window is the same on both paths", () => {
    expect(INDEXER_NULL_SNIFF).toBe(WALKER_NULL_SNIFF);
    expect(WALKER_NULL_SNIFF).toBe(8 * 1024);
  });
});
