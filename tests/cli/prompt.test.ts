import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { multiSelect } from "../../src/cli/prompt.js";

// When stdin is a TTY but lacks raw-mode support (some piped/CI
// shells), multiSelect degrades to a readline-backed numeric picker.
// The happy path uses the arrow-key picker instead, so this fallback
// can regress silently — these tests pin the degraded contract.

type StdinMock = PassThrough & {
  isTTY?: boolean;
  setRawMode?: unknown;
};

const ALL = [
  { value: "claude-code" as const, label: "Claude Code" },
  { value: "cursor" as const, label: "Cursor" },
  { value: "codex" as const, label: "Codex" },
];

let originalStdin: NodeJS.ReadStream;
let originalStdoutIsTTY: boolean | undefined;
let originalStdoutWrite: typeof process.stdout.write;
let originalConsoleLog: typeof console.log;
let stdin: StdinMock;

beforeEach(() => {
  originalStdin = process.stdin;
  originalStdoutIsTTY = process.stdout.isTTY;
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalConsoleLog = console.log;

  stdin = new PassThrough() as StdinMock;
  stdin.isTTY = true;
  // Intentionally no setRawMode — this is what steers multiSelect
  // into the numericFallback branch.

  Object.defineProperty(process, "stdin", {
    value: stdin,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
    writable: true,
  });
  process.stdout.write = ((_chunk: unknown): boolean => true) as typeof process.stdout.write;
  console.log = () => {};
});

afterEach(() => {
  Object.defineProperty(process, "stdin", {
    value: originalStdin,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: originalStdoutIsTTY,
    configurable: true,
    writable: true,
  });
  process.stdout.write = originalStdoutWrite;
  console.log = originalConsoleLog;
});

async function answer(text: string): Promise<void> {
  // Let multiSelect/createInterface register its listeners first.
  await new Promise<void>((resolve) => setImmediate(resolve));
  stdin.write(text + "\n");
}

describe("multiSelect — numericFallback (setRawMode unavailable)", () => {
  it("returns the initial defaults on empty input", async () => {
    const promise = multiSelect({
      title: "Pick agents",
      options: ALL,
      initial: ["claude-code"],
    });
    await answer("");
    await expect(promise).resolves.toEqual(["claude-code"]);
  });

  it("returns an empty array on empty input when there are no defaults", async () => {
    const promise = multiSelect({ title: "Pick", options: ALL });
    await answer("");
    await expect(promise).resolves.toEqual([]);
  });

  it("parses comma-separated indices", async () => {
    const promise = multiSelect({ title: "Pick", options: ALL });
    await answer("1,3");
    await expect(promise).resolves.toEqual(["claude-code", "codex"]);
  });

  it("accepts 'all' as a shortcut (case-insensitive)", async () => {
    const promise = multiSelect({ title: "Pick", options: ALL });
    await answer("ALL");
    await expect(promise).resolves.toEqual(["claude-code", "cursor", "codex"]);
  });

  it("accepts 'none' to clear defaults", async () => {
    const promise = multiSelect({
      title: "Pick",
      options: ALL,
      initial: ["claude-code", "cursor"],
    });
    await answer("none");
    await expect(promise).resolves.toEqual([]);
  });

  it("silently skips out-of-range and non-numeric entries, and de-dupes", async () => {
    const promise = multiSelect({ title: "Pick", options: ALL });
    await answer("0, 5, 2, foo, 2");
    await expect(promise).resolves.toEqual(["cursor"]);
  });

  it("returns [] synchronously when there are no options (short-circuit)", async () => {
    // Does not read from stdin at all — guards against a future
    // refactor that accidentally prompts for an empty option set.
    await expect(
      multiSelect({ title: "empty", options: [] }),
    ).resolves.toEqual([]);
  });
});
