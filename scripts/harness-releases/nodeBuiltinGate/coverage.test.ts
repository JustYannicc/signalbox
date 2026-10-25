import { describe, expect, it } from "@effect/vitest";
import { assertNodeBuiltinCoverage, inspectNodeBuiltinCoverage } from "./coverage.ts";

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

  it.each([
    ["missing", "missing-functions=os.release@claude.js:12:5"],
    ["unsupported", "unsupported-functions=os.release@claude.js:12:5"],
  ] as const)("fails when installed os has a %s release function", (status, diagnostic) => {
    const coverage = inspectNodeBuiltinCoverage({
      builtinModules: ["os"],
      requiredSpecifiers: ["node:os"],
      installedSpecifiers: ["os"],
      requiredFunctions: [
        {
          specifier: "node:os",
          memberPath: ["release"],
          module: "claude.js",
          line: 12,
          column: 5,
        },
      ],
      functionCapabilities: [
        {
          specifier: "os",
          memberPath: ["release"],
          status,
          evidence:
            status === "unsupported"
              ? "NodeOs.ts:97; Workerd native os.release returns an empty string"
              : "actual public Node personality has no os.release function",
        },
      ],
    });

    expect(coverage.status).toBe("fail");
    expect(coverage.requiredBuiltins).toEqual(["os"]);
    expect(coverage.missingBuiltins).toEqual([]);
    expect(coverage.requiredFunctions[0]).toMatchObject({ status, evidence: expect.any(String) });
    expect(() => assertNodeBuiltinCoverage(coverage)).toThrow(diagnostic);
  });

  it("keeps dynamic builtin member calls as source-located warnings", () => {
    const coverage = inspectNodeBuiltinCoverage({
      builtinModules: ["os"],
      requiredSpecifiers: ["os"],
      installedSpecifiers: ["os"],
      functionAmbiguities: [
        {
          kind: "dynamic-builtin-member-call",
          module: "claude.js",
          line: 8,
          column: 3,
          specifier: "os.<computed>",
        },
      ],
    });

    expect(coverage).toMatchObject({
      status: "pass",
      functionCallScope: "static-direct-calls",
      functionAmbiguities: [
        { kind: "dynamic-builtin-member-call", module: "claude.js", line: 8, column: 3 },
      ],
    });
    expect(() => assertNodeBuiltinCoverage(coverage)).not.toThrow();
    expect(coverage.functionAmbiguities[0]).toMatchObject({ severity: "warning" });
  });
  it("keeps unresolved loader calls blocking", () => {
    const coverage = inspectNodeBuiltinCoverage({
      builtinModules: ["os"],
      requiredSpecifiers: ["os"],
      installedSpecifiers: ["os"],
      functionAmbiguities: [
        {
          kind: "dynamic-builtin-loader-call",
          module: "release.js",
          line: 7,
          column: 2,
          specifier: "require.<computed>",
        },
      ],
    });
    expect(coverage.status).toBe("fail");
    expect(coverage.functionAmbiguities[0]).toMatchObject({ severity: "error" });
    expect(() => assertNodeBuiltinCoverage(coverage)).toThrow(
      "unresolved-function-calls=dynamic-builtin-loader-call@release.js:7:2",
    );
  });

  it("accepts explicit platform absence without calling it supported", () => {
    const coverage = inspectNodeBuiltinCoverage({
      builtinModules: ["process"],
      requiredSpecifiers: ["process"],
      installedSpecifiers: ["process"],
      requiredFunctions: [
        {
          specifier: "process",
          memberPath: ["stdin", "setRawMode"],
          module: "release.js",
          line: 8,
          column: 1,
        },
      ],
      functionCapabilities: [
        {
          specifier: "process",
          memberPath: ["stdin", "setRawMode"],
          status: "platform-pruned",
          evidence: "Non-TTY stdin has no raw-mode method",
        },
      ],
    });
    expect(coverage.status).toBe("pass");
    expect(coverage.requiredFunctions[0]?.status).toBe("platform-pruned");
  });
});
