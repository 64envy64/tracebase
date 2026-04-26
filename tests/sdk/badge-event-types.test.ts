/**
 * `BadgeEvent` + `Runtime` type-shape regression (PLAN-0.5.4 §3, §8.1).
 *
 * The privacy invariant for 0.5.4 is that `BadgeEvent` carries
 * counts + labels + queryId only — never user prompts, model
 * responses, tool input/output bodies, sanitised arg keys, or any
 * other potentially-sensitive content.
 *
 * Enforcement layers:
 *   1. The TypeScript shape itself excludes the forbidden keys;
 *      assigning an object literal with any of them to `BadgeEvent`
 *      is a compile error (excess-property check).
 *   2. The static `Extract<keyof BadgeEvent, Forbidden>` assertion
 *      below evaluates to `never` at compile time. If a future
 *      minor adds e.g. a `prompt` field to BadgeEvent, this test
 *      fails to compile — which is the whole point.
 *   3. A runtime smoke test confirms the file imports cleanly so
 *      `tsc --noEmit` actually evaluates the type assertions.
 */
import { describe, expect, it } from "vitest";
import type {
  AfterRunInput,
  BadgeEvent,
  BeforeRunInput,
  BeforeRunResult,
  CreateRuntimeOptions,
  ObserveToolBatchInput,
  ObserveToolBatchResult,
  Runtime,
  SaveContextInput,
  SaveContextResult,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Static assertions — verified at compile time by `npm run lint`.
// Kept inside the test file so a regression surfaces alongside the
// runtime tests, not as a stray check no one runs.
// ---------------------------------------------------------------------------

/** The single source of truth for what BadgeEvent must not carry. */
type ForbiddenInBadgeEvent =
  | "prompt"
  | "response"
  | "userText"
  | "assistantText"
  | "tool_input"
  | "tool_response"
  | "toolInput"
  | "toolResponse"
  | "argSummary"
  | "argKey"
  | "sessionId"
  | "session_id"
  | "file_path"
  | "filePath"
  | "path"
  | "code"
  | "transcript"
  | "transcriptPath";

/**
 * Evaluates to `never` iff `BadgeEvent` carries none of the
 * forbidden keys. If it does, this type evaluates to the offending
 * key(s) — and `assertNever` below fails to type-check.
 */
type _ForbiddenIntersection = Extract<keyof BadgeEvent, ForbiddenInBadgeEvent>;
type _AssertEmpty<T extends never> = T;
// If this line errors, BadgeEvent gained a forbidden key. Either
// remove the key from BadgeEvent or, if you really meant to add it,
// remove it from `ForbiddenInBadgeEvent` above with a justification.
type _BadgeEventForbiddenAssertion = _AssertEmpty<_ForbiddenIntersection>;

/** Exhaustiveness sanity-check on the runtime methods. */
type _AssertRuntimeShape = (
  r: Runtime,
  before: BeforeRunInput,
  after: AfterRunInput,
  obs: ObserveToolBatchInput,
  ctx: SaveContextInput,
) => Promise<[BeforeRunResult, void, ObserveToolBatchResult, SaveContextResult, void, void]>;
const _runtimeShape: _AssertRuntimeShape = async (r, before, after, obs, ctx) => {
  return [
    await r.beforeRun(before),
    await r.afterRun(after),
    await r.observeToolBatch(obs),
    await r.saveContext(ctx),
    await r.flush(),
    await r.close(),
  ];
};
void _runtimeShape;
void (null as unknown as _BadgeEventForbiddenAssertion);

// ---------------------------------------------------------------------------
// Runtime smoke
// ---------------------------------------------------------------------------

describe("BadgeEvent — public type shape", () => {
  it("constructs with the documented allowed fields", () => {
    const ev: BadgeEvent = {
      kind: "trace",
      label: "▣ TB TRACE  recalled 3 pattern(s)",
      count: 3,
      queryId: "abcdef12",
      tokens: 1200,
      ts: Date.now(),
      source: "openai",
    };
    expect(ev.kind).toBe("trace");
    expect(ev.count).toBe(3);
    expect(ev.queryId).toBe("abcdef12");
  });

  it("accepts every BadgeEventKind", () => {
    const kinds: BadgeEvent["kind"][] = [
      "trace",
      "memory",
      "memory-files", // 0.7.0-rc.3 §rc.3 — file memory bullet
      "context",
      "tool",
      "loop",
    ];
    for (const k of kinds) {
      const ev: BadgeEvent = { kind: k, label: `▣ TB ${k.toUpperCase()}`, ts: 0 };
      expect(ev.kind).toBe(k);
    }
  });

  it("excess-property check forbids `prompt`, `tool_input`, `argKey`", () => {
    // The four `@ts-expect-error` directives below DOCUMENT the
    // forbidden keys at the call site. If any of them ever stops
    // erroring (i.e. `BadgeEvent` is widened to allow the key),
    // tsc fails the build under `npm run lint`.
    const base: BadgeEvent = { kind: "trace", label: "x", ts: 0 };
    // @ts-expect-error — `prompt` is NOT in BadgeEvent.
    const a: BadgeEvent = { ...base, prompt: "should not exist" };
    // @ts-expect-error — `tool_input` is NOT in BadgeEvent.
    const b: BadgeEvent = { ...base, tool_input: { file_path: "x" } };
    // @ts-expect-error — `argKey` is NOT in BadgeEvent.
    const c: BadgeEvent = { ...base, argKey: "abc" };
    // @ts-expect-error — `sessionId` is NOT in BadgeEvent.
    const d: BadgeEvent = { ...base, sessionId: "s-1" };
    void a;
    void b;
    void c;
    void d;
  });
});

describe("CreateRuntimeOptions — type shape", () => {
  it("all fields optional; the empty object is a valid input", () => {
    const opts: CreateRuntimeOptions = {};
    expect(opts).toEqual({});
  });

  it("onBadge signature accepts a BadgeEvent and returns void", () => {
    const events: BadgeEvent[] = [];
    const opts: CreateRuntimeOptions = {
      onBadge: (ev: BadgeEvent) => {
        events.push(ev);
      },
    };
    opts.onBadge?.({ kind: "tool", label: "▣ TB TOOL  repeated 2× (Read)", ts: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("tool");
  });
});
