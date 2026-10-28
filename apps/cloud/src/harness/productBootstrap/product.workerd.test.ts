// @effect-diagnostics nodeBuiltinImport:off - Wrangler needs a filesystem entry point to launch local Workerd.
import * as NodeURL from "node:url";
import * as NodeProcess from "node:process";
import { afterEach, beforeAll, beforeEach, expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";

let harness: ReturnType<typeof createTestHarness>;
let productFacetSource: string;

beforeAll(async () => {
  const bundled = await build({
    entryPoints: [
      NodeURL.fileURLToPath(
        new URL("./tests/workerd/productFacet.workerd.fixture.ts", import.meta.url),
      ),
    ],
    bundle: true,
    // Resume records retain this fixture graph in a single Durable Object storage value.
    minify: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser"],
    target: "esnext",
    external: ["cloudflare:workers", "node:*", "./codex-engine.wasm"],
    write: false,
  });
  productFacetSource = bundled.outputFiles[0]?.text ?? "";
  if (productFacetSource.length === 0) throw new Error("The product fixture bundle is empty.");
}, 60_000);

const makeHarness = () =>
  createTestHarness({
    workers: [
      {
        config: {
          name: "1070-product-public-factory-workerd",
          main: NodeURL.fileURLToPath(
            new URL("./tests/workerd/product.workerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-19",
          compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
          worker_loaders: [{ binding: "LOADER" }],
          vars: {
            PRODUCT_FACET_SOURCE: productFacetSource,
            RESIDENT_BYTE_LIMIT: "128000000",
          },
          durable_objects: {
            bindings: [
              { name: "HARNESS_FILES_STORE", class_name: "HarnessFilesStoreObject" },
              { name: "HARNESS_RUN_STORE", class_name: "ProductFixtureRunStore" },
              { name: "HARNESS_THREAD_SUPERVISOR", class_name: "HarnessThreadSupervisorObject" },
              { name: "PROCESS_EXECUTION_SHARDS", class_name: "ProductFixtureShard" },
              { name: "PLACEMENT_STORES", class_name: "ProductFixturePlacementStore" },
              { name: "PRODUCT_FIXTURE", class_name: "ProductFixtureCapability" },
              { name: "PRODUCT_EXECUTOR", class_name: "ProductFixtureExecutor" },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: [
                "HarnessFilesStoreObject",
                "ProductFixtureRunStore",
                "HarnessThreadSupervisorObject",
                "ProductFixtureShard",
                "ProductFixturePlacementStore",
                "ProductFixtureCapability",
                "ProductFixtureExecutor",
              ],
            },
          ],
        },
      },
    ],
  });

beforeEach(async () => {
  if (productFacetSource.length === 0) throw new Error("Product fixture inputs were not prepared.");
  harness = makeHarness();
  await harness.listen();
}, 60_000);

afterEach(async () => {
  if (harness !== undefined) {
    await harness.close();
    NodeProcess.stdout.write("[public-C-harness-close-returned] productBootstrap\n");
  }
});

it("runs the actual Claude and Codex product factories through C's public shard APIs", async () => {
  const response = await harness.fetch("http://proof/positive");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.kind).toBe("product-c-workerd-public-chain");
  expect(result.initial.status).toBe("settled");
  expect(result.resumed.status).toBe("resumed");
  expect(result.continued.status).toBe("settled");
  expect(result.completedRequests).toEqual([
    { requestId: "turn-one", status: "completed", finishStatus: "completed" },
    { requestId: "turn-two", status: "completed", finishStatus: "completed" },
  ]);
  expect(result.restoreModes).toEqual({
    claude: "same-variant-serialized-checkpoint",
    codex: "cross-variant-fresh-boot",
  });
  expect(result.observations.events["fixture/event/bootstrap:claude"]).toMatchObject({
    provider: "claude-code",
    restoreMode: "same-variant-serialized-checkpoint",
  });
  expect(result.observations.events["fixture/event/bootstrap:codex"]).toMatchObject({
    provider: "codex",
    restoreMode: "cross-variant-fresh-boot",
  });
  expect(result.files.workspace).toBe("after\n");
  expect(result.files.codex).toBe("codex facet hydrated\n");
  expect(result.files.claudeTranscript).toContain("product-native-session");
  expect(result.observations.executor).toMatchObject({
    method: "POST",
    grant: { kind: "turn", requestId: "turn-two", call: 2 },
    signalAborted: false,
    requestSignalAborted: false,
    body: "native-executor-request",
  });
  expect(result.observations.initialAccessCalls).toBe(1);
  expect(result.observations.turnAccessCalls).toBe(2);
  // Release verification and WorkerLoader materialization each read the module once.
  expect(
    result.observations.releaseReadPaths.filter((path: string) => path === "codex/engine.wasm"),
  ).toHaveLength(2);
  expect(result.observations.modelRequests).toEqual(expect.arrayContaining(["/root", "/child"]));
  expect(result.proof.terminal).toHaveLength(2);
  expect(
    result.proof.terminal.every(
      (row: {
        readonly stopped: boolean;
        readonly joined: {
          readonly invocationRpc: boolean;
          readonly fetch: boolean;
          readonly ports: boolean;
        };
      }) => row.stopped && row.joined.invocationRpc && row.joined.fetch && row.joined.ports,
    ),
  ).toBe(true);
  expect(result.writer.writer).toBe(false);
});

it("rejects a prepared-release mismatch before publication and records the prepublication state", async () => {
  const response = await harness.fetch("http://proof/mismatch");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.kind).toBe("product-c-workerd-prepublication-mismatch");
  expect(result.rejected.rejected).toBe(true);
  expect(result.status.status).toBe("retained");
  expect(result.status.failure).toEqual({
    stage: "fresh-verification",
    reason: "prepared-release-mismatch",
  });
  expect(result.status.terminalEvidencePersisted).toBe(true);
  expect(result.status.preparedIdentityPersisted).toBe(false);
  expect(result.unchangedPublication).toBe(true);
  expect(result.after.generation).toBe(result.before.generation);
  expect(result.after.lifecycle).toBe("stopped");
  expect(result.after.preparedFacet ?? null).toEqual(result.before.preparedFacet ?? null);
  expect(result.proof.terminal).toHaveLength(1);
  expect(result.proof.terminal[0]).toMatchObject({
    stopped: true,
    joined: { invocationRpc: true, fetch: true, ports: true },
  });
  expect(result.proof.resumes).toEqual([
    {
      phase: "retained",
      prepared: false,
      failure: { stage: "fresh-verification", reason: "prepared-release-mismatch" },
    },
  ]);
  expect(result.writer.writer).toBe(false);
});

it.each([
  "missing-artifact",
  "changed-artifact",
  "missing-native",
  "changed-native",
  "missing-files",
  "changed-files",
])(
  "rejects %s through public C resume before prepared identity or publication",
  async (materialFault) => {
    const response = await harness.fetch(`http://proof/failure/${materialFault}`);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body);
    expect(result.kind).toBe("product-c-workerd-material-failure");
    expect(result.materialFault).toBe(materialFault);
    expect(result.rejected.rejected).toBe(true);
    expect(result.status.status).toBe("retained");
    expect(result.status.failure).toEqual({
      stage: materialFault.endsWith("files") ? "checkpoint" : "fresh-open",
      reason: "driver-failed",
    });
    expect(result.status.preparedIdentityPersisted).toBe(false);
    expect(result.status.terminalEvidencePersisted).toBe(true);
    expect(result.unchangedPublication).toBe(true);
    expect(result.after.generation).toBe(result.before.generation);
    expect(result.after.preparedFacet ?? null).toEqual(result.before.preparedFacet ?? null);
    expect(result.observations.turnAccessCalls).toBe(1);
    expect(result.writer.writer).toBe(false);
  },
);

it("restores Codex checkpoints inertly and starts the first fresh-grant turn through public C", async () => {
  const response = await harness.fetch("http://proof/codex-same");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.initialProvider).toBe("codex");
  expect(result.initial.status).toBe("settled");
  expect(result.resumed.status).toBe("resumed");
  expect(result.continued.status).toBe("settled");
  expect(result.restoreModes).toEqual({ codex: "same-variant-serialized-checkpoint" });
  expect(result.completedRequests).toEqual([
    { requestId: "turn-one", status: "completed", finishStatus: "completed" },
    { requestId: "turn-two", status: "completed", finishStatus: "completed" },
  ]);
  expect(result.observations.initialAccessCalls).toBe(2);
  expect(result.observations.turnAccessCalls).toBe(2);
  expect(
    result.observations.releaseReadPaths.filter((path: string) => path === "codex/engine.wasm"),
  ).toHaveLength(4);
  expect(result.observations.executor).toMatchObject({
    grant: { kind: "turn", requestId: "turn-two", call: 2 },
    signalAborted: false,
    requestSignalAborted: false,
    body: "native-executor-request",
  });
  expect(result.files.codex).toBe("codex facet hydrated\n");
  expect(result.proof.terminal).toHaveLength(2);
  expect(
    result.proof.terminal.every(
      (row: {
        stopped: boolean;
        joined: { invocationRpc: boolean; fetch: boolean; ports: boolean };
      }) => row.stopped && row.joined.invocationRpc && row.joined.fetch && row.joined.ports,
    ),
  ).toBe(true);
  expect(result.writer.writer).toBe(false);
});

it("returns the structured per-process checkpoint failure through fixture readiness immediately", async () => {
  const response = await harness.fetch(
    "http://proof/memory-failure-probe?runId=checkpoint-failure-probe",
  );
  const body = await response.json();

  expect(response.status).toBe(500);
  expect(body).toMatchObject({
    runId: "checkpoint-failure-probe",
    status: "failed",
    failure: {
      source: "process",
      processId: "product-memory-proof",
      error: "The fresh facet could not be prepared inert.",
      causes: [
        {
          _tag: "HarnessProcessPlacementError",
          kind: "prepare-failed",
          details: { facetFailureAt: "prepare", facetFailureCode: "rpc-error" },
        },
        {
          _tag: "HarnessRequestFacetError",
          message: "Harness host could not prepare the committed checkpoint inert.",
        },
        {
          code: "CODEX_CHECKPOINT_RESTORE",
          operation: "resume",
          message: "Synthetic Codex checkpoint restore failure.",
        },
      ],
    },
  });
});
