import type { UserEvent } from "./types.js";

/**
 * Emit only events that are NOT archived (archived events were already
 * handled by the previous pipeline pass; re-emitting them would
 * double-fire downstream consumers).
 */
export function shouldEmit(event: UserEvent): boolean {
  return event.archived;
}
