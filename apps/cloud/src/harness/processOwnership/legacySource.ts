import * as Schema from "effect/Schema";
import { HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import {
  HarnessRequestCheckpointSchema,
  HarnessRequestOfferSchema,
  type HarnessRequestOffer,
  type HarnessRequestPublisher,
  type HarnessRunStoreProcessSource,
  type HarnessRunStoreProcessSourceInput,
} from "../HarnessRunStore.ts";
import { HarnessThreadSupervisorResult } from "../HarnessThreadSupervisor.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../HarnessThreadSupervisor.ts";
import type { HarnessDurableStateBindings } from "../HarnessDurableState.ts";
import type { HarnessProcessPlacementIdentity } from "../processPlacement/contracts.ts";
import type { HarnessProcessExecutionEnvironment } from "../processPlacement/execution.ts";
import type { HarnessProcessResumeOperationInput } from "../processResume/contracts.ts";
import { HarnessProcessCheckpointInput } from "../processResume/checkpointContract.ts";
import { terminalKey, type ProcessTerminalEvidence } from "../processResume/terminalContract.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import type { HarnessProcessResumePlacementPin } from "../processResume/durableState.ts";
import { ProcessFence, readProcessFence } from "./fence.ts";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const capability = Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128));
const positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const artifact = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const RequestPublisher = Schema.Struct({
  generation: positive,
  facetNonce: id,
  publisherKey: capability,
});
const RequestFinish = Schema.Struct({
  sequence: positive,
  status: Schema.Literals(["completed", "failed"]),
  result: artifact,
  checkpoint: HarnessRequestCheckpointSchema,
});
const Control = Schema.Struct({
  ownerId: id,
  incarnationId: id,
  epoch: positive,
  controlKey: capability,
});
const Placement = Schema.Struct({
  owner: id,
  executionOperationId: id,
  shardOwner: id,
  shardIndex: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  shardIncarnationNonce: id,
});
const Identity = Schema.Struct({
  shardOwner: id,
  loaderId: id,
  facetKey: id,
  incarnationNonce: id,
});
const CheckpointReceipt = Schema.Struct({
  status: Schema.Literal("committed"),
  files: HarnessFilesStoreResult,
  supervisor: HarnessThreadSupervisorResult,
});
const TerminalEvidence = Schema.Struct({
  version: Schema.Literal(1),
  runId: id,
  processId: id,
  processOperationId: id,
  request: HarnessRequestOfferSchema,
  nativeSessionId: id,
  control: Control,
  publisher: RequestPublisher,
  placement: Placement,
  identity: Identity,
  finish: RequestFinish,
  completion: CheckpointReceipt,
  acknowledgementId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  stopped: Schema.Literal(true),
  joined: Schema.Struct({
    invocationRpc: Schema.Literal(true),
    fetch: Schema.Literal(true),
    ports: Schema.Literal(true),
  }),
});
const CompletionRecord = Schema.Struct({
  input: HarnessProcessCheckpointInput,
  phase: Schema.Literal("committed"),
  result: CheckpointReceipt,
});
const PriorResumeRecord = Schema.Struct({
  version: Schema.Literal(1),
  operation: Schema.Struct({
    runId: id,
    previousProcessId: id,
    previousOperationId: id,
    previousStepId: id,
    transition: Schema.Struct({ operationId: id }),
  }),
  phase: Schema.Literals([
    "reserved",
    "draining",
    "old-stopped",
    "prepared",
    "publication-attempted",
    "published",
    "active",
    "retained",
  ]),
});
const decodeTerminal = Schema.decodeUnknownSync(TerminalEvidence, { onExcessProperty: "error" });
const decodeCompletion = Schema.decodeUnknownSync(CompletionRecord, { onExcessProperty: "error" });
const decodeSupervisor = Schema.decodeUnknownSync(HarnessThreadSupervisorResult, {
  onExcessProperty: "error",
});
const decodePriorResume = Schema.decodeUnknownSync(PriorResumeRecord, {
  onExcessProperty: "ignore",
});

const completionKey = (runId: string, operationId: string, requestId: string) =>
  `harness-process-completion/v1/${encodeURIComponent(runId)}/${encodeURIComponent(operationId)}/${encodeURIComponent(requestId)}`;
const resumePrefix = (runId: string) => `harness-process-resume/v1/${encodeURIComponent(runId)}/`;
const resumeKey = (runId: string, operationId: string) =>
  `${resumePrefix(runId)}${encodeURIComponent(operationId)}`;
const MAX_PRIOR_RESUME_RECORDS = 128;

export type HarnessLegacyProcessSourceEnvironment = HarnessProcessExecutionEnvironment &
  Partial<HarnessDurableStateBindings>;

export type HarnessLegacyProcessSourceOperation = Pick<
  HarnessProcessResumeOperationInput,
  "runId" | "previousProcessId" | "previousOperationId" | "previousStepId" | "runStore"
> & {
  readonly transition: Pick<
    HarnessProcessResumeOperationInput["transition"],
    "control" | "publisher"
  >;
};

export type HarnessLegacyProcessSourceCandidate = {
  readonly version: 1;
  readonly retained: false;
  readonly runId: string;
  readonly process: {
    readonly processId: string;
    readonly operationId: string;
    readonly nativeSessionId: string;
  };
  readonly request: HarnessRequestOffer;
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly runStorePublisher: HarnessRequestPublisher;
  readonly parentCheckpoint: typeof HarnessRequestCheckpointSchema.Type;
  readonly placement: HarnessProcessResumePlacementPin;
  readonly identity: HarnessProcessPlacementIdentity;
  readonly fence: typeof ProcessFence.Type;
  readonly terminalKey: string;
  readonly legacySource: {
    readonly version: 1;
    readonly terminalKey: string;
    readonly completionKey: string;
  };
  readonly evidence: {
    readonly terminal: ProcessTerminalEvidence;
    readonly completion: typeof CompletionRecord.Type;
  };
};

export async function assertNoLegacyProcessResumeForSource(input: {
  readonly storage: DurableObjectStorage | DurableObjectTransaction;
  readonly runId: string;
  readonly processId: string;
  readonly processOperationId: string;
  readonly requestId: string;
}) {
  const prefix = resumePrefix(input.runId);
  const records = await input.storage.list({ prefix, limit: MAX_PRIOR_RESUME_RECORDS + 1 });
  if (records.size > MAX_PRIOR_RESUME_RECORDS)
    throw new Error(
      "Legacy resume history exceeds the bounded adoption check; explicit repair is required.",
    );
  for (const [key, value] of records) {
    let operationId: string;
    let prior: typeof PriorResumeRecord.Type;
    try {
      operationId = decodeURIComponent(key.slice(prefix.length));
      prior = decodePriorResume(value);
    } catch {
      throw new Error("Legacy resume history is malformed; explicit repair is required.");
    }
    if (
      !operationId ||
      key !== resumeKey(input.runId, operationId) ||
      prior.operation.runId !== input.runId ||
      prior.operation.transition.operationId !== operationId
    )
      throw new Error("Legacy resume history is inconsistent; explicit repair is required.");
    if (
      prior.operation.previousProcessId === input.processId &&
      prior.operation.previousOperationId === input.processOperationId &&
      prior.operation.previousStepId === input.requestId
    )
      throw new Error(
        "This legacy process source already has a resume attempt; replay is forbidden.",
      );
  }
}

/** Produces an adoption candidate from persisted C, RunStore, and current A records only. */
export async function readLegacyProcessSource(input: {
  readonly storage: DurableObjectStorage;
  readonly environment: HarnessLegacyProcessSourceEnvironment;
  readonly operation: HarnessLegacyProcessSourceOperation;
  readonly fence: typeof ProcessFence.Type;
}): Promise<HarnessLegacyProcessSourceCandidate> {
  let fence: typeof ProcessFence.Type;
  try {
    fence = readProcessFence(input.fence);
  } catch {
    throw new Error("The current process fence is invalid.");
  }

  const { operation } = input;
  const key = terminalKey(operation.runId, operation.previousOperationId, operation.previousStepId);
  let terminal: typeof TerminalEvidence.Type;
  try {
    terminal = decodeTerminal(await input.storage.get(key));
  } catch {
    throw new Error(
      "The exact terminal receipt is missing or malformed; explicit repair is required.",
    );
  }
  if (
    terminal.runId !== operation.runId ||
    terminal.processId !== operation.previousProcessId ||
    terminal.processOperationId !== operation.previousOperationId ||
    terminal.request.requestId !== operation.previousStepId ||
    terminal.finish.status !== "completed" ||
    !sameData(operation.transition.control, terminal.control) ||
    terminal.placement.owner !== fence.owner ||
    terminal.identity.shardOwner !== terminal.placement.shardOwner ||
    terminal.identity.loaderId !== terminal.identity.facetKey
  )
    throw new Error("The terminal receipt does not identify this legacy process source.");

  const completionKeyValue = completionKey(
    terminal.runId,
    terminal.processOperationId,
    terminal.request.requestId,
  );
  let completion: typeof CompletionRecord.Type;
  try {
    completion = decodeCompletion(await input.storage.get(completionKeyValue));
  } catch {
    throw new Error(
      "The committed completion receipt is missing or malformed; explicit repair is required.",
    );
  }
  const completionResult = completion.result;
  if (
    !sameData(completion.result, terminal.completion) ||
    completion.input.runId !== terminal.runId ||
    completion.input.processId !== terminal.processId ||
    completion.input.executionOperationId !== terminal.placement.executionOperationId ||
    completion.input.processOperationId !== terminal.processOperationId ||
    completion.input.requestId !== terminal.request.requestId ||
    completion.input.nativeSessionId !== terminal.nativeSessionId ||
    !sameData(completion.input.control, terminal.control) ||
    !sameData(completion.input.publisher, terminal.publisher) ||
    completion.input.checkpoint.checkpointId !== terminal.finish.checkpoint.native.id ||
    completionResult.files.checkpoint.checkpointId !== terminal.finish.checkpoint.native.id ||
    completionResult.files.checkpoint.manifestSha256 !==
      terminal.finish.checkpoint.filesystem.sha256 ||
    completionResult.supervisor.snapshot.nativeSessionId !== terminal.nativeSessionId ||
    completionResult.supervisor.snapshot.admittedStepId !== null ||
    !sameData(completionResult.supervisor.currentPublisher, terminal.publisher) ||
    completionResult.supervisor.snapshot.checkpoint.checkpointId !==
      completionResult.files.checkpoint.checkpointId ||
    completionResult.supervisor.snapshot.checkpoint.manifestSha256 !==
      completionResult.files.checkpoint.manifestSha256
  )
    throw new Error("The committed completion receipt does not match terminal evidence.");

  const sourceInput = {
    controlKey: operation.runStore.controlKey,
    supervisor: operation.runStore.supervisor,
  };
  const rawRunStore = input.environment.HARNESS_RUN_STORE?.getByName(operation.runId) as unknown as
    | { readProcessSource(auth: unknown, fence: unknown): Promise<unknown> }
    | undefined;
  if (rawRunStore === undefined)
    throw new Error("The RunStore namespace is unavailable for legacy adoption.");
  const runStoreSource = (await rawRunStore.readProcessSource(
    sourceInput as HarnessRunStoreProcessSourceInput,
    fence,
  )) as HarnessRunStoreProcessSource;
  if (
    runStoreSource.runId !== terminal.runId ||
    runStoreSource.processOperationId !== terminal.processOperationId ||
    !sameData(runStoreSource.request, terminal.request) ||
    !sameData(runStoreSource.finish, terminal.finish) ||
    !sameData(operation.runStore.currentPublisher, runStoreSource.currentPublisher) ||
    !sameData(operation.runStore.request, runStoreSource.request) ||
    !sameData(operation.runStore.checkpoint, runStoreSource.parentCheckpoint) ||
    operation.runStore.runId !== runStoreSource.runId ||
    operation.runStore.processId !== terminal.processId ||
    operation.runStore.processOperationId !== runStoreSource.processOperationId ||
    !sameData(runStoreSource.supervisor, operation.runStore.supervisor) ||
    !sameData(operation.transition.publisher, terminal.publisher) ||
    completion.input.checkpoint.parentCheckpointId !== runStoreSource.parentCheckpoint.native.id
  )
    throw new Error(
      "RunStore, A, and terminal receipts do not describe the same completed source.",
    );

  const rawSupervisor = input.environment.HARNESS_THREAD_SUPERVISOR.getByName(
    operation.runId,
  ) as unknown as { execute(command: unknown, fence: unknown): Promise<unknown> };
  const current = await rawSupervisor.execute(
    {
      type: "read",
      runId: operation.runId,
      control: operation.transition.control,
    },
    fence,
  );
  const currentSupervisor = decodeSupervisor(current);
  if (
    currentSupervisor.snapshot.lifecycle !== "accepting" ||
    currentSupervisor.snapshot.admittedStepId !== null ||
    currentSupervisor.snapshot.runId !== terminal.runId ||
    currentSupervisor.snapshot.ownerId !== operation.transition.control.ownerId ||
    currentSupervisor.snapshot.controlIncarnationId !==
      operation.transition.control.incarnationId ||
    currentSupervisor.snapshot.controlEpoch !== operation.transition.control.epoch ||
    currentSupervisor.snapshot.nativeSessionId !== terminal.nativeSessionId ||
    !sameData(currentSupervisor.currentPublisher, terminal.publisher) ||
    currentSupervisor.snapshot.checkpoint.checkpointId !==
      completionResult.files.checkpoint.checkpointId ||
    currentSupervisor.snapshot.checkpoint.manifestSha256 !==
      completionResult.files.checkpoint.manifestSha256
  )
    throw new Error("A's current state no longer matches the completed, stopped process.");

  return {
    version: 1,
    retained: false,
    runId: terminal.runId,
    process: {
      processId: terminal.processId,
      operationId: terminal.processOperationId,
      nativeSessionId: terminal.nativeSessionId,
    },
    request: runStoreSource.request,
    control: terminal.control,
    publisher: terminal.publisher,
    runStorePublisher: runStoreSource.currentPublisher,
    parentCheckpoint: runStoreSource.parentCheckpoint,
    placement: terminal.placement,
    identity: terminal.identity,
    fence,
    terminalKey: key,
    legacySource: {
      version: 1,
      terminalKey: key,
      completionKey: completionKeyValue,
    },
    evidence: { terminal: terminal as ProcessTerminalEvidence, completion },
  };
}
