import * as Effect from "effect/Effect";
import type { HarnessDurableStateBindings } from "../HarnessDurableState.ts";
import type { HarnessProcessExecutionEnvironment } from "../processPlacement/execution.ts";
import type { HarnessProcessResumeOperationInput } from "./contracts.ts";
import type { OwnedProcessRequest } from "./executionState.ts";
import { readOwnedTerminal, type DurableOwnedRequest } from "../processOwnership/ownedRequest.ts";
import { sameControl, samePublisher } from "./authority.ts";
import { sameData } from "./checkpointContract.ts";
import { createHarnessProcessResume } from "./service.ts";
import {
  createHarnessProcessResumePlacementDriver,
  type HarnessProcessResumePreparedFacetInstance,
} from "./placementDriver.ts";
import {
  readHarnessProcessResumeDurableRecord,
  writeHarnessProcessResumeDurableRecord,
  type HarnessProcessResumeDurableRecord,
} from "./durableState.ts";
import {
  settleTerminalEvidence,
  terminalKey,
  type ProcessTerminalEvidence,
} from "./terminalEvidence.ts";
import {
  validateHarnessProcessResumeRunStoreDrain,
  validateHarnessProcessResumeRunStoreStart,
} from "./runStore.ts";

export interface ResumedProcess {
  readonly operation: HarnessProcessResumeOperationInput;
  readonly prepared: HarnessProcessResumePreparedFacetInstance;
  readonly publication: Extract<
    Awaited<ReturnType<OwnedProcessRequest["durable"]["publishFreshFacet"]>>,
    { status: "published" }
  >;
  readonly boundary: ProcessTerminalEvidence;
  readonly placement: ProcessTerminalEvidence["placement"];
}
export interface ResumeAttempt {
  readonly operation: HarnessProcessResumeOperationInput;
  readonly controller: AbortController;
  readonly result: Promise<ResumedProcess>;
  readonly owned: ResumeSource;
  drainStarted: boolean;
}

type ResumeSource = DurableOwnedRequest & {
  readonly durable: OwnedProcessRequest["durable"];
  retained: boolean;
};

export function startResumeAttempt(input: {
  readonly operation: HarnessProcessResumeOperationInput;
  readonly owned: ResumeSource;
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment & HarnessDurableStateBindings;
  readonly isOwned: (attempt: ResumeAttempt) => boolean;
  readonly assertCurrent: () => Promise<void>;
  readonly placementNonce: string;
  readonly awaitSourceSettlement: () => Promise<void>;
  readonly onDrainStarted: () => void;
}) {
  const { operation, owned } = input;
  const completion = Promise.withResolvers<ResumedProcess>();
  const attempt: ResumeAttempt = {
    operation,
    owned,
    controller: new AbortController(),
    result: completion.promise,
    drainStarted: false,
  };
  let record: HarnessProcessResumeDurableRecord = {
    version: 1,
    operation,
    phase: "reserved",
    placement: owned.placement,
  };
  const check = () => {
    attempt.controller.signal.throwIfAborted();
    if (!input.isOwned(attempt)) throw new Error("Another operation owns the process transition.");
  };
  const save = async (
    changes: Partial<
      Pick<
        HarnessProcessResumeDurableRecord,
        "phase" | "prepared" | "publication" | "failure" | "terminalKey"
      >
    >,
  ) => {
    const next = { ...record, ...changes };
    await writeHarnessProcessResumeDurableRecord(input.context.storage, next);
    record = next;
  };
  const run = async () => {
    try {
      const previous = await readHarnessProcessResumeDurableRecord(
        input.context.storage,
        operation.runId,
        operation.transition.operationId,
      );
      if (previous !== undefined)
        throw new Error(
          "The persisted resume attempt requires explicit repair; it cannot be replayed.",
        );
      check();
      await input.assertCurrent();
      await save({});
      const current = await owned.durable.threadSupervisor.execute({
        type: "read",
        runId: operation.runId,
        control: operation.transition.control,
      });
      if (
        current.snapshot.lifecycle !== "accepting" ||
        (current.snapshot.admittedStepId !== null &&
          current.snapshot.admittedStepId !== operation.previousStepId) ||
        current.snapshot.nativeSessionId !== owned.process.nativeSessionId ||
        !samePublisher(current.currentPublisher, operation.transition.publisher) ||
        !samePublisher(current.currentPublisher, owned.publisher) ||
        !sameControl(operation.transition.control, owned.control)
      )
        throw new Error("The drain request no longer matches the active A publisher.");
      await validateHarnessProcessResumeRunStoreStart({
        store: owned.durable.runStore,
        operation,
        activeCheckpoint: {
          checkpointId: owned.parentCheckpoint.native.id,
          manifestSha256: owned.parentCheckpoint.filesystem.sha256,
        },
      });
      check();
      const preDrain = {
        lifecycle: current.snapshot.lifecycle,
        admittedStepId: current.snapshot.admittedStepId,
        checkpoint: current.snapshot.checkpoint,
        nativeSessionId: current.snapshot.nativeSessionId,
        generation: current.snapshot.generation,
        facetNonce: current.snapshot.facetNonce,
        controlEpoch: current.snapshot.controlEpoch,
        controlIncarnationId: current.snapshot.controlIncarnationId,
      };
      await save({ phase: "draining" });
      check();
      attempt.drainStarted = true;
      input.onDrainStarted();
      const drained = await owned.durable.beginDrain({
        control: operation.transition.control,
        publisher: operation.transition.publisher,
        expectedGeneration: operation.transition.expectedFacetGeneration,
        operationId: operation.transition.operationId,
        nextControl: operation.transition.nextControl,
      });
      if (drained.status !== "draining")
        throw new Error("The A drain is pending; process ownership stays reserved.");
      check();
      await input.awaitSourceSettlement();
      await input.assertCurrent();
      check();
      if (owned.retained) throw new Error("The previous process still has unresolved ownership.");
      const key = terminalKey(
        operation.runId,
        operation.previousOperationId,
        operation.previousStepId,
      );
      const { durable: _durable, ...source } = owned;
      const boundary = await readOwnedTerminal(
        input.context.storage,
        source,
        operation.transition.operationId,
      );
      if (
        boundary === undefined ||
        boundary.version !== 1 ||
        boundary.runId !== operation.runId ||
        boundary.processId !== operation.previousProcessId ||
        boundary.processOperationId !== operation.previousOperationId ||
        boundary.request.requestId !== operation.previousStepId ||
        !sameData(boundary.request, operation.runStore.request) ||
        !sameData(boundary.placement, owned.placement) ||
        !sameData(boundary.identity, owned.identity) ||
        !samePublisher(boundary.publisher, operation.transition.publisher)
      )
        throw new Error("No exact durable stop evidence belongs to this process transition.");
      check();
      const stopped = await settleTerminalEvidence({
        owned,
        evidence: boundary,
        control: operation.transition.nextControl,
      });
      const checkpoint = {
        ...stopped.snapshot.checkpoint,
        nativeSessionId: stopped.snapshot.nativeSessionId,
      };
      const journal = await validateHarnessProcessResumeRunStoreDrain({
        store: owned.durable.runStore,
        operation,
        checkpoint,
      });
      await save({ phase: "old-stopped", terminalKey: key });
      check();
      const driver = createHarnessProcessResumePlacementDriver({
        operation,
        shard: { ...owned.placement, shardIncarnationNonce: input.placementNonce },
        context: input.context,
        environment: input.environment,
        durable: owned.durable,
        controller: attempt.controller,
        save,
        handoff: {
          async beginDrain(request) {
            check();
            if (!sameData(request, operation.transition))
              throw new Error("The transition changed after reservation.");
            return { preDrain, result: drained, runStoreResult: journal };
          },
          async awaitDrain() {
            check();
            return { _tag: "committed", checkpoint };
          },
          retainOwnership() {
            owned.retained = true;
          },
        },
      });
      const result = await Effect.runPromise(
        createHarnessProcessResume(driver).resume(operation.transition),
      );
      check();
      return {
        operation,
        prepared: result.preparedFacet,
        publication: result.publication,
        boundary,
        placement: { ...owned.placement, shardIncarnationNonce: input.placementNonce },
      };
    } catch (cause) {
      owned.retained = true;
      try {
        await save({
          phase: "retained",
          failure: record.failure ?? {
            stage: attempt.drainStarted ? "drain" : "fence",
            reason: attempt.controller.signal.aborted ? "cancelled" : "unconfirmed",
          },
        });
      } catch {
        /* The prior intent and actual B ownership remain reserved for explicit repair. */
      }
      throw cause;
    }
  };
  // The caller installs the attempt synchronously before this task can reach its first await.
  queueMicrotask(() => {
    void run().then(completion.resolve, completion.reject);
  });
  return attempt;
}
