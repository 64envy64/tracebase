import {
  diagnoseSemanticSidecarConfig,
  startSemanticSidecar,
} from "./sidecar.js";

export async function runSemanticSidecarCli(): Promise<void> {
  const diagnosed = diagnoseSemanticSidecarConfig();
  if (diagnosed.status !== "configured") {
    console.error("semantic sidecar configuration invalid:");
    for (const reason of diagnosed.reasons) console.error(`  - ${reason}`);
    process.exitCode = 1;
    return;
  }

  const sidecar = await startSemanticSidecar(diagnosed.config);
  console.log(`semantic sidecar ready: ${sidecar.url} backend=${sidecar.backend} tenant=${sidecar.tenant}`);

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await sidecar.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void close().finally(() => process.exit(0)));
  }
}
