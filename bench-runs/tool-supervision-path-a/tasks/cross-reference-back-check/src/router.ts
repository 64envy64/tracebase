import type { UserEvent } from "./types.js";
import { shouldEmit } from "./handler.js";

const ONE_DAY_MS = 86_400_000;

export function route(events: UserEvent[]): UserEvent[] {
  const cutoff = Date.now() - ONE_DAY_MS;
  return events.filter(shouldEmit).filter((e) => e.createdAt > cutoff);
}
