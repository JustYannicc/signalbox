import * as Effect from "effect/Effect";
import type {
  HarnessDurableState,
  HarnessDurableStateBindings,
  HarnessDurableStateDrainResult,
  HarnessDurableStateFailureInput,
  HarnessDurableStatePublicationResult,
} from "../HarnessDurableState.ts";
import type {
  HarnessProcessHandle,
  HarnessProcessPublicationPublisher,
} from "../HarnessProcessPlacement.ts";
import type { HarnessProcessFacetInvokeInput } from "../HarnessProcessFacet.ts";
import type { HarnessProcessExecutionEnvironment } from "../processPlacement/execution.ts";
import { prepareHarnessProcessExecutionResumeFacet } from "../processPlacement/execution.ts";
import type {
  HarnessProcessResumeCheckpointOutcome,
  HarnessProcessResumeCheckpointReference,
  HarnessProcessResumeDriver,
  HarnessProcessResumeInput,
  HarnessProcessResumeOperationInput,
  HarnessProcessResumePreparedFacet,
  HarnessProcessResumePreparedRelease,
  HarnessProcessResumePublicationResult,
  HarnessProcessResumeRecovery,
} from "./contracts.ts";
import { HarnessProcessResumeDriverError } from "./errors.ts";
import type { HarnessProcessResumePreDrainSnapshot } from "./terminalEvidence.ts";

interface ResumeDrain {
  readonly preDrain: HarnessProcessResumePreDrainSnapshot;
  readonly result: HarnessDurableStateDrainResult;
}

interface CleanupEvidence {
  readonly stopAcknowledged: boolean;
  readonly invocationRpcJoined: boolean;
  readonly fetchJoined: boolean;
  readonly callbackPortsJoined: boolean;
  readonly disposed: boolean;
}

interface PreparedProcessFacet extends HarnessProcessResumePreparedFacet {
  readonly handle: HarnessProcessHandle<HarnessProcessFacetInvokeInput>;
  readonly releasePlacementWriter: () => Promise<void>;
  activation?: Awaited<
    ReturnType<HarnessProcessHandle<HarnessProcessFacetInvokeInput>["activate"]>
  >;
  readonly preparedPublisher: {
    readonly generation: number;
    readonly facetNonce: string;
    readonly publisherKey: string;
  };
  bActivated: boolean;
  activationFailure?: unknown;
}

export interface HarnessProcessResumeHandoff {
  readonly beginDrain: (
    input: HarnessProcessResumeInput,
    durable: HarnessDurableState,
  ) => Promise<ResumeDrain>;
  readonly awaitDrain: (
    drain: ResumeDrain,
  ) => Promise<HarnessProcessResumeCheckpointOutcome<HarnessProcessResumeCheckpointReference>>;
  readonly retainOwnership: () => void;
}

export function createHarnessProcessResumePlacementDriver(input: {
  readonly operation: HarnessProcessResumeOperationInput;
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment & HarnessDurableStateBindings;
  readonly shardIncarnationNonce: string;
  readonly durable: HarnessDurableState;
  readonly handoff: HarnessProcessResumeHandoff;
}): HarnessProcessResumeDriver<
  ResumeDrain,
  HarnessProcessResumeCheckpointReference,
  PreparedProcessFacet,
  HarnessProcessResumePublicationResult,
  CleanupEvidence
> {
  const operation = input.operation;
  const { transition } = operation;
  let publicationResult: HarnessDurableStatePublicationResult | undefined;

  return {
    beginDrain: (resumeInput) =>
      effect("fence", () => input.handoff.beginDrain(resumeInput, input.durable)),
    awaitDrain: (drain) => effect("drain", () => input.handoff.awaitDrain(drain)),
    isCurrentControl: ({ control }) =>
      effect("drain", async () => {
        const current = await input.durable.threadSupervisor.execute({
          type: "read",
          runId: operation.runId,
          control,
        });
        return (
          current.snapshot.ownerId === control.ownerId &&
          current.snapshot.controlIncarnationId === control.incarnationId &&
          current.snapshot.controlEpoch === control.epoch
        );
      }),
    readNativeSessionId: ({ control }) =>
      effect("checkpoint", async () => {
        const current = await input.durable.threadSupervisor.execute({
          type: "read",
          runId: operation.runId,
          control,
        });
        return current.snapshot.nativeSessionId;
      }),
    verifyCheckpoint: ({ checkpoint, nativeSessionId }) =>
      effect("checkpoint", async () => {
        const current = await input.durable.threadSupervisor.execute({
          type: "read",
          runId: operation.runId,
          control: transition.nextControl,
        });
        if (
          current.snapshot.nativeSessionId !== nativeSessionId ||
          current.snapshot.checkpoint.checkpointId !== checkpoint.checkpointId ||
          current.snapshot.checkpoint.manifestSha256 !== checkpoint.manifestSha256 ||
          current.snapshot.admittedStepId !== null ||
          current.snapshot.lifecycle !== "stopped"
        )
          throw new Error("The durable checkpoint does not match the settled process.");
        const stored = await input.durable.filesStore.execute({
          type: "readCheckpoint",
          runId: operation.runId,
          publisher: transition.publisher,
          checkpointId: checkpoint.checkpointId,
        });
        if (
          stored.checkpoint.checkpointId !== checkpoint.checkpointId ||
          stored.checkpoint.manifestSha256 !== checkpoint.manifestSha256
        )
          throw new Error("The files store did not return the committed checkpoint bytes.");
      }),
    prepareInert: (prepare) =>
      effect("fresh-open", async () => {
        if (
          prepare.nativeSessionId !== prepare.checkpoint.nativeSessionId ||
          prepare.control.ownerId !== transition.nextControl.ownerId ||
          prepare.control.incarnationId !== transition.nextControl.incarnationId ||
          prepare.expectedFacetGeneration !== transition.expectedFacetGeneration
        )
          throw new Error("Fresh facet preparation lost its durable identity binding.");

        const process = {
          ...input.operation.facet,
          nativeSessionId: prepare.nativeSessionId,
          checkpointId: prepare.checkpoint.checkpointId,
          manifestRevision: prepare.checkpoint.manifestSha256,
          operationId: prepare.operationId,
          priorFacetNonce: prepare.publisher.facetNonce,
          expectedFacetGeneration: prepare.expectedFacetGeneration,
          facetEnv: {
            HARNESS_RESUME_RUN_ID: operation.runId,
            HARNESS_RESUME_CONTROL: transition.nextControl,
            HARNESS_RESUME_PUBLISHER: prepare.publisher,
            HARNESS_RUN_STORE: input.environment.HARNESS_RUN_STORE,
            HARNESS_FILES_STORE: input.environment.HARNESS_FILES_STORE,
            HARNESS_THREAD_SUPERVISOR: input.environment.HARNESS_THREAD_SUPERVISOR,
          },
        };
        const opened = await prepareHarnessProcessExecutionResumeFacet({
          runId: operation.runId,
          executionOperationId: transition.operationId,
          shardOwner: `resume/${operation.runId}`,
          controllerClaim: transition.nextControl,
          shardIndex: 0,
          process,
          context: input.context,
          environment: input.environment,
          shardIncarnationNonce: input.shardIncarnationNonce,
        });
        const observed = await opened.readLoadedPreparedRelease();
        const preparedRelease = observed as HarnessProcessResumePreparedRelease | undefined;
        const preparedPublisher = {
          generation: prepare.expectedFacetGeneration + 1,
          facetNonce: opened.handle.identity.incarnationNonce,
          // @effect-diagnostics-next-line cryptoRandomUUID:off - A publisher capability is per prepared facet.
          publisherKey: crypto.randomUUID().replaceAll("-", ""),
        };
        return {
          identity: {
            ...opened.handle.identity,
            ...(preparedRelease === undefined ? {} : { preparedRelease }),
          },
          handle: opened.handle,
          releasePlacementWriter: opened.releaseWriter,
          preparedPublisher,
          bActivated: false,
        };
      }),
    verifyPrepared: ({ prepared, checkpoint, nativeSessionId, targetPreparedRelease }) =>
      effect("fresh-verification", async () => {
        const current = await input.durable.threadSupervisor.execute({
          type: "read",
          runId: operation.runId,
          control: transition.nextControl,
        });
        const loaded = await prepared.handle.identity;
        if (
          loaded.incarnationNonce !== prepared.identity.incarnationNonce ||
          current.snapshot.nativeSessionId !== nativeSessionId ||
          current.snapshot.checkpoint.checkpointId !== checkpoint.checkpointId ||
          current.snapshot.checkpoint.manifestSha256 !== checkpoint.manifestSha256 ||
          current.snapshot.lifecycle !== "stopped" ||
          !sameRelease(prepared.identity.preparedRelease, targetPreparedRelease)
        )
          throw new Error("The fresh facet did not restore the target durable identity.");
      }),
    persistPrepared: ({ control, publisher, operationId, prepared, expectedFacetGeneration }) =>
      effect("fresh-verification", async () => {
        if (
          control.ownerId !== transition.nextControl.ownerId ||
          control.incarnationId !== transition.nextControl.incarnationId ||
          control.epoch !== transition.nextControl.epoch ||
          control.controlKey !== transition.nextControl.controlKey ||
          publisher.generation !== expectedFacetGeneration ||
          prepared.preparedPublisher.generation !== expectedFacetGeneration + 1 ||
          prepared.preparedPublisher.facetNonce !== prepared.identity.incarnationNonce
        )
          throw new Error("The prepared publisher does not match the settled process identity.");
        await input.durable.threadSupervisor.execute({
          type: "prepareFreshFacet",
          runId: operation.runId,
          control,
          publisher,
          expectedGeneration: expectedFacetGeneration,
          operationId,
          preparedPublisher: prepared.preparedPublisher,
        });
      }),
    publishFreshFacet: (publish) =>
      effect("publication", async () => {
        let activationFailure: unknown;
        const authority: HarnessProcessPublicationPublisher = {
          publishProcessFacet: async (request) => {
            if (
              request.operationId !== publish.operationId ||
              request.identity.incarnationNonce !== publish.prepared.identity.incarnationNonce ||
              request.nativeSessionId !== publish.nativeSessionId ||
              request.checkpointId !== publish.checkpoint.checkpointId ||
              request.manifestRevision !== publish.checkpoint.manifestSha256 ||
              request.expectedFacetGeneration !== publish.expectedFacetGeneration ||
              request.controllerClaim.controlKey !== transition.nextControl.controlKey
            )
              throw new Error("The process placement requested another durable publication.");
            publicationResult = await input.durable.publishFreshFacet({
              control: transition.nextControl,
              operationId: publish.operationId,
              verifiedNativeSessionId: publish.nativeSessionId,
              checkpoint: {
                checkpointId: publish.checkpoint.checkpointId,
                manifestSha256: publish.checkpoint.manifestSha256,
              },
            });
            if (publicationResult.status !== "published")
              throw new Error("Durable process publication remains pending.");
            return {
              publication: publicationResult,
              publisher: publicationResult.supervisor.currentPublisher,
              requestId: operation.previousStepId,
            };
          },
        };

        try {
          publish.prepared.activation = await publish.prepared.handle.activate(authority);
          publish.prepared.bActivated = true;
        } catch (cause) {
          activationFailure = cause;
          publish.prepared.activationFailure = cause;
        }
        if (publicationResult !== undefined) return publicationResult;
        throw (
          activationFailure ?? new Error("Process placement did not return a publication receipt.")
        );
      }),
    activate: ({ control, operationId, prepared }) =>
      effect("activation", async () => {
        if (prepared.activationFailure !== undefined) throw prepared.activationFailure;
        if (!prepared.bActivated)
          throw new Error("B has not activated the published process facet.");
        const activated = await input.durable.recordActivation({ control, operationId });
        if (activated.status !== "accepting")
          throw new Error("Durable process activation remains pending.");
      }),
    cleanupPrepared: (prepared) =>
      effect("cleanup", async () => {
        const stopped = await prepared.handle.stop();
        const joined = await prepared.handle.join();
        const complete = stopped.acknowledged && allJoined(joined);
        const evidence = {
          stopAcknowledged: stopped.acknowledged,
          invocationRpcJoined: joined.invocationRpc,
          fetchJoined: joined.fetch,
          callbackPortsJoined: joined.ports,
          disposed: false as boolean,
        };
        if (!complete) {
          input.handoff.retainOwnership();
          return { _tag: "incomplete", evidence };
        }
        try {
          await prepared.handle.cleanup();
          evidence.disposed = true;
          await prepared.releasePlacementWriter();
          return { _tag: "complete", evidence };
        } catch {
          input.handoff.retainOwnership();
          return { _tag: "incomplete", evidence };
        }
      }),
    recordFailure: (failure) =>
      effect(
        "recovery",
        async () => await recordFailure(input.durable, operation.runId, transition, failure),
      ),
  };
}

async function recordFailure(
  durable: HarnessDurableState,
  runId: string,
  transition: HarnessProcessResumeInput,
  input: Parameters<
    HarnessProcessResumeDriver<
      ResumeDrain,
      HarnessProcessResumeCheckpointReference,
      PreparedProcessFacet,
      HarnessProcessResumePublicationResult,
      CleanupEvidence
    >["recordFailure"]
  >[0],
): Promise<HarnessProcessResumeRecovery> {
  let current;
  try {
    current = await durable.threadSupervisor.execute({
      type: "read",
      runId,
      control: transition.nextControl,
    });
  } catch {
    return "claim-changed";
  }

  if (
    (current.snapshot.lifecycle === "published" ||
      current.snapshot.lifecycle === "activation-failed" ||
      current.snapshot.lifecycle === "accepting") &&
    current.snapshot.lastPublicationOperationId === input.operationId
  ) {
    try {
      await durable.recordActivationFailure({
        control: transition.nextControl,
        operationId: input.operationId,
        failure: { kind: input.reason, message: "Process resume activation failed." },
      });
      return "recorded";
    } catch {
      return "record-failed";
    }
  }

  if (
    current.snapshot.lifecycle === "preparing" &&
    current.snapshot.preparedFacet?.operationId === input.operationId &&
    input.cleanup !== null
  ) {
    try {
      const failure: HarnessDurableStateFailureInput = {
        control: transition.nextControl,
        operationId: input.operationId,
        phase: "prepare",
        failure: { kind: input.reason, message: "Fresh facet preparation failed." },
        cleanup: {
          stopAcknowledged: input.cleanup.evidence.stopAcknowledged,
          invocationRpcJoined: input.cleanup.evidence.invocationRpcJoined,
          fetchJoined: input.cleanup.evidence.fetchJoined,
          callbackPortsJoined: input.cleanup.evidence.callbackPortsJoined,
          disposed: input.cleanup.evidence.disposed,
        },
      };
      await durable.recordPreparedFacetFailure(failure);
      return "recorded";
    } catch {
      return "record-failed";
    }
  }

  if (
    current.snapshot.lifecycle === "indeterminate" ||
    (current.snapshot.lifecycle === "stopped" && input.prepared === undefined)
  )
    return "recorded";

  if (input.publication !== undefined && input.publication.status !== "published")
    return "recorded";
  return "not-recorded";
}

function effect<A>(
  operation: HarnessProcessResumeDriverError["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, HarnessProcessResumeDriverError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new HarnessProcessResumeDriverError({ operation, cause }),
  });
}

function sameRelease(
  left: HarnessProcessResumePreparedRelease | undefined,
  right: HarnessProcessResumePreparedRelease,
): boolean {
  if (left === undefined) return false;
  return (
    left.artifact.provider === right.artifact.provider &&
    left.artifact.releaseId === right.artifact.releaseId &&
    left.artifact.artifactHash === right.artifact.artifactHash &&
    left.artifact.artifactRef === right.artifact.artifactRef &&
    left.artifact.sourceIdentity === right.artifact.sourceIdentity &&
    left.artifact.fixtureIdentity === right.artifact.fixtureIdentity &&
    left.artifact.createdAt === right.artifact.createdAt &&
    JSON.stringify(left.plan.release) === JSON.stringify(right.plan.release) &&
    left.plan.sourceIdentity === right.plan.sourceIdentity &&
    left.plan.computer.sourceIdentity === right.plan.computer.sourceIdentity &&
    left.plan.computer.manifestSha256 === right.plan.computer.manifestSha256 &&
    JSON.stringify(left.plan.preparedModules) === JSON.stringify(right.plan.preparedModules)
  );
}

function allJoined(joined: {
  readonly invocationRpc: boolean;
  readonly fetch: boolean;
  readonly ports: boolean;
}) {
  return joined.invocationRpc && joined.fetch && joined.ports;
}
