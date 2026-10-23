// @effect-diagnostics cryptoRandomUUID:off - execution and facet IDs are opaque platform identifiers.
import type { WorkerEntrypoint } from "cloudflare:workers";
import {
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessPlacementStoreClient,
} from "./durableStore.ts";
import {
  HarnessProcessPlacementError,
  type HarnessProcessControllerClaim,
  type HarnessProcessInvocationSettlement,
  type HarnessProcessJoined,
  type HarnessProcessPlacementIdentity,
  type HarnessProcessPublication,
  type HarnessProcessPublicationReceipt,
  type HarnessProcessPreparedFacet,
} from "./contracts.ts";
import { createHarnessProcessPlacement } from "./service.ts";
import type { ProcessSlotLease } from "../../computer/ProcessSlots.ts";

export interface HarnessProcessExecutionProcessInput {
  readonly processId: string;
  readonly codeId: string;
  readonly residentBytes: number;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly operationId: string;
  readonly priorFacetNonce: string;
  readonly preparedFacetNonce: string;
  readonly expectedFacetGeneration: number;
  readonly publication: HarnessProcessPublication;
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string | { readonly js: string }>>;
  readonly entrypoint: string;
  readonly input: unknown;
}

export interface HarnessProcessExecutionShardInput {
  readonly runId: string;
  readonly executionOperationId: string;
  readonly shardOwner: string;
  readonly shardIncarnationNonce: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly shardIndex?: number;
  readonly processes: readonly HarnessProcessExecutionProcessInput[];
}

export interface HarnessProcessExecutionProcessResult {
  readonly processId: string;
  readonly requestContextId: string;
  readonly identity: HarnessProcessPlacementIdentity | null;
  readonly status: "settled" | "unplaceable" | "recoverable";
  readonly settlement?: HarnessProcessInvocationSettlement;
  readonly recoveryId?: string;
  readonly error?: { readonly kind: string; readonly message: string };
}

export interface HarnessProcessExecutionShardResult {
  /** The first request's context. Each process also records its owning request context. */
  readonly requestContextId: string;
  readonly processes: readonly HarnessProcessExecutionProcessResult[];
}

export interface HarnessProcessLifecycleClient {
  invalidate(loaderId: string): Promise<void>;
  reconcile(
    lease: ProcessSlotLease,
  ): Promise<{ readonly acknowledged: true } | { readonly lost: "memory" | "isolate" }>;
}

export interface HarnessProcessExecutionEnvironment {
  readonly LOADER: WorkerLoader;
  readonly PLACEMENT_STORES: DurableObjectNamespace;
  readonly PROCESS_LIFECYCLE: DurableObjectNamespace;
  readonly GATES: DurableObjectNamespace;
  readonly RESIDENT_BYTE_LIMIT: string;
}

interface ProcessFacetRpc extends WorkerEntrypoint {
  prepareInert(input: {
    readonly identity: HarnessProcessPlacementIdentity;
    readonly operationId: string;
    readonly nativeSessionId: string;
    readonly checkpointId: string;
    readonly manifestRevision: string;
  }): ReturnType<HarnessProcessPreparedFacet["prepareInert"]>;
  activate(publication: HarnessProcessPublicationReceipt): Promise<void>;
  invoke(input: unknown): Promise<HarnessProcessInvocationSettlement>;
  stop(): Promise<{ readonly acknowledged: boolean }>;
  join(): Promise<HarnessProcessJoined>;
  dispose(): Promise<void>;
}

const WORKER_REQUEST_BATCH_LIMIT = 4;

/** Split work at the platform request boundary; ProcessSlots still controls each request's admission. */
export async function runHarnessProcessShard(
  input: HarnessProcessExecutionShardInput,
  contextKey: object,
  environment: HarnessProcessExecutionEnvironment,
  runOverflow: (
    input: HarnessProcessExecutionShardInput,
  ) => Promise<HarnessProcessExecutionShardResult>,
): Promise<HarnessProcessExecutionShardResult> {
  if (
    !input.runId ||
    !input.executionOperationId ||
    !input.shardOwner ||
    !input.shardIncarnationNonce
  )
    throw new TypeError(
      "A process execution shard needs a run, operation, stable owner, and incarnation.",
    );
  const firstIndex = input.shardIndex ?? 0;
  if (!Number.isSafeInteger(firstIndex) || firstIndex < 0)
    throw new RangeError("Process execution shard index is invalid.");
  const preparedNonces = input.processes.map((process) => process.preparedFacetNonce);
  if (
    preparedNonces.some((nonce) => !nonce) ||
    new Set(preparedNonces).size !== preparedNonces.length
  )
    throw new TypeError("Every process in a shard needs a distinct prepared facet nonce.");
  if (input.processes.length === 0) return { requestContextId: crypto.randomUUID(), processes: [] };

  const batches = [];
  for (let start = 0; start < input.processes.length; start += WORKER_REQUEST_BATCH_LIMIT) {
    batches.push({
      shardIndex: firstIndex + batches.length,
      processes: input.processes.slice(start, start + WORKER_REQUEST_BATCH_LIMIT),
    });
  }
  const results = await Promise.all(
    batches.map(({ shardIndex, processes }, index) => {
      const shard = { ...input, shardIndex, processes };
      return index === 0 ? runLocalShard(shard, contextKey, environment) : runOverflow(shard);
    }),
  );
  return {
    requestContextId: results[0]!.requestContextId,
    processes: results.flatMap((result) => result.processes),
  };
}

async function runLocalShard(
  input: HarnessProcessExecutionShardInput & { readonly shardIndex: number },
  contextKey: object,
  environment: HarnessProcessExecutionEnvironment,
): Promise<HarnessProcessExecutionShardResult> {
  const owner = await deterministicShardOwner(
    input.shardOwner,
    input.executionOperationId,
    input.shardIndex,
  );
  const storesStub = environment.PLACEMENT_STORES.get(
    environment.PLACEMENT_STORES.idFromName(owner),
  ) as unknown as HarnessProcessPlacementStoreClient;
  const stores = createHarnessProcessPlacementStoreClient(storesStub, owner);
  const lifecycle = environment.PROCESS_LIFECYCLE.get(
    environment.PROCESS_LIFECYCLE.idFromName(owner),
  ) as unknown as HarnessProcessLifecycleClient;
  const byteLimit = Number(environment.RESIDENT_BYTE_LIMIT);
  if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0)
    throw new RangeError("Process execution shard resident-byte limit is invalid.");

  const writer = {
    executionOperationId: input.executionOperationId,
    shardIndex: input.shardIndex,
    shardIncarnationNonce: input.shardIncarnationNonce,
    controllerClaim: input.controllerClaim,
  };
  await storesStub.claimWriter(owner, writer);
  let releaseWriter = true;
  try {
    const placement = await createHarnessProcessPlacement({
      owner,
      contextKey,
      context: "worker-request",
      shardIncarnationNonce: input.shardIncarnationNonce,
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
      invalidate: (loaderId) => lifecycle.invalidate(loaderId),
      reconcile: (lease) => lifecycle.reconcile(lease),
    });

    const requestContextId = crypto.randomUUID();
    const processes = await Promise.all(
      input.processes.map(async (process) => {
        let handle: Awaited<ReturnType<typeof placement.prepareInert<unknown>>> | undefined;
        try {
          handle = await placement.prepareInert(
            {
              codeId: process.codeId,
              residentBytes: process.residentBytes,
              nativeSessionId: process.nativeSessionId,
              checkpointId: process.checkpointId,
              manifestRevision: process.manifestRevision,
              priorFacetNonce: process.priorFacetNonce,
              preparedFacetNonce: process.preparedFacetNonce,
              operationId: process.operationId,
              controllerClaim: input.controllerClaim,
              expectedFacetGeneration: process.expectedFacetGeneration,
              signal: new AbortController().signal,
            },
            (identity) =>
              createFacet(environment, input.runId, requestContextId, process, identity),
          );
          await handle.activate(process.publication);
          const settlement = await handle.invoke({
            runId: input.runId,
            requestContextId,
            processId: process.processId,
            loaderId: handle.identity.loaderId,
            payload: process.input,
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
          if (recoverable) releaseWriter = false;
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
              : { recoveryId: String(failure.details.recoveryId) }),
            error: {
              kind: failure?.kind ?? "execution-failed",
              message:
                cleanupError === undefined
                  ? errorText(error)
                  : `${errorText(error)}; ${errorText(cleanupError)}`,
            },
          };
        }
      }),
    );

    if ((await placement.recoverable()).length > 0) releaseWriter = false;
    return { requestContextId, processes };
  } finally {
    if (releaseWriter) await storesStub.releaseWriter(owner, writer);
  }
}

export async function deterministicShardOwner(
  prefix: string,
  operationId: string,
  shardIndex: number,
) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(operationId));
  const operationKey = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${prefix}/exec-${operationKey}/shard-${shardIndex}`;
}

function createFacet(
  environment: HarnessProcessExecutionEnvironment,
  runId: string,
  requestContextId: string,
  process: HarnessProcessExecutionProcessInput,
  identity: HarnessProcessPlacementIdentity,
) {
  if (
    !process.mainModule ||
    !Object.hasOwn(process.modules, process.mainModule) ||
    !process.entrypoint
  )
    throw new TypeError("Process execution code must include a main module and entrypoint.");
  const gate = environment.GATES.get(environment.GATES.idFromName(runId));
  const workerCode: WorkerLoaderWorkerCode = {
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: process.mainModule,
    modules: process.modules,
    env: { GATE: gate, REQUEST_CONTEXT_ID: requestContextId },
    globalOutbound: null,
  };
  const worker = environment.LOADER.get(identity.loaderId, () => workerCode);
  const child = worker.getEntrypoint<ProcessFacetRpc>(process.entrypoint);
  return {
    prepareInert: (input: Parameters<ProcessFacetRpc["prepareInert"]>[0]) =>
      child.prepareInert(input),
    activate: (publication: HarnessProcessPublicationReceipt) => child.activate(publication),
    invoke: (input: unknown) => child.invoke(input),
    stop: () => child.stop(),
    join: () => child.join(),
    dispose: () => child.dispose(),
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
