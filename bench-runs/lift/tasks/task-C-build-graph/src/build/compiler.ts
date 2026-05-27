import type { ModuleManifest } from "../types.js";

/**
 * Compiler — fake per-module "compile" step. Returns the module's
 * compiled bytecode as a string (here: name + first 4 chars of source).
 */
export class Compiler {
  compile(m: ModuleManifest): string {
    const sourceHead = m.source.slice(0, 4);
    return `${m.name}:${sourceHead}`;
  }
}
