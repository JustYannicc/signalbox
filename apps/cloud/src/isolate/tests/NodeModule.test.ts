import { describe, expect, it } from "@effect/vitest";
import { createNodeBridge } from "../NodeBridge.ts";
import { createNodeModule, NodeModuleUnavailableError } from "../NodeModule.ts";

describe("prepared Node module facade", () => {
  it("keeps require aliases on the installed host and never falls through for missing builtins", () => {
    const fs = { promises: {} };
    const process = { env: { HOME: "/work/home" } };
    const bridge = createNodeBridge({ fs, process });
    const fail = () => {
      throw new Error("Builtin escaped to the prepared resolver");
    };
    const module = createNodeModule(bridge, fail, fail);
    const require = module.createRequire("/signalbox/claude.js");
    expect(require("fs")).toBe(fs);
    expect(require("node:fs")).toBe(fs);
    expect(require("node:fs/promises")).toBe(fs.promises);
    expect(require("node:process")).toBe(process);
    expect(require.resolve("fs")).toBe("fs");
    expect(require.resolve("node:fs")).toBe("node:fs");
    expect(() => require("node:crypto")).toThrow(
      expect.objectContaining({ code: "NODE_BUILTIN_UNAVAILABLE" }),
    );
    expect(() => require("node:future-builtin")).toThrow(
      expect.objectContaining({ code: "NODE_BUILTIN_UNKNOWN" }),
    );
  });

  it("resolves nonbuiltins only through an explicitly supplied prepared graph", () => {
    const value = { releaseModule: true };
    const seen: unknown[][] = [];
    const module = createNodeModule(
      createNodeBridge({}),
      (specifier, referrer) => {
        seen.push(["require", specifier, referrer]);
        return value;
      },
      (specifier, referrer) => {
        seen.push(["resolve", specifier, referrer]);
        return "/release/dependency.cjs";
      },
    );
    const require = module.createRequire(new URL("file:///release/entry.js"));
    expect(require("./dependency.cjs")).toBe(value);
    expect(require.resolve("./dependency.cjs")).toBe("/release/dependency.cjs");
    expect(seen).toEqual([
      ["require", "./dependency.cjs", "/release/entry.js"],
      ["resolve", "./dependency.cjs", "/release/entry.js"],
    ]);
  });

  it("reports absent graph capabilities instead of using native module resolution", () => {
    const module = createNodeModule(createNodeBridge({}));
    const require = module.createRequire("/signalbox/claude.js");
    for (const specifier of ["./dependency.cjs", "yaml", "audio-capture.node"]) {
      expect(() => require(specifier)).toThrow(NodeModuleUnavailableError);
      expect(() => require.resolve(specifier)).toThrow(NodeModuleUnavailableError);
    }
    expect(() => module._load()).toThrow(NodeModuleUnavailableError);
    expect(() => Reflect.construct(module.Module, [])).toThrow(NodeModuleUnavailableError);
    expect(() => module.createRequire("relative.js")).toThrow();
    expect(() => module.createRequire("https://example.com/release.js")).toThrow(TypeError);
  });
});
