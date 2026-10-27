// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - This test uses the local Workerd transport.
import * as NodeURL from "node:url";
import { afterEach, beforeAll, beforeEach, expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";
import { loadControlledCodexRelease } from "./tests/controlledRelease.fixture.ts";

let harness: ReturnType<typeof createTestHarness>;
let facetSource = "";

beforeAll(async () => {
  const bundled = await build({
    entryPoints: [
      NodeURL.fileURLToPath(new URL("./tests/controlledCreationFacet.fixture.ts", import.meta.url)),
    ],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser"],
    target: "esnext",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  facetSource = bundled.outputFiles[0]?.text ?? "";
  if (facetSource.length === 0) throw new Error("The controlled request-facet fixture is empty.");
}, 60_000);

const makeHarness = () =>
  createTestHarness({
    workers: [
      {
        config: {
          name: "harness-public-process-creation-proof",
          main: NodeURL.fileURLToPath(
            new URL("./tests/publicCreation.workerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-19",
          compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
          vars: {
            RESIDENT_BYTE_LIMIT: "128000000",
            COLD_CREATION_FACET_SOURCE: facetSource,
          },
          worker_loaders: [{ binding: "LOADER" }],
          durable_objects: {
            bindings: [
              { name: "HARNESS_FILES_STORE", class_name: "ColdCreationFilesStore" },
              { name: "HARNESS_RUN_STORE", class_name: "ControlledCreationRunStore" },
              { name: "HARNESS_THREAD_SUPERVISOR", class_name: "HarnessThreadSupervisorObject" },
              { name: "PROCESS_EXECUTION_SHARDS", class_name: "ColdCreationShard" },
              { name: "PLACEMENT_STORES", class_name: "PlacementStore" },
              { name: "COLD_CREATION_STORE", class_name: "CreationStore" },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: [
                "ColdCreationFilesStore",
                "ControlledCreationRunStore",
                "HarnessThreadSupervisorObject",
                "ColdCreationShard",
                "PlacementStore",
                "CreationStore",
              ],
            },
          ],
        },
      },
    ],
  });

beforeEach(async () => {
  if (facetSource.length === 0) throw new Error("Controlled facet source was not prepared.");
  harness = makeHarness();
  await harness.listen();
}, 60_000);

afterEach(async () => {
  if (harness !== undefined) await harness.close();
});

it("creates through public C, stores the peer UUID at generation one, and runs request one on that facet", async () => {
  const response = await harness.fetch("http://proof/fresh");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.kind).toBe("public-c-cold-create-retained-request");
  expect(result.initiallyMissing).toBe(true);
  expect(result.peerNativeSessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(result.created.status).toBe("created");
  expect(result.created.nativeSessionId).toBe(result.peerNativeSessionId);
  expect(result.status.status).toBe("bound");
  expect(result.status.nativeSessionId).toBe(result.peerNativeSessionId);
  expect(result.store).toMatchObject({
    generation: 1,
    facetNonce: result.created.identity.incarnationNonce,
    nativeSessionId: result.peerNativeSessionId,
    checkpoint: {
      checkpointId: result.created.checkpoint.native.id,
      manifestSha256: result.created.checkpoint.filesystem.sha256,
    },
    requestCheckpoint: result.created.checkpoint,
    firstFacet: {
      generation: 1,
      operationId: result.created.operationId,
      facetNonce: result.created.identity.incarnationNonce,
    },
    filesCheckpoint: {
      checkpointId: result.created.checkpoint.native.id,
      manifestSha256: result.created.checkpoint.filesystem.sha256,
    },
  });
  expect(JSON.parse(result.store.fileContent)).toMatchObject({
    nativeSessionId: result.peerNativeSessionId,
    userTurns: 0,
  });
  expect(result.committed).toBe("committed");
  expect(result.executed.processes[0]).toMatchObject({
    status: "settled",
    identity: result.created.identity,
  });
  expect(result.terminal).toEqual([
    expect.objectContaining({
      nativeSessionId: result.peerNativeSessionId,
      facetNonce: result.created.identity.incarnationNonce,
      stopped: true,
      joined: { invocationRpc: true, fetch: true, ports: true },
    }),
  ]);
  expect(result.creationPlacement).toMatchObject({
    identity: result.created.identity,
    disposed: true,
    released: true,
  });
  expect(result.placementWriter.writer).toBe(false);
  expect(result.observations["cold/events/peer-thread-start"]).toHaveLength(1);
  expect(result.observations["cold/events/facet-disposed"]).toEqual([
    expect.objectContaining({ facetNonce: result.created.identity.incarnationNonce }),
  ]);
  expect(result.observations["cold/events/request-runtime-run"]).toEqual([
    expect.objectContaining({
      requestId: expect.stringContaining("request-retained"),
      facetNonce: result.created.identity.incarnationNonce,
      nativeSessionId: result.peerNativeSessionId,
    }),
  ]);
  expect(result.observations["cold/events/facet-invoked"]).toHaveLength(1);
  expect(result.observations["cold/events/inert-restore"]).toBeUndefined();
  expect(result.observations["cold/events/normal-open"]).toBeUndefined();
  expect(result.loadedRelease).toEqual(await loadControlledCodexRelease());
}, 120_000);

it("keeps a claim-only crash uncertain and refuses to create or bind a second native thread", async () => {
  const response = await harness.fetch("http://proof/claim-crash");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.kind).toBe("public-c-claim-before-bind-recovery");
  expect(result.initiallyMissing).toBe(true);
  expect(result.first.rejected).toBe(true);
  expect(result.reconstructedStatus).toMatchObject({ status: "uncertain" });
  expect(result.retry.rejected).toBe(true);
  expect(result.retry.message).toContain("prior native creation is uncertain");
  expect(result.finalStatus).toMatchObject({ status: "uncertain" });
  expect(result.writerClaimFailures).toBe(1);
  expect(result.writer.writer).toBe(false);
  expect(result.peerEvents).toEqual({});
  expect(result.loadedRelease).toBeNull();
}, 120_000);

it("reconstructs a bound owner, disposes its exact facet, then restores the same UUID and initial checkpoint through native-journal runShard", async () => {
  const response = await harness.fetch("http://proof/bound-crash");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.kind).toBe("public-c-bound-recovery-strict-restore");
  expect(result.lostReply).toMatchObject({ rejected: true });
  expect(result.bound.status).toBe("bound");
  expect(result.bound.nativeSessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(result.recovered).toMatchObject({
    status: "bound",
    nativeSessionId: result.bound.nativeSessionId,
    identity: result.bound.identity,
    checkpoint: result.bound.checkpoint,
    lifecycle: "stopped",
    control: { epoch: 2 },
  });
  expect(result.beforePlacement.lease).toEqual(result.afterPlacement.lease);
  expect(result.afterPlacement).toMatchObject({
    identity: result.bound.identity,
    disposed: true,
    released: true,
    termination: { kind: "disposed", facetNonce: result.bound.identity.incarnationNonce },
  });
  expect(result.stopped).toMatchObject({
    lifecycle: "stopped",
    nativeSessionId: result.bound.nativeSessionId,
    checkpoint: {
      checkpointId: result.bound.checkpoint.native.id,
      manifestSha256: result.bound.checkpoint.filesystem.sha256,
    },
    publisher: {
      generation: 1,
      facetNonce: result.bound.identity.incarnationNonce,
    },
  });
  expect(result.observations["cold/events/peer-thread-start"]).toHaveLength(1);
  expect(result.observations["cold/events/inert-restore"]).toEqual([
    expect.objectContaining({
      nativeSessionId: result.bound.nativeSessionId,
      checkpointId: result.bound.checkpoint.native.id,
      manifestRevision: result.bound.checkpoint.filesystem.sha256,
      priorFacetNonce: result.bound.identity.incarnationNonce,
      expectedFacetGeneration: 1,
    }),
  ]);
  expect(result.observations["cold/events/request-runtime-run"]).toHaveLength(1);
  expect(result.observations["cold/events/facet-invoked"]).toHaveLength(1);
  expect(result.executed.processes[0]?.status).toBe("settled");
  const restoredFacetNonce = result.executed.processes[0]?.identity?.incarnationNonce;
  expect(restoredFacetNonce).toBeTruthy();
  expect(result.observations["cold/events/facet-disposed"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ facetNonce: result.bound.identity.incarnationNonce }),
      expect.objectContaining({ facetNonce: restoredFacetNonce }),
    ]),
  );
  expect(restoredFacetNonce).not.toBe(result.bound.identity.incarnationNonce);
  expect(result.committed).toBe("committed");
  expect(result.restored.nativeSessionId).toBe(result.bound.nativeSessionId);
  expect(result.restored.requestStatus).toBe("completed");
  expect(result.terminal).toEqual([
    expect.objectContaining({
      nativeSessionId: result.bound.nativeSessionId,
      stopped: true,
      joined: { invocationRpc: true, fetch: true, ports: true },
    }),
  ]);
  expect(result.placementWriter.writer).toBe(false);
  expect(result.loadedRelease).toEqual(await loadControlledCodexRelease());
}, 120_000);

it("recovers after actual C destruction without disposing the lost facet, then restores the same binding through native-journal runShard", async () => {
  const response = await harness.fetch("http://proof/parent-destroyed-crash");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.kind).toBe("public-c-parent-destroyed-bound-recovery-strict-restore");
  expect(result.afterIncarnationNonce).not.toBe(result.beforeIncarnationNonce);
  expect(result.beforeRequestCount).toBe(0);
  expect(result.beforeObservations["cold/events/request-runtime-run"]).toBeUndefined();
  expect(result.beforeObservations["cold/events/facet-invoked"]).toBeUndefined();
  expect(result.bound.status).toBe("bound");
  expect(result.recovered).toMatchObject({
    status: "bound",
    nativeSessionId: result.created.nativeSessionId,
    identity: result.created.identity,
    checkpoint: result.created.checkpoint,
    lifecycle: "settled",
    control: { epoch: 2 },
  });
  expect(result.settled).toMatchObject({
    lifecycle: "settled",
    nativeSessionId: result.created.nativeSessionId,
    checkpoint: {
      checkpointId: result.created.checkpoint.native.id,
      manifestSha256: result.created.checkpoint.filesystem.sha256,
    },
  });
  expect(result.afterPlacement).toMatchObject({
    identity: result.created.identity,
    disposed: false,
    released: true,
    termination: {
      kind: "parent-destroyed",
      observedByIncarnationNonce: result.afterIncarnationNonce,
    },
  });
  expect(result.beforePlacement.lease).toEqual(result.afterPlacement.lease);
  expect(result.observations["cold/events/peer-thread-start"]).toHaveLength(1);
  expect(result.observations["cold/events/inert-restore"]).toEqual([
    expect.objectContaining({
      nativeSessionId: result.created.nativeSessionId,
      checkpointId: result.created.checkpoint.native.id,
      manifestRevision: result.created.checkpoint.filesystem.sha256,
      priorFacetNonce: result.created.identity.incarnationNonce,
      expectedFacetGeneration: 1,
    }),
  ]);
  expect(result.observations["cold/events/facet-disposed"] ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ facetNonce: result.created.identity.incarnationNonce }),
    ]),
  );
  expect(result.observations["cold/events/request-runtime-run"]).toEqual([
    expect.objectContaining({
      requestId: expect.stringContaining("request-parent-destroyed"),
      nativeSessionId: result.created.nativeSessionId,
    }),
  ]);
  expect(result.observations["cold/events/facet-invoked"]).toEqual([
    expect.objectContaining({ requestId: expect.stringContaining("request-parent-destroyed") }),
  ]);
  expect(result.executed.processes[0]?.status).toBe("settled");
  expect(result.restored.nativeSessionId).toBe(result.created.nativeSessionId);
  expect(result.restored.requestStatus).toBe("completed");
  expect(result.committed).toBe("committed");
  expect(result.terminal).toEqual([
    expect.objectContaining({
      nativeSessionId: result.created.nativeSessionId,
      stopped: true,
      joined: { invocationRpc: true, fetch: true, ports: true },
    }),
  ]);
  expect(result.placementWriter.writer).toBe(false);
  expect(result.loadedRelease).toEqual(await loadControlledCodexRelease());
}, 120_000);

it("retries the same bound recovery input after FilesStore control sync and exact facet disposal failures", async () => {
  const response = await harness.fetch("http://proof/recovery-retries");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.kind).toBe("public-c-bound-recovery-retries");
  expect(result.syncFailure.rejected).toBe(true);
  expect(result.syncFailures).toBe(1);
  expect(result.afterSyncFailure).toMatchObject({
    disposed: false,
    released: false,
    termination: null,
  });
  expect(result.disposeFailure).toMatchObject({
    rejected: true,
    message: "Injected exact facet disposal failure.",
  });
  expect(result.exactDisposeFailures).toBe(1);
  expect(result.afterDisposeFailure).toMatchObject({
    disposed: false,
    released: false,
    termination: null,
  });
  expect(result.recovered).toMatchObject({
    status: "bound",
    nativeSessionId: result.created.nativeSessionId,
    checkpoint: result.created.checkpoint,
    lifecycle: "stopped",
    control: result.recoveryInput.nextControl,
  });
  expect(result.afterPlacement).toMatchObject({
    identity: result.created.identity,
    disposed: true,
    released: true,
    termination: { kind: "disposed", facetNonce: result.created.identity.incarnationNonce },
  });
  expect(result.lifecycle).toBe("stopped");
}, 120_000);

it("retries the exact offered first request after FilesStore admission fails, before any native dispatch", async () => {
  const response = await harness.fetch("http://proof/admission-retry");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.kind).toBe("public-c-first-request-files-admission-retry");
  expect(result.first.rejected).toBe(true);
  expect(result.admittedFailures).toBe(1);
  expect(result.offeredStatus).toBe("offered");
  expect(result.pendingStepId).toBe(result.requestId);
  expect(result.observationsAfterFailure["cold/events/request-runtime-run"]).toBeUndefined();
  expect(result.observationsAfterFailure["cold/events/peer-thread-start"]).toHaveLength(1);
  expect(result.finalStatus).toBe("completed");
  expect(result.finalLifecycle).toBe("accepting");
  expect(result.committed).toBe("committed");
  expect(result.executed.processes[0]?.status).toBe("settled");
  expect(result.observations["cold/events/request-runtime-run"]).toEqual([
    expect.objectContaining({ requestId: result.requestId }),
  ]);
  expect(result.observations["cold/events/facet-invoked"]).toEqual([
    expect.objectContaining({ requestId: result.requestId }),
  ]);
  expect(result.observations["cold/events/peer-thread-start"]).toHaveLength(1);
}, 120_000);
