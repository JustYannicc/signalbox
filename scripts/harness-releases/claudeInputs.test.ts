import { describe, expect, it } from "@effect/vitest";
import { assertClaudeBuildInputs, createClaudeBuildInputs } from "./claudeInputs.ts";
import { decodeClaudeNodeWebEnvironment } from "./claudeRuntimeInputs.ts";

const repository = new URL("../..", import.meta.url).pathname;

describe("Claude source build inputs", () => {
  it("rejects child process provenance without the expected module set", () => {
    expect(() =>
      decodeClaudeNodeWebEnvironment({
        schemaVersion: 1,
        moduleMapBytes: 10,
        moduleMapSha256: "a".repeat(64),
        modules: {},
      }),
    ).toThrow("CLAUDE_NODE_WEB_ENVIRONMENT_INVALID");
  });

  it("generates pinned package maps bound to the current NodeBridge facades", async () => {
    const inputs = await createClaudeBuildInputs(repository);
    assertClaudeBuildInputs(inputs);

    expect(inputs.provenance.dependencies).toHaveLength(8);
    expect(inputs.provenance.nodeBuiltinRoutes.count).toBe(43);
    expect(inputs.provenance.nodeBridgeFacades.count).toBe(86);
    expect(inputs.provenance.nodeBridgeFacades.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(inputs.environmentPackageModules)).toEqual(["ws", "node-fetch", "bun:jsc"]);
    expect(inputs.environmentPackageModules.ws).toContain('Symbol.for("signalbox.nodeBridge.v1")');
    expect(inputs.environmentPackageModules["node-fetch"]).toContain(
      'Symbol.for("signalbox.nodeBridge.v1")',
    );
    expect(inputs.provenance.packageMapRebinding.boundNativeImports.ws).toContain("node:tls");
    expect(inputs.provenance.nodeWebEnvironment.modules.ws!.packageClosure).toContainEqual(
      expect.objectContaining({ name: "ws", version: "8.22.0", license: "MIT" }),
    );
    expect(inputs.provenance.r5Diagnostic.facadeCountMatch).toBe(true);
  });

  it("rejects source and dependency data that no longer matches its provenance", async () => {
    const inputs = await createClaudeBuildInputs(repository);
    expect(() =>
      assertClaudeBuildInputs({
        ...inputs,
        environmentPackageModules: {
          ...inputs.environmentPackageModules,
          ws: `${inputs.environmentPackageModules.ws} `,
        },
      }),
    ).toThrow("CLAUDE_ENVIRONMENT_PACKAGE_PROVENANCE_MISMATCH");

    expect(() =>
      assertClaudeBuildInputs({
        ...inputs,
        provenance: {
          ...inputs.provenance,
          dependencies: inputs.provenance.dependencies.map((dependency, index) =>
            index === 0 ? { ...dependency, version: "0.0.0" } : dependency,
          ),
        },
      }),
    ).toThrow("CLAUDE_DEPENDENCY_PROVENANCE_INCOMPLETE");
  });
});
