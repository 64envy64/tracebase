import type { ModuleManifest } from "../types.js";

/**
 * Resolver — topologically order modules so each appears after every
 * module it depends on. Real-world manifests sometimes contain cycles
 * (circular import via lazy require). The resolver MUST tolerate them.
 */
export class Resolver {
  private byName: Map<string, ModuleManifest>;
  public cyclesSeen = 0;

  constructor(modules: ModuleManifest[]) {
    this.byName = new Map(modules.map((m) => [m.name, m]));
  }

  resolve(entry: string): string[] {
    const order: string[] = [];
    this.visit(entry, order);
    return order;
  }

  private visit(name: string, order: string[]): void {
    const mod = this.byName.get(name);
    if (!mod) return;
    for (const d of mod.deps) {
      this.visit(d, order);
    }
    if (!order.includes(name)) order.push(name);
  }
}
