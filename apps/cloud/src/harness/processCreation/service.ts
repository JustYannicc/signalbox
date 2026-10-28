import { activateCreationJournal } from "./journalActivation.ts";
import { readCreationInput } from "./placementSchema.ts";
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import {
  HarnessProcessCreationJournal,
  type HarnessProcessCreationClaim,
  type HarnessProcessCreationBinding,
} from "./journal.ts";
import { openCreationPlacement, type HarnessCreatedProcessPlacement } from "./placement.ts";
import {
  readyCreation,
  type HarnessProcessCreationInput,
  type HarnessProcessCreationEnvironment,
  type HarnessProcessCreationRunInput,
} from "./contracts.ts";
import type { OwnedProcessRequest } from "../processResume/executionState.ts";
import { runCreatedRequest } from "./execution.ts";
import { sameControl, samePublisher } from "../processResume/authority.ts";
import { recoverBoundCreation, type HarnessProcessCreationRecoveryInput } from "./recovery.ts";
import { samePreparedRelease, snapshotPreparedRelease } from "../processResume/identity.ts";

const stable = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return { bytes: Array.from(value) };
  if (value instanceof ArrayBuffer) return { bytes: Array.from(new Uint8Array(value)) };
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
};
const digestInput = async (input: HarnessProcessCreationInput) => {
  const bytes = new TextEncoder().encode(JSON.stringify(stable(input)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    id: input.operationId,
    bytes: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
  };
};

export class HarnessProcessCreationOwner {
  readonly #journal;
  #placement: HarnessCreatedProcessPlacement | undefined;
  #binding: HarnessProcessCreationBinding | undefined;
  #input: HarnessProcessCreationInput | undefined;
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessCreationEnvironment;
  readonly incarnationNonce: string;
  constructor(
    context: DurableObjectState,
    environment: HarnessProcessCreationEnvironment,
    incarnationNonce: string,
  ) {
    this.context = context;
    this.environment = environment;
    this.incarnationNonce = incarnationNonce;
    this.#journal = new HarnessProcessCreationJournal(context.storage);
  }

  async start(supplied: HarnessProcessCreationInput) {
    const input = readCreationInput(structuredClone(supplied));
    if (
      !input.runId ||
      !input.operationId ||
      input.run.seed.identity.runId !== input.runId ||
      input.facet.productBootstrap.provider !== "codex" ||
      input.facet.targetPreparedRelease.artifact.provider !== "codex" ||
      input.publisherKey.length < 32 ||
      input.publisherKey.length > 128 ||
      input.requestPublisherKey.length > 128 ||
      !input.requestModeId ||
      input.requestModeId.length > 256 ||
      input.requestPublisherKey.length < 32 ||
      new Set([
        input.publisherKey,
        input.requestPublisherKey,
        input.run.controlKey,
        input.run.supervisorKey,
        input.controllerClaim.controlKey,
      ]).size !== 5 ||
      input.run.controlKey === input.controllerClaim.controlKey ||
      input.run.supervisorKey === input.controllerClaim.controlKey
    )
      throw new Error(
        "Cold creation requires a Codex product, separate authorities, and an exact run seed.",
      );
    const owner = this.context.id.name;
    if (!owner) throw new Error("Cold creation requires a named shard owner.");
    const reference = await digestInput(input);
    const claim: HarnessProcessCreationClaim = {
      runId: input.runId,
      operationId: input.operationId,
      processId: input.facet.processId,
      ownerId: owner,
      ownerIncarnationId: this.incarnationNonce,
      controllerClaim: input.controllerClaim,
      descriptorSha256: reference.sha256,
    };
    const durable = createHarnessDurableState(this.environment, input.runId);
    await durable.runStore.execute(input.run);
    const claimed = await this.#journal.claim(claim);
    const intent = await durable.runStore.execute({
      type: "intent",
      runId: input.runId,
      supervisor: { epoch: 1, claimId: input.run.claimId, supervisorKey: input.run.supervisorKey },
      intent: { intentId: "harness-c-cold-create", kind: "process-create", reference },
    });
    const record = claimed.record;
    if (claimed.status === "existing") {
      if (
        record.claim.operationId !== claim.operationId ||
        record.claim.processId !== claim.processId ||
        record.claim.ownerId !== claim.ownerId ||
        record.claim.descriptorSha256 !== claim.descriptorSha256 ||
        !sameControl(record.claim.controllerClaim, claim.controllerClaim)
      )
        throw new Error(
          "The existing creation claim belongs to another immutable process or owner.",
        );
      if (record.binding === undefined)
        throw new Error(
          "The prior native creation is uncertain; its claim cannot launch another thread.",
        );
      if (record.phase === "staged") await this.#initialize(input, record.binding);
      if (record.phase === "staged") await this.#journal.bind(record.claim);
      await this.#authorize(input, record.binding);
      await activateCreationJournal(this.environment, input, record.binding);
      return readyCreation(input.operationId, record.binding, "bound");
    }
    if (intent.action !== "recorded")
      throw new Error("Another shard already owns the run's native creation intent.");
    this.#input = input;
    const placement = await openCreationPlacement(
      this.context,
      this.environment,
      this.incarnationNonce,
      input,
    );
    this.#placement = placement;
    const observed = await placement.stub.startFresh({
      operationId: input.operationId,
      targetFacetNonce: placement.identity.incarnationNonce,
      publisherKey: input.requestPublisherKey,
    });
    const loaded = snapshotPreparedRelease(
      (await placement.stub.loadedPreparedRelease()) as HarnessProcessCreationInput["facet"]["targetPreparedRelease"],
    );
    const expectedRelease = snapshotPreparedRelease(input.facet.targetPreparedRelease);
    if (
      loaded === undefined ||
      expectedRelease === undefined ||
      !samePreparedRelease(loaded, expectedRelease) ||
      observed.facetNonce !== placement.identity.incarnationNonce ||
      observed.filesCheckpoint.parentCheckpointId !== null ||
      observed.filesCheckpoint.checkpointId !== observed.checkpoint.native.id
    )
      throw new Error(
        "The initial native facet did not observe its selected release and checkpoint.",
      );
    const binding: HarnessProcessCreationBinding = {
      nativeSessionId: observed.nativeSessionId,
      identity: placement.identity,
      checkpoint: observed.checkpoint,
      initialization: {
        run: input.run,
        control: input.controllerClaim,
        nativeSessionId: observed.nativeSessionId,
        publisher: {
          generation: 1,
          facetNonce: placement.identity.incarnationNonce,
          publisherKey: input.publisherKey,
        },
        checkpoint: observed.filesCheckpoint,
      },
    };
    await this.#journal.stage(claim, binding);
    await this.#initialize(input, binding);
    await this.#journal.bind(claim);
    this.#binding = binding;
    await activateCreationJournal(this.environment, input, binding);
    return readyCreation(input.operationId, binding, "created");
  }

  async recover(input: HarnessProcessCreationRecoveryInput) {
    const record = await this.#journal.read(input.runId);
    if (
      record?.phase !== "bound" ||
      record.binding === undefined ||
      record.claim.operationId !== input.operationId
    )
      throw new Error("Initial recovery requires a durably bound native identity.");
    return recoverBoundCreation(
      this.context,
      this.environment,
      this.incarnationNonce,
      input,
      record.binding,
    );
  }

  async #initialize(input: HarnessProcessCreationInput, binding: HarnessProcessCreationBinding) {
    const durable = createHarnessDurableState(this.environment, input.runId);
    const initialized = await durable.initialize(binding.initialization);
    if (
      initialized.supervisor.snapshot.nativeSessionId !== binding.nativeSessionId ||
      initialized.files.checkpoint.checkpointId !== binding.checkpoint.native.id ||
      initialized.files.checkpoint.manifestSha256 !== binding.checkpoint.filesystem.sha256 ||
      !samePublisher(initialized.supervisor.currentPublisher, binding.initialization.publisher)
    )
      throw new Error("Initial durable stores did not confirm the exact native binding.");
    await this.#authorize(input, binding);
  }

  async #authorize(input: HarnessProcessCreationInput, binding: HarnessProcessCreationBinding) {
    const current = await createHarnessDurableState(
      this.environment,
      input.runId,
    ).threadSupervisor.execute({
      type: "read",
      runId: input.runId,
      control: input.controllerClaim,
    });
    if (
      current.snapshot.nativeSessionId !== binding.nativeSessionId ||
      !samePublisher(current.currentPublisher, binding.initialization.publisher) ||
      current.snapshot.checkpoint.checkpointId !== binding.checkpoint.native.id ||
      current.snapshot.checkpoint.manifestSha256 !== binding.checkpoint.filesystem.sha256
    )
      throw new Error("The bound native identity no longer owns the initial durable checkpoint.");
  }

  async run(
    supplied: HarnessProcessCreationRunInput,
    requestContextId: string,
    onOwned: (owned: OwnedProcessRequest) => Promise<void>,
  ) {
    const request = structuredClone(supplied);
    const input = this.#input;
    const placement = this.#placement;
    const binding = this.#binding;
    if (
      !input ||
      !placement ||
      !binding ||
      input.runId !== request.runId ||
      input.operationId !== request.operationId
    )
      throw new Error(
        "No retained created process owns this request; use its bound checkpoint to resume.",
      );
    await this.#authorize(input, binding);
    return runCreatedRequest({
      context: this.context,
      environment: this.environment,
      incarnationNonce: this.incarnationNonce,
      input,
      binding,
      placement,
      request,
      requestContextId,
      onOwned,
    });
  }

  async status(runId: string, control: HarnessProcessCreationInput["controllerClaim"]) {
    const record = await this.#journal.read(runId);
    if (!record) return { status: "missing" as const };
    if (!sameControl(record.claim.controllerClaim, control))
      throw new Error("Creation status requires the exact controller claim.");
    return record.binding === undefined
      ? { status: "uncertain" as const, operationId: record.claim.operationId }
      : {
          ...readyCreation(record.claim.operationId, record.binding, "bound"),
          phase: record.phase,
        };
  }
}
