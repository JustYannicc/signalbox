import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { makeHarness, topologyRunId } from "./tests/harnessStateWorkerd.testSupport.ts";

let harness: ReturnType<typeof makeHarness>;
beforeEach(() => {
  harness = makeHarness();
  return harness.listen();
}, 60_000);
afterEach(() => harness.close());

it("rehydrates separate run, files and supervisor DOs after eviction", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const initialized = await main.fetch("http://proof/initialize");
  expect(initialized.status).toBe(200);
  await main.evictDurableObject("HarnessRunStoreObject", { name: topologyRunId });
  await main.evictDurableObject("HarnessFilesStoreObject", { name: topologyRunId });
  await main.evictDurableObject("HarnessThreadSupervisorObject", { name: topologyRunId });

  const recoveredResponse = await main.fetch("http://proof/recover");
  expect(recoveredResponse.status).toBe(200);
  expect(await recoveredResponse.json()).toMatchObject({
    checkpoint: { checkpointId: "workerd-checkpoint-1" },
    file: [{ path: "src/proof.ts", text: "export const proof = true;\n" }],
  });
  const supervisorResponse = await main.fetch("http://proof/supervisor");
  expect(supervisorResponse.status).toBe(200);
  expect(await supervisorResponse.json()).toMatchObject({
    nativeSessionId: "workerd-native-session",
    lifecycle: "accepting",
    checkpoint: { checkpointId: "workerd-checkpoint-1" },
  });
});

it("activates, commits a step and publishes the next generation with the full current claim", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/lifecycle");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    invalidRunIdCode: "INVALID",
    initializationSynchronousThrow: false,
    initializationCode: "CONFLICT",
    filesSynchronousThrow: false,
    forbiddenFilesCode: "INVALID",
    forbiddenFilesErrorName: "HarnessDurableStateError",
    reconcileSynchronousThrow: false,
    rawReconcileCode: "INVALID",
    wrongKeyCode: "STALE_CONTROL",
    wrongKeyMessageContainsKey: false,
    publication2: "published",
    publicationControl2: {
      ownerId: "workerd-owner",
      incarnationId: "workerd-controller-incarnation-2",
      epoch: 2,
      controlKey: "workerd-controller-control-2-workerd-controller-control-2-",
    },
    publication2Evidence: {
      nativeSessionId: "workerd-native-session",
      receipt: {
        operationId: "resume-1",
        fromGeneration: 1,
        toGeneration: 2,
        priorFacetNonce: "workerd-facet-nonce-1",
        preparedFacetNonce: "workerd-facet-nonce-2",
        checkpoint: { checkpointId: "workerd-checkpoint-1" },
        status: "confirmed",
      },
    },
    activation2: "accepting",
    admission: "admitted",
    checkpoint2: { checkpointId: "workerd-checkpoint-2" },
    oldPublisherCode: "STALE_PUBLISHER",
    publication3: "published",
    publicationControl3: {
      ownerId: "workerd-owner",
      incarnationId: "workerd-controller-incarnation-3",
      epoch: 3,
      controlKey: "workerd-controller-control-3-workerd-controller-control-3-",
    },
    publication3Evidence: {
      nativeSessionId: "workerd-native-session",
      receipt: {
        operationId: "resume-2",
        fromGeneration: 2,
        toGeneration: 3,
        priorFacetNonce: "workerd-facet-nonce-2",
        preparedFacetNonce: "workerd-facet-nonce-3",
        checkpoint: { checkpointId: "workerd-checkpoint-2" },
        status: "confirmed",
      },
    },
    activation3: "accepting",
    snapshotContainsControlKey: false,
    snapshot: {
      nativeSessionId: "workerd-native-session",
      lifecycle: "accepting",
      generation: 3,
      checkpoint: { checkpointId: "workerd-checkpoint-2" },
      lastPublication: {
        fromGeneration: 2,
        toGeneration: 3,
        checkpoint: { checkpointId: "workerd-checkpoint-2" },
      },
    },
  });
});

it("repairs a failed second publication write using the next full controller claim", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/handoff");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    secondWriteFailureCode: "OUT_OF_ORDER",
    mismatchedReceiptCode: "CONFLICT",
    staleClaimCode: "STALE_CONTROL",
    stalePublicationCode: "STALE_CONTROL",
    repairStatus: "published",
    repairControl: {
      ownerId: "workerd-owner",
      incarnationId: "workerd-controller-incarnation-3",
      epoch: 3,
      controlKey: "workerd-controller-control-3-workerd-controller-control-3-",
    },
    receipt: {
      operationId: "resume-1",
      fromGeneration: 1,
      toGeneration: 2,
      priorFacetNonce: "workerd-facet-nonce-1",
      preparedFacetNonce: "workerd-facet-nonce-2",
      status: "confirmed",
    },
  });
});

it("keeps prepared identity until joined settlement and files cleanup, then retries reconcile", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/reconcile");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    incompleteCode: "INDETERMINATE",
    unresolvedLifecycle: "indeterminate",
    unresolvedPreparedFacet: {
      operationId: "resume-1",
      generation: 2,
      facetNonce: "workerd-facet-nonce-2",
    },
    pendingReceipt: { operationId: "resume-1", status: "pending" },
    staleClaimCode: "STALE_CONTROL",
    abortedReceipt: true,
    reconciledLifecycle: "recoverable",
    retryAction: "unchanged",
    nextPreparedFacet: { operationId: "resume-2", generation: 2 },
  });
});

it("does not replace an invocation before actual joins are observed", async () => {
  const response = await harness
    .getWorker("harness-durable-state-main")
    .fetch("http://proof/unjoined");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    nativeSessionId: "workerd-native-session",
    expectedNativeSessionId: "workerd-native-session",
    unresolvedLifecycle: "indeterminate",
    unresolvedGeneration: 1,
    unresolvedFacetNonce: "workerd-facet-nonce-1",
    blockedCode: "INDETERMINATE",
    replacementBlockedCode: "INDETERMINATE",
    persistedSettlement: {
      outcome: "stopped",
      invocationRpcJoined: true,
      fetchJoined: true,
      callbackPortsJoined: true,
    },
    preparedLifecycle: "preparing",
  });
});
