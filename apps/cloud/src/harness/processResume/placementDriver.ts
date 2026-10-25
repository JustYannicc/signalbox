import type {
  HarnessDurableState,
  HarnessDurableStateBindings,
  HarnessDurableStateDrainResult,
  HarnessDurableStatePublicationResult,
} from "../HarnessDurableState.ts";
import type { HarnessRunStoreResult } from "../HarnessRunStore.ts";
import type { HarnessThreadSupervisorPublisher } from "../HarnessThreadSupervisor.ts";
import type {
  HarnessProcessHandle,
  HarnessProcessPublicationPublisher,
  HarnessProcessPublishedActivation,
} from "../HarnessProcessPlacement.ts";
import type { HarnessProcessFacetInvokeInput } from "../HarnessProcessFacet.ts";
import type {
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionSupervisorClient,
} from "../processPlacement/execution.ts";
import { prepareHarnessProcessExecutionResumeFacet } from "../processPlacement/execution.ts";
import type {
  HarnessProcessResumeCheckpointOutcome,
  HarnessProcessResumeCheckpointReference,
  HarnessProcessResumeDriver,
  HarnessProcessResumeInput,
  HarnessProcessResumeOperationInput,
  HarnessProcessResumePreparedFacet,
  HarnessProcessResumePublicationResult,
} from "./contracts.ts";
import { samePreparedRelease, snapshotPreparedRelease } from "./identity.ts";
import type { HarnessProcessResumePreDrainSnapshot } from "./terminalEvidence.ts";
import { replaceHarnessProcessResumeRunStoreFacet } from "./runStore.ts";
import { authorizePublication, sameControl } from "./authority.ts";
import { ownedPromise } from "./ownedEffect.ts";
import type {
  HarnessProcessResumeDurableRecord,
  HarnessProcessResumePlacementPin,
} from "./durableState.ts";

interface ResumeDrain {
  readonly preDrain: HarnessProcessResumePreDrainSnapshot;
  readonly result: HarnessDurableStateDrainResult;
  runStoreResult?: HarnessRunStoreResult;
}
interface CleanupEvidence {
  readonly stopAcknowledged: boolean;
  readonly invocationRpcJoined: boolean;
  readonly fetchJoined: boolean;
  readonly callbackPortsJoined: boolean;
  readonly disposed: boolean;
}
export interface HarnessProcessResumePreparedFacetInstance extends HarnessProcessResumePreparedFacet {
  readonly handle: HarnessProcessHandle<HarnessProcessFacetInvokeInput>;
  readonly releasePlacementWriter: () => Promise<void>;
  readonly preparedPublisher: HarnessThreadSupervisorPublisher;
  activation?: Awaited<
    ReturnType<HarnessProcessHandle<HarnessProcessFacetInvokeInput>["activate"]>
  >;
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
  readonly shard: HarnessProcessResumePlacementPin;
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment & HarnessDurableStateBindings;
  readonly durable: HarnessDurableState;
  readonly handoff: HarnessProcessResumeHandoff;
  readonly controller: AbortController;
  readonly save: (
    changes: Partial<
      Pick<HarnessProcessResumeDurableRecord, "phase" | "prepared" | "publication" | "failure">
    >,
  ) => Promise<void>;
}): HarnessProcessResumeDriver<
  ResumeDrain,
  HarnessProcessResumeCheckpointReference,
  HarnessProcessResumePreparedFacetInstance,
  HarnessProcessResumePublicationResult,
  CleanupEvidence
> {
  const { operation, durable, controller } = input;
  const { transition } = operation;
  const check = () => controller.signal.throwIfAborted();
  const effect = <A>(
    stage: Parameters<typeof ownedPromise>[0],
    run: () => Promise<A>,
    allowCancelled = false,
  ) => ownedPromise(stage, controller, run, allowCancelled);
  let publicationResult: HarnessDurableStatePublicationResult | undefined;
  const authorityRead: HarnessProcessExecutionSupervisorClient = {
    execute: (command) => durable.threadSupervisor.execute(command),
    publishProcessFacet: async () => {
      throw new Error("Resume publication is owned by the prepared transition.");
    },
    authorizeProcessFacetActivation: async () => {
      throw new Error("Resume authorization is owned by the prepared transition.");
    },
    reconcileProcessFacetPublication: async (request) => {
      await durable.threadSupervisor.execute({
        type: "read",
        runId: operation.runId,
        control: request.controllerClaim,
      });
      return { status: "unknown" };
    },
  };
  return {
    beginDrain: (request) => effect("fence", () => input.handoff.beginDrain(request, durable)),
    awaitDrain: (drain) => effect("drain", () => input.handoff.awaitDrain(drain)),
    isCurrentControl: ({ control }) =>
      effect(
        "drain",
        async () => {
          const current = await durable.threadSupervisor.execute({
            type: "read",
            runId: operation.runId,
            control,
          });
          return (
            current.snapshot.ownerId === control.ownerId &&
            current.snapshot.controlEpoch === control.epoch &&
            current.snapshot.controlIncarnationId === control.incarnationId
          );
        },
        true,
      ),
    readNativeSessionId: ({ control }) =>
      effect(
        "checkpoint",
        async () =>
          (
            await durable.threadSupervisor.execute({
              type: "read",
              runId: operation.runId,
              control,
            })
          ).snapshot.nativeSessionId,
      ),
    verifyCheckpoint: ({ checkpoint, nativeSessionId }) =>
      effect("checkpoint", async () => {
        const current = await durable.threadSupervisor.execute({
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
        const stored = await durable.filesStore.execute({
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
        check();
        const process = {
          ...operation.facet,
          nativeSessionId: prepare.nativeSessionId,
          checkpointId: prepare.checkpoint.checkpointId,
          manifestRevision: prepare.checkpoint.manifestSha256,
          operationId: prepare.operationId,
          priorFacetNonce: prepare.publisher.facetNonce,
          expectedFacetGeneration: prepare.expectedFacetGeneration,
          runStorePublisher: {
            generation: operation.runStore.currentPublisher.generation + 1,
            publisherKey: operation.runStore.nextPublisherKey,
          },
          facetEnv: {
            HARNESS_RESUME_RUN_ID: operation.runId,
            HARNESS_RESUME_CONTROL: transition.nextControl,
            HARNESS_RESUME_PUBLISHER: prepare.publisher,
            HARNESS_RESUME_RUN_STORE: input.environment.HARNESS_RUN_STORE.getByName(
              operation.runId,
            ),
            HARNESS_RESUME_FILES_STORE: input.environment.HARNESS_FILES_STORE.getByName(
              operation.runId,
            ),
            HARNESS_RESUME_SUPERVISOR: input.environment.HARNESS_THREAD_SUPERVISOR.getByName(
              operation.runId,
            ),
          },
        };
        const opened = await prepareHarnessProcessExecutionResumeFacet({
          runId: operation.runId,
          executionOperationId: input.shard.executionOperationId,
          shardOwner: input.shard.shardOwner,
          placementOwner: input.shard.owner,
          controllerClaim: transition.nextControl,
          shardIndex: input.shard.shardIndex,
          process,
          context: input.context,
          environment: input.environment,
          shardIncarnationNonce: input.shard.shardIncarnationNonce,
          signal: controller.signal,
          authority: authorityRead,
        });
        const observed = await opened.readLoadedPreparedRelease();
        const preparedRelease = snapshotPreparedRelease(
          observed as Parameters<typeof snapshotPreparedRelease>[0],
        );
        return {
          identity: {
            ...opened.handle.identity,
            ...(preparedRelease === undefined ? {} : { preparedRelease }),
          },
          handle: opened.handle,
          releasePlacementWriter: opened.releaseWriter,
          preparedPublisher: {
            generation: prepare.expectedFacetGeneration + 1,
            facetNonce: opened.handle.identity.incarnationNonce,
            // @effect-diagnostics-next-line cryptoRandomUUID:off - each prepared A publisher receives a fresh capability.
            publisherKey: crypto.randomUUID().replaceAll("-", ""),
          },
          bActivated: false,
        };
      }),
    verifyPrepared: ({ prepared, checkpoint, nativeSessionId, targetPreparedRelease }) =>
      effect("fresh-verification", async () => {
        const current = await durable.threadSupervisor.execute({
          type: "read",
          runId: operation.runId,
          control: transition.nextControl,
        });
        if (
          current.snapshot.nativeSessionId !== nativeSessionId ||
          current.snapshot.checkpoint.checkpointId !== checkpoint.checkpointId ||
          current.snapshot.checkpoint.manifestSha256 !== checkpoint.manifestSha256 ||
          current.snapshot.lifecycle !== "stopped" ||
          !samePreparedRelease(prepared.identity.preparedRelease, targetPreparedRelease)
        )
          throw new Error("The fresh facet did not restore the selected release and checkpoint.");
        check();
      }),
    persistPrepared: (prepared) =>
      effect("fresh-verification", async () => {
        const observed = prepared.prepared.identity.preparedRelease;
        if (
          observed === undefined ||
          !samePreparedRelease(observed, prepared.targetPreparedRelease) ||
          !sameControl(prepared.control, transition.nextControl)
        )
          throw new Error("The complete observed target is required before prepared persistence.");
        check();
        await input.save({
          phase: "prepared",
          prepared: {
            requested: prepared.targetPreparedRelease,
            observed,
            publisher: prepared.prepared.preparedPublisher,
            identity: prepared.prepared.identity,
            checkpoint: prepared.checkpoint,
          },
        });
        check();
        await durable.threadSupervisor.execute({
          type: "prepareFreshFacet",
          runId: operation.runId,
          control: prepared.control,
          publisher: prepared.publisher,
          expectedGeneration: prepared.expectedFacetGeneration,
          operationId: prepared.operationId,
          preparedPublisher: prepared.prepared.preparedPublisher,
        });
      }),
    publishFreshFacet: (publish) =>
      effect("publication", async () => {
        check();
        await input.save({ phase: "publication-attempted" });
        check();
        const authority: HarnessProcessPublicationPublisher<HarnessProcessPublishedActivation> = {
          publishProcessFacet: async (request) => {
            check();
            if (
              request.operationId !== publish.operationId ||
              request.identity.incarnationNonce !== publish.prepared.identity.incarnationNonce ||
              request.nativeSessionId !== publish.nativeSessionId ||
              request.checkpointId !== publish.checkpoint.checkpointId ||
              request.manifestRevision !== publish.checkpoint.manifestSha256 ||
              request.expectedFacetGeneration !== publish.expectedFacetGeneration ||
              !sameControl(request.controllerClaim, transition.nextControl)
            )
              throw new Error("B requested another process publication.");
            publicationResult = await durable.publishFreshFacet({
              control: transition.nextControl,
              operationId: publish.operationId,
              verifiedNativeSessionId: publish.nativeSessionId,
              checkpoint: {
                checkpointId: publish.checkpoint.checkpointId,
                manifestSha256: publish.checkpoint.manifestSha256,
              },
            });
            await input.save({
              phase:
                publicationResult.status === "published" ? "published" : "publication-attempted",
              publication: publicationResult,
            });
            if (publicationResult.status !== "published")
              throw new Error("Durable publication remains pending.");
            check();
            return {
              publication: publicationResult,
              publisher: {
                generation: publish.prepared.preparedPublisher.generation,
                facetNonce: publish.prepared.identity.incarnationNonce,
                publisherKey: operation.runStore.nextPublisherKey,
              },
              requestMode: "awaiting-next-request",
            };
          },
          authorizeProcessFacetActivation: async (request, receipt) => {
            check();
            if (
              publicationResult?.status !== "published" ||
              publicationResult.receipt !== receipt ||
              publish.drain.runStoreResult === undefined
            )
              throw new Error("B activation has no exact publication and journal receipts.");
            await replaceHarnessProcessResumeRunStoreFacet({
              store: durable.runStore,
              operation,
              expectedJournal: publish.drain.runStoreResult,
              checkpoint: publish.checkpoint,
              preparedFacetNonce: publish.prepared.identity.incarnationNonce,
              publication: publicationResult,
            });
            check();
            await authorizePublication({
              durable,
              runId: operation.runId,
              publication: publicationResult,
              request,
              lifecycle: "published",
            });
            check();
          },
        };
        try {
          publish.prepared.activation = await publish.prepared.handle.activate(authority);
          publish.prepared.bActivated = true;
        } catch (cause) {
          publish.prepared.activationFailure = cause;
        }
        if (publicationResult !== undefined) return publicationResult;
        throw publish.prepared.activationFailure ?? new Error("B returned no publication result.");
      }),
    activate: ({ control, operationId, prepared }) =>
      effect("activation", async () => {
        if (prepared.activationFailure !== undefined) throw prepared.activationFailure;
        if (!prepared.bActivated) throw new Error("B has not activated this process.");
        check();
        const result = await durable.recordActivation({ control, operationId });
        if (result.status !== "accepting") throw new Error("A activation is pending.");
        check();
        await input.save({ phase: "active" });
      }),
    cleanupPrepared: (prepared) =>
      effect(
        "cleanup",
        async () => {
          const stopped = await prepared.handle.stop();
          const joined = await prepared.handle.join();
          const evidence = {
            stopAcknowledged: stopped.acknowledged,
            invocationRpcJoined: joined.invocationRpc,
            fetchJoined: joined.fetch,
            callbackPortsJoined: joined.ports,
            disposed: false,
          };
          if (
            controller.signal.aborted ||
            !stopped.acknowledged ||
            !joined.invocationRpc ||
            !joined.fetch ||
            !joined.ports
          ) {
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
        },
        true,
      ),
    recordFailure: (failure) =>
      effect(
        "recovery",
        async () => {
          input.handoff.retainOwnership();
          await input.save({
            phase: "retained",
            failure: { stage: failure.stage, reason: failure.reason },
          });
          const current = await durable.threadSupervisor.execute({
            type: "read",
            runId: operation.runId,
            control: transition.nextControl,
          });
          if (
            current.snapshot.lastPublicationOperationId === failure.operationId &&
            ["published", "activation-failed", "accepting"].includes(current.snapshot.lifecycle)
          ) {
            await durable.recordActivationFailure({
              control: transition.nextControl,
              operationId: failure.operationId,
              failure: {
                kind: failure.reason,
                message: "The process resume requires explicit repair.",
              },
            });
          } else if (current.snapshot.lifecycle === "preparing" && failure.cleanup !== null) {
            await durable.recordPreparedFacetFailure({
              control: transition.nextControl,
              operationId: failure.operationId,
              phase: "prepare",
              failure: {
                kind: failure.reason,
                message: "The prepared process requires explicit repair.",
              },
              cleanup: failure.cleanup.evidence,
            });
          }
          return "recorded" as const;
        },
        true,
      ),
  };
}
