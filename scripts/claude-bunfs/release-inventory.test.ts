import { describe, expect, it } from "@effect/vitest";
import {
  assertInventoryIsClosed,
  assertNoNewUnguardedNames,
  diffReleaseInventories,
  scanClaudeReleaseInventory,
  serializeReleaseInventory,
  type ReleaseInventoryInput,
} from "./release-inventory.ts";

const capabilities: ReleaseInventoryInput["capabilities"] = {
  bunApis: { file: "implemented", spawnSync: "unsupported" },
  nodeBuiltins: {
    fs: {
      available: true,
      defaultImport: false,
      defaultMembers: [],
      namespaceImport: true,
      namedExports: ["readFileSync"],
      commonJs: true,
      commonJsMembers: ["readFileSync"],
    },
  },
  featureOffPaths: ["spawnSync"],
};

function input(
  version: string,
  entrySource: string,
  includeChanges = true,
  bunVersion: string | null = null,
): ReleaseInventoryInput {
  const entry = {
    index: 0,
    key: "$bunfs/entry",
    name: "/$bunfs/entry",
    loader: 1,
    source: entrySource,
    bytes: entrySource.length,
  };
  const childSource = 'import * as path from "node:path"; path.join("a", "b");';
  const modules: ReleaseInventoryInput["modules"] = [
    entry,
    ...(includeChanges
      ? [
          {
            index: 1,
            key: "$bunfs/child",
            name: "/$bunfs/child",
            loader: 1,
            source: childSource,
            bytes: childSource.length,
          },
          {
            index: 2,
            key: "$bunfs/native.node",
            name: "/$bunfs/native.node",
            loader: 10,
            bytes: 24,
          },
          {
            index: 3,
            key: "$bunfs/orphan",
            name: "/$bunfs/orphan",
            loader: 1,
            source: "Bun.random();",
            bytes: 13,
          },
        ]
      : []),
  ];
  return {
    release: { version, platform: "linux-x64", bunVersion },
    binary: { bytes: 128, sha256: "a".repeat(64) },
    graph: { entry: 0, flags: 1, recordSize: 32 },
    modules,
    capabilities,
  };
}

describe("Claude release inventory", () => {
  it("returns reachable AST findings and counts from decoded loader-1 sources", () => {
    const report = scanClaudeReleaseInventory(
      input(
        "2.1.302",
        `
import * as fs from "node:fs";
import "./child";
if (typeof Bun.file === "function") Bun.file(".");
Bun.spawnSync("true");
fs.readFileSync("config.json");
require("./native.node");
await import(target);
eval("return 1");
const maps = "/proc/self/maps";
`,
      ),
    );

    expect(report.schemaVersion).toBe(1);
    expect(report.modules.count).toBe(4);
    expect(report.modules.bytes).toBe(report.modules.javascriptBytes + 24);
    expect(report.modules.javascriptCount).toBe(3);
    expect(report.modules.reachableCount).toBe(3);
    expect(report.modules.reachableJavascriptCount).toBe(2);
    expect(report.modules.reachableJavascriptBytes).toBeGreaterThan(0);
    expect(report.bunApis.members.map((member) => member.path)).toEqual(["file", "spawnSync"]);
    expect(report.builtins.map((builtin) => builtin.canonicalBuiltin)).toEqual(["fs", "path"]);
    expect(report.napiModules.map((module) => module.key)).toEqual(["$bunfs/native.node"]);
    expect(report.unresolvedReferences.map((reference) => reference.kind)).toEqual([
      "dynamic-import",
    ]);
    expect(report.codegenFindings.map((finding) => finding.kind)).toEqual(["eval", "proc-path"]);
    expect(report.bunCapabilityGaps.map((gap) => `${gap.name}:${gap.reason}`)).toEqual([
      "spawnSync:unguarded-unsupported-use",
    ]);
    expect(report.bunApis.members.some((member) => member.path === "random")).toBe(false);
    expect(serializeReleaseInventory(report)).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(() => assertInventoryIsClosed(report)).toThrow("dynamic-import");
  });

  it("diffs unsupported names by semantic path and preserves candidate unresolved references", () => {
    const baseline = scanClaudeReleaseInventory(input("2.1.301", 'import "./child";', false));
    const candidate = scanClaudeReleaseInventory(input("2.1.302", 'Bun.spawnSync("true");', false));
    const diff = diffReleaseInventories(baseline, candidate);
    expect(diff.addedBunMembers).toEqual(["spawnSync"]);
    expect(diff.newUnguardedNames.map((gap) => gap.name)).toEqual(["spawnSync"]);
    expect(() => assertNoNewUnguardedNames(diff)).toThrow("spawnSync");
  });

  it("does not let a guarded baseline member hide its unguarded candidate use", () => {
    const baseline = scanClaudeReleaseInventory(
      input("2.1.301", 'import * as fs from "node:fs"; fs.newApi?.();', false),
    );
    const candidate = scanClaudeReleaseInventory(
      input("2.1.302", 'import * as fs from "node:fs"; fs.newApi();', false),
    );
    const diff = diffReleaseInventories(baseline, candidate);

    expect(baseline.builtinGaps.find((gap) => gap.name === "newApi")?.guarded).toBe(true);
    expect(candidate.builtinGaps.find((gap) => gap.name === "newApi")?.guarded).toBe(false);
    expect(diff.newUnguardedNames.map((gap) => gap.name)).toEqual(["newApi"]);
  });

  it("diffs semantic codegen operations, proc paths, module size and Bun version", () => {
    const baseline = scanClaudeReleaseInventory(
      input("2.1.301", 'eval("return 1"); const maps = "/proc/self/maps";', false, "1.2.0"),
    );
    const candidate = scanClaudeReleaseInventory(
      input(
        "2.1.302",
        'new Function("return 1"); const status = "/proc/self/status";',
        false,
        "1.3.0",
      ),
    );
    const diff = diffReleaseInventories(baseline, candidate);

    expect(diff.addedCodegenOperations).toEqual(["Function:construct"]);
    expect(diff.removedCodegenOperations).toEqual(["eval:call"]);
    expect(diff.addedProcPaths).toEqual(["/proc/self/status"]);
    expect(diff.removedProcPaths).toEqual(["/proc/self/maps"]);
    expect(diff.moduleCountChanges).toContainEqual({
      field: "javascriptBytes",
      baseline: baseline.modules.javascriptBytes,
      candidate: candidate.modules.javascriptBytes,
    });
    expect(diff.bunVersionChange).toEqual({ baseline: "1.2.0", candidate: "1.3.0" });
  });

  it("integrates awaited builtins, destructuring gaps, and reachable native edges", () => {
    const report = scanClaudeReleaseInventory(
      input(
        "2.1.302",
        `
import "./child";
const fs = await import("node:fs");
fs.readFileSync("config.json");
const request = require;
const { [memberName]: selected } = request("fs");
selected();
const { ...allExports } = request("fs");
allExports.readFileSync("other.json");
require("./native.node");
`,
      ),
    );

    expect(report.modules.reachableCount).toBe(3);
    expect(report.modules.reachableJavascriptCount).toBe(2);
    expect(report.napiModules.map((module) => module.key)).toEqual(["$bunfs/native.node"]);
    expect(report.builtins.map((builtin) => builtin.specifier)).toEqual([
      "fs",
      "node:fs",
      "node:path",
    ]);
    expect(
      report.builtins
        .find((builtin) => builtin.specifier === "node:fs")
        ?.memberUses.map((use) => use.member),
    ).toEqual(["readFileSync"]);
    expect(
      report.builtins.find((builtin) => builtin.specifier === "fs")?.dynamicMemberUses.length,
    ).toBeGreaterThan(0);
    expect(report.unresolvedReferences).toEqual([]);
    expect(
      report.builtinGaps.some(
        (gap) => gap.kind === "node-builtin" && gap.reason === "dynamic-member",
      ),
    ).toBe(true);
  });
});
