/**
 * Helpers used by the MCP v2 tools (get_reasoning_patterns,
 * record_reasoning_outcome). Kept as a separate module so they're
 * unit-testable without spinning up an MCP server.
 */
import type { BlockStore } from "../core/block-store.js";

/**
 * Collect the block ids and fact ids that were actually injected for a
 * given queryId. Powers `record_reasoning_outcome` when the caller
 * says `usedPattern: true` without naming specific items — we credit
 * every item that was injected for that query.
 *
 * Reads both `injection` and `fact_injection` events filtered by
 * queryId. Deduped preserving first-seen order.
 */
export function collectInjectedFromQuery(
  store: BlockStore,
  queryId: string,
): { blockIds: string[]; factIds: string[] } {
  const events = store.readEvents({ queryId, limit: 10_000 });
  const blockIds: string[] = [];
  const factIds: string[] = [];
  const seenB = new Set<string>();
  const seenF = new Set<string>();
  for (const ev of events) {
    if (ev.event === "injection" && !seenB.has(ev.blockId)) {
      seenB.add(ev.blockId);
      blockIds.push(ev.blockId);
    } else if (ev.event === "fact_injection" && !seenF.has(ev.factId)) {
      seenF.add(ev.factId);
      factIds.push(ev.factId);
    }
  }
  return { blockIds, factIds };
}

/**
 * Decide which block + fact ids to credit with `agent_used` based on
 * the caller's record_reasoning_outcome arguments. Rules:
 *
 *   1. If `usedBlocks` / `usedFacts` is given, use those verbatim
 *      (finest granularity, caller knows best).
 *   2. Else if `usedPattern` is true, credit every id that the store
 *      recorded as injected for this query (shortcut).
 *   3. Else credit nothing (the agent explicitly reports it didn't
 *      use the patterns — neutral attribution).
 *
 * `usedBlocks` / `usedFacts` are always intersected with the actually-
 * injected set so a caller can't silently credit arbitrary ids that
 * never appeared in the injection payload.
 */
export function resolveUsedItems(
  injected: { blockIds: string[]; factIds: string[] },
  args: {
    usedPattern?: boolean;
    usedBlocks?: string[];
    usedFacts?: string[];
  },
): { usedBlockIds: string[]; usedFactIds: string[] } {
  const injectedBlockSet = new Set(injected.blockIds);
  const injectedFactSet = new Set(injected.factIds);

  if (args.usedBlocks !== undefined || args.usedFacts !== undefined) {
    return {
      usedBlockIds: (args.usedBlocks ?? []).filter((id) => injectedBlockSet.has(id)),
      usedFactIds: (args.usedFacts ?? []).filter((id) => injectedFactSet.has(id)),
    };
  }
  if (args.usedPattern === true) {
    return {
      usedBlockIds: injected.blockIds,
      usedFactIds: injected.factIds,
    };
  }
  return { usedBlockIds: [], usedFactIds: [] };
}
