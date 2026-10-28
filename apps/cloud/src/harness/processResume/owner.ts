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
import {
  boundaryFromResumed,
  readProcessBoundary,
  assertBoundaryCaller,
  saveProcessBoundary,
} from "../processOwnership/boundary.ts";
import { restoreEvictedProcess } from "../processOwnership/restore.ts";
import { stopEvictedProcess } from "../processOwnership/stopEvicted.ts";
import { ownedRequestKey } from "../processOwnership/ownedRequest.ts";
import { saveCreatedProcessBoundary } from "../processOwnership/creationBoundary.ts";
import { HarnessProcessCreationJournal } from "../processCreation/journal.ts";
import type { OwnedProcessRequest } from "./executionState.ts";
import { persistTerminalEvidence } from "./terminalEvidence.ts";
import { activeResumeKey, readHarnessProcessResumeDurableRecord } from "./durableState.ts";
import { authorizePublication } from "./authority.ts";
import { sameData, snapshotCheckpointInput } from "./checkpointContract.ts";
import {
  assertContinuation,
  continueResumedProcess,
  snapshotContinuation,
  type NormalizedContinuation,
} from "./continuation.ts";
import type { HarnessRequestCheckpoint } from "../HarnessRunStore.ts";
import type { HarnessProcessInvocationSettlement } from "../processPlacement/contracts.ts";
import { stopIdleProcess } from "./idleStop.ts";
import { HarnessProcessCreationOwner } from "../processCreation/service.ts";
import type {
  HarnessProcessCreationInput,
  HarnessProcessCreationRunInput,
} from "../processCreation/contracts.ts";
import type { HarnessProcessCreationRecoveryInput } from "../processCreation/recovery.ts";
import { validateHarnessProcessResumeRunStoreActive } from "./runStore.ts";
import { processFacetStores } from "../processOwnership/bindings.ts";
import type { ProcessIncarnation } from "../processOwnership/incarnation.ts";
import { adoptLegacyOwnedRequest } from "../processOwnership/adoptLegacyOwnedRequest.ts";
import {
  reserveOwnedResume,
  saveOwnedRequest,
  retainOwnedRequest,
} from "../processOwnership/ownedRequest.ts";

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
  #creation: HarnessProcessCreationOwner | undefined;
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
  readonly incarnation: ProcessIncarnation;
  constructor(
    context: DurableObjectState,
    environment: HarnessProcessExecutionEnvironment &
      Partial<Pick<HarnessDurableStateBindings, "HARNESS_RUN_STORE" | "HARNESS_FILES_STORE">>,
    incarnationNonce: string,
    incarnation: ProcessIncarnation,
  ) {
    this.context = context;
    this.environment = environment;
    this.incarnationNonce = incarnationNonce;
    this.incarnation = incarnation;
    this.#checkpoints = new ProcessCheckpointOwner(context.storage, () => this.#current, {
      durableForRun: (runId) =>
        createHarnessDurableState(
          this.environment as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
          runId,
        ),
      assertCurrent: async () => {
        await this.incarnation.assertCurrent();
      },
    });
  }

  #creationOwner() {
    const {
      HARNESS_RUN_STORE,
      HARNESS_FILES_STORE,
      HARNESS_THREAD_SUPERVISOR,
      PLACEMENT_STORES,
      LOADER,
      RESIDENT_BYTE_LIMIT,
    } = this.environment;
    const namespaces = [
      HARNESS_RUN_STORE,
      HARNESS_FILES_STORE,
      HARNESS_THREAD_SUPERVISOR,
      PLACEMENT_STORES,
    ];
    if (
      !HARNESS_RUN_STORE ||
      !HARNESS_FILES_STORE ||
      !LOADER ||
      typeof LOADER.get !== "function" ||
      namespaces.some(
        (binding) =>
          !binding || typeof binding.getByName !== "function" || typeof binding.get !== "function",
      ) ||
      !Number.isSafeInteger(Number(RESIDENT_BYTE_LIMIT)) ||
      Number(RESIDENT_BYTE_LIMIT) <= 0
    )
      throw new Error(
        "Cold creation requires the public durable stores, loader, placement, and residency limit.",
      );
    return (this.#creation ??= new HarnessProcessCreationOwner(
      this.context,
      {
        ...this.environment,
        HARNESS_RUN_STORE,
        HARNESS_FILES_STORE,
        // The placement-only environment types this binding without durable-state RPC methods.
        HARNESS_THREAD_SUPERVISOR: this.environment
          .HARNESS_THREAD_SUPERVISOR as unknown as HarnessDurableStateBindings["HARNESS_THREAD_SUPERVISOR"],
      },
      this.incarnationNonce,
    ));
  }

  async #exclusiveFresh<Result>(operation: () => Promise<Result>): Promise<Result> {
    await this.incarnation.assertCurrent();
    if (this.#running || this.#current || this.#attempt || this.#resumed || this.#retained)
      throw new Error("This shard already owns process execution.");
    this.#running = true;
    try {
      return await operation();
    } finally {
      this.#running = false;
    }
  }

  startFreshProcess(input: HarnessProcessCreationInput) {
    return this.#exclusiveFresh(async () => {
      const result = await this.#creationOwner().start(input);
      const boundary = await readProcessBoundary(this.context.storage, input.runId);
      if (boundary === undefined) {
        const record = await new HarnessProcessCreationJournal(this.context.storage).read(
          input.runId,
        );
        if (record?.phase !== "bound" || !record.binding)
          throw new Error("Native creation has no durable binding.");
        await saveCreatedProcessBoundary({
          storage: this.context.storage,
          incarnation: this.incarnation,
          creation: input,
          binding: record.binding,
        });
      } else if (boundary.phase === "ready" && boundary.fence.nonce !== this.incarnationNonce) {
        const recovered = await restoreEvictedProcess({
          context: this.context,
          environment: this.environment as HarnessProcessExecutionEnvironment &
            HarnessDurableStateBindings,
          incarnation: this.incarnation,
          boundary,
        });
        this.#resumed = recovered.resumed;
        this.#continuationCheckpoint = recovered.boundary.checkpoint;
        return { ...result, identity: recovered.resumed.prepared.identity };
      }
      return result;
    });
  }

  async runCreatedProcess(input: HarnessProcessCreationRunInput, requestContextId: string) {
    const boundary = await readProcessBoundary(this.context.storage, input.runId);
    const fence = await this.incarnation.assertCurrent();
    if (
      boundary !== undefined &&
      (boundary.fence.nonce !== fence.nonce || this.#resumed !== undefined)
    ) {
      if (input.operationId !== boundary.callerOperationId)
        throw new Error("The first request targets another native creation.");
      return this.continueProcess(
        {
          runId: input.runId,
          processId: boundary.process.processId,
          executionOperationId: boundary.placement.executionOperationId,
          resumeOperationId: boundary.callerOperationId,
          control: boundary.control,
          runStore: {
            ...boundary.runStore,
            currentPublisher: boundary.callerPublisher,
            request: input.request,
            checkpoint: boundary.checkpoint,
          },
        },
        requestContextId,
      );
    }
    return this.#exclusiveFresh(() =>
      this.#creationOwner().run(input, requestContextId, async (owned) => {
        this.#current = owned;
        await saveOwnedRequest(this.context.storage, owned, this.incarnation);
      }),
    );
  }

  recoverFreshProcess(input: HarnessProcessCreationRecoveryInput) {
    return this.#exclusiveFresh(() => this.#creationOwner().recover(input));
  }

  processCreationStatus(input: {
    readonly runId: string;
    readonly control: HarnessProcessCreationInput["controllerClaim"];
  }) {
    return this.#creationOwner().status(input.runId, input.control);
  }

  async runShard(
    input: HarnessProcessExecutionShardInput,
    requestContextId: string,
    hooks?: HarnessProcessExecutionHooks,
  ): Promise<HarnessProcessExecutionShardResult> {
    await this.incarnation.assertCurrent();
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
          ...(await processFacetStores(
            this.environment as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
            input.runId,
          )),
        },
      };
      const result = await this.#runBatches({ ...input, processes: [prepared] }, requestContextId, {
        ...hooks,
        authority: initial.authority,
        afterActivation: async ({ handle, activation }) => {
          const active = await initial.afterActivation();
          this.#current = {
            kind: "published",
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
          await saveOwnedRequest(this.context.storage, this.#current, this.incarnation);
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
            await retainOwnedRequest(this.context.storage, owned);
            return "retain";
          }
        },
      });
      if (result.processes.some((item) => item.status !== "settled")) {
        this.#retained = true;
        if (this.#current !== undefined)
          await retainOwnedRequest(this.context.storage, this.#current);
      }
      return result;
    } finally {
      this.#running = false;
      this.#current?.settled.resolve();
    }
  }

  async commitProcessCheckpoint(supplied: unknown) {
    const input = snapshotCheckpointInput(supplied);
    const boundary = await readProcessBoundary(this.context.storage, input.runId);
    if (
      boundary !== undefined &&
      input.processOperationId === boundary.callerOperationId &&
      input.processOperationId !== boundary.process.operationId
    ) {
      if (
        input.executionOperationId !== boundary.placement.executionOperationId ||
        input.processId !== boundary.process.processId ||
        !sameData(input.control, boundary.control) ||
        !sameData(input.publisher, boundary.prepared.preparedPublisher)
      )
        throw new Error("The completion does not identify the current restored process.");
      return this.#checkpoints.commit({
        ...input,
        processOperationId: boundary.process.operationId,
      });
    }
    return this.#checkpoints.commit(input);
  }

  async resumeProcess(supplied: unknown): Promise<ResumeProcessResult> {
    await this.incarnation.assertCurrent();
    let operation = snapshotHarnessProcessResumeOperation(supplied);
    if (operation === undefined)
      return Promise.reject(
        new Error("Process resume input is invalid or lacks the caller's journal capabilities."),
      );
    if (this.#attempt !== undefined || this.#resumed !== undefined || this.#retained)
      throw new Error("This shard already owns a resume attempt; replay is forbidden.");
    await this.environment.HARNESS_C_PROCESS_STORES?.forRun(operation.runId).runStore.execute({
      type: "read",
      runId: operation.runId,
    });
    await adoptLegacyOwnedRequest({
      storage: this.context.storage,
      environment: this.environment as HarnessProcessExecutionEnvironment &
        HarnessDurableStateBindings,
      operation,
      incarnation: this.incarnation,
    });
    const source = await reserveOwnedResume(this.context.storage, operation, this.incarnation);
    const runningSource = source.terminalKey === undefined ? this.#current : undefined;
    if (
      source.terminalKey === undefined &&
      (runningSource === undefined ||
        !sameData(runningSource.handle.identity, source.identity) ||
        !sameData(runningSource.request, source.request))
    )
      throw new Error(
        "The active source has no owned settlement barrier; explicit repair is required.",
      );
    const durable = createHarnessDurableState(
      this.environment as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
      operation.runId,
    );
    const owned = {
      ...source,
      durable,
      retained: false,
    };
    const attempt = startResumeAttempt({
      operation,
      owned,
      context: this.context,
      environment: this.environment as HarnessProcessExecutionEnvironment &
        HarnessDurableStateBindings,
      isOwned: (candidate) => this.#attempt === candidate,
      assertCurrent: () => this.incarnation.assertCurrent().then(() => undefined),
      placementNonce: this.incarnationNonce,
      awaitSourceSettlement: () => runningSource?.settled.promise ?? Promise.resolve(),
      onDrainStarted: () => {
        if (runningSource !== undefined) runningSource.control = operation.transition.nextControl;
      },
    });
    this.#attempt = attempt;
    return attempt.result.then(async (resumed) => {
      this.#resumed = resumed;
      this.#continuation = undefined;
      this.#continuationCheckpoint = resumed.checkpoint;
      this.#idle = false;
      this.#attempt = undefined;
      const confirmed = await this.#confirmResumed(resumed, operation);
      await boundaryFromResumed(this.context.storage, this.incarnation, resumed, durable);
      return confirmed;
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
    const result = this.#prepareContinuation(request, requestContextId).catch((cause) => {
      this.#continuations.delete(request.runStore.request.requestId);
      throw cause;
    });
    this.#continuations.set(request.runStore.request.requestId, { request, result });
    return result;
  }

  async #prepareContinuation(request: NormalizedContinuation, requestContextId: string) {
    await this.incarnation.assertCurrent();
    const boundary = await readProcessBoundary(this.context.storage, request.runId);
    if (boundary !== undefined) {
      assertBoundaryCaller(boundary, request);
      if (boundary.phase !== "ready" && boundary.phase !== "idle")
        throw new Error("The process boundary needs explicit repair or is stopped.");
      if (this.#resumed === undefined) {
        if (this.#running || this.#attempt !== undefined || this.#retained)
          throw new Error("Another operation owns process recovery.");
        this.#running = true;
        try {
          const recovered = await restoreEvictedProcess({
            context: this.context,
            environment: this.environment as HarnessProcessExecutionEnvironment &
              HarnessDurableStateBindings,
            incarnation: this.incarnation,
            boundary,
          });
          this.#resumed = recovered.resumed;
          this.#continuationCheckpoint = recovered.boundary.checkpoint;
          this.#idle = false;
        } finally {
          this.#running = false;
        }
      }
      request = {
        ...request,
        resumeOperationId: this.#resumed.operationId,
        runStore: { ...request.runStore, currentPublisher: this.#resumed.requestPublisher },
      };
    }
    return this.#continueOwned(request, requestContextId);
  }

  #continueOwned(request: NormalizedContinuation, requestContextId: string) {
    const resumed = this.#resumed;
    const durable =
      this.#resumed === undefined
        ? undefined
        : createHarnessDurableState(
            this.environment as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
            request.runId,
          );
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
      onStarting: async () => {
        const boundary = await readProcessBoundary(this.context.storage, request.runId);
        if (boundary !== undefined)
          await saveProcessBoundary(this.context.storage, this.incarnation, {
            ...boundary,
            phase: "executing",
          });
      },
      onIdle: async (checkpoint, settlement) => {
        this.#continuationCheckpoint = checkpoint;
        this.#idleSettlement = settlement;
        this.#idle = true;
        const boundary = await readProcessBoundary(this.context.storage, request.runId);
        const owned = this.#current;
        if (boundary === undefined || owned === undefined)
          throw new Error("The completed continuation has no durable process boundary.");
        await saveProcessBoundary(this.context.storage, this.incarnation, {
          ...boundary,
          phase: "idle",
          checkpoint,
          lastRequest: {
            request: owned.request,
            ownedKey: ownedRequestKey(
              owned.runId,
              owned.process.operationId,
              owned.request.requestId,
            ),
            settlement,
          },
        });
      },
      assertOwned: () => {
        if (this.#continuation !== attempt || this.#retained)
          throw new Error("Continuation ownership changed.");
      },
      onOwned: async (owned) => {
        this.#current = owned;
        await saveOwnedRequest(this.context.storage, owned, this.incarnation);
        this.#idle = false;
      },
    })
      .then(
        (process) => {
          if (process.status !== "idle") this.#resumed = undefined;
          result.resolve({ requestContextId, processes: [process] });
        },
        async (cause) => {
          this.#retained = true;
          try {
            const boundary = await readProcessBoundary(this.context.storage, request.runId);
            if (boundary !== undefined)
              await saveProcessBoundary(this.context.storage, this.incarnation, {
                ...boundary,
                phase: "retained",
              });
          } finally {
            result.reject(cause);
          }
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
    const result = this.#prepareStop(request).catch((cause) => {
      this.#idleStops.delete(key);
      throw cause;
    });
    this.#idleStops.set(key, { request, result });
    return result;
  }

  async #prepareStop(request: NormalizedContinuation): Promise<{ readonly status: "stopped" }> {
    await this.incarnation.assertCurrent();
    const boundary = await readProcessBoundary(this.context.storage, request.runId);
    if (boundary !== undefined) {
      assertBoundaryCaller(boundary, request);
      if (this.#resumed === undefined) {
        if (this.#running || this.#attempt !== undefined || this.#retained)
          throw new Error("Another operation owns process stop.");
        this.#running = true;
        try {
          return await stopEvictedProcess({
            context: this.context,
            environment: this.environment as HarnessProcessExecutionEnvironment &
              HarnessDurableStateBindings,
            incarnation: this.incarnation,
            boundary,
            request,
          });
        } finally {
          this.#running = false;
        }
      }
      request = {
        ...request,
        resumeOperationId: this.#resumed.operationId,
        runStore: { ...request.runStore, currentPublisher: this.#resumed.requestPublisher },
      };
    }
    return this.#stopOwned(request);
  }

  #stopOwned(request: NormalizedContinuation): Promise<{ readonly status: "stopped" }> {
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
        async () => {
          const boundary = await readProcessBoundary(this.context.storage, request.runId);
          if (boundary !== undefined)
            await saveProcessBoundary(this.context.storage, this.incarnation, {
              ...boundary,
              phase: "stopped",
            });
          this.#resumed = undefined;
          return { status: "stopped" as const };
        },
        async (cause) => {
          this.#retained = true;
          owned.retained = true;
          await retainOwnedRequest(this.context.storage, owned);
          throw cause;
        },
      )
      .finally(() => {
        this.#running = false;
      });
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

  async #confirmResumed(
    resumed: ResumedProcess,
    operation: Parameters<typeof startResumeAttempt>[0]["operation"],
  ): Promise<ResumeProcessResult> {
    const { prepared, publication, process } = resumed;
    const durable = createHarnessDurableState(
      this.environment as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
      resumed.runId,
    );
    if (this.#running) throw new Error("The resumed process is not idle.");
    await validateHarnessProcessResumeRunStoreActive({
      store: durable.runStore,
      operation,
      checkpoint: {
        checkpointId: resumed.checkpoint.native.id,
        manifestSha256: resumed.checkpoint.filesystem.sha256,
        nativeSessionId: resumed.nativeSessionId,
      },
      preparedFacetNonce: prepared.identity.incarnationNonce,
    });
    await authorizePublication({
      durable,
      runId: resumed.runId,
      publication,
      lifecycle: "accepting",
      request: {
        identity: prepared.identity,
        controllerClaim: resumed.control,
        operationId: process.operationId,
        nativeSessionId: resumed.nativeSessionId,
        checkpointId: resumed.checkpoint.native.id,
        manifestRevision: resumed.checkpoint.filesystem.sha256,
        priorFacetNonce: process.priorFacetNonce,
        expectedFacetGeneration: process.expectedFacetGeneration,
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
