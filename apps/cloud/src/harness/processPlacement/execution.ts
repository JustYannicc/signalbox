import { HarnessProcessPlacementError } from "./contracts.ts";
import type { HarnessProcessFacetInvokeInput as FacetInvokeInput } from "../HarnessProcessFacet.ts";
import { DURABLE_OBJECT_INVOCATION_LIMIT } from "./limits.ts";
import {
  openPlacementSession,
  createFacet,
  PlacementCreationFailure,
} from "./executionLifecycle.ts";
import type {
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionShardResult,
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionHooks,
} from "./executionLifecycle.ts";
export {
  deterministicShardOwner,
  prepareHarnessProcessExecutionResumeFacet,
} from "./executionLifecycle.ts";
export type {
  HarnessProcessExecutionProcessInput,
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionProcessResult,
  HarnessProcessExecutionShardResult,
  HarnessProcessExecutionHooks,
  HarnessProcessExecutionControlSnapshot,
  HarnessProcessExecutionSupervisorClient,
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionResumeHandle,
} from "./executionLifecycle.ts";

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

async function runLocalShard(
  input: HarnessProcessExecutionShardInput & { readonly shardIndex: number },
  requestContextId: string,
  context: DurableObjectState,
  environment: HarnessProcessExecutionEnvironment,
  shardIncarnationNonce: string,
  hooks?: HarnessProcessExecutionHooks,
): Promise<HarnessProcessExecutionShardResult> {
  let session;
  try {
    session = await openPlacementSession(
      input,
      context,
      environment,
      shardIncarnationNonce,
      hooks?.authority,
    );
  } catch (cause) {
    if (!(cause instanceof PlacementCreationFailure)) throw cause;
    return {
      requestContextId,
      processes: input.processes.map((process) => {
        const recoveryId = cause.records.find(
          (record) => record.processId === process.processId,
        )?.loaderId;
        return {
          processId: process.processId,
          requestContextId,
          identity: null,
          status: "recoverable" as const,
          ...(recoveryId === undefined ? {} : { recoveryId }),
          error: {
            kind:
              cause.cause instanceof HarnessProcessPlacementError
                ? cause.cause.kind
                : "recovery-unresolved",
            message: cause.message,
          },
        };
      }),
    };
  }
  const { stores, priorRecords, placement, authority } = session;
  let ownershipDisposition: "proven-complete" | "retained" = "proven-complete";
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
      if (
        priorRecords.some(
          (record) =>
            record.terminalFailure !== undefined ||
            record.publicationState === "in-progress" ||
            record.publicationState === "unknown" ||
            record.publicationState === "pending" ||
            record.publicationState === "confirmed" ||
            liveTokens.has(record.lease.token),
        )
      )
        ownershipDisposition = "retained";
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
          await hooks?.afterActivation?.({ process, handle, activation });
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
            ownershipDisposition = "retained";
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
              ownershipDisposition = "retained";
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
          const failure = error instanceof HarnessProcessPlacementError ? error : undefined;
          const noLease = failure?.kind === "unplaceable" && failure.identity === undefined;
          if (
            !noLease &&
            (cleanupError !== undefined ||
              (handle === undefined &&
                !(failure instanceof HarnessProcessPlacementError && !failure.recoverable)) ||
              failure?.recoverable === true)
          )
            ownershipDisposition = "retained";
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
    if (ownershipDisposition === "proven-complete") await session.close();
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
