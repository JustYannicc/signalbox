import {
  createHarnessProcessFacetAdapter,
  type HarnessProcessFacetInvokeInput,
} from "../HarnessProcessFacet.ts";
import {
  HarnessProcessPlacementError,
  createHarnessProcessPlacement,
} from "../HarnessProcessPlacement.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessPlacementRequest,
  HarnessProcessPlacementWriter,
  HarnessProcessPublicationPublisher,
} from "../HarnessProcessPlacement.ts";
import type { ProductionFacetEnvironment } from "./productionFacet.workerd.fixture.ts";
import type {
  RunStoreFacetEnvironment,
  TestHarnessProcessRunStoreRequestFacetObject,
} from "./runStoreFacet.workerd.fixture.ts";
import { createHarnessProcessPlacementStoreClient } from "./durableStore.ts";
import {
  invocationReplyLossControlKey,
  invocationReplyLossRunId,
  invocationReplyLossSupervisorKey,
  processFacetArtifact,
  processFacetCheckpoint,
} from "./runStoreFacet.workerd.fixture.ts";

export interface InvocationRecoveryEnvironment
  extends ProductionFacetEnvironment, RunStoreFacetEnvironment {
  readonly PROCESS_RUN_STORE_FACETS: DurableObjectNamespace<
    TestHarnessProcessRunStoreRequestFacetObject & Rpc.DurableObjectBranded
  >;
}

export async function runInvocationReplyLossProof(
  env: InvocationRecoveryEnvironment,
  contextKey: object,
  controllerClaim: HarnessProcessControllerClaim,
  supervisor: HarnessProcessPublicationPublisher & {
    noteProcessInvocation(): Promise<void>;
    publicationCallCount(): Promise<number>;
    processInvocationCount(): Promise<number>;
  },
) {
  const runId = invocationReplyLossRunId;
  const runStore = env.HARNESS_RUN_STORES.getByName(runId);
  await runStore.execute({
    type: "initialize",
    seed: {
      identity: {
        runId,
        hostId: "invocation-loss-host",
        threadId: "invocation-loss-thread",
        logicalTurnId: "invocation-loss-turn",
        filesystemId: "invocation-loss-filesystem",
      },
      locator: processFacetArtifact,
      config: processFacetArtifact,
      artifacts: [],
    },
    controlKey: invocationReplyLossControlKey,
    supervisorKey: invocationReplyLossSupervisorKey,
    claimId: "invocation-loss-claim",
    requestId: "invocation-loss-bootstrap",
  });
  await runStore.execute({
    type: "request.mode",
    runId,
    controlKey: invocationReplyLossControlKey,
    requestId: "invocation-loss-mode",
    checkpoint: processFacetCheckpoint,
  });

  const owner = "fixture/invocation-reply-loss";
  const operationId = "invocation-reply-loss-operation";
  const processId = "invocation-reply-loss-process";
  const execution = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  const shardIncarnationNonce = await execution.executionIncarnationNonce();
  const storeStub = env.PLACEMENT_STORES.getByName(owner);
  const writer: HarnessProcessPlacementWriter = {
    executionOperationId: "invocation-reply-loss-execution",
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
      throw new Error("This fixture starts without an existing invocation lease.");
    },
  });
  const request: HarnessProcessPlacementRequest = {
    processId,
    codeId: "real-run-store-facet",
    residentBytes: 1,
    nativeSessionId: "invocation-loss-native-session",
    checkpointId: processFacetCheckpoint.native.id,
    manifestRevision: processFacetCheckpoint.filesystem.sha256,
    priorFacetNonce: "invocation-loss-prior-facet",
    controllerClaim,
    operationId,
    expectedFacetGeneration: 0,
    signal: new AbortController().signal,
  };
  const publicationPublisher: HarnessProcessPublicationPublisher = {
    async publishProcessFacet(input) {
      const activation = await supervisor.publishProcessFacet(input);
      const replacement = await runStore.execute({
        type: "request.replaceFacet",
        runId,
        controlKey: invocationReplyLossControlKey,
        expectedGeneration: input.expectedFacetGeneration,
        operationId: input.operationId,
        facetNonce: input.identity.incarnationNonce,
        publisherKey: activation.publisher.publisherKey,
      });
      if (replacement.action !== "recorded" && replacement.action !== "unchanged")
        throw new Error("Fixture RunStore did not record the published facet.");
      const offered = await runStore.execute({
        type: "request.offer",
        runId,
        supervisor: {
          supervisorKey: invocationReplyLossSupervisorKey,
          epoch: 1,
          claimId: "invocation-loss-claim",
        },
        request: { requestId: activation.requestId, input: processFacetArtifact },
      });
      if (offered.action !== "recorded" && offered.action !== "unchanged")
        throw new Error("Fixture RunStore did not record the offered request.");
      return activation;
    },
  };
  let fixtureDroppedInvocationReply = false;
  const handle = await placement.prepareInert<HarnessProcessFacetInvokeInput>(
    request,
    (locator) => {
      const adapter = createHarnessProcessFacetAdapter(
        locator,
        env.PROCESS_RUN_STORE_FACETS.getByName(locator.facetKey),
      );
      return {
        ...adapter,
        async invoke(input) {
          await adapter.invoke(input);
          await supervisor.noteProcessInvocation();
          fixtureDroppedInvocationReply = true;
          throw new Error("The completed invocation reply was dropped by the fixture.");
        },
      };
    },
  );
  const activation = await handle.activate(publicationPublisher);
  let invocationReplyDropped = false;
  let invocationErrorKind = "none";
  try {
    await handle.invoke({ publisher: activation.publisher, requestId: activation.requestId });
  } catch (cause) {
    invocationReplyDropped = true;
    invocationErrorKind =
      cause instanceof HarnessProcessPlacementError
        ? cause.kind
        : cause instanceof Error
          ? cause.name
          : "unknown";
  }
  let cleanupRetained = false;
  try {
    await handle.cleanup({ retainPublishedOwnership: true });
  } catch (cause) {
    cleanupRetained =
      cause instanceof HarnessProcessPlacementError &&
      cause.kind === "cleanup-incomplete" &&
      cause.details?.causeCode === "INVOCATION_OUTCOME_UNKNOWN";
  }

  const firstRecord = (await stores.recovery.list()).find(
    (candidate) => candidate.processId === processId,
  );
  const firstState = await stores.processSlots.load();
  const firstLeaseHeld =
    firstRecord !== undefined &&
    firstState?.slots.some((slot) => slot.holder?.token === firstRecord.lease.token) === true;
  const facet =
    firstRecord === undefined
      ? undefined
      : env.PROCESS_RUN_STORE_FACETS.getByName(firstRecord.facetKey);
  const facetLifecycle = await facet?.lifecycleObserved();
  const committed = await runStore.execute({ type: "read", runId });
  const committedEntry = committed.snapshot.requests?.entries.find(
    (entry) => entry.request.requestId === activation.requestId,
  );

  await storeStub.releaseWriter(owner, writer);
  try {
    await execution.crashForTest();
  } catch {
    // Aborting the named execution DO creates a new authenticated incarnation on the next RPC.
  }
  const replacementExecution = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  const replacementNonce = await replacementExecution.executionIncarnationNonce();
  const replacementWriter: HarnessProcessPlacementWriter = {
    ...writer,
    shardIncarnationNonce: replacementNonce,
  };
  await storeStub.claimWriter(owner, replacementWriter);
  const replacementStores = createHarnessProcessPlacementStoreClient(
    storeStub,
    owner,
    replacementWriter,
  );
  let reconciliationCalls = 0;
  let reconstructionBlocked = false;
  try {
    await createHarnessProcessPlacement({
      owner,
      contextKey: {},
      context: "worker-request",
      shardIncarnationNonce: replacementNonce,
      controllerClaim,
      residentByteLimit: 1024,
      store: replacementStores.processSlots,
      recovery: replacementStores.recovery,
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
      reconcile: async (lease) => {
        reconciliationCalls++;
        const record = (await replacementStores.recovery.list()).find(
          (candidate) => candidate.lease.token === lease.token,
        );
        if (
          record?.publicationState !== "confirmed" ||
          record.invocationReply !== "unresolved" ||
          record.invocationRequestId !== activation.requestId ||
          record.operationId !== operationId ||
          record.controllerClaim.ownerId !== controllerClaim.ownerId ||
          record.controllerClaim.incarnationId !== controllerClaim.incarnationId ||
          record.controllerClaim.epoch !== controllerClaim.epoch ||
          record.controllerClaim.controlKey !== controllerClaim.controlKey
        )
          throw new Error("Invocation recovery did not retain its exact publisher request.");
        throw new Error("B has no authoritative invocation-outcome repair protocol.");
      },
    });
  } catch {
    reconstructionBlocked = true;
  }
  const finalRecords = await replacementStores.recovery.list();
  const finalRecord = finalRecords.find((candidate) => candidate.processId === processId);
  const finalState = await replacementStores.processSlots.load();
  const leaseStillHeld =
    finalRecord !== undefined &&
    finalState?.slots.some((slot) => slot.holder?.token === finalRecord.lease.token) === true;
  const publisherCalls = await supervisor.publicationCallCount();
  const invocationCalls = await supervisor.processInvocationCount();
  await storeStub.releaseWriter(owner, replacementWriter);
  return Response.json({
    invocationReplyDropped,
    fixtureDroppedInvocationReply,
    invocationErrorKind,
    cleanupRetained,
    actualRequestStatus: committedEntry?.status,
    actualRequestFinish: committedEntry?.finish,
    facetLifecycle,
    record:
      firstRecord === undefined
        ? undefined
        : {
            operationId: firstRecord.operationId,
            processId: firstRecord.processId,
            controllerClaim: firstRecord.controllerClaim,
            state: firstRecord.state,
            publicationState: firstRecord.publicationState,
            publicationReceipt: firstRecord.publicationReceipt,
            invocationRequestId: firstRecord.invocationRequestId,
            invocationReply: firstRecord.invocationReply,
            lastFailureCode: firstRecord.lastFailure?.code,
            stopAcknowledged: firstRecord.stopAcknowledged,
            joined: firstRecord.joined,
          },
    firstLeaseHeld,
    firstInFlight: placement.signals.inFlight,
    firstResident: placement.signals.resident,
    replacementNonceIsFresh: replacementNonce !== shardIncarnationNonce,
    reconciliationCalls,
    reconstructionBlocked,
    finalRecoveryCount: finalRecords.length,
    finalLeaseStillHeld: leaseStillHeld,
    publisherCalls,
    invocationCalls,
  });
}
