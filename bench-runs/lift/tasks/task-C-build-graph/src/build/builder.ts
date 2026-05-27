import type { Manifest, BuildArtifact } from "../types.js";
import { Resolver } from "./resolver.js";
import { Compiler } from "./compiler.js";
import { Logger } from "../util/logger.js";

/**
 * Builder — top-level orchestrator. Resolves order, compiles each
 * module in order, returns the artifact.
 */
export class Builder {
  private compiler = new Compiler();
  constructor(private logger: Logger = new Logger()) {}

  build(manifest: Manifest): BuildArtifact {
    const resolver = new Resolver(manifest.modules);
    const order = resolver.resolve(manifest.entry);
    const compiled = order.map((n) => {
      const m = manifest.modules.find((mm) => mm.name === n)!;
      return this.compiler.compile(m);
    });
    return { order, compiled, cycles: resolver.cyclesSeen };
  }
}
