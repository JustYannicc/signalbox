import { prepareClaudeFacetCode } from "../prepareClaudeFacet.ts";
import {
  CLAUDE_OWNER_COMPATIBILITY,
  claudeOwnerCode,
  openClaudeOwnerRelease,
} from "./claudeOwnerCode.ts";
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
    seed: {
      home: "/workspace/.home/claude",
      cwd: "/workspace",
    },
    workingSet: { byteLimit: 1024 * 1024, metadataLimit: 32_768, pathByteLimit: 4096 },
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
      runtime: {
        ...runtime,
        turnJson: { baseline: runtime.turnJson, hooks: runtime.turnJson },
        seed: runtime.seed,
      },
      facetSource: "synthetic",
      kernelSource: "export class ClaudeKernelFacet {}",
      cliSource: "export class ClaudeCliFacet {}",
      computerSource: "export class ComputerExecutionObject {}",
      sdkHostSource: "synthetic-sdk-host",
      environmentPackages: {},
      expected: { baseline: prepared("baseline"), hooks: prepared("hooks") },
    },
  };
  const transport = createClaudeCTransport({
    variant: "baseline",
    configuration: async () => configuration,
    shard: () => ({
      startFreshProcess: unavailable,
      runCreatedProcess: unavailable,
      processCreationStatus: unavailable,
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

test.each(["baseline", "hooks"] as const)(
  "%s owner code reads the CLI's release only inside the CLI's own factory",
  async (variant) => {
    const f = await setup();
    try {
      let reads = 0;
      const assets = {
        fetch: (request: Request) => {
          reads++;
          return f.fixture.binding.fetch(request);
        },
      };
      const claude = f.configuration.claude;
      const release = await openClaudeOwnerRelease(claude.expected[variant], claude, assets);
      const owners = claudeOwnerCode({
        compatibility: CLAUDE_OWNER_COMPATIBILITY,
        release,
        sources: {
          kernel: () => claude.kernelSource,
          cli: () => claude.cliSource,
          computer: () => claude.computerSource,
          sdk: () => claude.sdkHostSource,
        },
        kernelEnv: { QUALIFIER_CLAUDE_VARIANT: variant },
        commands: "qualifier-commands",
      });
      const opened = reads;
      const kernelCode = await owners.kernel();
      const computerCode = await owners.computer();
      expect(reads).toBe(opened);
      const cliCode = await owners.cli();
      expect(reads).toBeGreaterThan(opened);
      const sdkCode = await owners.sdk();
      const paths = (code: WorkerLoaderWorkerCode) => Object.keys(code.modules);
      expect(kernelCode.env).toEqual({ QUALIFIER_CLAUDE_VARIANT: variant });
      expect(paths(kernelCode)).toEqual(["claude-kernel-entry.mjs", "qualifier-claude-kernel.mjs"]);
      expect(computerCode.env).toMatchObject({ CHILD_WORKERS: "qualifier-commands" });
      expect(paths(computerCode)).toEqual([
        "computer-execution-entry.mjs",
        "computer-execution.mjs",
      ]);
      expect(paths(cliCode)).toContain("qualifier-claude-cli.mjs");
      expect(paths(cliCode).some((key) => key.includes("/cli/"))).toBe(true);
      expect(paths(cliCode).some((key) => key.includes("/sdk/"))).toBe(false);
      expect(paths(sdkCode)).toContain("qualifier-claude-sdk-host.mjs");
      expect(paths(sdkCode).some((key) => key.includes("/cli/"))).toBe(false);
    } finally {
      await f.fixture.dispose();
    }
  },
);

test("the C loader prepares only the inert import calibration, never a Claude turn facet", async () => {
  const f = await setup();
  try {
    const expected = f.configuration.claude.expected.baseline;
    const inputs = {
      RUN_ID: rootRunId,
      CONFIG_SHA256: "a".repeat(64),
      authorities: {
        access: f.fixture.binding,
        executor: f.fixture.binding,
        continuations: f.fixture.binding,
      },
    };
    const calibration = {
      compatibilityDate: "2026-10-19",
      mainModule: "qualifier-claude-calibration-facet.mjs",
      modules: {},
      env: {
        HARNESS_C_TARGET_PREPARED_RELEASE: expected,
        HARNESS_C_PRODUCT_CAPABILITIES: {},
        QUALIFIER_CLAUDE_FACET_MODE: "inert-import-calibration",
      },
    };
    const prepared = await prepareClaudeFacetCode(
      calibration,
      f.configuration,
      f.fixture.binding,
      inputs,
    );
    expect(prepared.variant).toBe("baseline");
    expect(prepared.code.env).toMatchObject({
      RUN_ID: rootRunId,
      QUALIFIER_CLAUDE_VARIANT: "baseline",
    });
    expect(prepared.code.env).not.toHaveProperty("CLAUDE_KERNEL");
    expect(prepared.code.modules).toHaveProperty("qualifier-claude-implementation.mjs");
    await expect(
      prepareClaudeFacetCode(
        {
          ...calibration,
          mainModule: "qualifier-claude-facet.mjs",
          env: { ...calibration.env, QUALIFIER_CLAUDE_FACET_MODE: undefined },
        },
        f.configuration,
        f.fixture.binding,
        inputs,
      ),
    ).rejects.toThrow("DEPLOY3_CLAUDE_FACET_MODE_MISMATCH");
    await expect(
      prepareClaudeFacetCode(
        { ...calibration, env: { ...calibration.env, QUALIFIER_CLAUDE_VARIANT: "hooks" } },
        f.configuration,
        f.fixture.binding,
        inputs,
      ),
    ).rejects.toThrow("SELECTED_VARIANT_MISMATCH");
  } finally {
    await f.fixture.dispose();
  }
});
