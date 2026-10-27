import {
  createHarnessDurableState,
  type HarnessDurableStateBindings,
} from "../HarnessDurableState.ts";
import type {
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionHooks,
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionShardResult,
} from "../processPlacement/execution.ts";
import { runHarnessProcessExecutionShard } from "../processPlacement/execution.ts";
import { DURABLE_OBJECT_INVOCATION_LIMIT } from "../processPlacement/limits.ts";
import {
  snapshotHarnessProcessResumeOperation,
  sameHarnessProcessResumeOperation,
} from "./operation.ts";
import { startResumeAttempt, type ResumeAttempt, type ResumedProcess } from "./resumeAttempt.ts";
import {
  assertHarnessProcessExecutionMode,
  createInitialProcessAuthority,
} from "./initialExecution.ts";
import { ProcessCheckpointOwner } from "./checkpoint.ts";
import type { OwnedProcessRequest } from "./executionState.ts";
import { persistTerminalEvidence } from "./terminalEvidence.ts";
import { activeResumeKey, readHarnessProcessResumeDurableRecord } from "./durableState.ts";
import { authorizePublication, sameControl, samePublisher } from "./authority.ts";
import { sameData } from "./checkpointContract.ts";
import {
  assertContinuation,
  continueResumedProcess,
  snapshotContinuation,
  type NormalizedContinuation,
} from "./continuation.ts";
import type { HarnessRequestCheckpoint } from "../HarnessRunStore.ts";
import type { HarnessProcessInvocationSettlement } from "../processPlacement/contracts.ts";
import { stopIdleProcess } from "./idleStop.ts";
import { validateHarnessProcessResumeRunStoreActive } from "./runStore.ts";

export interface ResumeProcessResult {
  readonly status: "resumed";
  readonly identity: ResumedProcess["prepared"]["identity"];
}
interface ExecutionShardExports {
  readonly HarnessProcessExecutionEntrypoint: (options: {
    readonly props: Record<string, never>;
  }) => {
    runShard(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult>;
  };
}

/** Owns lifecycle state for one real shard context; callers can never supply a context or handle. */
export class HarnessProcessResumeOwner {
  #running = false;
  #retained = false;
  #current: OwnedProcessRequest | undefined;
  #attempt: ResumeAttempt | undefined;
  #resumed: ResumedProcess | undefined;
  readonly #checkpoints;
  #idle = false;
  #continuationCheckpoint: HarnessRequestCheckpoint | undefined;
  #idleSettlement: HarnessProcessInvocationSettlement | undefined;
  readonly #continuations = new Map<
    string,
    {
      readonly request: NormalizedContinuation;
      readonly result: Promise<HarnessProcessExecutionShardResult>;
    }
  >();
  readonly #idleStops = new Map<
    string,
    {
      readonly request: NormalizedContinuation;
      readonly result: Promise<{ readonly status: "stopped" }>;
    }
  >();
  #continuation:
    | {
        readonly request: NormalizedContinuation;
        readonly result: Promise<HarnessProcessExecutionShardResult>;
      }
    | undefined;
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment &
    Partial<Pick<HarnessDurableStateBindings, "HARNESS_RUN_STORE" | "HARNESS_FILES_STORE">>;
  readonly incarnationNonce: string;
  constructor(
    context: DurableObjectState,
    environment: HarnessProcessExecutionEnvironment &
      Partial<Pick<HarnessDurableStateBindings, "HARNESS_RUN_STORE" | "HARNESS_FILES_STORE">>,
    incarnationNonce: string,
  ) {
    this.context = context;
    this.environment = environment;
    this.incarnationNonce = incarnationNonce;
    this.#checkpoints = new ProcessCheckpointOwner(context.storage, () => this.#current);
  }

  async runShard(
    input: HarnessProcessExecutionShardInput,
    requestContextId: string,
    hooks?: HarnessProcessExecutionHooks,
  ): Promise<HarnessProcessExecutionShardResult> {
    if (
      this.#running ||
      this.#attempt !== undefined ||
      this.#resumed !== undefined ||
      this.#retained
    )
      throw new Error("This shard already owns execution or recovery work.");
    this.#running = true;
    try {
      if (assertHarnessProcessExecutionMode(input) === "placement")
        return await this.#runBatches(input, requestContextId, hooks);
      if (
        this.environment.HARNESS_RUN_STORE === undefined ||
        this.environment.HARNESS_FILES_STORE === undefined
      )
        throw new Error("Native process execution requires both public durable stores.");
      const durable = createHarnessDurableState(
        this.environment as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
        input.runId,
      );
      const initial = createInitialProcessAuthority({
        shard: input,
        durable,
        assertOwned: () => {
          if (!this.#running || this.#retained)
            throw new Error("The initial process no longer owns this execution.");
        },
      });
      const retained = await this.context.storage.get(activeResumeKey);
      if (retained !== undefined)
        throw new Error(
          "This shard has a durable transition; use its owned continuation or explicit repair.",
        );
      const process = input.processes[0]!;
      const prepared = {
        ...process,
        journal: initial.journal,
        runStorePublisher: {
          generation: process.expectedFacetGeneration + 1,
          publisherKey: initial.journal.runStore.nextPublisherKey,
        },
        resumeFacetEnv: {
          HARNESS_RESUME_RUN_ID: input.runId,
          HARNESS_RESUME_CONTROL: input.controllerClaim,
          HARNESS_RESUME_PUBLISHER: initial.journal.publisher,
          HARNESS_RESUME_RUN_STORE: this.environment.HARNESS_RUN_STORE.getByName(input.runId),
          HARNESS_RESUME_FILES_STORE: this.environment.HARNESS_FILES_STORE.getByName(input.runId),
          HARNESS_RESUME_SUPERVISOR: this.environment.HARNESS_THREAD_SUPERVISOR.getByName(
            input.runId,
          ),
        },
      };
      const result = await this.#runBatches({ ...input, processes: [prepared] }, requestContextId, {
        ...hooks,
        authority: initial.authority,
        afterActivation: async ({ handle, activation }) => {
          const active = await initial.afterActivation();
          this.#current = {
            runId: input.runId,
            durable,
            process: prepared,
            handle,
            ...active,
            control: input.controllerClaim,
            placement: {
              owner: this.context.id.name ?? "",
              executionOperationId: input.executionOperationId,
              shardOwner: input.shardOwner,
              shardIndex: input.shardIndex ?? 0,
              shardIncarnationNonce: this.incarnationNonce,
            },
            journal: initial.journal.runStore,
            parentCheckpoint: initial.journal.runStore.checkpoint,
            completion: Promise.withResolvers(),
            settled: Promise.withResolvers(),
            retained: false,
          };
          await hooks?.afterActivation?.({ process: prepared, handle, activation });
        },
        beforeCleanup: async (cleanup) => {
          const owned = this.#current;
          if (owned === undefined || cleanup.handle !== owned.handle) {
            this.#retained = true;
            return "retain";
          }
          try {
            if ((await hooks?.beforeCleanup?.(cleanup)) === "retain")
              throw new Error("The execution owner retained this process.");
            await persistTerminalEvidence({
              storage: this.context.storage,
              owned,
              ...(cleanup.settlement === undefined ? {} : { settlement: cleanup.settlement }),
              ...(cleanup.failure === undefined ? {} : { failure: cleanup.failure }),
            });
            return "cleanup";
          } catch {
            owned.retained = true;
            this.#retained = true;
            return "retain";
          }
        },
      });
      if (result.processes.some((item) => item.status !== "settled")) this.#retained = true;
      return result;
    } finally {
      this.#running = false;
      this.#current?.settled.resolve();
    }
  }

  commitProcessCheckpoint(input: unknown) {
    return this.#checkpoints.commit(input);
  }

  resumeProcess(supplied: unknown): Promise<ResumeProcessResult> {
    const operation = snapshotHarnessProcessResumeOperation(supplied);
    if (operation === undefined)
      return Promise.reject(
        new Error("Process resume input is invalid or lacks the caller's journal capabilities."),
      );
    const previous = this.#attempt;
    if (previous !== undefined) {
      if (!sameHarnessProcessResumeOperation(previous.operation, operation))
        return Promise.reject(new Error("Another immutable resume attempt owns this shard."));
      return previous.result.then((resumed) => this.#cached(resumed));
    }
    if (this.#resumed !== undefined) {
      if (!sameHarnessProcessResumeOperation(this.#resumed.operation, operation))
        return Promise.reject(
          new Error(
            "The resumed process must complete its next request before another transition.",
          ),
        );
      return this.#cached(this.#resumed);
    }
    const owned = this.#current;
    if (
      owned === undefined ||
      owned.retained ||
      this.#retained ||
      operation.runId !== owned.runId ||
      operation.previousProcessId !== owned.process.processId ||
      operation.previousOperationId !== owned.process.operationId ||
      operation.previousStepId !== owned.request.requestId ||
      !sameControl(operation.transition.control, owned.control) ||
      !samePublisher(operation.transition.publisher, owned.publisher) ||
      !sameData(operation.runStore.currentPublisher, owned.runStorePublisher) ||
      !sameData(operation.runStore.request, owned.request) ||
      !sameData(operation.runStore.checkpoint, owned.parentCheckpoint)
    )
      return Promise.reject(
        new Error("Resume does not identify the exact owned process and request."),
      );
    owned.durable = createHarnessDurableState(
      this.environment as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
      operation.runId,
    );
    const attempt = startResumeAttempt({
      operation,
      owned,
      context: this.context,
      environment: this.environment as HarnessProcessExecutionEnvironment &
        HarnessDurableStateBindings,
      isOwned: (candidate) => this.#attempt === candidate,
    });
    this.#attempt = attempt;
    return attempt.result.then((resumed) => {
      this.#resumed = resumed;
      this.#continuation = undefined;
      this.#continuationCheckpoint = resumed.boundary.finish.checkpoint;
      this.#idle = false;
      this.#attempt = undefined;
      return this.#cached(resumed);
    });
  }

  continueProcess(
    supplied: unknown,
    requestContextId: string,
  ): Promise<HarnessProcessExecutionShardResult> {
    const request = snapshotContinuation(supplied);
    const previous = this.#continuations.get(request.runStore.request.requestId);
    if (previous !== undefined) {
      if (!sameData(previous.request, request))
        return Promise.reject(new Error("Another arrived request owns this continuation."));
      return previous.result;
    }
    const resumed = this.#resumed;
    const durable = this.#current?.durable;
    if (
      resumed === undefined ||
      durable === undefined ||
      this.#running ||
      this.#attempt !== undefined ||
      this.#retained
    )
      return Promise.reject(new Error("No idle activated process is available for continuation."));
    const checkpoint = this.#continuationCheckpoint;
    if (checkpoint === undefined)
      return Promise.reject(new Error("The process has no owned checkpoint cursor."));
    try {
      assertContinuation(request, resumed, checkpoint);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const idle = this.#idle;
    const result = Promise.withResolvers<HarnessProcessExecutionShardResult>();
    const attempt = { request, result: result.promise };
    this.#continuations.set(request.runStore.request.requestId, attempt);
    this.#continuation = attempt;
    this.#running = true;
    void continueResumedProcess({
      request,
      resumed,
      durable,
      storage: this.context.storage,
      requestContextId,
      checkpoint,
      idle,
      onIdle: (checkpoint, settlement) => {
        this.#continuationCheckpoint = checkpoint;
        this.#idleSettlement = settlement;
        this.#idle = true;
      },
      assertOwned: () => {
        if (this.#continuation !== attempt || this.#retained)
          throw new Error("Continuation ownership changed.");
      },
      onOwned: (owned) => {
        this.#current = owned;
        this.#idle = false;
      },
    })
      .then(
        (process) => {
          if (process.status !== "idle") this.#resumed = undefined;
          result.resolve({ requestContextId, processes: [process] });
        },
        (cause) => {
          this.#retained = true;
          result.reject(cause);
        },
      )
      .finally(() => {
        this.#running = false;
      });
    return result.promise;
  }

  stopIdleProcess(supplied: unknown): Promise<{ readonly status: "stopped" }> {
    const request = snapshotContinuation(supplied);
    const key = JSON.stringify([
      request.runId,
      request.processId,
      request.resumeOperationId,
      request.runStore.request.requestId,
    ]);
    const previous = this.#idleStops.get(key);
    if (previous !== undefined) {
      if (!sameData(previous.request, request))
        return Promise.reject(new Error("Another idle-stop attempt owns this process."));
      return previous.result;
    }
    const resumed = this.#resumed;
    const owned = this.#current;
    const checkpoint = this.#continuationCheckpoint;
    const settlement = this.#idleSettlement;
    if (
      !this.#idle ||
      this.#running ||
      this.#retained ||
      resumed === undefined ||
      owned === undefined ||
      checkpoint === undefined ||
      settlement === undefined ||
      !sameData(request.runStore.request, owned.request)
    )
      return Promise.reject(new Error("No completed idle process is owned here."));
    try {
      assertContinuation(request, resumed, checkpoint);
    } catch (cause) {
      return Promise.reject(cause);
    }
    this.#running = true;
    this.#idle = false;
    const result = stopIdleProcess({
      request,
      resumed,
      owned,
      checkpoint,
      settlement,
      storage: this.context.storage,
    })
      .then(
        () => {
          this.#resumed = undefined;
          return { status: "stopped" as const };
        },
        (cause) => {
          this.#retained = true;
          owned.retained = true;
          throw cause;
        },
      )
      .finally(() => {
        this.#running = false;
      });
    this.#idleStops.set(key, { request, result });
    return result;
  }

  async cancelResumeProcess(supplied: unknown) {
    const operation = snapshotHarnessProcessResumeOperation(supplied);
    const attempt = this.#attempt;
    if (
      operation === undefined ||
      attempt === undefined ||
      !sameHarnessProcessResumeOperation(operation, attempt.operation)
    )
      throw new Error("Cancellation must identify the exact owned resume attempt.");
    await attempt.owned.durable.threadSupervisor.execute({
      type: "read",
      runId: operation.runId,
      control: attempt.drainStarted
        ? operation.transition.nextControl
        : operation.transition.control,
    });
    if (this.#attempt !== attempt)
      throw new Error("The resume attempt changed while cancellation was authorized.");
    attempt.controller.abort();
    await attempt.result.catch(() => undefined);
    return { status: "retained" as const, operationId: operation.transition.operationId };
  }

  async processResumeStatus(input: {
    readonly runId: string;
    readonly operationId: string;
    readonly control: OwnedProcessRequest["control"];
  }) {
    const durable = createHarnessDurableState(
      this.environment as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
      input.runId,
    );
    await durable.threadSupervisor.execute({
      type: "read",
      runId: input.runId,
      control: input.control,
    });
    const record = await readHarnessProcessResumeDurableRecord(
      this.context.storage,
      input.runId,
      input.operationId,
    );
    return record === undefined
      ? { status: "missing" as const }
      : {
          status: record.phase,
          operationId: input.operationId,
          terminalEvidencePersisted: record.terminalKey !== undefined,
          preparedIdentityPersisted: record.prepared !== undefined,
          ...(record.prepared === undefined ? {} : { identity: record.prepared.identity }),
          ...(record.failure === undefined ? {} : { failure: record.failure }),
        };
  }

  async #cached(resumed: ResumedProcess): Promise<ResumeProcessResult> {
    const { operation, prepared, publication, boundary } = resumed;
    const durable = this.#current?.durable;
    if (durable === undefined || this.#running)
      throw new Error("The cached resume result has no idle current owner.");
    await validateHarnessProcessResumeRunStoreActive({
      store: durable.runStore,
      operation,
      checkpoint: {
        ...boundary.completion.files.checkpoint,
        nativeSessionId: boundary.nativeSessionId,
      },
      preparedFacetNonce: prepared.identity.incarnationNonce,
    });
    await authorizePublication({
      durable,
      runId: operation.runId,
      publication,
      lifecycle: "accepting",
      request: {
        identity: prepared.identity,
        controllerClaim: operation.transition.nextControl,
        operationId: operation.transition.operationId,
        nativeSessionId: boundary.nativeSessionId,
        checkpointId: boundary.completion.files.checkpoint.checkpointId,
        manifestRevision: boundary.completion.files.checkpoint.manifestSha256,
        priorFacetNonce: operation.transition.publisher.facetNonce,
        expectedFacetGeneration: operation.transition.expectedFacetGeneration,
      },
    });
    const { shardOwner, loaderId, facetKey, incarnationNonce } = prepared.identity;
    return { status: "resumed", identity: { shardOwner, loaderId, facetKey, incarnationNonce } };
  }

  async #runBatches(
    input: HarnessProcessExecutionShardInput,
    requestContextId: string,
    hooks?: HarnessProcessExecutionHooks,
  ): Promise<HarnessProcessExecutionShardResult> {
    const batches = [];
    for (let start = 0; start < input.processes.length; start += DURABLE_OBJECT_INVOCATION_LIMIT)
      batches.push({
        shardIndex: (input.shardIndex ?? 0) + batches.length,
        processes: input.processes.slice(start, start + DURABLE_OBJECT_INVOCATION_LIMIT),
      });
    const results = await Promise.all(
      batches.map(({ shardIndex, processes }, index) => {
        const shard = { ...input, shardIndex, processes };
        if (index === 0)
          return runHarnessProcessExecutionShard(
            shard,
            requestContextId,
            this.context,
            this.environment,
            this.incarnationNonce,
            hooks,
          );
        const exports = (this.context as unknown as { readonly exports: ExecutionShardExports })
          .exports;
        return exports.HarnessProcessExecutionEntrypoint({ props: {} }).runShard({
          ...shard,
          shardOwner: `${shard.shardOwner}/do-overflow-${shardIndex}`,
          shardIndex: 0,
        });
      }),
    );
    return {
      requestContextId: results[0]?.requestContextId ?? requestContextId,
      processes: results.flatMap((result) => result.processes),
    };
  }
}
