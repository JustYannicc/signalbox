import { describe, expect, it } from "vite-plus/test";
import { HarnessReleasePlanError, planHarnessRelease } from "../../HarnessReleasePlan.ts";
import { claudeInput, codexInput, descriptor, hash, otherHash } from "./fixtures.ts";

describe("planHarnessRelease", () => {
  it("carries verified worker descriptors and rejects missing or contradictory payloads", () => {
    const input = claudeInput();
    const worker = {
      entry: "file:///embedded/worker",
      module: "worker.cjs",
      inputs: ["bun-graph:/embedded/worker"],
      sourceBytes: 34,
      preparedBytes: descriptor.bytes,
    };
    Reflect.set(input.rawManifests.cli, "workerEntries", { "hooks-worker": worker });
    const plan = planHarnessRelease(input);
    expect(plan.harness === "claude-code" && plan.workerEntries["hooks-worker"]).toEqual({
      ...worker,
      module: "worker.cjs",
    });
    worker.preparedBytes++;
    expect(() => planHarnessRelease(input)).toThrow("Invalid Claude worker entry");
    worker.preparedBytes--;
    worker.module = "missing.js";
    expect(() => planHarnessRelease(input)).toThrow();
  });
  it("prepares every Codex runtime descriptor and excludes build provenance", () => {
    const input = codexInput();
    const plan = planHarnessRelease(input);
    expect(plan.harness).toBe("codex");
    expect(plan.release).toEqual({
      harness: "codex",
      version: "next-codex",
      manifestSha256: input.artifactHash,
      modules: {
        "codex/engine.wasm": descriptor,
        "codex/loader.mjs": descriptor,
        "codex/runtime/helper.mjs": descriptor,
      },
    });
    expect(plan.preparedModules["codex/runtime/helper.mjs"]).toEqual({
      ...descriptor,
      component: "codex",
      name: "runtime/helper.mjs",
      path: "codex/runtime/helper.mjs",
      type: "js",
    });
    expect(plan.componentManifestPaths).toEqual({ codex: "codex/manifest.json" });
  });

  it.each([
    ["abiVersion", 2],
    ["target", "wasm32-unknown-unknown"],
    ["version", "  "],
    ["upstreamCommit", ""],
    ["moduleBytes", 13],
    ["moduleSha256", otherHash],
    ["moduleBudgetBytes", 11],
    ["moduleBudgetPassed", false],
    ["moduleBytes", -1],
  ])("rejects contradictory Codex %s=%s", (field, value) => {
    const input = codexInput();
    Reflect.set(input.rawManifests.codex, field, value);
    expect(() => planHarnessRelease(input)).toThrow(HarnessReleasePlanError);
  });

  it.each(["engine.wasm", "loader.mjs"])("requires Codex %s", (name) => {
    const input = codexInput();
    Reflect.deleteProperty(input.rawManifests.codex.files, name);
    expect(() => planHarnessRelease(input)).toThrow(/engine\/loader/);
  });

  it("rejects an undeclared common runtime payload and unknown runtime types", () => {
    const input = codexInput();
    delete input.manifest.files["codex/runtime/helper.mjs"];
    expect(() => planHarnessRelease(input)).toThrow(/common payload/);
    input.manifest.files["codex/runtime/helper.mjs"] = descriptor;
    Reflect.set(input.rawManifests.codex.files, "extra.bin", descriptor);
    input.manifest.files["codex/extra.bin"] = descriptor;
    expect(() => planHarnessRelease(input)).toThrow(/Unsupported Codex runtime/);
  });

  it("preserves Claude native names, all module types, assets and provider metadata", () => {
    const input = claudeInput();
    const plan = planHarnessRelease(input);
    if (plan.harness !== "claude-code") throw new Error("Expected Claude plan");
    expect(plan.release.version).toBe("next-cli");
    expect(plan.release.manifestSha256).toBe(input.artifactHash);
    expect(Object.keys(plan.release.modules)).toEqual([
      "cli/claude.js",
      "cli/worker.cjs",
      "cli/data.txt",
      "cli/engine.wasm",
      "sdk/sdk.mjs",
    ]);
    expect(plan.preparedModules["cli/claude.js"]).toEqual({
      ...descriptor,
      component: "cli",
      name: "claude.js",
      path: "cli/cli-main.js",
      type: "js",
    });
    expect(Object.values(plan.preparedModules).map((entry) => entry.type)).toEqual([
      "js",
      "cjs",
      "text",
      "wasm",
      "js",
    ]);
    expect(plan.main).toEqual({ module: "cli/claude.js", export: "launch" });
    expect(plan.initialize).toEqual({ module: "sdk/sdk.mjs", export: "initialize" });
    expect(plan.embeddedEntrypoints).toEqual({ "/embedded/worker": "cli/worker.cjs" });
    expect(plan.hostEntrypoints).toEqual({ "host/worker": "cli/worker.cjs" });
    expect(plan.assets).toEqual([
      {
        ...descriptor,
        component: "cli",
        name: "/help",
        path: "cli/assets/help",
        key: "help",
        loader: 5,
        encoding: 0,
      },
    ]);
    expect(plan.moduleMaps).toEqual([
      { ...descriptor, component: "cli", name: "module-map.json", path: "cli/module-map.json" },
    ]);
    expect(plan.requiredHostModules).toEqual({ cli: ["node:fs"], sdk: ["child_process"] });
    expect(plan.environmentPackageModules).toEqual({ "bun:jsc": descriptor });
    expect(plan.sdk.version).toBe("next-sdk");
  });

  it("preserves omission configuration identity in the accepted Claude plan", () => {
    const input = claudeInput();
    const omission = {
      schemaVersion: 1,
      configuration: { name: "product", env: {} },
      configurationReplacements: {},
      configurationRemoved: [],
      corpus: null,
      omittedModules: [],
    };
    Reflect.set(input.rawManifests.cli, "omission", omission);
    Reflect.set(input.manifest, "omission", { configuration: { name: "product" } });

    const plan = planHarnessRelease(input);
    expect(plan).not.toHaveProperty("omission");
    expect(input.rawManifests.cli).toHaveProperty("omission", omission);
  });

  it.each([
    ["qualification", "Claude release configuration is not product-enabled"],
    ["unknown", "Invalid Claude release omission"],
  ])("rejects %s configuration from product planning", (name, message) => {
    const input = claudeInput();
    Reflect.set(input.rawManifests.cli, "omission", {
      schemaVersion: 1,
      configuration: { name, env: {} },
      configurationReplacements: {},
      configurationRemoved: [],
      corpus: null,
      omittedModules: [],
    });
    Reflect.set(input.manifest, "omission", { configuration: { name } });

    expect(() => planHarnessRelease(input)).toThrow(message);
  });

  it.each([
    ["cli", "schemaVersion", 2],
    ["sdk", "schemaVersion", 2],
    ["cli", "mainModule", "missing.js"],
    ["sdk", "mainModule", "missing.mjs"],
    ["cli", "mainModule", "data.txt"],
    ["cli", "mainExport", ""],
    ["cli", "mainExport", "wrong"],
    ["sdk", "initializeExport", "wrong"],
    ["cli", "embeddedEntrypointExport", ""],
    ["cli", "requiredHostModules", [12]],
    ["sdk", "requiredHostModules", [null]],
    ["cli", "environmentPackageModules", { invalid: {} }],
    ["cli", "bytes", 0],
  ])("rejects malformed %s %s", (component, field, value) => {
    const input = claudeInput();
    Reflect.set(
      component === "cli" ? input.rawManifests.cli : input.rawManifests.sdk,
      field,
      value,
    );
    expect(() => planHarnessRelease(input)).toThrow(HarnessReleasePlanError);
  });

  it.each([
    ["cli", "provider", "codex"],
    ["sdk", "provider", "claude-code"],
    ["sdk", "name", "different-sdk"],
    ["cli", "version", ""],
    ["sdk", "version", "  "],
  ])("rejects wrong %s release %s", (component, field, value) => {
    const input = claudeInput();
    Reflect.set(
      component === "cli" ? input.rawManifests.cli.release : input.rawManifests.sdk.release,
      field,
      value,
    );
    expect(() => planHarnessRelease(input)).toThrow(HarnessReleasePlanError);
  });

  it.each(["embeddedEntrypoints", "hostEntrypoints"])("requires declared %s targets", (field) => {
    const input = claudeInput();
    Reflect.set(input.rawManifests.cli, field, { worker: "missing.js" });
    expect(() => planHarnessRelease(input)).toThrow(/declared JS module/);
  });

  it.each([
    ["cli/cli-main.js", "sha256", otherHash],
    ["cli/worker.cjs", "bytes", 1],
    ["sdk/sdk.mjs", "sha256", otherHash],
    ["sdk/sdk.mjs", "bytes", 1],
    ["cli/assets/help", "sha256", otherHash],
    ["cli/assets/help", "bytes", 1],
    ["cli/module-map.json", "sha256", otherHash],
  ])("rejects common payload mismatch at %s %s", (path, field, value) => {
    const input = claudeInput();
    const entry = input.manifest.files[path];
    if (entry === undefined) throw new Error("Fixture entry missing");
    Reflect.set(entry, field, value);
    expect(() => planHarnessRelease(input)).toThrow(/common payload/);
  });

  it("requires the CLI module-map payload", () => {
    const input = claudeInput();
    delete input.manifest.files["cli/module-map.json"];
    expect(() => planHarnessRelease(input)).toThrow(/common payload/);
  });

  it.each(["type", "path", "bytes", "sha256"])("validates module descriptor %s", (field) => {
    const input = claudeInput();
    Reflect.set(input.rawManifests.cli.modules["worker.cjs"], field, null);
    expect(() => planHarnessRelease(input)).toThrow(HarnessReleasePlanError);
  });

  it("rejects unknown module types", () => {
    const input = claudeInput();
    input.rawManifests.sdk.modules["sdk.mjs"].type = "json";
    expect(() => planHarnessRelease(input)).toThrow(HarnessReleasePlanError);
  });

  it("rejects CLI/SDK native module collisions even with qualified release keys", () => {
    const input = claudeInput();
    Reflect.set(
      input.rawManifests.sdk.modules,
      "claude.js",
      input.rawManifests.sdk.modules["sdk.mjs"],
    );
    expect(() => planHarnessRelease(input)).toThrow(/module name collision/);
  });

  it("rejects ambiguous native names for one module payload", () => {
    const input = claudeInput();
    input.rawManifests.cli.modules["worker.cjs"].path = "cli-main.js";
    expect(() => planHarnessRelease(input)).toThrow(/payload collision/);
  });

  it.each(["sourceIdentity", "manifestSha256"])("enforces the trusted computer %s", (field) => {
    const input = codexInput();
    Reflect.set(input.trustedComputer, field, "different");
    expect(() => planHarnessRelease(input)).toThrow(/trusted pin/);
  });

  it("rejects mixed providers and missing component manifest payloads", () => {
    const input = codexInput();
    Reflect.set(input.rawManifests, "cli", {});
    expect(() => planHarnessRelease(input)).toThrow(/Unexpected provider component/);
    Reflect.deleteProperty(input.rawManifests, "cli");
    delete input.manifest.files["codex/manifest.json"];
    expect(() => planHarnessRelease(input)).toThrow(/component manifest payload/);
  });

  it("uses the supplied artifact identity without inventing a provider hash", () => {
    const input = claudeInput();
    input.artifactHash = otherHash;
    expect(planHarnessRelease(input).release.manifestSha256).toBe(otherHash);
    expect(hash).not.toBe(otherHash);
  });
});
