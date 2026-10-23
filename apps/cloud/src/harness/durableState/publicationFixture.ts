import { createHarnessDurableState } from "../HarnessDurableState.ts";
import type { HarnessDurableStateBindings } from "../HarnessDurableState.ts";
import type { HarnessFilesStoreCommand, HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import type {
  HarnessThreadSupervisorCommand,
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
  HarnessThreadSupervisorResult,
  HarnessThreadSupervisorSnapshot,
} from "../HarnessThreadSupervisor.ts";

export const runId = "durable-run";
export const manifest0 = { checkpointId: "checkpoint-0", manifestSha256: "a".repeat(64) };
export const control1 = {
  ownerId: "owner",
  incarnationId: "owner-incarnation-1",
  epoch: 1,
  controlKey: "controller-key-1-".repeat(3),
} satisfies HarnessThreadSupervisorControlClaim;
export const publisher1 = {
  generation: 1,
  facetNonce: "facet-nonce-1",
  publisherKey: "publisher-key-1-".repeat(3),
} satisfies HarnessThreadSupervisorPublisher;
export const preparedPublisher2 = {
  generation: 2,
  facetNonce: "facet-nonce-2",
  publisherKey: "publisher-key-2-".repeat(3),
} satisfies HarnessThreadSupervisorPublisher;
export const control2 = {
  ownerId: "owner",
  incarnationId: "owner-incarnation-2",
  epoch: 2,
  controlKey: "controller-key-2-".repeat(3),
} satisfies HarnessThreadSupervisorControlClaim;
export const control3 = {
  ownerId: "owner",
  incarnationId: "owner-incarnation-3",
  epoch: 3,
  controlKey: "controller-key-3-".repeat(3),
} satisfies HarnessThreadSupervisorControlClaim;

type Mutable<A> = { -readonly [Key in keyof A]: A[Key] };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const codedError = (code: string) => Object.assign(new Error(code), { code });

export function createPublicationFixture() {
  let currentControl = control2;
  let currentPublisher = publisher1;
  let preparedPublisher: HarnessThreadSupervisorPublisher | null = preparedPublisher2;
  let controlOperationId: string | null = null;
  let publicationAttempt = 0;
  let fileControl = control2;
  let filePublisher = publisher1;
  let filePublication: HarnessFilesStoreResult["publication"] = null;
  const snapshot: Mutable<HarnessThreadSupervisorSnapshot> = {
    runId,
    ownerId: control2.ownerId,
    controlIncarnationId: control2.incarnationId,
    controlEpoch: control2.epoch,
    nativeSessionId: "native-session-fixed",
    checkpoint: manifest0,
    generation: publisher1.generation,
    facetNonce: publisher1.facetNonce,
    lifecycle: "preparing",
    admittedStepId: null,
    preparedFacet: {
      operationId: "resume-1",
      generation: preparedPublisher2.generation,
      facetNonce: preparedPublisher2.facetNonce,
      checkpoint: manifest0,
    },
    lastPublication: null,
    lastPublicationOperationId: null,
    stopAcknowledgementId: "stop-ack",
    settlement: {
      outcome: "stopped",
      invocationRpcJoined: true,
      fetchJoined: true,
      callbackPortsJoined: true,
    },
    lastFailure: null,
    reconciliationEvidenceId: null,
  };
  const supervisorResult = (
    action: HarnessThreadSupervisorResult["action"],
  ): HarnessThreadSupervisorResult => ({
    action,
    snapshot: structuredClone(snapshot),
    currentPublisher,
    preparedPublisher,
  });
  const filesResult = (action: HarnessFilesStoreResult["action"]): HarnessFilesStoreResult => ({
    action,
    checkpoint: manifest0,
    parentCheckpointId: null,
    activeStepId: null,
    publication: filePublication,
    files: [],
  });
  const supervisor = {
    async execute(input: unknown): Promise<HarnessThreadSupervisorResult> {
      const command = input as HarnessThreadSupervisorCommand;
      if (command.type === "read") {
        if (!same(command.control, currentControl)) throw codedError("STALE_CONTROL");
        return supervisorResult("unchanged");
      }
      if (command.type === "beginDrain") {
        if (command.operationId === controlOperationId && same(command.nextControl, currentControl))
          return supervisorResult("unchanged");
        if (!same(command.control, currentControl)) throw codedError("STALE_CONTROL");
        currentControl = command.nextControl;
        controlOperationId = command.operationId;
        snapshot.ownerId = currentControl.ownerId;
        snapshot.controlIncarnationId = currentControl.incarnationId;
        snapshot.controlEpoch = currentControl.epoch;
        return supervisorResult("draining");
      }
      if (command.type === "publishFreshFacet") {
        if (publicationAttempt++ === 0) {
          currentControl = control3;
          controlOperationId = "takeover-during-publication";
          snapshot.controlIncarnationId = control3.incarnationId;
          snapshot.controlEpoch = control3.epoch;
          throw codedError("STALE_CONTROL");
        }
        if (!same(command.control, currentControl)) throw codedError("STALE_CONTROL");
        currentPublisher = preparedPublisher2;
        preparedPublisher = null;
        snapshot.generation = preparedPublisher2.generation;
        snapshot.facetNonce = preparedPublisher2.facetNonce;
        snapshot.lifecycle = "published";
        snapshot.preparedFacet = null;
        snapshot.lastPublication = {
          operationId: command.operationId,
          fromGeneration: command.expectedGeneration,
          toGeneration: preparedPublisher2.generation,
          priorFacetNonce: publisher1.facetNonce,
          preparedFacetNonce: preparedPublisher2.facetNonce,
          checkpoint: command.checkpoint,
        };
        snapshot.lastPublicationOperationId = command.operationId;
        return supervisorResult("published");
      }
      throw codedError("INVALID");
    },
  };
  const files = {
    async execute(input: unknown): Promise<HarnessFilesStoreResult> {
      const command = input as HarnessFilesStoreCommand;
      if (command.type === "syncControl") {
        if (!same(command.control, fileControl) && command.control.epoch !== fileControl.epoch + 1)
          throw codedError("STALE_CONTROL");
        fileControl = command.control;
        return filesResult("draining");
      }
      if (command.type === "publishFacet") {
        if (!same(command.control, fileControl)) throw codedError("STALE_CONTROL");
        if (filePublication) {
          if (
            filePublication.operationId !== command.operationId ||
            filePublication.fromGeneration !== command.expectedGeneration ||
            !same(filePublication.checkpoint, command.checkpoint)
          )
            throw codedError("CONFLICT");
          return filesResult("pending");
        }
        filePublication = {
          operationId: command.operationId,
          fromGeneration: command.expectedGeneration,
          toGeneration: command.preparedPublisher.generation,
          priorFacetNonce: command.publisher.facetNonce,
          preparedFacetNonce: command.preparedPublisher.facetNonce,
          checkpoint: command.checkpoint,
          status: "pending",
        };
        return filesResult("pending");
      }
      if (command.type === "confirmFacetPublication") {
        if (!same(command.control, fileControl) || !filePublication)
          throw codedError("STALE_CONTROL");
        filePublisher = command.preparedPublisher;
        filePublication = { ...filePublication, status: "confirmed" };
        return filesResult("confirmed");
      }
      if (command.type === "readPublication") {
        if (!same(command.control, fileControl)) throw codedError("STALE_CONTROL");
        return filesResult(filePublication?.status === "pending" ? "pending" : "unchanged");
      }
      if (command.type === "readCheckpoint" || command.type === "recoverCheckpoint") {
        if (!same(command.publisher, filePublisher)) throw codedError("STALE_PUBLISHER");
        return filesResult("read");
      }
      throw codedError("INVALID");
    },
  };
  const runStore = {
    async execute() {
      return {};
    },
  };
  const namespace = <A>(store: A) => ({ getByName: (_name: string) => store });
  const durable = createHarnessDurableState(
    {
      HARNESS_RUN_STORE: namespace(
        runStore,
      ) as unknown as HarnessDurableStateBindings["HARNESS_RUN_STORE"],
      HARNESS_FILES_STORE: namespace(
        files,
      ) as unknown as HarnessDurableStateBindings["HARNESS_FILES_STORE"],
      HARNESS_THREAD_SUPERVISOR: namespace(
        supervisor,
      ) as unknown as HarnessDurableStateBindings["HARNESS_THREAD_SUPERVISOR"],
    },
    runId,
  );
  return { durable, supervisor, runId };
}
