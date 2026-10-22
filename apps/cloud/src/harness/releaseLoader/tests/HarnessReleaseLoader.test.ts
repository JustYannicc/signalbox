import { describe, expect, it, vi } from "vite-plus/test";
import { loadHarnessRelease } from "../../HarnessReleaseLoader.ts";
import {
  claudeFixture,
  cliModuleMap,
  codexFixture,
  encodeJson,
  literalModuleName,
} from "./artifactFixtures.ts";

describe("loadHarnessRelease", () => {
  it("verifies Codex modules without retaining bytes and leaves Cargo.lock out of native inputs", async () => {
    const fixture = await codexFixture();
    const ready = await loadHarnessRelease(fixture.options);
    expect(ready.plan.harness).toBe("codex");
    expect(ready.plan.release.manifestSha256).toBe(fixture.options.identity.artifactHash);
    expect([...ready.payloads.keys()]).toEqual([]);
    expect(fixture.reads).toEqual([
      "manifest.json",
      "codex/manifest.json",
      "codex/engine.wasm",
      "codex/loader.mjs",
      "codex/helper.mjs",
    ]);
    expect(fixture.reads).not.toContain("codex/Cargo.lock");
  });

  it("verifies all Claude modules but retains only shared assets and module maps", async () => {
    const fixture = await claudeFixture();
    const ready = await loadHarnessRelease(fixture.options);
    const expectedPaths = [...fixture.files.keys()].filter(
      (path) => !path.endsWith("manifest.json"),
    );
    const retainedPaths = new Set(["cli/assets/help", "cli/data.txt", "cli/module-map.json"]);
    expect([...ready.payloads.keys()].sort()).toEqual([...retainedPaths].sort());
    for (const path of expectedPaths) {
      expect(fixture.reads.filter((read) => read === path)).toHaveLength(1);
      expect(ready.payloads.get(path)).toEqual(
        retainedPaths.has(path) ? fixture.files.get(path) : undefined,
      );
    }
    const module = ready.plan.preparedModules[`cli/${literalModuleName}`];
    expect(module?.name).toBe(literalModuleName);
    expect(module?.path).toBe(`cli/${literalModuleName}`);
    expect(fixture.reads).toContain(`cli/${literalModuleName}`);
    expect(fixture.reads).not.toContain("cli/chunks//$bunfs/root/chunk.js");
    expect(ready.plan.preparedModules["cli/cli.js"]?.path).toBe("cli/main/cli.js");
  });

  it("rejects a rehashed qualification artifact on the product load path", async () => {
    const fixture = await claudeFixture({
      omission: {
        schemaVersion: 1,
        configuration: { name: "qualification", env: {} },
        configurationReplacements: {},
        configurationRemoved: [],
        corpus: null,
        chunks: [],
      },
      omissionIdentity: { configuration: { name: "qualification" } },
    });

    await expect(loadHarnessRelease(fixture.options)).rejects.toThrow(
      "Claude release configuration is not product-enabled",
    );
    expect(fixture.reads).toContain("cli/manifest.json");
  });

  it("does not resolve for the caller until the last required read finishes", async () => {
    const fixture = await claudeFixture();
    let release!: () => void;
    let markPaused!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    const use = vi.fn();
    const pending = loadHarnessRelease({
      ...fixture.options,
      source: {
        async read(ref, path) {
          const bytes = await fixture.options.source.read(ref, path);
          if (path === "cli/module-map.json") {
            markPaused();
            await gate;
          }
          return bytes;
        },
      },
    }).then((ready) => {
      use(ready);
      return ready;
    });
    await paused;
    expect(use).not.toHaveBeenCalled();
    expect(fixture.reads).toContain("sdk/sdk.mjs");
    expect(fixture.reads).toContain("cli/assets/help");
    release();
    const ready = await pending;
    expect(use).toHaveBeenCalledWith(ready);
  });

  it.each(["codex/helper.mjs", "cli/assets/help", "cli/module-map.json"])(
    "rejects corrupt late payload %s before caller use",
    async (path) => {
      const fixture = path.startsWith("codex/") ? await codexFixture() : await claudeFixture();
      const bytes = fixture.files.get(path)!;
      const corrupt = Uint8Array.from(bytes);
      corrupt[0] = corrupt[0]! ^ 1;
      fixture.files.set(path, corrupt);
      const use = vi.fn();
      await expect(loadHarnessRelease(fixture.options).then(use)).rejects.toMatchObject({
        code: "FILE_HASH_MISMATCH",
      });
      expect(use).not.toHaveBeenCalled();
      expect(fixture.reads).toContain(
        path.startsWith("codex/") ? "codex/engine.wasm" : "sdk/sdk.mjs",
      );
    },
  );

  it("propagates the accepted reader's size rejection", async () => {
    const fixture = await codexFixture();
    fixture.files.set("codex/helper.mjs", new Uint8Array());
    await expect(loadHarnessRelease(fixture.options)).rejects.toMatchObject({
      code: "FILE_SIZE_MISMATCH",
    });
  });

  it("delegates source identity validation to the accepted reader", async () => {
    const fixture = await codexFixture();
    fixture.options.identity.sourceIdentity = "f".repeat(64);
    await expect(loadHarnessRelease(fixture.options)).rejects.toMatchObject({
      code: "SOURCE_IDENTITY_MISMATCH",
    });
    expect(fixture.reads).toEqual(["manifest.json"]);
  });

  it("keeps the plan tied to the identity and trusted inputs supplied before reads", async () => {
    const fixture = await codexFixture();
    const hash = fixture.options.identity.artifactHash;
    const ready = await loadHarnessRelease({
      ...fixture.options,
      source: {
        async read(ref, path) {
          const bytes = await fixture.options.source.read(ref, path);
          fixture.options.identity.artifactHash = "f".repeat(64);
          fixture.options.trustedComputer.sourceIdentity = "changed";
          return bytes;
        },
      },
    });
    expect(ready.plan.release.manifestSha256).toBe(hash);
    expect(ready.plan.computer.sourceIdentity).not.toBe("changed");
  });

  it("delegates the trusted computer pin and aggregate module allowance to the converter", async () => {
    const fixture = await codexFixture();
    await expect(
      loadHarnessRelease({
        ...fixture.options,
        trustedComputer: { ...fixture.options.trustedComputer, sourceIdentity: "wrong" },
      }),
    ).rejects.toThrow(/trusted pin/);
    await expect(
      loadHarnessRelease({
        ...fixture.options,
        maxPreparedModuleBytes: fixture.options.maxPreparedModuleBytes - 1,
      }),
    ).rejects.toThrow(/allowance/);
    await expect(
      loadHarnessRelease({ ...fixture.options, maxPreparedModuleBytes: Infinity }),
    ).rejects.toThrow(/allowance/);
    expect(fixture.reads.every((path) => path.endsWith("manifest.json"))).toBe(true);
  });
});

describe("module map bytes", () => {
  it.each([
    "wrong-entry",
    "missing-entry",
    "extra-entry",
    "wrong-type",
    "wrong-path",
    "absolute-path",
    "parent-path",
  ])("rejects a hash-valid CLI map with %s", async (fault) => {
    const map = cliModuleMap();
    if (fault === "wrong-entry") {
      map["other.js"] = map["cli.js"]!;
      delete map["cli.js"];
    }
    if (fault === "missing-entry") delete map["cli.js"];
    if (fault === "extra-entry") map["extra.js"] = map["cli.js"]!;
    if (fault === "wrong-type") map["cli.js"]!.type = "cjs";
    if (fault === "wrong-path") map["cli.js"]!.path = "cli.js";
    if (fault === "absolute-path") map["cli.js"]!.path = "/main/cli.js";
    if (fault === "parent-path") map["cli.js"]!.path = "other/../main/cli.js";
    const fixture = await claudeFixture({ cliMapBytes: encodeJson(map) });
    const use = vi.fn();
    await expect(loadHarnessRelease(fixture.options).then(use)).rejects.toThrow(/Module map/);
    expect(use).not.toHaveBeenCalled();
    expect(fixture.reads).toContain("cli/module-map.json");
  });

  it.each([
    new TextEncoder().encode("not json"),
    new Uint8Array([0xff]),
    encodeJson([]),
    encodeJson({ "cli.js": { path: 1, type: "js" } }),
    encodeJson({ ...cliModuleMap(), "cli.js": { path: "main/cli.js", type: "js", extra: true } }),
  ])("rejects malformed module-map wire bytes", async (cliMapBytes) => {
    const fixture = await claudeFixture({ cliMapBytes });
    await expect(loadHarnessRelease(fixture.options)).rejects.toThrow();
  });

  it("honors an optional SDK map and checks it against SDK modules", async () => {
    const map = { "sdk.mjs": { path: "sdk.mjs", type: "js" } };
    const valid = await claudeFixture({ sdkMapBytes: encodeJson(map) });
    const ready = await loadHarnessRelease(valid.options);
    expect(ready.payloads.get("sdk/module-map.json")).toEqual(encodeJson(map));
    expect(valid.reads.filter((path) => path === "sdk/module-map.json")).toHaveLength(1);
    const invalid = await claudeFixture({ sdkMapBytes: encodeJson(cliModuleMap()) });
    await expect(loadHarnessRelease(invalid.options)).rejects.toThrow(/Module map/);
  });
});
