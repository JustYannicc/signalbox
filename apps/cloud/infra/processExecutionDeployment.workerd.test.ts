// @effect-diagnostics nodeBuiltinImport:off - this proof invokes the normal Worker entrypoint in local workerd.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness, unstable_readConfig } from "wrangler";

import type {
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionShardResult,
} from "../src/harness/HarnessProcessPlacement.ts";
import type { CloudEnv } from "../src/worker.ts";
import { COMPATIBILITY_DATE, cloudStage } from "./stage.ts";

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
const missingLimitCloudName = "signalbox-cloud-missing-resident-limit";
const normalConfig = unstable_readConfig(
  {
    config: NodeURL.fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    env: "dev",
  },
  { hideWarnings: true },
);
const testConfigDirectory = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "signalbox-process-execution-deployment-"),
);
const testAssetsDirectory = NodePath.join(testConfigDirectory, "assets");
NodeFS.mkdirSync(testAssetsDirectory);
const {
  assets: configuredAssets,
  containers: _containers,
  configPath: _configPath,
  definedEnvironments: _definedEnvironments,
  env: _env,
  targetEnvironment: _targetEnvironment,
  topLevelName: _topLevelName,
  triggers: _triggers,
  userConfigPath: _userConfigPath,
  ...normalDevConfig
} = normalConfig;
// The normal Wrangler reader supplies the Worker graph; only unused containers and built assets are replaced for this local RPC proof.
const cloudConfig = {
  ...normalDevConfig,
  name: cloudName,
  assets: { ...configuredAssets, directory: testAssetsDirectory },
  containers: [],
};
const processExecutionProbeConfig = (name: string, service: string) => ({
  name,
  main: NodeURL.fileURLToPath(
    new URL("./processExecutionDeploymentProbe.worker.ts", import.meta.url),
  ),
  compatibility_date: COMPATIBILITY_DATE,
  services: [
    {
      binding: "PROCESS_EXECUTION",
      service,
      entrypoint: "HarnessProcessExecutionEntrypoint",
    },
  ],
});

const harness = createTestHarness({
  root: NodeURL.fileURLToPath(new URL("../", import.meta.url)),
  workers: [
    {
      config: cloudConfig,
      vars: { LOCAL_WORKERD: "1", RESIDENT_BYTE_LIMIT: "1" },
    },
    {
      config: { ...cloudConfig, name: missingLimitCloudName },
      vars: { LOCAL_WORKERD: "1" },
    },
    {
      config: processExecutionProbeConfig("process-execution-deployment-probe", cloudName),
    },
    {
      config: processExecutionProbeConfig(
        "process-execution-deployment-missing-limit-probe",
        missingLimitCloudName,
      ),
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
    const cloud = harness.getWorker<CloudEnv>(cloudName);
    const env = await cloud.getEnv();
    expect(env.RESIDENT_BYTE_LIMIT).toBe("1");
    await env.HARNESS_THREAD_SUPERVISOR.getByName(runId).execute({
      type: "initialize",
      runId,
      nativeSessionId: "deployment-reachability-session",
      control,
      publisher,
      checkpoint,
    });

    const input = executionInput(runId, 5);

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

  it("rejects a missing resident-byte limit at execution before placement", async () => {
    const runId = "deployment-missing-resident-limit-run";
    const cloud = harness.getWorker<CloudEnv>(missingLimitCloudName);
    const env = await cloud.getEnv();
    expect(env.RESIDENT_BYTE_LIMIT).toBeUndefined();
    await env.HARNESS_THREAD_SUPERVISOR.getByName(runId).execute({
      type: "initialize",
      runId,
      nativeSessionId: "deployment-reachability-session",
      control,
      publisher,
      checkpoint,
    });

    const probe = harness.getWorker("process-execution-deployment-missing-limit-probe");
    const response = await probe.fetch("http://probe/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(executionInput(runId, 1)),
    });
    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(500);
    expect(body.error).toContain("Process execution shard resident-byte limit is invalid.");
  }, 120_000);
});

function executionInput(runId: string, processCount: number): HarnessProcessExecutionShardInput {
  return {
    runId,
    executionOperationId: `deployment-reachability-operation-${runId}`,
    shardOwner: `deployment-reachability-${runId}`,
    controllerClaim: control,
    processes: Array.from({ length: processCount }, (_, index) => ({
      processId: `deployment-${runId}-process-${index}`,
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
}
