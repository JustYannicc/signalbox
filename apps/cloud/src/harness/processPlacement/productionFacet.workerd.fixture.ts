import * as Effect from "effect/Effect";
import { createHarnessProcessFacetAdapter } from "../HarnessProcessFacet.ts";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import { createHarnessRequestFacetClass } from "../HarnessRequestFacetObject.ts";
import type { HarnessProcessPlacementStoreClient } from "./durableStore.ts";
import { createHarnessProcessPlacementStoreClient } from "./durableStore.ts";
import {
  createHarnessProcessPlacement,
  type HarnessProcessControllerClaim,
  type HarnessProcessPublicationPublisher,
  type HarnessProcessPlacementRequest,
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPlacementWriter,
  type HarnessProcessFacetLocator,
} from "../HarnessProcessPlacement.ts";
import type {
  HarnessRequestCheckpoint,
  HarnessRequestPublisher,
  HarnessRunArtifact,
  HarnessRunSnapshot,
  HarnessRunStoreResult,
} from "../HarnessRunStore.ts";
import type { ProcessSlotLease, ProcessSlotState } from "../../computer/ProcessSlots.ts";

const processFacetArtifact: HarnessRunArtifact = {
  id: "process-facet-proof-artifact",
  bytes: 1,
  sha256: "a".repeat(64),
};
const processFacetCheckpoint: HarnessRequestCheckpoint = {
  native: processFacetArtifact,
  filesystem: processFacetArtifact,
};
const processFacetNativeSessionId = "production-native-session";

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
    prepareInert: (request) =>
      Effect.gen(function* () {
        const prepareCalls = yield* Effect.tryPromise({
          try: async () => {
            const prior = (await input.ctx.storage.get<number>("prepare-inert-calls")) ?? 0;
            await input.ctx.storage.put("prepare-inert-calls", prior + 1);
            return prior + 1;
          },
          catch: () =>
            new HarnessRequestFacetError("Fixture preparation counter could not be stored."),
        });
        if (
          request.targetFacetNonce !== input.facetNonce ||
          request.checkpointId !== processFacetCheckpoint.native.id ||
          request.manifestRevision !== processFacetCheckpoint.filesystem.sha256
        )
          return yield* Effect.fail(
            new HarnessRequestFacetError(
              "Fixture did not find the requested committed checkpoint.",
            ),
          );

        // These storage receipts exercise only the generic prepare/retain/close lifecycle.
        const settled = yield* Effect.tryPromise({
          try: () =>
            Promise.all(
              ["invocationRpc", "fetch", "ports"].map((kind) =>
                input.ctx.storage.put(`preparation-${kind}-settled`, true),
              ),
            ),
          catch: () => new HarnessRequestFacetError("Fixture preparation did not settle."),
        });
        const [invocationRpc, fetch, ports] = yield* Effect.tryPromise({
          try: () =>
            Promise.all(
              ["invocationRpc", "fetch", "ports"].map((kind) =>
                input.ctx.storage.get<boolean>(`preparation-${kind}-settled`),
              ),
            ),
          catch: () =>
            new HarnessRequestFacetError("Fixture preparation evidence could not be read."),
        });
        if (settled.length !== 3 || prepareCalls < 1)
          return yield* Effect.fail(
            new HarnessRequestFacetError("Fixture preparation did not settle."),
          );
        yield* Effect.addFinalizer(() =>
          Effect.tryPromise({
            try: () => input.ctx.storage.put("prepared-runtime-closed", true),
            catch: () =>
              new HarnessRequestFacetError("Prepared runtime closure could not be recorded."),
          }).pipe(Effect.orDie),
        );
        return {
          facetNonce: input.facetNonce,
          nativeSessionId: processFacetNativeSessionId,
          checkpoint: processFacetCheckpoint,
          manifestRevision: processFacetCheckpoint.filesystem.sha256,
          joined: {
            invocationRpc: invocationRpc === true,
            fetch: fetch === true,
            ports: ports === true,
          },
          runtime: {
            run: () =>
              Effect.gen(function* () {
                yield* Effect.tryPromise({
                  try: () => input.ctx.storage.put("prepared-runtime-invoked", true),
                  catch: () =>
                    new HarnessRequestFacetError(
                      "Prepared runtime invocation could not be recorded.",
                    ),
                });
                return {
                  status: "completed" as const,
                  result: processFacetArtifact,
                  checkpoint: processFacetCheckpoint,
                };
              }),
          },
        };
      }),
    open: (checkpoint) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => input.ctx.storage.put("legacy-open-called", true),
          catch: () => new HarnessRequestFacetError("Legacy open observation could not be stored."),
        });
        yield* Effect.addFinalizer(() =>
          Effect.tryPromise({
            try: () => input.ctx.storage.put("request-scope-closed", true),
            catch: () =>
              new HarnessRequestFacetError("Request scope closure could not be recorded."),
          }).pipe(Effect.orDie),
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
  override async dispose(expectedFacetNonce: string) {
    await super.dispose(expectedFacetNonce);
    await this.ctx.storage.put("request-facet-disposed", true);
  }

  async lifecycleObserved() {
    return {
      legacyOpenCalled: (await this.ctx.storage.get<boolean>("legacy-open-called")) === true,
      preparedRuntimeClosed:
        (await this.ctx.storage.get<boolean>("prepared-runtime-closed")) === true,
      preparedRuntimeInvoked:
        (await this.ctx.storage.get<boolean>("prepared-runtime-invoked")) === true,
      requestFacetDisposed:
        (await this.ctx.storage.get<boolean>("request-facet-disposed")) === true,
      prepareInertCalls: (await this.ctx.storage.get<number>("prepare-inert-calls")) ?? 0,
      settled: {
        invocationRpc:
          (await this.ctx.storage.get<boolean>("preparation-invocationRpc-settled")) === true,
        fetch: (await this.ctx.storage.get<boolean>("preparation-fetch-settled")) === true,
        ports: (await this.ctx.storage.get<boolean>("preparation-ports-settled")) === true,
      },
    };
  }

  crashForTest() {
    this.ctx.abort("Fixture request-facet recreation proof.");
  }
}

export interface ProductionFacetEnvironment {
  readonly PROCESS_TEST_FACETS: DurableObjectNamespace<
    TestHarnessProcessRequestFacetObject & Rpc.DurableObjectBranded
  >;
  readonly PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<
    {
      executionIncarnationNonce(): Promise<string>;
      crashForTest(): void;
    } & Rpc.DurableObjectBranded
  >;
  readonly PLACEMENT_STORES: DurableObjectNamespace<
    HarnessProcessPlacementStoreClient & Rpc.DurableObjectBranded
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
    nativeSessionId: processFacetNativeSessionId,
    checkpointId: processFacetCheckpoint.native.id,
    manifestRevision: processFacetCheckpoint.filesystem.sha256,
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
  const activation = await handle.activate(publisher);
  const settlement = await handle.invoke({
    publisher: activation.publisher,
    requestId: activation.requestId,
  });
  await handle.cleanup();
  return Response.json({
    constructorNonce: handle.identity.incarnationNonce,
    publishedNonce: activation.publication.receipt?.preparedFacetNonce,
    action: (settlement.value as HarnessRunStoreResult).action,
    lifecycle: await requestFacet.lifecycleObserved(),
    inFlight: placement.signals.inFlight,
    resident: placement.signals.resident,
  });
}

export async function runIdentityReplyLossProof(
  env: ProductionFacetEnvironment,
  contextKey: object,
  controllerClaim: HarnessProcessControllerClaim,
) {
  const owner = "fixture/identity-reply-loss";
  const executionOperationId = "identity-reply-loss-execution";
  const processId = "identity-reply-loss-process";
  const firstExecution = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  const firstNonce = await firstExecution.executionIncarnationNonce();
  const storeStub = env.PLACEMENT_STORES.getByName(owner);
  const firstWriter: HarnessProcessPlacementWriter = {
    executionOperationId,
    shardIndex: 0,
    shardIncarnationNonce: firstNonce,
    controllerClaim,
  };
  await storeStub.claimWriter(owner, firstWriter);
  const firstStores = createHarnessProcessPlacementStoreClient(storeStub, owner, firstWriter);
  const request = identityLossRequest(processId, controllerClaim);
  let remoteIdentityObserved: string | undefined;
  let identityReplyLost = false;
  const firstContext = contextKey;
  const firstPlacement = await createHarnessProcessPlacement({
    owner,
    contextKey: firstContext,
    context: "worker-request",
    shardIncarnationNonce: firstNonce,
    controllerClaim,
    residentByteLimit: 1024,
    store: firstStores.processSlots,
    recovery: firstStores.recovery,
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
      throw new Error("The first request has no prior leases to reconcile.");
    },
  });

  let provisional: HarnessProcessPlacementRecoveryRecord | undefined;
  try {
    await firstPlacement.prepareInert(request, (locator) => {
      const stub = env.PROCESS_TEST_FACETS.getByName(locator.facetKey);
      const adapter = createHarnessProcessFacetAdapter(locator, stub);
      return {
        ...adapter,
        async identity() {
          const observed = await adapter.identity();
          remoteIdentityObserved = observed.incarnationNonce;
          identityReplyLost = true;
          throw new Error("Injected caller response loss after remote identity returned.");
        },
      };
    });
  } catch {
    // The placement must keep its lease and provisional record after this lost reply.
    provisional = (await firstStores.recovery.list())[0];
  } finally {
    await storeStub.releaseWriter(owner, firstWriter);
  }

  const heldAfterLostReply = {
    inFlight: firstPlacement.signals.inFlight,
    resident: firstPlacement.signals.resident,
  };
  if (
    provisional === undefined ||
    provisional.identityState !== "unknown" ||
    provisional.incarnationNonce !== undefined ||
    provisional.state !== "identity-unknown" ||
    !identityReplyLost ||
    remoteIdentityObserved === undefined
  )
    throw new Error("Lost identity reply did not leave an honest provisional owner.");

  try {
    await firstExecution.crashForTest();
  } catch {
    // Aborting this execution object forces the next owner to rebuild its allocator.
  }
  const replacement = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  const replacementNonce = await replacement.executionIncarnationNonce();
  const replacementWriter: HarnessProcessPlacementWriter = {
    ...firstWriter,
    shardIncarnationNonce: replacementNonce,
  };
  await storeStub.claimWriter(owner, replacementWriter);
  const replacementStores = createHarnessProcessPlacementStoreClient(
    storeStub,
    owner,
    replacementWriter,
  );
  const replacementContext = {};
  let stopAcknowledged = false;
  let joined = false;
  let disposed = false;
  let prepareCalls = 0;
  const replacementPlacement = await createHarnessProcessPlacement({
    owner,
    contextKey: replacementContext,
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
    reconcile: async (lease: ProcessSlotLease) => {
      const record = (await replacementStores.recovery.list()).find(
        (entry) => entry.lease.token === lease.token,
      );
      if (record === undefined || record.identityState !== "unknown")
        throw new Error("Identity-loss repair requires its provisional record.");
      const locator: HarnessProcessFacetLocator = {
        shardOwner: record.shardOwner,
        loaderId: record.loaderId,
        facetKey: record.facetKey,
      };
      const facet = createHarnessProcessFacetAdapter(
        locator,
        env.PROCESS_TEST_FACETS.getByName(locator.facetKey),
      );
      const observed = await facet.identity();
      if (observed.facetKey !== record.facetKey || !observed.incarnationNonce)
        throw new Error("Repair did not observe the actual constructor identity.");
      await replacementStores.recovery.save({
        ...record,
        identityState: "observed",
        incarnationNonce: observed.incarnationNonce,
        state: "cleanup-required",
      });
      const stopped = await facet.stop();
      stopAcknowledged = stopped.acknowledged;
      if (!stopAcknowledged) throw new Error("Remote stop was not acknowledged.");
      const joinedResources = await facet.join();
      joined = joinedResources.invocationRpc && joinedResources.fetch && joinedResources.ports;
      if (!joined) throw new Error("Remote resources did not join.");
      await facet.dispose();
      disposed = true;
      return { acknowledged: true };
    },
  });
  const state = await replacementStores.processSlots.load();
  const liveTokens = new Set(
    state?.slots.flatMap((slot) => (slot.holder === undefined ? [] : [slot.holder.token])) ?? [],
  );
  for (const record of await replacementStores.recovery.list()) {
    if (!liveTokens.has(record.lease.token))
      await replacementStores.recovery.remove(record.loaderId);
  }
  prepareCalls = (await env.PROCESS_TEST_FACETS.getByName(provisional.loaderId).lifecycleObserved())
    .prepareInertCalls;
  const remaining = await replacementStores.recovery.list();
  const result = {
    identityReplyLost,
    remoteIdentityObserved,
    provisional: {
      identityState: provisional.identityState,
      noncePresent: provisional.incarnationNonce !== undefined,
      state: provisional.state,
    },
    heldAfterLostReply,
    stopAcknowledged,
    joined,
    disposed,
    prepareCalls,
    recoveredInFlight: replacementPlacement.signals.inFlight,
    recoveredResident: replacementPlacement.signals.resident,
    remainingRecoveryRecords: remaining.length,
  };
  await storeStub.releaseWriter(owner, replacementWriter);
  return Response.json(result);
}

function identityLossRequest(
  processId: string,
  controllerClaim: HarnessProcessControllerClaim,
): HarnessProcessPlacementRequest {
  return {
    processId,
    codeId: "identity-loss-code",
    residentBytes: 1,
    nativeSessionId: processFacetNativeSessionId,
    checkpointId: processFacetCheckpoint.native.id,
    manifestRevision: processFacetCheckpoint.filesystem.sha256,
    priorFacetNonce: "identity-loss-prior-nonce",
    controllerClaim,
    operationId: "identity-loss-operation",
    expectedFacetGeneration: 1,
    signal: new AbortController().signal,
  };
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
