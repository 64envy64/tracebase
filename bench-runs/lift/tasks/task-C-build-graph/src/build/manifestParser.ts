import type { Manifest, ModuleManifest } from "../types.js";

/**
 * ManifestParser — turns a raw JSON-shaped object into a typed Manifest.
 * Validation only; no graph reasoning. Pure / synchronous.
 */
export class ManifestParser {
  parse(raw: unknown): Manifest {
    if (!raw || typeof raw !== "object") throw new Error("manifest must be an object");
    const r = raw as Record<string, unknown>;
    if (typeof r.entry !== "string") throw new Error("manifest.entry required");
    const mods = r.modules;
    if (!Array.isArray(mods)) throw new Error("manifest.modules must be array");
    const modules: ModuleManifest[] = [];
    for (const m of mods) {
      if (typeof m !== "object" || !m) throw new Error("module entry invalid");
      const mr = m as Record<string, unknown>;
      modules.push({
        name: String(mr.name),
        deps: Array.isArray(mr.deps) ? mr.deps.map(String) : [],
        source: String(mr.source ?? ""),
      });
    }
    return { modules, entry: r.entry };
  }
}
