import { prepareClaudeFacetCode } from "../prepareClaudeFacet.ts";
import { expect, test } from "vite-plus/test";
import { productLoadedPreparedRelease } from "../../../../src/harness/ProductHarnessProcessRelease.ts";
import { loadDeploy3ClaudeAssets } from "../claudeAssets.ts";
import { syntheticAssets } from "../syntheticAssets.fixture.ts";
import { createClaudeCTransport, claudeLane } from "./claudeCTransport.ts";
import {
  loadClaudeQualificationRelease,
  readClaudeQualificationInputs,
  decodeClaudeFacetConfiguration,
} from "./claudeConfiguration.ts";

const rootRunId = "6d8d793b-0cbb-45cd-87a4-22d557e5025e";
const unavailable = async () => {
  throw new Error("C owner would run here");
};

async function setup() {
  const fixture = await syntheticAssets();
  const opened = await loadDeploy3ClaudeAssets(fixture.input, fixture.binding);
  const runtime = decodeClaudeFacetConfiguration({
    schema: "sb1070/deploy3-claude-facet/v1",
    purpose: "qualification",
    assets: fixture.input,
    workload: {
      collectorNonce: "synthetic-collector",
      mcpProbe: {
        toolName: "mcp__executor__qualification_echo",
        input: { text: "synthetic-probe" },
        expectedText: "synthetic-probe",
      },
      apiRevision: "EC1APIr2",
      model: "synthetic",
    },
    turnJson: ["{}"],
    seed: { home: "/workspace/.home/claude", cwd: "/workspace" },
  });
  const prepared = (variant: "baseline" | "hooks") =>
    productLoadedPreparedRelease(
      "claude-code",
      opened.releaseVariants.catalog[variant].fullArtifact,
      { plan: opened[variant].plan, payloads: new Map() },
    );
  const configuration = {
    runId: rootRunId,
    claude: {
      runtime: { ...runtime, turnJson: { baseline: runtime.turnJson, hooks: runtime.turnJson } },
      facetSource: "synthetic",
      environmentPackages: {},
      expected: { baseline: prepared("baseline"), hooks: prepared("hooks") },
    },
  };
  const transport = createClaudeCTransport({
    variant: "baseline",
    configuration: async () => configuration,
    shard: () => ({
      runShard: unavailable,
      resumeProcess: unavailable,
      continueProcess: unavailable,
      commitProcessCheckpoint: unavailable,
      stopIdleProcess: unavailable,
    }),
    phaseForRequest: () => "work",
    beginStep: unavailable,
    endStep: unavailable,
  });
  return { fixture, configuration, transport, runtime };
}

test("C admission refuses another lane and another prepared variant before contacting C", async () => {
  const f = await setup();
  try {
    const lane = claudeLane(rootRunId, "baseline");
    const base = {
      runId: lane.runId,
      executionOperationId: "synthetic-operation",
      shardOwner: lane.shardOwner,
      controllerClaim: {
        ownerId: "synthetic",
        incarnationId: "synthetic",
        epoch: 1,
        controlKey: "c".repeat(32),
      },
      executionMode: "native-journal" as const,
    };
    await expect(
      f.transport.runShard({ ...base, runId: "another-run", processes: [] }, "request"),
    ).rejects.toThrow("one real native-journal lane");
    const process = {
      processId: lane.processId,
      codeId: f.configuration.claude.expected.baseline.artifact.releaseId,
      residentBytes: 104 * 1024 * 1024,
      nativeSessionId: "b4945f59-d1c1-43f5-8b19-439f54856651",
      checkpointId: "synthetic",
      manifestRevision: "a".repeat(64),
      operationId: "synthetic",
      priorFacetNonce: "synthetic",
      expectedFacetGeneration: 1,
      mainModule: "qualifier-claude-facet.mjs",
      entrypoint: "ClaudeFacet",
      modules: {
        "qualifier-claude-facet.mjs": {
          js: "export { ClaudeFacet } from './qualifier-claude-implementation.mjs';\n",
        },
      },
      productBootstrap: {
        provider: "claude-code" as const,
        preparedReleaseId: f.configuration.claude.expected.hooks.artifact.releaseId,
        restoreMode: "same-variant-serialized-checkpoint" as const,
      },
      targetPreparedRelease: f.configuration.claude.expected.hooks,
    };
    await expect(
      f.transport.runShard({ ...base, processes: [process] }, "request"),
    ).rejects.toThrow("selected qualification variant");
  } finally {
    await f.fixture.dispose();
  }
});

test("both runtime releases load from full ledger rows through the exact public identity decoder", async () => {
  const f = await setup();
  try {
    const inputs = await readClaudeQualificationInputs(f.runtime, f.fixture.binding);
    for (const variant of ["baseline", "hooks"] as const) {
      const expected = f.configuration.claude.expected[variant];
      const loaded = await loadClaudeQualificationRelease(inputs, expected.artifact);
      expect(loaded.artifact).toEqual(expected.artifact);
      expect(loaded.plan.preparedModules).toEqual(expected.plan.preparedModules);
    }
  } finally {
    await f.fixture.dispose();
  }
});

test("resumed loader derives its variant from C's actual selected release and refuses a conflicting label", async () => {
  const f = await setup();
  try {
    for (const variant of ["baseline", "hooks"] as const) {
      const code = {
        compatibilityDate: "2026-10-19",
        mainModule: "qualifier-claude-facet.mjs",
        modules: {},
        env: { HARNESS_C_TARGET_PREPARED_RELEASE: f.configuration.claude.expected[variant] },
      };
      const prepared = await prepareClaudeFacetCode(code, f.configuration, f.fixture.binding);
      expect(prepared.variant).toBe(variant);
      expect(prepared.code.env.QUALIFIER_CLAUDE_VARIANT).toBe(variant);
      expect(prepared.code.modules).toHaveProperty("qualifier-claude-implementation.mjs");
      await expect(
        prepareClaudeFacetCode(
          {
            ...code,
            env: {
              ...code.env,
              QUALIFIER_CLAUDE_VARIANT: variant === "baseline" ? "hooks" : "baseline",
            },
          },
          f.configuration,
          f.fixture.binding,
        ),
      ).rejects.toThrow("SELECTED_VARIANT_MISMATCH");
    }
  } finally {
    await f.fixture.dispose();
  }
});
