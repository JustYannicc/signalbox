import { createHarnessProcessFacetAdapter } from "../HarnessProcessFacet.ts";
import {
  HarnessProcessPlacementError,
  createHarnessProcessPlacement,
} from "../HarnessProcessPlacement.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessPlacementRequest,
  HarnessProcessPlacementWriter,
} from "../HarnessProcessPlacement.ts";
import type { ProductionFacetEnvironment } from "./productionFacet.workerd.fixture.ts";
import { createHarnessProcessPlacementStoreClient } from "./durableStore.ts";
import {
  processFacetCheckpoint,
  processFacetNativeSessionId,
} from "./runStoreFacet.workerd.fixture.ts";

export type PreparationCleanupEnvironment = ProductionFacetEnvironment;

export async function runPreparationCleanupFailureProof(
  env: PreparationCleanupEnvironment,
  contextKey: object,
  controllerClaim: HarnessProcessControllerClaim,
) {
  const owner = "fixture/preparation-cleanup-failure";
  const operationId = "preparation-cleanup-failure-operation";
  const processId = "preparation-cleanup-failure-process";
  const execution = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  const shardIncarnationNonce = await execution.executionIncarnationNonce();
  const storeStub = env.PLACEMENT_STORES.getByName(owner);
  const writer: HarnessProcessPlacementWriter = {
    executionOperationId: operationId,
    shardIndex: 0,
    shardIncarnationNonce,
    controllerClaim,
  };
  await storeStub.claimWriter(owner, writer);
  const stores = createHarnessProcessPlacementStoreClient(storeStub, owner, writer);
  const placement = await createHarnessProcessPlacement({
    owner,
    contextKey,
    context: "worker-request",
    shardIncarnationNonce,
    controllerClaim,
    residentByteLimit: 1024,
    store: stores.processSlots,
    recovery: stores.recovery,
    scheduleQuantum(callback) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
      return () => {
        cancelled = true;
      };
    },
    invalidate() {},
    reconcile: async () => {
      throw new Error("This fixture has no prior preparation-failure lease.");
    },
  });
  const request: HarnessProcessPlacementRequest = {
    processId,
    codeId: "request-facet",
    residentBytes: 1,
    nativeSessionId: processFacetNativeSessionId,
    checkpointId: processFacetCheckpoint.native.id,
    manifestRevision: processFacetCheckpoint.filesystem.sha256,
    priorFacetNonce: "preparation-failure-prior-facet",
    controllerClaim,
    operationId,
    expectedFacetGeneration: 1,
    signal: new AbortController().signal,
  };
  let failure: unknown;
  try {
    await placement.prepareInert(request, (locator) =>
      createHarnessProcessFacetAdapter(
        locator,
        env.PROCESS_TEST_FACETS.getByName(locator.facetKey),
      ),
    );
  } catch (cause) {
    failure = cause;
  }
  const records = await stores.recovery.list();
  const record = records.find((candidate) => candidate.processId === processId);
  const slotState = await stores.processSlots.load();
  const held =
    record !== undefined &&
    slotState?.slots.some((slot) => slot.holder?.token === record.lease.token) === true;
  const lifecycle =
    record === undefined
      ? undefined
      : await env.PROCESS_TEST_FACETS.getByName(record.facetKey).lifecycleObserved();
  const result = {
    failureKind:
      failure instanceof HarnessProcessPlacementError ? failure.kind : "unexpected-failure",
    recoverable: failure instanceof HarnessProcessPlacementError && failure.recoverable,
    operationId: record?.operationId,
    processId: record?.processId,
    controllerClaim: record?.controllerClaim,
    identityState: record?.identityState,
    incarnationNonce: record?.incarnationNonce,
    state: record?.state,
    stopAcknowledged: record?.stopAcknowledged,
    joined: record?.joined,
    held,
    leaseCount: placement.signals.resident,
    inFlight: placement.signals.inFlight,
    recoveryCount: records.length,
    lifecycle,
  };
  await storeStub.releaseWriter(owner, writer);
  return Response.json(result);
}
