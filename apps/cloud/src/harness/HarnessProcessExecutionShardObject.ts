import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import {
  createHarnessDurableState,
  type HarnessDurableStateBindings,
} from "./HarnessDurableState.ts";
import type { HarnessThreadSupervisorResult } from "./HarnessThreadSupervisor.ts";
import type {
  HarnessProcessExecutionHooks,
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionShardInput,
} from "./processPlacement/execution.ts";
import {
  runHarnessProcessExecutionShard,
  type HarnessProcessExecutionProcessInput,
} from "./processPlacement/execution.ts";
import type { HarnessProcessExecutionShardResult } from "./processPlacement/execution.ts";
import { DURABLE_OBJECT_INVOCATION_LIMIT } from "./processPlacement/limits.ts";
import type {
  HarnessProcessResumeCheckpointOutcome,
  HarnessProcessResumeInput,
  HarnessProcessResumeOperationInput,
} from "./processResume/contracts.ts";
import { createHarnessProcessResumePlacementDriver } from "./processResume/placementDriver.ts";
import {
  persistTerminalEvidence,
  type HarnessProcessResumePreDrainSnapshot,
} from "./processResume/terminalEvidence.ts";
import { createHarnessProcessResume } from "./processResume/service.ts";

type ResumeCheckpointOutcome = HarnessProcessResumeCheckpointOutcome<{
  readonly checkpointId: string;
  readonly manifestSha256: string;
  readonly nativeSessionId: string;
}>;

interface ActiveResumeAttempt {
  readonly operation: HarnessProcessResumeOperationInput;
  readonly preDrain: HarnessProcessResumePreDrainSnapshot;
  readonly durable: ReturnType<typeof createHarnessDurableState>;
  readonly fenceReady: Promise<boolean>;
  readonly resolveFence: (ready: boolean) => void;
  terminalOutcome?: ResumeCheckpointOutcome;
}

interface HarnessProcessExecutionShardExports {
  readonly HarnessProcessExecutionEntrypoint: (options: {
    readonly props: Record<string, never>;
  }) => {
    runShard(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult>;
  };
}

/** The DO I/O context owns the durable keyed Dynamic Worker facets it starts. */
export class HarnessProcessExecutionShardObject extends DurableObject<HarnessProcessExecutionEnvironment> {
  #activeShard:
    | {
        readonly input: HarnessProcessExecutionShardInput;
        readonly completed: Promise<void>;
      }
    | undefined;
  #resumeAttempt: ActiveResumeAttempt | undefined;
  #resumedFacet:
    | {
        readonly operationKey: string;
        readonly identity: {
          readonly shardOwner: string;
          readonly loaderId: string;
          readonly facetKey: string;
          readonly incarnationNonce: string;
        };
        readonly preparedFacet: unknown;
      }
    | undefined;
  // @effect-diagnostics-next-line cryptoRandomUUID:off - immutable identity for this DO construction.
  readonly #executionIncarnationNonce = crypto.randomUUID();

  executionIncarnationNonce() {
    return this.#executionIncarnationNonce;
  }

  protected processExecutionHooks(): HarnessProcessExecutionHooks | undefined {
    return {
      beforeCleanup: async ({ runId, process, requestId, handle, settlement, failure }) => {
        const attempt = this.#resumeAttempt;
        if (attempt === undefined) return "cleanup";
        if (
          runId !== attempt.operation.runId ||
          process.processId !== attempt.operation.previousProcessId ||
          process.operationId !== attempt.operation.previousOperationId
        )
          return "retain";

        if (!(await attempt.fenceReady)) return "retain";
        try {
          attempt.terminalOutcome = await persistTerminalEvidence({
            durable: attempt.durable,
            transition: attempt.operation.transition,
            operation: attempt.operation,
            previousProcess: process,
            preDrain: attempt.preDrain,
            requestId,
            handle,
            ...(settlement === undefined ? {} : { settlement }),
            ...(failure === undefined ? {} : { failure }),
          });
        } catch {
          attempt.terminalOutcome = { _tag: "indeterminate" };
        }
        return attempt.terminalOutcome._tag === "committed" ? "cleanup" : "retain";
      },
    };
  }

  async runShard(
    input: HarnessProcessExecutionShardInput,
    requestContextId: string,
  ): Promise<HarnessProcessExecutionShardResult> {
    if (this.#activeShard !== undefined)
      throw new Error("This process shard already has an active writer.");
    const completed = Promise.withResolvers<void>();
    const activeShard = { input, completed: completed.promise };
    this.#activeShard = activeShard;
    try {
      const firstIndex = input.shardIndex ?? 0;
      const batches = [];
      for (
        let start = 0;
        start < input.processes.length;
        start += DURABLE_OBJECT_INVOCATION_LIMIT
      ) {
        batches.push({
          shardIndex: firstIndex + batches.length,
          processes: input.processes.slice(start, start + DURABLE_OBJECT_INVOCATION_LIMIT),
        });
      }
      if (batches.length === 0) return { requestContextId, processes: [] };

      const results = await Promise.all(
        batches.map(({ shardIndex, processes }, index) => {
          const shard = { ...input, shardIndex, processes };
          return index === 0
            ? runHarnessProcessExecutionShard(
                shard,
                requestContextId,
                this.ctx,
                this.env,
                this.#executionIncarnationNonce,
                this.processExecutionHooks(),
              )
            : this.#overflow(shard);
        }),
      );
      return {
        requestContextId: results[0]!.requestContextId,
        processes: results.flatMap((result) => result.processes),
      };
    } finally {
      completed.resolve();
      if (this.#activeShard === activeShard) this.#activeShard = undefined;
    }
  }

  /** Fences and drains the live shard before preparing and publishing its replacement facet. */
  async resumeProcess(operation: HarnessProcessResumeOperationInput) {
    const operationKey = `${operation.runId}\u0000${operation.transition.operationId}`;
    if (this.#resumedFacet?.operationKey === operationKey)
      return { status: "resumed" as const, identity: this.#resumedFacet.identity };
    if (this.#resumedFacet !== undefined)
      throw new Error("This shard already owns a resumed process facet.");

    const activeShard = this.#activeShard;
    if (activeShard === undefined || this.#resumeAttempt !== undefined)
      throw new Error("A process can only resume while its shard invocation is owned here.");
    if (
      operation.runId !== activeShard.input.runId ||
      activeShard.input.processes.length !== 1 ||
      activeShard.input.processes[0]?.processId !== operation.previousProcessId ||
      activeShard.input.processes[0]?.operationId !== operation.previousOperationId ||
      operation.previousStepId.length === 0
    )
      throw new Error("Process resume does not identify the active shard invocation.");
    if (this.env.HARNESS_RUN_STORE === undefined || this.env.HARNESS_FILES_STORE === undefined)
      throw new Error(
        "Process resume requires the run and files stores in this shard environment.",
      );

    const durable = createHarnessDurableState(
      this.env as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
      operation.runId,
    );
    const preDrain = await durable.threadSupervisor.execute({
      type: "read",
      runId: operation.runId,
      control: operation.transition.control,
    });
    validatePreDrain(operation, activeShard.input.processes[0]!, preDrain);

    const fence = Promise.withResolvers<boolean>();
    const attempt: ActiveResumeAttempt = {
      operation,
      preDrain: snapshotPreDrain(preDrain),
      durable,
      fenceReady: fence.promise,
      resolveFence: fence.resolve,
    };
    this.#resumeAttempt = attempt;
    try {
      const drained = await durable.beginDrain({
        control: operation.transition.control,
        publisher: operation.transition.publisher,
        expectedGeneration: operation.transition.expectedFacetGeneration,
        operationId: operation.transition.operationId,
        nextControl: operation.transition.nextControl,
      });
      if (drained.status !== "draining")
        throw new Error("The durable stores did not confirm the process drain.");
      attempt.resolveFence(true);

      const handoff = {
        async beginDrain(input: HarnessProcessResumeInput) {
          if (input.operationId !== operation.transition.operationId)
            throw new Error("The process resume operation changed after its drain was fenced.");
          return { preDrain: attempt.preDrain, result: drained };
        },
        async awaitDrain() {
          await activeShard.completed;
          if (attempt.terminalOutcome?._tag !== "committed")
            return attempt.terminalOutcome ?? { _tag: "indeterminate" as const };
          const current = await durable.threadSupervisor.execute({
            type: "read",
            runId: operation.runId,
            control: operation.transition.nextControl,
          });
          const checkpoint = attempt.terminalOutcome.checkpoint;
          const files = await durable.filesStore.execute({
            type: "readCheckpoint",
            runId: operation.runId,
            publisher: operation.transition.publisher,
            checkpointId: checkpoint.checkpointId,
          });
          if (
            current.snapshot.lifecycle !== "stopped" ||
            current.snapshot.admittedStepId !== null ||
            current.snapshot.nativeSessionId !== checkpoint.nativeSessionId ||
            current.snapshot.checkpoint.checkpointId !== checkpoint.checkpointId ||
            current.snapshot.checkpoint.manifestSha256 !== checkpoint.manifestSha256 ||
            files.checkpoint.checkpointId !== checkpoint.checkpointId ||
            files.checkpoint.manifestSha256 !== checkpoint.manifestSha256
          )
            return { _tag: "indeterminate" as const };
          return { _tag: "committed" as const, checkpoint };
        },
        retainOwnership() {},
      };
      const driver = createHarnessProcessResumePlacementDriver({
        operation,
        context: this.ctx,
        environment: this.env as HarnessProcessExecutionEnvironment & HarnessDurableStateBindings,
        shardIncarnationNonce: this.#executionIncarnationNonce,
        durable,
        handoff,
      });
      const result = await Effect.runPromise(
        createHarnessProcessResume(driver).resume(operation.transition),
      );
      const identity = {
        shardOwner: result.preparedFacet.identity.shardOwner,
        loaderId: result.preparedFacet.identity.loaderId,
        facetKey: result.preparedFacet.identity.facetKey,
        incarnationNonce: result.preparedFacet.identity.incarnationNonce,
      };
      this.#resumedFacet = {
        operationKey,
        identity,
        preparedFacet: result.preparedFacet,
      };
      return { status: "resumed" as const, identity };
    } finally {
      attempt.resolveFence(false);
      if (this.#resumeAttempt === attempt) this.#resumeAttempt = undefined;
    }
  }

  #overflow(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult> {
    const exports = (
      this.ctx as unknown as { readonly exports: HarnessProcessExecutionShardExports }
    ).exports;
    // Give each DO branch its own prefix before the Worker entrypoint allocates nested indices.
    return exports.HarnessProcessExecutionEntrypoint({ props: {} }).runShard({
      ...input,
      shardOwner: `${input.shardOwner}/do-overflow-${input.shardIndex ?? 0}`,
      shardIndex: 0,
    });
  }
}

function validatePreDrain(
  operation: HarnessProcessResumeOperationInput,
  process: HarnessProcessExecutionProcessInput,
  current: HarnessThreadSupervisorResult,
) {
  const transition = operation.transition;
  const { snapshot, currentPublisher } = current;
  if (
    snapshot.lifecycle !== "accepting" ||
    snapshot.admittedStepId !== operation.previousStepId ||
    snapshot.ownerId !== transition.control.ownerId ||
    snapshot.controlIncarnationId !== transition.control.incarnationId ||
    snapshot.controlEpoch !== transition.control.epoch ||
    snapshot.generation !== transition.expectedFacetGeneration ||
    snapshot.facetNonce !== transition.publisher.facetNonce ||
    currentPublisher.generation !== transition.publisher.generation ||
    currentPublisher.facetNonce !== transition.publisher.facetNonce ||
    currentPublisher.publisherKey !== transition.publisher.publisherKey ||
    snapshot.nativeSessionId !== process.nativeSessionId ||
    snapshot.generation !== process.expectedFacetGeneration + 1 ||
    snapshot.checkpoint.checkpointId !== process.checkpointId ||
    snapshot.checkpoint.manifestSha256 !== process.manifestRevision ||
    process.processId !== operation.previousProcessId ||
    process.operationId !== operation.previousOperationId
  )
    throw new Error("Process resume does not match the active durable invocation.");
}

function snapshotPreDrain(
  current: HarnessThreadSupervisorResult,
): HarnessProcessResumePreDrainSnapshot {
  const { snapshot } = current;
  return {
    lifecycle: snapshot.lifecycle,
    admittedStepId: snapshot.admittedStepId,
    checkpoint: { ...snapshot.checkpoint },
    nativeSessionId: snapshot.nativeSessionId,
    generation: snapshot.generation,
    facetNonce: snapshot.facetNonce,
    controlEpoch: snapshot.controlEpoch,
    controlIncarnationId: snapshot.controlIncarnationId,
  };
}
