import { describe, expect, it } from "vite-plus/test";
import { decodeClaudeFacetConfiguration } from "./claudeConfiguration.ts";

function configuration() {
  const artifactHash = "a".repeat(64);
  return {
    schema: "sb1070/deploy3-claude-facet/v1",
    purpose: "qualification",
    assets: {
      schema: "sb1070/deploy3-claude-assets/v2",
      ownerIssue: 1072,
      assets: {
        status: "supplied",
        purpose: "qualification",
        projectId: "claude-qualification",
        metadata: { path: "claude/metadata.json", bytes: 1, sha256: artifactHash },
        baselinePin: {
          identity: {
            artifactRef: `sha256:${artifactHash}`,
            artifactHash,
            sourceIdentity: "b".repeat(64),
          },
          preparedModules: {},
        },
        trustedComputer: {
          sourceIdentity: "b".repeat(64),
          manifestSha256: "c".repeat(64),
        },
        maxPreparedModuleBytes: 1024,
      },
    },
    workload: {
      collectorNonce: "collector-nonce-1",
      mcpProbe: {
        toolName: "mcp__executor__qualification_echo",
        input: { text: "synthetic-probe" },
        expectedText: "synthetic-probe",
      },
      apiRevision: "EC1APIr2",
      model: "claude-sonnet-4-6",
    },
    turnJson: ["{}"],
    seed: {
      home: "/workspace/.home/claude",
      cwd: "/workspace",
    },
  };
}

describe("Claude qualification runtime configuration", () => {
  it("requires a qualification asset bundle and the exact API revision", () => {
    expect(decodeClaudeFacetConfiguration(configuration()).assets.assets.purpose).toBe(
      "qualification",
    );
    expect(() =>
      decodeClaudeFacetConfiguration({
        ...configuration(),
        assets: {
          ...configuration().assets,
          assets: { ...configuration().assets.assets, purpose: "release" },
        },
      }),
    ).toThrow("DEPLOY3_CLAUDE_QUALIFICATION_ASSETS_REQUIRED");
    expect(() =>
      decodeClaudeFacetConfiguration({
        ...configuration(),
        workload: { ...configuration().workload, apiRevision: "EC1APIr1" },
      }),
    ).toThrow();
  });

  it("rejects builder-only fields and missing turn input", () => {
    expect(() =>
      decodeClaudeFacetConfiguration({ ...configuration(), facetSource: "builder source" }),
    ).toThrow();
    expect(() => decodeClaudeFacetConfiguration({ ...configuration(), turnJson: [] })).toThrow(
      "DEPLOY3_CLAUDE_TURN_INPUT_MISSING",
    );
  });
});
