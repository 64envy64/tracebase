import { Sandbox } from "./sandbox.js";

const sb = new Sandbox("./eval/agentic/fixtures/fix-off-by-one", "test");
console.log("Sandbox dir:", sb.dir);

// Test readFile
const source = sb.readFile("source.ts");
console.log("Source length:", source.length, "chars");

// Test runTests (should FAIL — bug is present)
const result = sb.runTests("typescript");
console.log("Tests passed:", result.passed);
console.log("Output:", result.output.slice(-300));

sb.cleanup();
console.log("Done.");
