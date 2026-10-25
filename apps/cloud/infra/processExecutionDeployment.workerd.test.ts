// @effect-diagnostics nodeBuiltinImport:off - this proof invokes the normal Worker entrypoint in local workerd.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

import type {
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionShardResult,
} from "../src/harness/HarnessProcessPlacement.ts";
import { parseJsonc } from "../../../scripts/cloud-migrations/check.ts";
import { COMPATIBILITY_DATE, cloudStage } from "./stage.ts";

interface ProcessSupervisorNamespace {
  getByName(name: string): {
    execute(command: unknown): Promise<unknown>;
  };
}

interface CloudEnvironment {
  readonly HARNESS_THREAD_SUPERVISOR: ProcessSupervisorNamespace;
}

const control = {
  ownerId: "deployment-reachability-owner",
  incarnationId: "deployment-reachability-controller",
  epoch: 1,
  controlKey: "deployment-reachability-control-key-000000000000",
};

const publisher = {
  generation: 1,
  facetNonce: "deployment-reachability-facet",
  publisherKey: "deployment-reachability-publisher-key-000000000000",
};

const checkpoint = {
  checkpointId: "deployment-reachability-checkpoint",
  manifestSha256: "0".repeat(64),
};

const cloudName = cloudStage("production").cloudWorker;
type JsonObject = Record<string, unknown>;
const normalConfig = parseJsonc(
  NodeFS.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as JsonObject;
const configuredEnvironments = normalConfig.env as Record<string, JsonObject>;
const configuredDev = configuredEnvironments.dev;
if (configuredDev === undefined) throw new Error("The normal Wrangler config has no dev env.");
const testConfigDirectory = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "signalbox-process-execution-deployment-"),
);
const testAssetsDirectory = NodePath.join(testConfigDirectory, "assets");
const testConfigPath = NodePath.join(testConfigDirectory, "wrangler.json");
NodeFS.mkdirSync(testAssetsDirectory);
const {
  env: _environments,
  assets: configuredAssets,
  containers: _containers,
  $schema: _schema,
  ...baseConfig
} = normalConfig;
const { dev: _dev, ...otherEnvironments } = configuredEnvironments;
const { containers: _devContainers, ...devConfig } = configuredDev;
// Keep the real root Worker, bindings, migrations and dev overrides; this RPC proof never needs containers or built web assets.
NodeFS.writeFileSync(
  testConfigPath,
  JSON.stringify({
    ...baseConfig,
    main: NodeURL.fileURLToPath(new URL("../src/worker.ts", import.meta.url)),
    assets: { ...(configuredAssets as JsonObject), directory: testAssetsDirectory },
    containers: [],
    env: {
      ...otherEnvironments,
      dev: { ...devConfig, containers: [] },
    },
  }),
);

const harness = createTestHarness({
  root: NodeURL.fileURLToPath(new URL("../", import.meta.url)),
  workers: [
    {
      configPath: testConfigPath,
      env: "dev",
      vars: { LOCAL_WORKERD: "1", RESIDENT_BYTE_LIMIT: "1" },
    },
    {
      config: {
        name: "process-execution-deployment-probe",
        main: NodeURL.fileURLToPath(
          new URL("./processExecutionDeploymentProbe.worker.ts", import.meta.url),
        ),
        compatibility_date: COMPATIBILITY_DATE,
        services: [
          {
            binding: "PROCESS_EXECUTION",
            service: cloudName,
            entrypoint: "HarnessProcessExecutionEntrypoint",
          },
        ],
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(async () => {
  await harness.close();
  NodeFS.rmSync(testConfigDirectory, { recursive: true, force: true });
});

describe("normal process-execution deployment wiring", () => {
  it("routes the named entrypoint through the real shard namespace and ctx.exports overflow", async () => {
    const runId = "deployment-reachability-run";
    const cloud = harness.getWorker<CloudEnvironment>(cloudName);
    const env = await cloud.getEnv();
    await env.HARNESS_THREAD_SUPERVISOR.getByName(runId).execute({
      type: "initialize",
      runId,
      nativeSessionId: "deployment-reachability-session",
      control,
      publisher,
      checkpoint,
    });

    const input: HarnessProcessExecutionShardInput = {
      runId,
      executionOperationId: "deployment-reachability-operation",
      shardOwner: "deployment-reachability",
      controllerClaim: control,
      processes: Array.from({ length: 5 }, (_, index) => ({
        processId: `deployment-process-${index}`,
        codeId: `deployment-code-${index}`,
        residentBytes: 2,
        nativeSessionId: "deployment-reachability-session",
        checkpointId: checkpoint.checkpointId,
        manifestRevision: "deployment-reachability-manifest",
        operationId: `deployment-operation-${index}`,
        priorFacetNonce: publisher.facetNonce,
        expectedFacetGeneration: publisher.generation,
        mainModule: "main.js",
        modules: { "main.js": "export default () => 1;" },
        entrypoint: "HarnessProcessFacetObject",
      })),
    };

    const probe = harness.getWorker("process-execution-deployment-probe");
    const response = await probe.fetch("http://probe/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);

    const result = JSON.parse(body) as HarnessProcessExecutionShardResult;
    expect(result.processes).toHaveLength(5);
    expect(result.processes.map(({ status }) => status)).toEqual([
      "unplaceable",
      "unplaceable",
      "unplaceable",
      "unplaceable",
      "unplaceable",
    ]);
    expect(new Set(result.processes.map(({ requestContextId }) => requestContextId)).size).toBe(2);
  }, 120_000);
});
