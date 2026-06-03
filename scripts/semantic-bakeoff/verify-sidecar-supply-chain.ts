import { verifySemanticSidecarSupplyChain } from "../../src/experiments/semantic-bakeoff/service/supply-chain.js";

const report = verifySemanticSidecarSupplyChain(process.cwd());
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
