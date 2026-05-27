import { SessionStore } from "./auth/sessionStore.js";
import { PermissionChecker } from "./auth/permissionChecker.js";
import { AuthMiddleware } from "./auth/middleware.js";

/**
 * Server — top-level binding. Tests construct directly.
 */
export class Server {
  public readonly sessions: SessionStore;
  public readonly middleware: AuthMiddleware;

  constructor(sessionCapacity: number) {
    this.sessions = new SessionStore(sessionCapacity);
    const perms = new PermissionChecker();
    this.middleware = new AuthMiddleware(this.sessions, perms);
  }
}
