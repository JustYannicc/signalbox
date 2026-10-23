// @effect-diagnostics cryptoRandomUUID:off - execution IDs and facet names are opaque platform identifiers.
import {
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessPlacementStoreClient,
} from "./durableStore.ts";
import {
  HarnessProcessPlacementError,
  type HarnessProcessControllerClaim,
  type HarnessProcessFacetLocator,
  type HarnessProcessInvocationSettlement,
  type HarnessProcessJoined,
  type HarnessProcessPlacementIdentity,
  type HarnessProcessPreparedFacet,
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPlacementRecoveryStore,
  type HarnessProcessPublicationPublisher,
} from "./contracts.ts";
import {
  createHarnessProcessFacetAdapter,
  type HarnessProcessFacetInvokeInput as FacetInvokeInput,
} from "../HarnessProcessFacet.ts";
import { createHarnessProcessPlacement, forgetHarnessProcessPlacement } from "./service.ts";
import { DURABLE_OBJECT_INVOCATION_LIMIT } from "./limits.ts";
import { type HarnessProcessPlacementWriter } from "./storeSchema.ts";
import type { ProcessSlotLease } from "../../computer/ProcessSlots.ts";
import type { HarnessRequestFacetObject } from "../HarnessRequestFacetObject.ts";

export interface HarnessProcessExecutionProcessInput {
  readonly processId: string;
  readonly codeId: string;
  readonly residentBytes: number;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly operationId: string;
  readonly priorFacetNonce: string;
  readonly expectedFacetGeneration: number;
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string | { readonly js: string }>>;
  readonly entrypoint: string;
  /** Bindings come from the harness owner. Fixture-only observers stay in the fixture. */
  readonly facetEnv?: Readonly<Record<string, unknown>>;
}

export interface HarnessProcessExecutionShardInput {
  readonly runId: string;
  readonly executionOperationId: string;
  /** Stable supervisor prefix; the execution operation and shard index are appended. */
  readonly shardOwner: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly shardIndex?: number;
  readonly processes: readonly HarnessProcessExecutionProcessInput[];
}

export interface HarnessProcessExecutionProcessResult {
  readonly processId: string;
  readonly requestContextId: string;
  readonly identity: HarnessProcessPlacementIdentity | null;
  readonly status: "settled" | "unplaceable" | "recoverable" | "recovered";
  readonly settlement?: HarnessProcessInvocationSettlement;
  readonly recoveryId?: string;
  readonly error?: {
    readonly kind: string;
    readonly message: string;
    readonly identityMismatch?: "facet-key" | "incarnation" | "native-session" | "checkpoint";
    readonly causeCode?: string;
    readonly facetFailureAt?: "identity" | "prepare" | "persist" | "park";
    readonly facetFailureCode?:
      | "type-error"
      | "range-error"
      | "syntax-error"
      | "rpc-not-found"
      | "rpc-error"
      | "unknown";
  };
}

export interface HarnessProcessExecutionShardResult {
  readonly requestContextId: string;
  readonly processes: readonly HarnessProcessExecutionProcessResult[];
}

export interface HarnessProcessExecutionHooks {
  readonly beforeInvoke?: (input: {
    readonly runId: string;
    readonly processId: string;
    readonly requestContextId: string;
  }) => Promise<void>;
}

export interface HarnessProcessExecutionControlSnapshot {
  readonly ownerId: string;
  readonly controlIncarnationId: string;
  readonly controlEpoch: number;
}

export interface HarnessProcessExecutionSupervisorClient extends HarnessProcessPublicationPublisher {
  execute(input: {
    readonly type: "read";
    readonly runId: string;
    readonly control: HarnessProcessControllerClaim;
  }): Promise<{ readonly snapshot: HarnessProcessExecutionControlSnapshot }>;
}

export interface HarnessProcessExecutionEnvironment {
  readonly LOADER: WorkerLoader;
  readonly PLACEMENT_STORES: DurableObjectNamespace;
  readonly HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace;
  readonly RESIDENT_BYTE_LIMIT: string;
}

type HarnessProcessFacetStub = Pick<HarnessRequestFacetObject, "identity" | "run" | "dispose"> &
  Rpc.DurableObjectBranded;

/** Runs one shard in the DO context that owns its durable facets and ProcessSlots writer. */
export async function runHarnessProcessExecutionShard(
  input: HarnessProcessExecutionShardInput,
  requestContextId: string,
  context: DurableObjectState,
  environment: HarnessProcessExecutionEnvironment,
  shardIncarnationNonce: string,
  hooks?: HarnessProcessExecutionHooks,
): Promise<HarnessProcessExecutionShardResult> {
  validateShard(input);
  if (input.processes.length > DURABLE_OBJECT_INVOCATION_LIMIT)
    throw new RangeError("A durable-object process shard exceeds its context batch size.");
  return await runLocalShard(
    { ...input, shardIndex: input.shardIndex ?? 0 },
    requestContextId,
    context,
    environment,
    shardIncarnationNonce,
    hooks,
  );
}

export async function deterministicShardOwner(
  prefix: string,
  operationId: string,
  shardIndex: number,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(operationId));
  const operationKey = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${prefix}/exec-${operationKey}/shard-${shardIndex}`;
}

async function runLocalShard(
  input: HarnessProcessExecutionShardInput & { readonly shardIndex: number },
  requestContextId: string,
  context: DurableObjectState,
  environment: HarnessProcessExecutionEnvironment,
  shardIncarnationNonce: string,
  hooks?: HarnessProcessExecutionHooks,
): Promise<HarnessProcessExecutionShardResult> {
  const owner = await deterministicShardOwner(
    input.shardOwner,
    input.executionOperationId,
    input.shardIndex,
  );
  const storesStub = environment.PLACEMENT_STORES.getByName(
    owner,
  ) as unknown as HarnessProcessPlacementStoreClient;
  const authority = environment.HARNESS_THREAD_SUPERVISOR.getByName(
    input.runId,
  ) as unknown as HarnessProcessExecutionSupervisorClient;

  // A successful authoritative read checks the full control key even though the snapshot omits it.
  const control = await authority.execute({
    type: "read",
    runId: input.runId,
    control: input.controllerClaim,
  });
  if (
    control.snapshot.ownerId !== input.controllerClaim.ownerId ||
    control.snapshot.controlIncarnationId !== input.controllerClaim.incarnationId ||
    control.snapshot.controlEpoch !== input.controllerClaim.epoch
  )
    throw new HarnessProcessPlacementError(
      "stale-publication",
      "Process execution is not owned by the current controller claim.",
      true,
    );

  const writer: HarnessProcessPlacementWriter = {
    executionOperationId: input.executionOperationId,
    shardIndex: input.shardIndex,
    shardIncarnationNonce,
    controllerClaim: input.controllerClaim,
  };
  await storesStub.claimWriter(owner, writer);
  const stores = createHarnessProcessPlacementStoreClient(storesStub, owner, writer);
  let priorRecords: readonly HarnessProcessPlacementRecoveryRecord[] = [];
  let placementPromise: ReturnType<typeof createHarnessProcessPlacement> | undefined;
  try {
    priorRecords = await stores.recovery.list();
    const processById = new Map(input.processes.map((process) => [process.processId, process]));
    const byteLimit = Number(environment.RESIDENT_BYTE_LIMIT);
    if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0)
      throw new RangeError("Process execution shard resident-byte limit is invalid.");

    let placement;
    try {
      placementPromise = createHarnessProcessPlacement({
        owner,
        // The DurableObjectState owns one allocator while this runShard request is active.
        contextKey: context,
        context: "durable-object",
        shardIncarnationNonce,
        controllerClaim: input.controllerClaim,
        store: stores.processSlots,
        recovery: stores.recovery,
        residentByteLimit: byteLimit,
        scheduleQuantum(callback) {
          let cancelled = false;
          queueMicrotask(() => {
            if (!cancelled) callback();
          });
          return () => {
            cancelled = true;
          };
        },
        invalidate(loaderId) {
          context.facets.abort(loaderId, "The process-slot lease was retired.");
          context.facets.delete(loaderId);
        },
        reconcile: (lease) =>
          reconcileFacet({
            lease,
            records: priorRecords,
            processById,
            context,
            environment,
            recovery: stores.recovery,
          }),
      });
      placement = await placementPromise;
    } catch (cause) {
      return {
        requestContextId,
        processes: input.processes.map((process) => {
          const recoveryId = priorRecords.find(
            (record) => record.processId === process.processId,
          )?.loaderId;
          return {
            processId: process.processId,
            requestContextId,
            identity: null,
            status: "recoverable" as const,
            ...(recoveryId === undefined ? {} : { recoveryId }),
            error: {
              kind: recoveryFailureKind(cause),
              message: "Existing process state needs repair.",
            },
          };
        }),
      };
    }

    if (priorRecords.length > 0) {
      const state = await stores.processSlots.load();
      const liveTokens = new Set(
        state?.slots.flatMap((slot) => (slot.holder === undefined ? [] : [slot.holder.token])) ??
          [],
      );
      for (const record of priorRecords) {
        if (!liveTokens.has(record.lease.token) && record.terminalFailure === undefined)
          await stores.recovery.remove(record.loaderId);
      }
      return {
        requestContextId,
        processes: priorRecords.map((record) => ({
          processId: record.processId,
          requestContextId,
          identity: {
            shardOwner: record.shardOwner,
            loaderId: record.loaderId,
            facetKey: record.facetKey,
            incarnationNonce: record.incarnationNonce,
          },
          status: "recovered" as const,
          recoveryId: record.loaderId,
          ...(record.terminalFailure === undefined
            ? {}
            : {
                error: {
                  kind: "activation-failed",
                  message: "Published process ownership still needs authorized repair.",
                },
              }),
        })),
      };
    }

    const processes = await Promise.all(
      input.processes.map(async (process) => {
        let handle:
          | Awaited<ReturnType<typeof placement.prepareInert<FacetInvokeInput>>>
          | undefined;
        try {
          handle = await placement.prepareInert<FacetInvokeInput>(
            {
              processId: process.processId,
              codeId: process.codeId,
              residentBytes: process.residentBytes,
              nativeSessionId: process.nativeSessionId,
              checkpointId: process.checkpointId,
              manifestRevision: process.manifestRevision,
              priorFacetNonce: process.priorFacetNonce,
              operationId: process.operationId,
              controllerClaim: input.controllerClaim,
              expectedFacetGeneration: process.expectedFacetGeneration,
              signal: new AbortController().signal,
            },
            (identity) => createFacet(context, environment, process, identity),
          );
          const activation = await authority.publishProcessFacet({
            identity: handle.identity,
            controllerClaim: input.controllerClaim,
            operationId: process.operationId,
            nativeSessionId: process.nativeSessionId,
            checkpointId: process.checkpointId,
            manifestRevision: process.manifestRevision,
            priorFacetNonce: process.priorFacetNonce,
            expectedFacetGeneration: process.expectedFacetGeneration,
          });
          await handle.activate(activation.publication);
          await hooks?.beforeInvoke?.({
            runId: input.runId,
            processId: process.processId,
            requestContextId,
          });
          const settlement = await handle.invoke({
            publisher: activation.publisher,
            requestId: activation.requestId,
          });
          await handle.cleanup();
          return {
            processId: process.processId,
            requestContextId,
            identity: handle.identity,
            status: "settled" as const,
            settlement,
          };
        } catch (error) {
          let cleanupError: unknown;
          if (handle !== undefined) {
            try {
              await handle.cleanup();
            } catch (cause) {
              cleanupError = cause;
            }
          }
          const failure = error instanceof HarnessProcessPlacementError ? error : undefined;
          const recoverable = failure?.recoverable === true || cleanupError !== undefined;
          return {
            processId: process.processId,
            requestContextId,
            identity: failure?.identity ?? handle?.identity ?? null,
            status:
              failure?.kind === "unplaceable"
                ? ("unplaceable" as const)
                : recoverable
                  ? ("recoverable" as const)
                  : ("settled" as const),
            ...(failure?.details?.recoveryId === undefined
              ? {}
              : { recoveryId: failure.details.recoveryId }),
            error: {
              kind: failure?.kind ?? "execution-failed",
              message: errorMessage(failure?.kind ?? "execution-failed"),
              ...(failure?.details?.identityMismatch === undefined
                ? {}
                : { identityMismatch: failure.details.identityMismatch }),
              ...(failure?.details?.causeCode === undefined
                ? {}
                : { causeCode: failure.details.causeCode }),
              ...(failure?.details?.facetFailureAt === undefined
                ? {}
                : { facetFailureAt: failure.details.facetFailureAt }),
              ...(failure?.details?.facetFailureCode === undefined
                ? {}
                : { facetFailureCode: failure.details.facetFailureCode }),
            },
          };
        }
      }),
    );
    return { requestContextId, processes };
  } finally {
    // Completed requests release writer ownership even when a lease remains for explicit repair.
    await storesStub.releaseWriter(owner, writer);
    if (placementPromise !== undefined) forgetHarnessProcessPlacement(context, placementPromise);
  }
}

async function reconcileFacet(input: {
  readonly lease: ProcessSlotLease;
  readonly records: readonly HarnessProcessPlacementRecoveryRecord[];
  readonly processById: ReadonlyMap<string, HarnessProcessExecutionProcessInput>;
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment;
  readonly recovery: HarnessProcessPlacementRecoveryStore;
}): Promise<{ readonly acknowledged: true } | { readonly lost: "memory" | "isolate" }> {
  const record = input.records.find((candidate) => candidate.lease.token === input.lease.token);
  if (record === undefined) throw new Error("Process recovery does not have a repairable record.");
  const process = input.processById.get(record.processId);
  if (
    process === undefined ||
    process.codeId !== record.programCodeId ||
    process.operationId !== record.operationId ||
    process.nativeSessionId !== record.nativeSessionId ||
    process.checkpointId !== record.checkpointId ||
    process.manifestRevision !== record.manifestRevision ||
    process.priorFacetNonce !== record.priorFacetNonce
  )
    throw new Error("Process recovery requires its exact process descriptor.");

  const identity: HarnessProcessPlacementIdentity = {
    shardOwner: record.shardOwner,
    loaderId: record.loaderId,
    facetKey: record.facetKey,
    incarnationNonce: record.incarnationNonce,
  };
  const facet = createFacet(input.context, input.environment, process, identity);
  const actual = await facet.identity();
  if (
    actual.facetKey !== identity.facetKey ||
    actual.incarnationNonce !== identity.incarnationNonce
  ) {
    throw new Error("Process recovery cannot prove the retained facet's constructor identity.");
  }
  if (record.terminalFailure !== undefined) {
    const joined = await stopAndDispose(facet);
    await input.recovery.save({
      ...record,
      state: "activation-failed",
      stopAcknowledged: true,
      joined,
      lastFailure: record.terminalFailure,
    });
    input.context.facets.delete(identity.facetKey);
    return { acknowledged: true };
  }
  const stopped = await facet.stop();
  if (!stopped.acknowledged) throw new Error("Process recovery stop is not acknowledged.");
  const joined = await facet.join();
  if (!allJoined(joined)) throw new Error("Process recovery has not joined all resources.");
  await facet.dispose();
  input.context.facets.delete(identity.facetKey);
  return { acknowledged: true };
}

async function stopAndDispose(
  facet: HarnessProcessPreparedFacet<unknown>,
): Promise<HarnessProcessJoined> {
  const stopped = await facet.stop();
  if (!stopped.acknowledged) throw new Error("Replacement facet stop is not acknowledged.");
  const joined = await facet.join();
  if (!allJoined(joined)) throw new Error("Replacement facet resources have not joined.");
  await facet.dispose();
  return joined;
}

function createFacet(
  context: DurableObjectState,
  environment: HarnessProcessExecutionEnvironment,
  process: HarnessProcessExecutionProcessInput,
  identity: HarnessProcessFacetLocator,
): HarnessProcessPreparedFacet<FacetInvokeInput> {
  if (
    !process.mainModule ||
    !Object.hasOwn(process.modules, process.mainModule) ||
    !process.entrypoint
  )
    throw new TypeError("Process execution code must include a main module and entrypoint.");
  if (identity.facetKey !== identity.loaderId)
    throw new TypeError("A process facet key must use its ProcessSlots loader ID.");
  const workerCode: WorkerLoaderWorkerCode = {
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: process.mainModule,
    modules: process.modules,
    env: {
      ...process.facetEnv,
      HARNESS_PROCESS_ID: process.processId,
      HARNESS_PROCESS_SHARD_OWNER: identity.shardOwner,
      HARNESS_PROCESS_LOADER_ID: identity.loaderId,
      HARNESS_PROCESS_FACET_KEY: identity.facetKey,
    },
    globalOutbound: null,
  };
  const worker = environment.LOADER.get(identity.loaderId, () => workerCode);
  const facetClass = worker.getDurableObjectClass<HarnessProcessFacetStub>(process.entrypoint, {
    props: {
      facetKey: identity.facetKey,
      loaderId: identity.loaderId,
      shardOwner: identity.shardOwner,
    },
  });
  const facet = context.facets.get<HarnessProcessFacetStub>(identity.facetKey, () => ({
    class: facetClass,
  }));
  return createHarnessProcessFacetAdapter(identity, facet);
}

function validateShard(input: HarnessProcessExecutionShardInput) {
  if (!input.runId || !input.executionOperationId || !input.shardOwner)
    throw new TypeError(
      "A process execution shard needs a run, operation, stable owner, and incarnation.",
    );
  if (!Number.isSafeInteger(input.shardIndex ?? 0) || (input.shardIndex ?? 0) < 0)
    throw new RangeError("Process execution shard index is invalid.");
  const processIds = input.processes.map(({ processId }) => processId);
  if (processIds.some((processId) => !processId) || new Set(processIds).size !== processIds.length)
    throw new TypeError("A process execution shard needs distinct process IDs.");
}

function errorMessage(kind: string): string {
  switch (kind) {
    case "unplaceable":
      return "This process needs a different execution destination.";
    case "stale-publication":
      return "The process publication or controller claim is stale.";
    case "prepare-failed":
      return "The process facet could not be prepared.";
    case "activation-failed":
      return "Published process ownership still needs authorized repair.";
    case "cleanup-incomplete":
      return "Process cleanup needs recovery.";
    case "invocation-unsettled":
      return "The process invocation did not settle.";
    case "recovery-unresolved":
      return "Existing process state needs repair.";
    default:
      return "Process execution failed.";
  }
}

function recoveryFailureKind(cause: unknown): string {
  if (cause instanceof HarnessProcessPlacementError) return cause.kind;
  if (cause instanceof TypeError) return "invalid-process-state";
  if (cause instanceof RangeError) return "invalid-process-limit";
  if (cause instanceof Error && cause.name === "ProcessSlotStorageError")
    return "process-slot-storage";
  return "recovery-unresolved";
}

function allJoined(joined: HarnessProcessJoined): boolean {
  return joined.invocationRpc && joined.fetch && joined.ports;
}
