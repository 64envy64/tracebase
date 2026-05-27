/**
 * PermissionChecker — static role → permission table.
 * Pure / synchronous.
 */
const PERMISSIONS: Record<string, string[]> = {
  admin: ["read", "write", "delete", "manage"],
  editor: ["read", "write"],
  viewer: ["read"],
};

export class PermissionChecker {
  can(roles: string[], action: string): boolean {
    for (const r of roles) {
      const perms = PERMISSIONS[r] ?? [];
      if (perms.includes(action)) return true;
    }
    return false;
  }
}
