import { SessionStore } from "./sessionStore.js";
import { PermissionChecker } from "./permissionChecker.js";

export interface AuthResult {
  ok: boolean;
  userId?: string;
  reason?: "no-session" | "forbidden";
}

/**
 * AuthMiddleware — bound to a SessionStore + PermissionChecker.
 * Called per-request: looks up the session, refreshes recency, checks
 * whether the role allows the requested action.
 */
export class AuthMiddleware {
  constructor(
    private readonly sessions: SessionStore,
    private readonly perms: PermissionChecker,
  ) {}

  check(sid: string, action: string): AuthResult {
    const rec = this.sessions.lookup(sid);
    if (!rec) return { ok: false, reason: "no-session" };
    if (!this.perms.can(rec.roles, action)) return { ok: false, reason: "forbidden", userId: rec.userId };
    return { ok: true, userId: rec.userId };
  }
}
