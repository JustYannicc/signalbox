import * as Effect from "effect/Effect";
import { createHarnessProcessFacetAdapter } from "../HarnessProcessFacet.ts";
import { createHarnessRequestFacetClass } from "../HarnessRequestFacetObject.ts";
import {
  createHarnessProcessPlacement,
  type HarnessProcessControllerClaim,
  type HarnessProcessPublicationPublisher,
  type HarnessProcessPlacementRequest,
  type HarnessProcessPlacementRecoveryRecord,
} from "../HarnessProcessPlacement.ts";
import type {
  HarnessRequestCheckpoint,
  HarnessRequestPublisher,
  HarnessRunArtifact,
  HarnessRunSnapshot,
  HarnessRunStoreResult,
} from "../HarnessRunStore.ts";
import type { ProcessSlotState } from "../../computer/ProcessSlots.ts";

const processFacetArtifact: HarnessRunArtifact = {
  id: "process-facet-proof-artifact",
  bytes: 1,
  sha256: "a".repeat(64),
};
const processFacetCheckpoint: HarnessRequestCheckpoint = {
  native: processFacetArtifact,
  filesystem: processFacetArtifact,
};

const TestRequestFacet = createHarnessRequestFacetClass<Record<string, never>>((input) =>
  Effect.succeed({
    runId: "production-process-facet-proof",
    facetNonce: input.facetNonce,
    store: {
      async execute(command): Promise<HarnessRunStoreResult> {
        const supplied = command as {
          readonly type: string;
          readonly requestId?: string;
          readonly publisher?: HarnessRequestPublisher;
        };
        const publisher = supplied.publisher ?? {
          generation: 2,
          facetNonce: input.facetNonce,
          publisherKey: "fixture-publisher",
        };
        return {
          action:
            supplied.type === "request.admit"
              ? "execute-once"
              : supplied.type === "request.finish"
                ? "committed"
                : "unchanged",
          snapshot: requestFacetSnapshot(publisher, supplied.requestId ?? "fixture-request"),
        };
      },
    },
    verify: () => Effect.void,
    open: (checkpoint) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => input.ctx.storage.put("request-scope-closed", true)),
        );
        return {
          run: () =>
            Effect.succeed({
              status: "completed" as const,
              result: processFacetArtifact,
              checkpoint,
            }),
        };
      }),
  }),
);

export class TestHarnessProcessRequestFacetObject extends TestRequestFacet {
  async cleanupObserved() {
    return (await this.ctx.storage.get<boolean>("request-scope-closed")) === true;
  }

  crashForTest() {
    this.ctx.abort("Fixture request-facet recreation proof.");
  }
}

export interface ProductionFacetEnvironment {
  readonly PROCESS_TEST_FACETS: DurableObjectNamespace<
    TestHarnessProcessRequestFacetObject & Rpc.DurableObjectBranded
  >;
}

export async function runProductionFacetProof(
  env: ProductionFacetEnvironment,
  publisher: HarnessProcessPublicationPublisher,
  controllerClaim: HarnessProcessControllerClaim,
) {
  let slotState: ProcessSlotState | undefined;
  const recovery = new Map<string, HarnessProcessPlacementRecoveryRecord>();
  const placement = await createHarnessProcessPlacement({
    owner: "fixture/production-process-facet",
    contextKey: {},
    context: "worker-request",
    shardIncarnationNonce: "production-facet-shard-incarnation",
    controllerClaim,
    residentByteLimit: 1024,
    store: {
      load: async () => slotState,
      save: async (next) => {
        slotState = next;
      },
    },
    recovery: {
      list: async () => [...recovery.values()],
      save: async (record) => {
        recovery.set(record.loaderId, record);
      },
      remove: async (loaderId) => {
        recovery.delete(loaderId);
      },
    },
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
    reconcile: async () => ({ acknowledged: true }),
  });
  const request: HarnessProcessPlacementRequest = {
    processId: "production-process-facet",
    codeId: "production-request-facet",
    residentBytes: 1,
    nativeSessionId: "production-native-session",
    checkpointId: "production-checkpoint",
    manifestRevision: "b".repeat(64),
    priorFacetNonce: "production-prior-facet",
    controllerClaim,
    operationId: "production-operation",
    expectedFacetGeneration: 1,
    signal: new AbortController().signal,
  };
  const requestFacet = env.PROCESS_TEST_FACETS.getByName("production-process-facet-proof");
  const handle = await placement.prepareInert(request, (locator) =>
    createHarnessProcessFacetAdapter(locator, requestFacet),
  );
  const activation = await publisher.publishProcessFacet({
    identity: handle.identity,
    controllerClaim,
    operationId: request.operationId,
    nativeSessionId: request.nativeSessionId,
    checkpointId: request.checkpointId,
    manifestRevision: request.manifestRevision,
    priorFacetNonce: request.priorFacetNonce,
    expectedFacetGeneration: request.expectedFacetGeneration,
  });
  await handle.activate(activation.publication);
  const settlement = await handle.invoke({
    publisher: activation.publisher,
    requestId: activation.requestId,
  });
  await handle.cleanup();
  return Response.json({
    constructorNonce: handle.identity.incarnationNonce,
    publishedNonce: activation.publication.receipt?.preparedFacetNonce,
    action: (settlement.value as HarnessRunStoreResult).action,
    disposed: await requestFacet.cleanupObserved(),
    inFlight: placement.signals.inFlight,
    resident: placement.signals.resident,
  });
}

export async function sameKeyRequestFacetReconstruction(env: ProductionFacetEnvironment) {
  const first = env.PROCESS_TEST_FACETS.getByName("same-key-request-facet");
  const original = await first.identity();
  try {
    await first.crashForTest();
  } catch {
    // `crashForTest` aborts its Durable Object context, so this RPC is expected to reject.
  }
  const replacement = await env.PROCESS_TEST_FACETS.getByName("same-key-request-facet").identity();
  return Response.json({
    originalNonce: original.facetNonce,
    replacementNonce: replacement.facetNonce,
  });
}

function requestFacetSnapshot(
  publisher: HarnessRequestPublisher,
  requestId: string,
): HarnessRunSnapshot {
  const requestMode = {
    modeId: "process-facet-proof-mode",
    initialCheckpoint: processFacetCheckpoint,
    checkpoint: processFacetCheckpoint,
    facets: [
      {
        generation: publisher.generation,
        operationId: "production-operation",
        facetNonce: publisher.facetNonce,
        publisherKey: publisher.publisherKey,
        supervisorEpoch: 1,
        checkpoint: processFacetCheckpoint,
      },
    ],
    entries: [
      {
        request: { requestId, input: processFacetArtifact },
        generation: publisher.generation,
        facetNonce: publisher.facetNonce,
        status: "offered" as const,
        progress: null,
        finish: null,
        reconciliation: null,
      },
    ],
  };
  return {
    version: 2,
    seed: {
      identity: {
        runId: "production-process-facet-proof",
        hostId: "production-host",
        threadId: "production-thread",
        logicalTurnId: "production-turn",
        filesystemId: "production-filesystem",
      },
      locator: processFacetArtifact,
      config: processFacetArtifact,
      artifacts: [],
    },
    supervisor: {
      epoch: 1,
      claimId: "production-claim",
      requestId: "production-supervisor-request",
      expectedEpoch: 0,
    },
    invocation: null,
    progress: null,
    terminal: null,
    receipts: [],
    intents: [],
    requests: requestMode,
  };
}
