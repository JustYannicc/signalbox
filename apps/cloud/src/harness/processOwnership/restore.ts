import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import { layerCrypto } from "../../platform.ts";
import type { HarnessDurableState, HarnessDurableStateBindings } from "../HarnessDurableState.ts";
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import type {
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionSupervisorClient,
} from "../processPlacement/execution.ts";
import { prepareHarnessProcessExecutionResumeFacet } from "../processPlacement/execution.ts";
import type { ResumedProcess } from "../processResume/resumeAttempt.ts";
import { samePreparedRelease, snapshotPreparedRelease } from "../processResume/identity.ts";
import { authorizePublication } from "../processResume/authority.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import type { Published } from "../processResume/authority.ts";
import type { ProcessIncarnation } from "./incarnation.ts";
import { processFacetStores } from "./bindings.ts";
import { creationPlacementKey } from "../processCreation/contracts.ts";
import type { HarnessProcessCreationPlacement } from "../processCreation/contracts.ts";
import { releaseCreationPlacement } from "../processCreation/releasePlacement.ts";
import { retireEvictedPlacement } from "./retireEvictedPlacement.ts";
import { processBoundaryKey, validateProcessBoundary, type ProcessBoundary } from "./boundary.ts";

export async function retireEvictedBoundary(input: {
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment & HarnessDurableStateBindings;
  readonly incarnation: ProcessIncarnation;
  readonly boundary: ProcessBoundary;
  readonly durable: HarnessDurableState;
  readonly operationId: string;
}) {
  const { boundary, incarnation, durable } = input;
  const { currentFence } = await validateProcessBoundary({
    storage: input.context.storage,
    incarnation,
    boundary,
    durable,
  });
  if (
    currentFence.incarnation <= boundary.fence.incarnation ||
    currentFence.nonce === boundary.fence.nonce
  )
    throw new Error("A live parent cannot retire its own native process as evicted.");
  await durable.retireEvictedFacet({
    control: boundary.control,
    publisher: boundary.prepared.preparedPublisher,
    expectedGeneration: boundary.requestPublisher.generation,
    checkpoint: {
      checkpointId: boundary.checkpoint.native.id,
      manifestSha256: boundary.checkpoint.filesystem.sha256,
    },
    nativeSessionId: boundary.nativeSessionId,
    sourceFence: boundary.fence,
    currentFence,
    operationId: input.operationId,
  });
  if (boundary.publication === undefined) {
    const key = creationPlacementKey(boundary.runId);
    const placement = await input.context.storage.get<HarnessProcessCreationPlacement>(key);
    if (
      !placement ||
      !sameData(placement.identity, boundary.prepared.identity) ||
      placement.writer.shardIncarnationNonce !== boundary.fence.nonce ||
      placement.operationId !== boundary.callerOperationId
    )
      throw new Error("Evicted creation does not match its durable placement.");
    input.context.facets.abort(
      placement.lease.loaderId,
      "The fenced creation parent was destroyed.",
    );
    input.context.facets.delete(placement.lease.loaderId);
    await releaseCreationPlacement(input.context, input.environment, currentFence.nonce, {
      ...placement,
      termination: { kind: "parent-destroyed", observedByIncarnationNonce: currentFence.nonce },
    });
  } else {
    await retireEvictedPlacement({
      context: input.context,
      environment: input.environment,
      incarnation,
      source: {
        fence: boundary.fence,
        placement: boundary.placement,
        identity: boundary.prepared.identity,
        processId: boundary.process.processId,
        control: boundary.control,
      },
    });
  }
  return currentFence;
}

/** An idle heap is disposable. Only a verified checkpoint and a new publication survive it. */
export async function restoreEvictedProcess(input: {
  readonly context: DurableObjectState;
  readonly environment: HarnessProcessExecutionEnvironment & HarnessDurableStateBindings;
  readonly incarnation: ProcessIncarnation;
  readonly boundary: ProcessBoundary;
}) {
  const { boundary, context, environment, incarnation } = input;
  const durable = createHarnessDurableState(environment, boundary.runId);
  const { currentFence, journal } = await validateProcessBoundary({
    storage: context.storage,
    incarnation,
    boundary,
    durable,
  });
  if (
    currentFence.incarnation <= boundary.fence.incarnation ||
    currentFence.nonce === boundary.fence.nonce
  )
    throw new Error("Eviction restore requires a strictly newer parent incarnation.");
  const target = boundary.process.targetPreparedRelease;
  const bootstrap = boundary.process.productBootstrap;
  if (!target || !bootstrap)
    throw new Error("The durable process boundary has no verified native release descriptor.");
  const started = performance.now();
  const operationId = `eviction-restore-${currentFence.incarnation}-${currentFence.nonce}`;
  const restoreKey = `harness-process-eviction/v1/${encodeURIComponent(boundary.runId)}/${operationId}`;
  await context.storage.transaction(async (transaction) => {
    await incarnation.assertCurrent();
    if (
      (await transaction.get(restoreKey)) !== undefined ||
      !sameData(await transaction.get(processBoundaryKey(boundary.runId)), boundary)
    )
      throw new Error("Another transition owns this eviction restore.");
    await transaction.put(restoreKey, {
      version: 1,
      phase: "reserved",
      source: boundary,
      currentFence,
    });
    await transaction.put(processBoundaryKey(boundary.runId), { ...boundary, phase: "restoring" });
  });
  try {
    await retireEvictedBoundary({ ...input, durable, operationId });
    const publisherKey = (
      await Effect.runPromise(
        Crypto.Crypto.use((service) => service.randomUUIDv4()).pipe(Effect.provide(layerCrypto)),
      )
    ).replaceAll("-", "");
    const process: ResumedProcess["process"] = {
      ...boundary.process,
      productBootstrap: { ...bootstrap, restoreMode: "same-variant-serialized-checkpoint" },
      targetPreparedRelease: target,
      operationId,
      checkpointId: boundary.checkpoint.native.id,
      manifestRevision: boundary.checkpoint.filesystem.sha256,
      priorFacetNonce: boundary.prepared.identity.incarnationNonce,
      expectedFacetGeneration: boundary.requestPublisher.generation,
      runStorePublisher: { generation: boundary.requestPublisher.generation + 1, publisherKey },
      resumeFacetEnv: {
        HARNESS_RESUME_RUN_ID: boundary.runId,
        HARNESS_RESUME_CONTROL: boundary.control,
        HARNESS_RESUME_PUBLISHER: boundary.prepared.preparedPublisher,
        ...(await processFacetStores(environment, boundary.runId)),
      },
    };
    const authority: HarnessProcessExecutionSupervisorClient = {
      execute: (command) => durable.threadSupervisor.execute(command),
      publishProcessFacet: async () => {
        throw new Error("Eviction restore owns publication.");
      },
      authorizeProcessFacetActivation: async () => {
        throw new Error("Eviction restore owns activation.");
      },
      reconcileProcessFacetPublication: async () => ({ status: "unknown" }),
    };
    const opened = await prepareHarnessProcessExecutionResumeFacet({
      runId: boundary.runId,
      executionOperationId: boundary.placement.executionOperationId,
      shardOwner: boundary.placement.shardOwner,
      placementOwner: boundary.placement.owner,
      controllerClaim: boundary.control,
      shardIndex: boundary.placement.shardIndex,
      process,
      context,
      environment,
      shardIncarnationNonce: currentFence.nonce,
      signal: new AbortController().signal,
      authority,
    });
    const observed = snapshotPreparedRelease(
      (await opened.readLoadedPreparedRelease()) as typeof target,
    );
    if (
      !observed ||
      !samePreparedRelease(observed, target) ||
      opened.handle.identity.incarnationNonce === boundary.prepared.identity.incarnationNonce
    )
      throw new Error(
        "The restored native process did not prove a fresh identity and exact release.",
      );
    const preparedPublisher = {
      generation: boundary.requestPublisher.generation + 1,
      facetNonce: opened.handle.identity.incarnationNonce,
      publisherKey: (
        await Effect.runPromise(
          Crypto.Crypto.use((service) => service.randomUUIDv4()).pipe(Effect.provide(layerCrypto)),
        )
      ).replaceAll("-", ""),
    };
    await context.storage.put(restoreKey, {
      version: 1,
      phase: "prepared",
      source: boundary,
      currentFence,
      identity: opened.handle.identity,
      preparedPublisher,
      observed,
    });
    await durable.threadSupervisor.execute({
      type: "prepareFreshFacet",
      runId: boundary.runId,
      control: boundary.control,
      publisher: boundary.prepared.preparedPublisher,
      expectedGeneration: boundary.requestPublisher.generation,
      operationId,
      preparedPublisher,
    });
    let publication: Published | undefined;
    const publicationRequest = {
      identity: opened.handle.identity,
      controllerClaim: boundary.control,
      operationId,
      nativeSessionId: boundary.nativeSessionId,
      checkpointId: boundary.checkpoint.native.id,
      manifestRevision: boundary.checkpoint.filesystem.sha256,
      priorFacetNonce: boundary.prepared.identity.incarnationNonce,
      expectedFacetGeneration: boundary.requestPublisher.generation,
    };
    await opened.handle.activate({
      publishProcessFacet: async () => {
        const result = await durable.publishFreshFacet({
          control: boundary.control,
          operationId,
          verifiedNativeSessionId: boundary.nativeSessionId,
          checkpoint: {
            checkpointId: boundary.checkpoint.native.id,
            manifestSha256: boundary.checkpoint.filesystem.sha256,
          },
        });
        if (result.status !== "published")
          throw new Error("Eviction publication remains uncertain.");
        publication = result;
        await context.storage.put(restoreKey, {
          version: 1,
          phase: "published",
          source: boundary,
          currentFence,
          publication,
        });
        return {
          publication,
          publisher: { ...preparedPublisher, publisherKey },
          requestMode: "awaiting-next-request" as const,
        };
      },
      authorizeProcessFacetActivation: async () => {
        if (!publication) throw new Error("Eviction activation has no confirmed publication.");
        const replaced = await durable.runStore.execute({
          type: "request.replaceFacet",
          runId: boundary.runId,
          controlKey: boundary.runStore.controlKey,
          expectedGeneration: boundary.requestPublisher.generation,
          operationId,
          facetNonce: opened.handle.identity.incarnationNonce,
          publisherKey,
        });
        if (
          replaced.action !== "recorded" ||
          !sameData(replaced.snapshot.requests?.entries, journal.snapshot.requests?.entries) ||
          !sameData(replaced.snapshot.requests?.checkpoint, boundary.checkpoint) ||
          !sameData(replaced.snapshot.supervisor, journal.snapshot.supervisor)
        )
          throw new Error(
            "Eviction restore changed the conversation or committed workspace cursor.",
          );
        await authorizePublication({
          durable,
          runId: boundary.runId,
          publication,
          request: publicationRequest,
          lifecycle: "published",
        });
      },
    });
    if (!publication) throw new Error("Eviction restore returned no publication.");
    const activation = await durable.recordActivation({ control: boundary.control, operationId });
    if (activation.status !== "accepting")
      throw new Error("Eviction activation remains incomplete.");
    await authorizePublication({
      durable,
      runId: boundary.runId,
      publication,
      request: publicationRequest,
      lifecycle: "accepting",
    });
    const { resumeFacetEnv: _bindings, ...serializableProcess } = process;
    const resumed: ResumedProcess = {
      runId: boundary.runId,
      operationId,
      // RPC bindings belong to this incarnation and are never serialized into the next boundary.
      process: serializableProcess,
      control: boundary.control,
      runStore: boundary.runStore,
      requestPublisher: { ...preparedPublisher, publisherKey },
      prepared: {
        identity: { ...opened.handle.identity, preparedRelease: observed },
        handle: opened.handle,
        releasePlacementWriter: opened.releaseWriter,
        preparedPublisher,
        bActivated: true,
      },
      publication,
      nativeSessionId: boundary.nativeSessionId,
      checkpoint: boundary.checkpoint,
      placement: { ...boundary.placement, shardIncarnationNonce: currentFence.nonce },
    };
    const next: ProcessBoundary = {
      ...boundary,
      ...resumed,
      phase: "ready",
      fence: currentFence,
      prepared: { identity: opened.handle.identity, preparedPublisher },
    };
    const durationMs = performance.now() - started;
    const countKey = `harness-eviction-restores/v1/${encodeURIComponent(boundary.threadId)}`;
    let restoreCount = 0;
    await context.storage.transaction(async (transaction) => {
      await incarnation.assertCurrent();
      restoreCount = ((await transaction.get<number>(countKey)) ?? 0) + 1;
      await transaction.put(countKey, restoreCount);
      await transaction.put(restoreKey, {
        version: 1,
        phase: "active",
        source: boundary,
        currentFence,
        publication,
        durationMs,
        restoreCount,
      });
      await transaction.put(processBoundaryKey(boundary.runId), next);
    });
    await Effect.runPromise(
      Effect.log({
        type: "harness.eviction.restore",
        threadId: boundary.threadId,
        runId: boundary.runId,
        processId: process.processId,
        executionOperationId: boundary.placement.executionOperationId,
        restoreCount,
        durationMs,
        checkpointId: boundary.checkpoint.native.id,
        status: "restored",
        from: {
          incarnationNonce: boundary.prepared.identity.incarnationNonce,
          generation: boundary.requestPublisher.generation,
        },
        to: {
          incarnationNonce: preparedPublisher.facetNonce,
          generation: preparedPublisher.generation,
        },
      }),
    );
    return { resumed, boundary: next };
  } catch (cause) {
    await context.storage.put(processBoundaryKey(boundary.runId), {
      ...boundary,
      phase: "retained",
    });
    throw cause;
  }
}
