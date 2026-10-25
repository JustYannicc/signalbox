// @effect-diagnostics cryptoRandomUUID:off - execution IDs and facet names are opaque platform identifiers.
import {
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessPlacementStoreClient,
} from "./durableStore.ts";
import {
  HarnessProcessPlacementError,
  type HarnessProcessHandle,
  type HarnessProcessControllerClaim,
  type HarnessProcessFacetLocator,
  type HarnessProcessInvocationSettlement,
  type HarnessProcessJoined,
  type HarnessProcessPlacementIdentity,
  type HarnessProcessPreparedFacet,
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPlacementRecoveryStore,
  type HarnessProcessPublicationPublisher,
  type HarnessProcessPublicationReconciler,
  type HarnessProcessPlacement,
} from "./contracts.ts";
import {
  createHarnessProcessFacetAdapter,
  type HarnessProcessFacetInvokeInput as FacetInvokeInput,
} from "../HarnessProcessFacet.ts";
import { createHarnessProcessPlacement, forgetHarnessProcessPlacement } from "./service.ts";
import { DURABLE_OBJECT_INVOCATION_LIMIT } from "./limits.ts";
import { type HarnessProcessPlacementWriter } from "./storeSchema.ts";
import { sameClaim } from "./storeSchema.ts";
import { confirmedProcessPublication } from "./publication.ts";
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
  /** Gives the shard owner one chance to persist a terminal handoff before B releases its lease. */
  readonly beforeCleanup?: (input: {
    readonly runId: string;
    readonly process: HarnessProcessExecutionProcessInput;
    readonly requestContextId: string;
    readonly requestId?: string;
    readonly handle: HarnessProcessHandle<FacetInvokeInput>;
    readonly settlement?: HarnessProcessInvocationSettlement;
    readonly failure?: unknown;
  }) => Promise<"cleanup" | "retain">;
}

export interface HarnessProcessExecutionControlSnapshot {
  readonly ownerId: string;
  readonly controlIncarnationId: string;
  readonly controlEpoch: number;
}

export interface HarnessProcessExecutionSupervisorClient
  extends HarnessProcessPublicationPublisher, HarnessProcessPublicationReconciler {
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
  readonly HARNESS_RUN_STORE?: DurableObjectNamespace;
  readonly HARNESS_FILES_STORE?: DurableObjectNamespace;
  readonly RESIDENT_BYTE_LIMIT: string;
}

type HarnessProcessFacetStub = Pick<
  HarnessRequestFacetObject,
  "identity" | "prepareInert" | "run" | "dispose"
> &
  Rpc.DurableObjectBranded & {
    /** Implemented only by a host that can observe its verified prepared artifact load. */
    loadedPreparedRelease?: () => Promise<unknown>;
  };

export interface HarnessProcessExecutionResumeHandle {
  readonly handle: HarnessProcessHandle<FacetInvokeInput>;
  readonly readLoadedPreparedRelease: () => Promise<unknown>;
  readonly placementOwner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly releaseWriter: () => Promise<void>;
}

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

interface HarnessProcessExecutionPlacementSession {
  readonly owner: string;
  readonly storesStub: HarnessProcessPlacementStoreClient;
  readonly authority: HarnessProcessExecutionSupervisorClient;
  readonly writer: HarnessProcessPlacementWriter;
  readonly stores: ReturnType<typeof createHarnessProcessPlacementStoreClient>;
  readonly priorRecords: readonly HarnessProcessPlacementRecoveryRecord[];
  readonly placement: HarnessProcessPlacement;
  readonly close: () => Promise<void>;
}

async function openPlacementSession(
  input: HarnessProcessExecutionShardInput & { readonly shardIndex: number },
  context: DurableObjectState,
  environment: HarnessProcessExecutionEnvironment,
  shardIncarnationNonce: string,
): Promise<HarnessProcessExecutionPlacementSession> {
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
  let placementPromise: ReturnType<typeof createHarnessProcessPlacement> | undefined;
  try {
    const priorRecords = await stores.recovery.list();
    const processById = new Map(input.processes.map((process) => [process.processId, process]));
    const byteLimit = Number(environment.RESIDENT_BYTE_LIMIT);
    if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0)
      throw new RangeError("Process execution shard resident-byte limit is invalid.");
    placementPromise = createHarnessProcessPlacement({
      owner,
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
          reconciler: authority,
          context,
          environment,
          recovery: stores.recovery,
        }),
    });
    const placement = await placementPromise;
    let closed = false;
    return {
      owner,
      storesStub,
      authority,
      writer,
      stores,
      priorRecords,
      placement,
      async close() {
        if (closed) return;
        await storesStub.releaseWriter(owner, writer);
        if (placementPromise !== undefined)
          forgetHarnessProcessPlacement(context, placementPromise);
        closed = true;
      },
    };
  } catch (error) {
    await storesStub.releaseWriter(owner, writer);
    if (placementPromise !== undefined) forgetHarnessProcessPlacement(context, placementPromise);
    throw error;
  }
}

/** Opens one fresh facet through the same actual keyed placement and writer path as runShard. */
export async function prepareHarnessProcessExecutionResumeFacet(input: {
  readonly runId: string;
  readonly executionOperationId: string;
  readonly shardOwner: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly shardIndex: number;
  readonly process: HarnessProcessExecutionProcessInput;
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment;
  readonly shardIncarnationNonce: string;
}): Promise<HarnessProcessExecutionResumeHandle> {
  const session = await openPlacementSession(
    {
      runId: input.runId,
      executionOperationId: input.executionOperationId,
      shardOwner: input.shardOwner,
      controllerClaim: input.controllerClaim,
      shardIndex: input.shardIndex,
      processes: [input.process],
    },
    input.context,
    input.environment,
    input.shardIncarnationNonce,
  );
  if (session.priorRecords.length !== 0) {
    await session.close();
    throw new HarnessProcessPlacementError(
      "prepare-failed",
      "A process resume shard already has retained placement records.",
      true,
    );
  }
  let loadedPreparedRelease: unknown;
  const process = input.process;
  try {
    const handle = await session.placement.prepareInert<FacetInvokeInput>(
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
      (identity) => {
        const facet = createFacet(input.context, input.environment, process, identity);
        return {
          ...facet,
          async prepareInert(request) {
            const observation = await facet.prepareInert(request);
            loadedPreparedRelease = await facet.readLoadedPreparedRelease();
            return observation;
          },
        };
      },
    );
    return {
      handle,
      readLoadedPreparedRelease: async () => loadedPreparedRelease,
      placementOwner: session.owner,
      writer: session.writer,
      releaseWriter: session.close,
    };
  } catch (error) {
    await session.close();
    throw error;
  }
}

async function runLocalShard(
  input: HarnessProcessExecutionShardInput & { readonly shardIndex: number },
  requestContextId: string,
  context: DurableObjectState,
  environment: HarnessProcessExecutionEnvironment,
  shardIncarnationNonce: string,
  hooks?: HarnessProcessExecutionHooks,
): Promise<HarnessProcessExecutionShardResult> {
  let session: HarnessProcessExecutionPlacementSession;
  try {
    session = await openPlacementSession(input, context, environment, shardIncarnationNonce);
  } catch (cause) {
    return {
      requestContextId,
      processes: input.processes.map((process) => ({
        processId: process.processId,
        requestContextId,
        identity: null,
        status: "recoverable" as const,
        error: {
          kind: recoveryFailureKind(cause),
          message: "Existing process state needs repair.",
        },
      })),
    };
  }
  const { stores, priorRecords, placement, authority } = session;
  let retainWriter = false;
  try {
    if (priorRecords.length > 0) {
      const state = await stores.processSlots.load();
      const liveTokens = new Set(
        state?.slots.flatMap((slot) => (slot.holder === undefined ? [] : [slot.holder.token])) ??
          [],
      );
      for (const record of priorRecords) {
        if (
          !liveTokens.has(record.lease.token) &&
          record.terminalFailure === undefined &&
          (record.publicationState === undefined || record.publicationState === "not-published")
        )
          await stores.recovery.remove(record.loaderId);
      }
      return {
        requestContextId,
        processes: priorRecords.map((record) => ({
          processId: record.processId,
          requestContextId,
          identity:
            record.incarnationNonce === undefined
              ? null
              : {
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
        let requestId: string | undefined;
        let cleanupAttempted = false;
        let cleanupFailure: unknown;
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
          const activation = await handle.activate(authority);
          requestId = activation.requestId;
          await hooks?.beforeInvoke?.({
            runId: input.runId,
            processId: process.processId,
            requestContextId,
          });
          const settlement = await handle.invoke({
            publisher: activation.publisher,
            requestId: activation.requestId,
          });
          if (
            (await beforeCleanup(hooks, {
              runId: input.runId,
              process,
              requestContextId,
              requestId,
              handle,
              settlement,
            })) === "retain"
          ) {
            retainWriter = true;
            return {
              processId: process.processId,
              requestContextId,
              identity: handle.identity,
              status: "recoverable" as const,
              recoveryId: handle.identity.loaderId,
              error: {
                kind: "resume-evidence-unavailable",
                message: "Process termination evidence is incomplete or not durable.",
              },
            };
          }
          cleanupAttempted = true;
          try {
            await handle.cleanup();
          } catch (cause) {
            cleanupFailure = cause;
            throw cause;
          }
          return {
            processId: process.processId,
            requestContextId,
            identity: handle.identity,
            status: "settled" as const,
            settlement,
          };
        } catch (error) {
          if (handle !== undefined && !cleanupAttempted) {
            const disposition = await beforeCleanup(hooks, {
              runId: input.runId,
              process,
              requestContextId,
              ...(requestId === undefined ? {} : { requestId }),
              handle,
              failure: error,
            });
            if (disposition === "retain") {
              retainWriter = true;
              return {
                processId: process.processId,
                requestContextId,
                identity: handle.identity,
                status: "recoverable" as const,
                recoveryId: handle.identity.loaderId,
                error: {
                  kind: "resume-evidence-unavailable",
                  message: "Process termination evidence is incomplete or not durable.",
                },
              };
            }
          }
          let cleanupError: unknown = cleanupFailure;
          if (handle !== undefined && !cleanupAttempted) {
            try {
              cleanupAttempted = true;
              await handle.cleanup({ retainPublishedOwnership: true });
            } catch (cause) {
              cleanupError = cause;
            }
          }
          if (cleanupAttempted && cleanupFailure !== undefined) retainWriter = true;
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
    if (!retainWriter) await session.close();
  }
}

async function beforeCleanup(
  hooks: HarnessProcessExecutionHooks | undefined,
  input: NonNullable<HarnessProcessExecutionHooks["beforeCleanup"]> extends (
    value: infer Input,
  ) => Promise<unknown>
    ? Input
    : never,
): Promise<"cleanup" | "retain"> {
  try {
    return (await hooks?.beforeCleanup?.(input)) ?? "cleanup";
  } catch {
    return "retain";
  }
}

async function reconcileFacet(input: {
  readonly lease: ProcessSlotLease;
  readonly records: readonly HarnessProcessPlacementRecoveryRecord[];
  readonly processById: ReadonlyMap<string, HarnessProcessExecutionProcessInput>;
  readonly reconciler: HarnessProcessPublicationReconciler;
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
    process.priorFacetNonce !== record.priorFacetNonce ||
    (record.expectedFacetGeneration !== undefined &&
      process.expectedFacetGeneration !== record.expectedFacetGeneration)
  )
    throw new Error("Process recovery requires its exact process descriptor.");

  const locator: HarnessProcessFacetLocator = {
    shardOwner: record.shardOwner,
    loaderId: record.loaderId,
    facetKey: record.facetKey,
  };
  const facet = createFacet(input.context, input.environment, process, locator);
  const actual = await facet.identity();
  if (
    actual.facetKey !== locator.facetKey ||
    (record.incarnationNonce !== undefined && actual.incarnationNonce !== record.incarnationNonce)
  ) {
    throw new Error("Process recovery cannot prove the retained facet's constructor identity.");
  }
  const identity: HarnessProcessPlacementIdentity = {
    ...locator,
    incarnationNonce: actual.incarnationNonce,
  };
  if (record.identityState !== "observed" || record.incarnationNonce === undefined) {
    await input.recovery.save({
      ...record,
      identityState: "observed",
      incarnationNonce: identity.incarnationNonce,
      state: "cleanup-required",
    });
  }
  if (record.terminalFailure !== undefined) {
    const joined = await stopAndDispose(facet);
    await input.recovery.save({
      ...record,
      identityState: "observed",
      incarnationNonce: identity.incarnationNonce,
      state: "activation-failed",
      stopAcknowledged: true,
      joined,
      lastFailure: record.terminalFailure,
    });
    input.context.facets.delete(identity.facetKey);
    return { acknowledged: true };
  }

  if (
    record.publicationState === "in-progress" ||
    record.publicationState === "unknown" ||
    record.publicationState === "pending" ||
    record.publicationState === "confirmed"
  ) {
    const expectedFacetGeneration = record.expectedFacetGeneration;
    if (expectedFacetGeneration === undefined)
      throw new Error("Uncertain publication recovery has no saved generation fence.");
    const request = {
      identity,
      controllerClaim: record.controllerClaim,
      operationId: record.operationId,
      nativeSessionId: record.nativeSessionId,
      checkpointId: record.checkpointId,
      manifestRevision: record.manifestRevision,
      priorFacetNonce: record.priorFacetNonce,
      expectedFacetGeneration,
    };
    const disposition = await input.reconciler.reconcileProcessFacetPublication(request);
    if (disposition.status === "published") {
      const receipt = confirmedProcessPublication(disposition.publication, {
        controllerClaim: record.controllerClaim,
        operationId: record.operationId,
        nativeSessionId: record.nativeSessionId,
        checkpointId: record.checkpointId,
        manifestRevision: record.manifestRevision,
        priorFacetNonce: record.priorFacetNonce,
        expectedFacetGeneration,
        identity,
      });
      if (receipt === undefined || !samePublicationReceipt(record.publicationReceipt, receipt))
        throw new Error("Publication reconciliation did not confirm the exact stored operation.");
      await input.recovery.save({
        ...record,
        identityState: "observed",
        incarnationNonce: identity.incarnationNonce,
        state: "publication-confirmed",
        publicationState: "confirmed",
        publicationReceipt: receipt,
      });
      throw new Error("Confirmed publication ownership stays reserved for explicit repair.");
    }
    if (disposition.status !== "not-published")
      throw new Error("Publication disposition is pending or unknown; keep its lease reserved.");
    if (
      record.publicationState === "confirmed" ||
      !sameClaim(disposition.controllerClaim, record.controllerClaim) ||
      disposition.operationId !== record.operationId ||
      disposition.currentPublisher.generation !== expectedFacetGeneration ||
      disposition.currentPublisher.facetNonce !== record.priorFacetNonce ||
      disposition.lastPublicationOperationId === record.operationId
    )
      throw new Error(
        "Non-publication evidence did not match the exact prior owner and operation.",
      );

    const stopped = await facet.stop();
    if (!stopped.acknowledged) throw new Error("Unpublished process stop is not acknowledged.");
    const joined = await facet.join();
    if (!allJoined(joined)) throw new Error("Unpublished process resources have not joined.");
    await facet.dispose();
    await input.recovery.save({
      ...record,
      identityState: "observed",
      incarnationNonce: identity.incarnationNonce,
      state: "cleanup-required",
      publicationState: "not-published",
      stopAcknowledged: true,
      joined,
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

function samePublicationReceipt(
  left: HarnessProcessPlacementRecoveryRecord["publicationReceipt"],
  right: NonNullable<HarnessProcessPlacementRecoveryRecord["publicationReceipt"]>,
): boolean {
  if (left === undefined) return true;
  return (
    left.operationId === right.operationId &&
    left.fromGeneration === right.fromGeneration &&
    left.toGeneration === right.toGeneration &&
    left.priorFacetNonce === right.priorFacetNonce &&
    left.preparedFacetNonce === right.preparedFacetNonce &&
    left.checkpoint.checkpointId === right.checkpoint.checkpointId &&
    left.checkpoint.manifestSha256 === right.checkpoint.manifestSha256 &&
    left.status === right.status
  );
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
): HarnessProcessPreparedFacet<FacetInvokeInput> & {
  readonly readLoadedPreparedRelease: () => Promise<unknown>;
} {
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
  return {
    ...createHarnessProcessFacetAdapter(identity, facet),
    async readLoadedPreparedRelease() {
      const observe = facet.loadedPreparedRelease;
      if (typeof observe !== "function") return undefined;
      return await observe.call(facet);
    },
  };
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
