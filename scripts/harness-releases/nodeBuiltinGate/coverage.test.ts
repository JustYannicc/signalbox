import { describe, expect, it } from "@effect/vitest";
import { inspectNodeBuiltinCoverage } from "./coverage.ts";

const builtinModules = ["dns", "dns/promises", "fs", "fs/promises", "path"];

describe("Node builtin coverage", () => {
  it("canonicalizes bare and node-prefixed aliases including builtin subpaths", () => {
    const coverage = inspectNodeBuiltinCoverage({
      builtinModules,
      requiredSpecifiers: ["dns", "node:dns/promises", "node:path"],
      installedSpecifiers: ["node:dns", "dns/promises", "path"],
    });

    expect(coverage).toMatchObject({
      status: "pass",
      requiredBuiltins: ["dns", "dns/promises", "path"],
      installedBuiltins: ["dns", "dns/promises", "path"],
      missingBuiltins: [],
      unknownBuiltinSpecifiers: [],
    });
  });

  it("fails when DNS is missing whether the release uses bare or node aliases", () => {
    for (const requiredSpecifiers of [
      ["dns"],
      ["node:dns"],
      ["dns/promises"],
      ["node:dns/promises"],
    ]) {
      const coverage = inspectNodeBuiltinCoverage({
        builtinModules,
        requiredSpecifiers,
        installedSpecifiers: ["path"],
      });

      expect(coverage.status).toBe("fail");
      expect(coverage.missingBuiltins).toEqual([requiredSpecifiers[0]!.replace(/^node:/u, "")]);
    }
  });

  it("fails for unknown Node builtins and keeps computed imports visible", () => {
    const coverage = inspectNodeBuiltinCoverage({
      builtinModules,
      requiredSpecifiers: ["node:unknown_builtin"],
      installedSpecifiers: ["node:unreviewed"],
      ambiguities: [
        {
          kind: "dynamic-require",
          module: "release.js",
          line: 4,
          column: 8,
          specifier: "<dynamic>",
        },
      ],
    });

    expect(coverage).toMatchObject({
      status: "fail",
      missingBuiltins: [],
      unknownBuiltinSpecifiers: ["node:unknown_builtin", "node:unreviewed"],
      ambiguities: [
        {
          kind: "dynamic-require",
          module: "release.js",
          specifier: "<dynamic>",
        },
      ],
    });
  });
});
