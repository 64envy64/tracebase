import { describe, it, expect } from "vitest";
import { Cli } from "../src/cli.js";

describe("Cli.buildFrom", () => {
  it("compiles an acyclic project so each module appears after its deps", () => {
    const cli = new Cli();
    const out = cli.buildFrom({
      entry: "app",
      modules: [
        { name: "app", deps: ["lib", "ui"], source: "appsrc" },
        { name: "lib", deps: ["core"], source: "libsrc" },
        { name: "ui", deps: ["core"], source: "uisrc" },
        { name: "core", deps: [], source: "coresrc" },
      ],
    });
    expect(out.order.indexOf("core")).toBeLessThan(out.order.indexOf("lib"));
    expect(out.order.indexOf("lib")).toBeLessThan(out.order.indexOf("app"));
    expect(out.compiled).toEqual(out.order.map((n) => `${n}:${n.slice(0, 4)}`));
  });

  it("tolerates a cycle without hanging or stack overflow", () => {
    const cli = new Cli();
    const out = cli.buildFrom({
      entry: "x",
      modules: [
        { name: "x", deps: ["y"], source: "xsrc" },
        { name: "y", deps: ["z"], source: "ysrc" },
        { name: "z", deps: ["x"], source: "zsrc" }, // cycle x -> y -> z -> x
      ],
    });
    expect(out.order.length).toBe(3);
    expect(new Set(out.order)).toEqual(new Set(["x", "y", "z"]));
  });

  it("tolerates a self-loop", () => {
    const cli = new Cli();
    const out = cli.buildFrom({
      entry: "v",
      modules: [
        { name: "v", deps: ["u"], source: "vsrc" },
        { name: "u", deps: ["u"], source: "usrc" }, // self-loop on u
      ],
    });
    expect(out.order.length).toBe(2);
    expect(new Set(out.order)).toEqual(new Set(["u", "v"]));
  });
});
