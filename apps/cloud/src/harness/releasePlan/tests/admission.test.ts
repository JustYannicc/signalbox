import { describe, expect, it } from "vite-plus/test";
import { planHarnessRelease } from "../../HarnessReleasePlan.ts";
import { claudeInput, codexInput } from "./fixtures.ts";

describe("prepared module allowance", () => {
  it.each([undefined, NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid trusted allowance %s",
    (allowance) => {
      const input = codexInput();
      Reflect.set(input, "maxPreparedModuleBytes", allowance);
      expect(() => planHarnessRelease(input)).toThrow(/allowance/);
    },
  );

  it("counts Codex loader and helpers separately from the engine cap", () => {
    const input = { ...codexInput(), maxPreparedModuleBytes: 36 };
    expect(Object.keys(planHarnessRelease(input).preparedModules)).toHaveLength(3);
    input.maxPreparedModuleBytes = 35;
    expect(() => planHarnessRelease(input)).toThrow(/allowance/);
  });

  it("counts all CLI module types and the SDK together", () => {
    const input = { ...claudeInput(), maxPreparedModuleBytes: 60 };
    expect(Object.keys(planHarnessRelease(input).preparedModules)).toHaveLength(5);
    input.maxPreparedModuleBytes = 59;
    expect(() => planHarnessRelease(input)).toThrow(/allowance/);
  });

  it("accepts a zero allowance as valid but rejects nonempty modules", () => {
    const input = { ...codexInput(), maxPreparedModuleBytes: 0 };
    expect(() => planHarnessRelease(input)).toThrow(/exceed/);
  });

  it("rejects sums above the safe integer range without rounding", () => {
    const input = { ...codexInput(), maxPreparedModuleBytes: Number.MAX_SAFE_INTEGER };
    const manifest = input.rawManifests.codex;
    manifest.files["engine.wasm"].bytes = Number.MAX_SAFE_INTEGER;
    manifest.moduleBytes = Number.MAX_SAFE_INTEGER;
    manifest.moduleBudgetBytes = Number.MAX_SAFE_INTEGER;
    input.manifest.files["codex/engine.wasm"] = { ...manifest.files["engine.wasm"] };
    expect(() => planHarnessRelease(input)).toThrow(/allowance/);
  });

  it("admits the exact safe integer boundary", () => {
    const input = codexInput();
    input.maxPreparedModuleBytes = Number.MAX_SAFE_INTEGER;
    const manifest = input.rawManifests.codex;
    manifest.files["engine.wasm"].bytes = Number.MAX_SAFE_INTEGER - 24;
    manifest.moduleBytes = manifest.files["engine.wasm"].bytes;
    manifest.moduleBudgetBytes = manifest.moduleBytes;
    input.manifest.files["codex/engine.wasm"] = { ...manifest.files["engine.wasm"] };
    expect(planHarnessRelease(input).release.modules["codex/engine.wasm"]?.bytes).toBe(
      manifest.moduleBytes,
    );
  });
});

function renameWorker(name: string) {
  const input = { ...claudeInput(), maxPreparedModuleBytes: 60 };
  const cli = input.rawManifests.cli;
  Reflect.set(cli.modules, name, cli.modules["worker.cjs"]);
  Reflect.deleteProperty(cli.modules, "worker.cjs");
  cli.embeddedEntrypoints["/embedded/worker"] = name;
  cli.hostEntrypoints["host/worker"] = name;
  return input;
}

describe("native logical module names", () => {
  it("rejects noncanonical Codex runtime names", () => {
    const input = codexInput();
    Reflect.set(input.rawManifests.codex.files, "runtime/../helper.mjs", {
      bytes: 12,
      sha256: input.artifactHash,
    });
    input.manifest.files["codex/runtime/../helper.mjs"] = { bytes: 12, sha256: input.artifactHash };
    expect(() => planHarnessRelease(input)).toThrow(/relative module name/);
  });
  it.each([
    "/worker.cjs",
    "../worker.cjs",
    "./worker.cjs",
    "dir/../worker.cjs",
    "dir/./worker.cjs",
    "dir//worker.cjs",
    "worker.cjs/",
    "C:/worker.cjs",
    "https://host/worker.cjs",
    "dir\\worker.cjs",
    "worker.cjs?query",
    "worker.cjs#fragment",
    "worker\u0000.cjs",
    "worker\n.cjs",
    " worker.cjs",
  ])("rejects %s while the verified payload path stays valid", (name) => {
    expect(() => planHarnessRelease(renameWorker(name))).toThrow(/relative module name/);
  });

  it("validates SDK names independently of their payload paths", () => {
    const input = { ...claudeInput(), maxPreparedModuleBytes: 60 };
    const sdk = input.rawManifests.sdk;
    Reflect.set(sdk.modules, "/sdk.mjs", sdk.modules["sdk.mjs"]);
    Reflect.deleteProperty(sdk.modules, "sdk.mjs");
    sdk.mainModule = "/sdk.mjs";
    expect(() => planHarnessRelease(input)).toThrow(/relative module name/);
  });

  it("preserves nested and percent-escaped native names literally", () => {
    const name = "workers/%2F%24bunfs%2Froot%2Fworker.cjs";
    const plan = planHarnessRelease(renameWorker(name));
    expect(plan.preparedModules[`cli/${name}`]?.name).toBe(name);
    expect(plan.preparedModules[`cli/${name}`]?.path).toBe("cli/worker.cjs");
    if (plan.harness !== "claude-code") throw new Error("Expected Claude plan");
    expect(plan.embeddedEntrypoints["/embedded/worker"]).toBe(`cli/${name}`);
  });
});
