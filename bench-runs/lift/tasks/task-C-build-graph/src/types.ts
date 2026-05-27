export interface ModuleManifest {
  name: string;
  deps: string[];
  source: string;
}

export interface Manifest {
  modules: ModuleManifest[];
  entry: string;
}

export interface BuildArtifact {
  order: string[];
  compiled: string[];
  cycles: number;
}
