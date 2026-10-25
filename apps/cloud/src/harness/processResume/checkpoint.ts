import type { HarnessDurableStateCheckpointResult } from "../HarnessDurableState.ts";
import type { OwnedProcessRequest } from "./executionState.ts";
import {
  snapshotCheckpointInput,
  sameData,
  type HarnessProcessCheckpointInput,
} from "./checkpointContract.ts";
import { readCompletedJournal } from "./completedJournal.ts";
import { sameControl, samePublisher, sameReference } from "./authority.ts";

interface CompletionRecord {
  readonly input: HarnessProcessCheckpointInput;
  readonly phase: "intent" | "committed" | "retained";
  readonly result?: HarnessDurableStateCheckpointResult;
  readonly failure?: "commit-unknown" | "receipt-mismatch" | "persistence-unknown";
}
interface CompletionAttempt {
  readonly input: HarnessProcessCheckpointInput;
  readonly result: Promise<HarnessDurableStateCheckpointResult>;
}
export const completionKey = (runId: string, processOperationId: string, requestId: string) =>
  `harness-process-completion/v1/${encodeURIComponent(runId)}/${encodeURIComponent(processOperationId)}/${encodeURIComponent(requestId)}`;

/** One commit attempt owns its exact file bytes until a real composed receipt or explicit repair. */
export class ProcessCheckpointOwner {
  readonly #attempts = new Map<string, CompletionAttempt>();
  readonly storage: DurableObjectStorage;
  readonly active: () => OwnedProcessRequest | undefined;
  constructor(storage: DurableObjectStorage, active: () => OwnedProcessRequest | undefined) {
    this.storage = storage;
    this.active = active;
  }

  commit(supplied: unknown): Promise<HarnessDurableStateCheckpointResult> {
    const input = snapshotCheckpointInput(supplied);
    const key = completionKey(input.runId, input.processOperationId, input.requestId);
    const existing = this.#attempts.get(key);
    if (existing !== undefined) {
      if (!sameData(existing.input, input))
        return Promise.reject(
          new Error("A duplicate completion changed its checkpoint bytes or authority."),
        );
      return existing.result.then(() => this.#readKnown(input));
    }
    const owned = this.active();
    if (
      owned === undefined ||
      owned.retained ||
      input.runId !== owned.runId ||
      input.processId !== owned.process.processId ||
      input.executionOperationId !== owned.placement.executionOperationId ||
      input.processOperationId !== owned.process.operationId ||
      input.requestId !== owned.request.requestId ||
      input.nativeSessionId !== owned.process.nativeSessionId ||
      !sameControl(input.control, owned.control) ||
      !samePublisher(input.publisher, owned.publisher) ||
      input.checkpoint.parentCheckpointId !== owned.parentCheckpoint.native.id
    )
      return Promise.reject(
        new Error(
          "Process completion does not identify the current owned request and parent checkpoint.",
        ),
      );
    const result = Promise.withResolvers<HarnessDurableStateCheckpointResult>();
    this.#attempts.set(key, { input, result: result.promise });
    void this.#commit(input, owned).then(result.resolve, result.reject);
    return result.promise;
  }

  async #commit(input: HarnessProcessCheckpointInput, owned: OwnedProcessRequest) {
    const key = completionKey(input.runId, input.processOperationId, input.requestId);
    let intentWritten = false;
    let result: HarnessDurableStateCheckpointResult | undefined;
    try {
      const prior = await this.storage.get<CompletionRecord>(key);
      if (prior !== undefined) {
        if (!sameData(prior.input, input))
          throw new Error("Persisted completion belongs to another payload.");
        return await this.#readKnown(input);
      }
      const journal = await readCompletedJournal(owned);
      if (input.checkpoint.checkpointId !== journal.finish.checkpoint.native.id)
        throw new Error("The supplied checkpoint is not the completed journal's native envelope.");
      const current = await owned.durable.threadSupervisor.execute({
        type: "read",
        runId: input.runId,
        control: input.control,
      });
      this.#assertOwned(owned, input);
      if (
        current.snapshot.nativeSessionId !== input.nativeSessionId ||
        !samePublisher(current.currentPublisher, input.publisher) ||
        current.snapshot.admittedStepId !== input.requestId ||
        current.snapshot.checkpoint.checkpointId !== input.checkpoint.parentCheckpointId ||
        current.snapshot.checkpoint.manifestSha256 !== owned.parentCheckpoint.filesystem.sha256 ||
        (current.snapshot.lifecycle !== "accepting" && current.snapshot.lifecycle !== "draining")
      )
        throw new Error("A no longer owns this request's parent checkpoint.");
      await this.storage.put(key, { input, phase: "intent" } satisfies CompletionRecord);
      intentWritten = true;
      this.#assertOwned(owned, input);
      result = await owned.durable.commitCheckpoint({
        publisher: input.publisher,
        stepId: input.requestId,
        expectedCheckpointId: input.checkpoint.parentCheckpointId!,
        checkpoint: input.checkpoint,
      });
      if (
        result.status !== "committed" ||
        result.files.checkpoint.checkpointId !== journal.finish.checkpoint.native.id ||
        result.files.checkpoint.manifestSha256 !== journal.finish.checkpoint.filesystem.sha256 ||
        !sameReference(result.files.checkpoint, result.supervisor.snapshot.checkpoint) ||
        result.supervisor.snapshot.nativeSessionId !== input.nativeSessionId ||
        !samePublisher(result.supervisor.currentPublisher, input.publisher) ||
        result.supervisor.snapshot.admittedStepId !== null
      )
        throw new Error("A's actual checkpoint receipt does not match the completed journal.");
      this.#assertOwned(owned, input);
      // Reauthenticate after both remote writes; a stale reply cannot complete another owner's work.
      const authenticated = await owned.durable.threadSupervisor.execute({
        type: "read",
        runId: input.runId,
        control: input.control,
      });
      if (
        !sameReference(authenticated.snapshot.checkpoint, result.files.checkpoint) ||
        !samePublisher(authenticated.currentPublisher, input.publisher)
      )
        throw new Error("A changed while the completion receipt was being confirmed.");
      const finished = await readCompletedJournal(owned);
      if (!sameData(finished.finish, journal.finish))
        throw new Error("The journal finish changed during checkpoint commit.");
      await this.storage.put(key, { input, phase: "committed", result } satisfies CompletionRecord);
      owned.completion.resolve(result);
      return result;
    } catch (cause) {
      owned.retained = true;
      if (intentWritten) {
        try {
          await this.storage.put(key, {
            input,
            phase: "retained",
            ...(result === undefined ? {} : { result }),
            failure: result === undefined ? "commit-unknown" : "receipt-mismatch",
          } satisfies CompletionRecord);
        } catch {
          /* The intent still reserves this attempt if recovery persistence also fails. */
        }
      }
      owned.completion.resolve(undefined);
      throw cause;
    }
  }

  #assertOwned(owned: OwnedProcessRequest, input: HarnessProcessCheckpointInput) {
    if (this.active() !== owned || owned.retained || !sameControl(owned.control, input.control))
      throw new Error("Process completion lost its owned request.");
  }

  async #readKnown(input: HarnessProcessCheckpointInput) {
    const record = await this.storage.get<CompletionRecord>(
      completionKey(input.runId, input.processOperationId, input.requestId),
    );
    if (
      record?.phase !== "committed" ||
      record.result?.status !== "committed" ||
      !sameData(record.input, input)
    )
      throw new Error("The completion attempt needs explicit repair; it cannot be replayed.");
    const owned = this.active();
    if (
      owned === undefined ||
      owned.runId !== input.runId ||
      owned.request.requestId !== input.requestId ||
      owned.retained
    )
      throw new Error("The completed request no longer has live ownership here.");
    const current = await owned.durable.threadSupervisor.execute({
      type: "read",
      runId: input.runId,
      control: input.control,
    });
    const journal = await readCompletedJournal(owned);
    if (
      !samePublisher(current.currentPublisher, input.publisher) ||
      !sameReference(current.snapshot.checkpoint, record.result.files.checkpoint) ||
      current.snapshot.checkpoint.checkpointId !== journal.finish.checkpoint.native.id ||
      current.snapshot.checkpoint.manifestSha256 !== journal.finish.checkpoint.filesystem.sha256
    )
      throw new Error("The cached completion no longer has current A and journal authority.");
    return record.result;
  }
}
