import type { Manifest, BuildArtifact } from "./types.js";
import { ManifestParser } from "./build/manifestParser.js";
import { Builder } from "./build/builder.js";

/**
 * Cli — entrypoint. Tests construct directly.
 */
export class Cli {
  private parser = new ManifestParser();
  private builder = new Builder();

  buildFrom(rawManifest: unknown): BuildArtifact {
    const manifest: Manifest = this.parser.parse(rawManifest);
    return this.builder.build(manifest);
  }
}
