import {
  HarnessProcessPlacementError,
  createHarnessProcessPlacement,
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessControllerClaim,
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPlacementRequest,
  type HarnessProcessPlacementWriter,
  type HarnessProcessPublication,
  type HarnessProcessPublicationReceipt,
  type HarnessProcessPublishedActivation,
} from "../HarnessProcessPlacement.ts";
import type { InvocationRecoveryEnvironment } from "./invocationReplyLoss.workerd.fixture.ts";
import {
  createReadmissionFacet,
  readmissionPublicationFor,
  type InvocationReadmissionInput,
} from "./invocationReadmission.workerd.support.ts";

export async function runInvocationReadmissionProof(
  env: InvocationRecoveryEnvironment,
  contextKey: object,
  controllerClaim: HarnessProcessControllerClaim,
) {
  const owner = "fixture/invocation-readmission";
  const operationId = "invocation-readmission-operation";
  const processId = "invocation-readmission-process";
  const firstRequestId = "invocation-readmission-first";
  const secondRequestId = "invocation-readmission-second";
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
      throw new Error("This fixture has no prior invocation lease.");
    },
  });
  const request: HarnessProcessPlacementRequest = {
    processId,
    codeId: "readmission-test-facet",
    residentBytes: 1,
    nativeSessionId: "invocation-readmission-native-session",
    checkpointId: "invocation-readmission-checkpoint",
    manifestRevision: "f".repeat(64),
    priorFacetNonce: "invocation-readmission-prior-facet",
    controllerClaim,
    operationId,
    expectedFacetGeneration: 0,
    signal: new AbortController().signal,
  };
  const secondEntered = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const activationReceipts: HarnessProcessPublicationReceipt[] = [];
  const invocations: string[] = [];
  let constructorNonce: string | undefined;
  const handle = await placement.prepareInert<InvocationReadmissionInput>(request, (locator) => {
    const nonce = `readmission-facet-${locator.loaderId}`;
    constructorNonce = nonce;
    return createReadmissionFacet(locator, nonce, request, {
      secondRequestId,
      secondEntered,
      releaseSecond: releaseSecond.promise,
      invocations,
      activationReceipts,
    });
  });
  let publisherCalls = 0;
  const activation = await handle.activate({
    async publishProcessFacet(input): Promise<HarnessProcessPublishedActivation> {
      publisherCalls++;
      const publication = readmissionPublicationFor(input);
      return {
        publication,
        publisher: {
          generation: input.expectedFacetGeneration + 1,
          facetNonce: input.identity.incarnationNonce,
          publisherKey: `publisher-${operationId}`,
        },
        requestId: firstRequestId,
      };
    },
  });

  const activationRecord = requiredRecord(await stores.recovery.list(), processId);
  let firstRequestIdentityProtected = false;
  try {
    await storeStub.saveRecovery(owner, writer, {
      ...activationRecord,
      invocationMayHaveStarted: true,
      invocationAttempt: 1,
      invocationRequestId: "invocation-readmission-stale-first-request",
      invocationReply: "unresolved",
    });
  } catch {
    firstRequestIdentityProtected = true;
  }
  const firstSettlement = await handle.invoke({ requestId: firstRequestId });
  const firstRecord = requiredRecord(await stores.recovery.list(), processId);
  const firstSlotState = await stores.processSlots.load();

  const resume = Promise.withResolvers<{
    readonly value: string;
    readonly publication: HarnessProcessPublication;
  }>();
  const parkedAtBoundary = Promise.withResolvers<void>();
  const parking = handle.park(() => {
    parkedAtBoundary.resolve();
    return resume.promise;
  }, new AbortController().signal);
  await parkedAtBoundary.promise;
  const parkedInFlight = placement.signals.inFlight;
  const parkedResident = placement.signals.resident;
  const parkedSlotState = await stores.processSlots.load();
  resume.resolve({ value: "readmitted", publication: activation.publication });
  const resumeValue = await parking;
  const readmittedInFlight = placement.signals.inFlight;
  const readmittedResident = placement.signals.resident;

  const secondRunning = handle.invoke({ requestId: secondRequestId });
  await secondEntered.promise;
  const unresolvedRecord = requiredRecord(await stores.recovery.list(), processId);
  const unresolvedSlotState = await stores.processSlots.load();
  let duplicateRejected = false;
  try {
    await handle.invoke({ requestId: secondRequestId });
  } catch (cause) {
    duplicateRejected =
      cause instanceof HarnessProcessPlacementError && cause.kind === "invocation-unsettled";
  }
  let staleReceivedWriteRejected = false;
  try {
    await storeStub.saveRecovery(owner, writer, firstRecord);
  } catch {
    staleReceivedWriteRejected = true;
  }
  const afterStaleWrite = requiredRecord(await stores.recovery.list(), processId);
  const leaseHeldWhileUnresolved =
    unresolvedSlotState?.slots.some(
      (slot) => slot.holder?.token === unresolvedRecord.lease.token,
    ) === true;

  releaseSecond.resolve();
  const secondSettlement = await secondRunning;
  const settledRecord = requiredRecord(await stores.recovery.list(), processId);
  const stableIdentity =
    handle.identity.incarnationNonce === constructorNonce &&
    settledRecord.operationId === operationId &&
    settledRecord.controllerClaim.ownerId === controllerClaim.ownerId &&
    settledRecord.controllerClaim.incarnationId === controllerClaim.incarnationId &&
    settledRecord.controllerClaim.epoch === controllerClaim.epoch &&
    settledRecord.controllerClaim.controlKey === controllerClaim.controlKey;
  const samePublication =
    JSON.stringify(firstRecord.publicationReceipt) ===
      JSON.stringify(settledRecord.publicationReceipt) &&
    activationReceipts.length === 2 &&
    JSON.stringify(activationReceipts[0]) === JSON.stringify(activationReceipts[1]);
  await handle.cleanup();
  const finalRecords = await stores.recovery.list();
  await storeStub.releaseWriter(owner, writer);

  return Response.json({
    firstAttempt: {
      attempt: firstRecord.invocationAttempt,
      requestId: firstRecord.invocationRequestId,
      reply: firstRecord.invocationReply,
      settled: firstSettlement.stopAcknowledged && firstSettlement.joined.fetch,
    },
    firstRequestIdentityProtected,
    parkedInFlight,
    parkedResident,
    parkedPermitRetained: parkedSlotState?.slots.some(
      (slot) => slot.holder?.token === firstRecord.lease.token && slot.holder.permitted === false,
    ),
    resumeValue,
    readmittedInFlight,
    readmittedResident,
    unresolvedAttempt: {
      attempt: unresolvedRecord.invocationAttempt,
      requestId: unresolvedRecord.invocationRequestId,
      reply: unresolvedRecord.invocationReply,
    },
    duplicateRejected,
    staleReceivedWriteRejected,
    staleWriteLeftCurrentAttemptUnresolved:
      afterStaleWrite.invocationAttempt === 2 &&
      afterStaleWrite.invocationRequestId === secondRequestId &&
      afterStaleWrite.invocationReply === "unresolved",
    leaseHeldWhileUnresolved,
    secondAttempt: {
      attempt: settledRecord.invocationAttempt,
      requestId: settledRecord.invocationRequestId,
      reply: settledRecord.invocationReply,
      settled: secondSettlement.stopAcknowledged && secondSettlement.joined.fetch,
    },
    stableIdentity,
    samePublication,
    publisherCalls,
    facetInvocations: invocations,
    finalInFlight: placement.signals.inFlight,
    finalResident: placement.signals.resident,
    finalRecoveryCount: finalRecords.length,
    firstSlotHeldBeforePark: firstSlotState?.slots.some(
      (slot) => slot.holder?.token === firstRecord.lease.token,
    ),
  });
}

function requiredRecord(
  records: readonly HarnessProcessPlacementRecoveryRecord[],
  processId: string,
): HarnessProcessPlacementRecoveryRecord {
  const record = records.find((candidate) => candidate.processId === processId);
  if (record === undefined) throw new Error("Process-placement recovery record was not persisted.");
  return record;
}
