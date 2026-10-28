// @effect-diagnostics nodeBuiltinImport:off globalFetch:off cryptoRandomUUID:off - This fixture exercises the real Workerd DO transport.
import * as Effect from "effect/Effect";
export { HarnessProcessStoreBinding } from "../../HarnessProcessStoreBinding.ts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { dataForDriver } from "../../adapter/tests/data.ts";
import { createHarnessDurableState } from "../../HarnessDurableState.ts";
import { HarnessProcessExecutionShardObject } from "../../HarnessProcessExecutionShardObject.ts";
import type {
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionShardInput,
  HarnessProcessPlacementIdentity,
} from "../../HarnessProcessPlacement.ts";
import { deterministicShardOwner } from "../../HarnessProcessPlacement.ts";
import { HarnessThreadSupervisorObject } from "../../HarnessThreadSupervisorObject.ts";
import type { HarnessRequestCheckpoint, HarnessRequestOffer } from "../../HarnessRunStore.ts";
import type {
  HarnessRunInitialization,
  HarnessDurableStateBindings,
} from "../../HarnessDurableState.ts";
import type { HarnessProcessCreationInput } from "../../HarnessProcessCreation.ts";
import { creationPlacementKey } from "../../HarnessProcessCreation.ts";
import type { HarnessProcessCreationRecoveryInput } from "../../HarnessProcessCreation.ts";
import { reference } from "../../processResume/tests/releaseMaterial.ts";
import type { ColdCreationPlacementStore } from "./processCreationStores.fixture.ts";
import {
  ColdCreationFilesStore,
  ColdCreationPlacementStore as PlacementStore,
} from "./processCreationStores.fixture.ts";
import type { ControlledCreationStore } from "./controlledCreationStore.fixture.ts";
import { ControlledCreationStore as CreationStore } from "./controlledCreationStore.fixture.ts";
import { ControlledCreationRunStore } from "./controlledCreationRunStore.fixture.ts";
import { loadControlledCodexRelease } from "./controlledRelease.fixture.ts";

type CreationWorkerEnv = Omit<
  HarnessProcessExecutionEnvironment,
  "PLACEMENT_STORES" | "HARNESS_FILES_STORE"
> &
  Omit<HarnessDurableStateBindings, "HARNESS_RUN_STORE" | "HARNESS_FILES_STORE"> & {
    readonly COLD_CREATION_FACET_SOURCE: string;
    readonly COLD_CREATION_STORE: DurableObjectNamespace<ControlledCreationStore>;
    readonly HARNESS_RUN_STORE: DurableObjectNamespace<ControlledCreationRunStore>;
    readonly HARNESS_FILES_STORE: DurableObjectNamespace<ColdCreationFilesStore>;
    readonly PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<ColdCreationShard>;
    readonly PLACEMENT_STORES: DurableObjectNamespace<ColdCreationPlacementStore>;
  };

export class ColdCreationShard extends HarnessProcessExecutionShardObject {
  constructor(ctx: DurableObjectState, env: CreationWorkerEnv) {
    super(ctx, {
      ...env,
      HARNESS_C_PRODUCT_CAPABILITIES: {
        "cold-creation-store": env.COLD_CREATION_STORE.getByName(
          "cold-creation",
        ) as unknown as Fetcher,
      },
    });
  }

  async loseNextCreationReplyAfterBind() {
    await this.ctx.storage.put("cold-creation/lose-next-create-reply", true);
  }

  override async startFreshProcess(
    input: Parameters<HarnessProcessExecutionShardObject["startFreshProcess"]>[0],
  ) {
    const result = await super.startFreshProcess(input);
    if (!(await this.ctx.storage.get("cold-creation/lose-next-create-reply"))) return result;
    await this.ctx.storage.delete("cold-creation/lose-next-create-reply");
    throw new Error("Injected lost reply after the initial identity was bound.");
  }

  abortIncarnation() {
    this.ctx.abort("Reconstruct the actual C execution incarnation.");
  }

  async creationPlacement(runId: string) {
    const record = await this.ctx.storage.get<{
      readonly owner: string;
      readonly lease: { readonly token: string; readonly loaderId: string };
      readonly identity?: {
        readonly incarnationNonce: string;
        readonly shardOwner: string;
        readonly loaderId: string;
      };
      readonly disposed?: true;
      readonly released?: true;
      readonly termination?:
        | { readonly kind: "disposed"; readonly facetNonce: string }
        | { readonly kind: "parent-destroyed"; readonly observedByIncarnationNonce: string };
    }>(creationPlacementKey(runId));
    if (record === undefined) return null;
    return {
      owner: record.owner,
      lease: record.lease,
      identity: record.identity ?? null,
      disposed: record.disposed === true,
      released: record.released === true,
      termination: record.termination ?? null,
    };
  }

  async terminalEvidence() {
    const entries = await this.ctx.storage.list<{
      readonly nativeSessionId: string;
      readonly identity: { readonly incarnationNonce: string };
      readonly stopped: boolean;
      readonly joined: {
        readonly invocationRpc: boolean;
        readonly fetch: boolean;
        readonly ports: boolean;
      };
      readonly request: { readonly requestId: string };
    }>({ prefix: "harness-process-terminal/v1/" });
    return [...entries.values()].map((entry) => ({
      nativeSessionId: entry.nativeSessionId,
      facetNonce: entry.identity.incarnationNonce,
      stopped: entry.stopped,
      joined: entry.joined,
      requestId: entry.request.requestId,
    }));
  }
}

export {
  ColdCreationFilesStore,
  ControlledCreationRunStore,
  HarnessThreadSupervisorObject,
  PlacementStore,
  CreationStore,
};

interface Setup {
  readonly runId: string;
  readonly ownerPrefix: string;
  readonly owner: string;
  readonly placementExecutionId: string;
  readonly input: HarnessProcessCreationInput;
}

function secret(label: string) {
  return `${label}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

async function setup(env: CreationWorkerEnv): Promise<Setup> {
  const runId = `cold-create-${crypto.randomUUID()}`;
  const ownerPrefix = `cold/${runId}`;
  const placementExecutionId = `placement-${runId}`;
  const owner = await deterministicShardOwner(ownerPrefix, placementExecutionId, 0);
  const release = await loadControlledCodexRelease();
  const data = await Effect.runPromise(dataForDriver(ProviderDriverKind.make("codex")));
  const seed = await reference(`seed-${runId}`, new TextEncoder().encode(runId));
  const claimId = `claim-${runId}`;
  const controllerClaim = {
    ownerId: claimId,
    incarnationId: secret("controller-incarnation"),
    epoch: 1,
    controlKey: secret("controller-control"),
  };
  const run: HarnessRunInitialization = {
    type: "initialize",
    seed: {
      identity: {
        runId,
        hostId: "cold-creation-workerd",
        threadId: data.threadId,
        logicalTurnId: `logical-${runId}`,
        filesystemId: `files-${runId}`,
      },
      locator: seed,
      config: seed,
      artifacts: [seed],
    },
    controlKey: secret("run-control"),
    supervisorKey: secret("run-supervisor"),
    claimId,
    requestId: `initialize-${runId}`,
  };
  const input: HarnessProcessCreationInput = {
    runId,
    operationId: `create-${runId}`,
    run,
    controllerClaim,
    publisherKey: secret("initial-publisher"),
    requestPublisherKey: secret("request-publisher"),
    requestModeId: `request-mode-${runId}`,
    facet: {
      processId: `process-${runId}`,
      codeId: release.artifact.releaseId,
      residentBytes: 1,
      mainModule: "controlledCreationFacet.mjs",
      modules: { "controlledCreationFacet.mjs": { js: env.COLD_CREATION_FACET_SOURCE } },
      entrypoint: "ControlledCreationFacet",
      productBootstrap: {
        provider: "codex",
        preparedReleaseId: release.artifact.releaseId,
        restoreMode: "same-variant-serialized-checkpoint",
      },
      targetPreparedRelease: release,
    },
  };
  return { runId, ownerPrefix, owner, placementExecutionId, input };
}

async function offer(env: CreationWorkerEnv, setup: Setup, suffix: string) {
  const requestId = `request-${suffix}-${setup.runId}`;
  const artifact = await env.COLD_CREATION_STORE.getByName("cold-creation").putArtifact(
    `input-${requestId}`,
    new TextEncoder().encode(
      JSON.stringify({ runId: setup.runId, requestId, prompt: "Run one controlled request." }),
    ),
  );
  return { requestId, offer: { requestId, input: artifact } satisfies HarnessRequestOffer };
}

async function commitRequest(input: {
  readonly env: CreationWorkerEnv;
  readonly setup: Setup;
  readonly shard: Pick<ColdCreationShard, "commitProcessCheckpoint">;
  readonly request: { readonly requestId: string; readonly offer: HarnessRequestOffer };
  readonly processOperationId: string;
  readonly executionOperationId: string;
  readonly nativeSessionId: string;
  readonly control: HarnessProcessCreationInput["controllerClaim"];
  readonly running: Promise<unknown>;
}) {
  const runStore = input.env.HARNESS_RUN_STORE.getByName(input.setup.runId);
  await Promise.race([
    runStore.waitForFinish(input.request.requestId),
    input.running.then((result) => {
      throw new Error(
        `The controlled process ended before its request finished: ${JSON.stringify(result)}`,
      );
    }),
  ]);
  const checkpoint = await input.env.COLD_CREATION_STORE.getByName("cold-creation").material(
    input.request.requestId,
  );
  const durable = createHarnessDurableState(input.env, input.setup.runId);
  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId: input.setup.runId,
    control: input.control,
  });
  return await input.shard.commitProcessCheckpoint({
    runId: input.setup.runId,
    processId: input.setup.input.facet.processId,
    executionOperationId: input.executionOperationId,
    processOperationId: input.processOperationId,
    requestId: input.request.requestId,
    nativeSessionId: input.nativeSessionId,
    control: input.control,
    publisher: current.currentPublisher,
    checkpoint,
  });
}

type BoundCreation = {
  readonly status: "bound" | "created";
  readonly identity: HarnessProcessPlacementIdentity;
  readonly nativeSessionId: string;
  readonly checkpoint: HarnessRequestCheckpoint;
};

async function runNativeJournalRestore(input: {
  readonly env: CreationWorkerEnv;
  readonly setup: Setup;
  readonly shard: Pick<ColdCreationShard, "runShard" | "commitProcessCheckpoint">;
  readonly request: Awaited<ReturnType<typeof offer>>;
  readonly bound: BoundCreation;
  readonly nextControl: HarnessProcessCreationInput["controllerClaim"];
}) {
  const durable = createHarnessDurableState(input.env, input.setup.runId);
  const restoreOperationId = `strict-restore-${input.setup.runId}`;
  const publisher = {
    generation: 1,
    facetNonce: input.bound.identity.incarnationNonce,
    publisherKey: input.setup.input.publisherKey,
  };
  const requestPublisher = {
    generation: 1,
    facetNonce: input.bound.identity.incarnationNonce,
    publisherKey: input.setup.input.requestPublisherKey,
  };
  const process: HarnessProcessExecutionShardInput["processes"][number] = {
    ...input.setup.input.facet,
    nativeSessionId: input.bound.nativeSessionId,
    checkpointId: input.bound.checkpoint.native.id,
    manifestRevision: input.bound.checkpoint.filesystem.sha256,
    operationId: restoreOperationId,
    priorFacetNonce: input.bound.identity.incarnationNonce,
    expectedFacetGeneration: 1,
    journal: {
      publisher,
      runStore: {
        runId: input.setup.runId,
        processId: input.setup.input.facet.processId,
        processOperationId: input.setup.input.operationId,
        transitionOperationId: restoreOperationId,
        controlKey: input.setup.input.run.controlKey,
        supervisor: {
          epoch: 1,
          claimId: input.setup.input.run.claimId,
          supervisorKey: input.setup.input.run.supervisorKey,
        },
        currentPublisher: requestPublisher,
        nextPublisherKey: secret("next-request-publisher"),
        request: input.request.offer,
        checkpoint: input.bound.checkpoint,
      },
    },
  };
  const shardInput: HarnessProcessExecutionShardInput = {
    executionMode: "native-journal",
    runId: input.setup.runId,
    executionOperationId: input.setup.placementExecutionId,
    shardOwner: input.setup.ownerPrefix,
    controllerClaim: input.nextControl,
    processes: [process],
  };
  const running = input.shard.runShard(shardInput, `context-${input.request.requestId}`);
  const committed = await commitRequest({
    env: input.env,
    setup: input.setup,
    shard: input.shard,
    request: input.request,
    processOperationId: restoreOperationId,
    executionOperationId: input.setup.placementExecutionId,
    nativeSessionId: input.bound.nativeSessionId,
    control: input.nextControl,
    running,
  });
  const executed = await running;
  const after = await durable.threadSupervisor.execute({
    type: "read",
    runId: input.setup.runId,
    control: input.nextControl,
  });
  const journal = await durable.runStore.execute({ type: "read", runId: input.setup.runId });
  return {
    restored: {
      nativeSessionId: after.snapshot.nativeSessionId,
      checkpoint: after.snapshot.checkpoint,
      generation: after.currentPublisher.generation,
      facetNonce: after.currentPublisher.facetNonce,
      requestStatus: journal.snapshot.requests?.entries.at(-1)?.status,
    },
    committed: committed.status,
    executed,
    observations: await input.env.COLD_CREATION_STORE.getByName("cold-creation").observations(),
    loadedRelease:
      (await input.env.COLD_CREATION_STORE.getByName("cold-creation").loadedReleaseObservation()) ??
      null,
    placementWriter: await input.env.PLACEMENT_STORES.getByName(input.setup.owner).writerStatus(
      input.setup.owner,
    ),
  };
}

async function createdRequest(env: CreationWorkerEnv) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const capability = env.COLD_CREATION_STORE.getByName("cold-creation");
  const before = await shard.processCreationStatus({
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  const created = await shard.startFreshProcess(fixture.input);
  const status = await shard.processCreationStatus({
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  const durable = createHarnessDurableState(env, fixture.runId);
  const initialSupervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  const initialJournal = await durable.runStore.execute({ type: "read", runId: fixture.runId });
  const initialFiles = await durable.filesStore.execute({
    type: "readCheckpoint",
    runId: fixture.runId,
    publisher: {
      generation: 1,
      facetNonce: created.identity.incarnationNonce,
      publisherKey: fixture.input.publisherKey,
    },
    checkpointId: created.checkpoint.native.id,
  });
  const initialStore = {
    generation: initialSupervisor.currentPublisher.generation,
    facetNonce: initialSupervisor.currentPublisher.facetNonce,
    nativeSessionId: initialSupervisor.snapshot.nativeSessionId,
    checkpoint: initialSupervisor.snapshot.checkpoint,
    requestCheckpoint: initialJournal.snapshot.requests?.initialCheckpoint,
    firstFacet: initialJournal.snapshot.requests?.facets[0],
    filesCheckpoint: initialFiles.checkpoint,
    fileContent: new TextDecoder().decode(initialFiles.files[0]?.bytes),
  };
  const request = await offer(env, fixture, "retained");
  const running = shard.runCreatedProcess(
    { runId: fixture.runId, operationId: fixture.input.operationId, request: request.offer },
    `context-${request.requestId}`,
  );
  const committed = await commitRequest({
    env,
    setup: fixture,
    shard,
    request,
    processOperationId: fixture.input.operationId,
    executionOperationId: fixture.input.operationId,
    nativeSessionId: created.nativeSessionId,
    control: fixture.input.controllerClaim,
    running,
  });
  const executed = await running;
  return {
    kind: "public-c-cold-create-retained-request",
    initiallyMissing: before.status === "missing",
    peerNativeSessionId: created.nativeSessionId,
    created,
    status,
    store: initialStore,
    committed: committed.status,
    executed,
    terminal: await shard.terminalEvidence(),
    creationPlacement: await shard.creationPlacement(fixture.runId),
    observations: await capability.observations(),
    loadedRelease: (await capability.loadedReleaseObservation()) ?? null,
    placementWriter: await env.PLACEMENT_STORES.getByName(fixture.owner).writerStatus(
      fixture.owner,
    ),
  };
}

async function claimCrash(env: CreationWorkerEnv) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const placement = env.PLACEMENT_STORES.getByName(fixture.owner);
  const capability = env.COLD_CREATION_STORE.getByName("cold-creation");
  const before = await shard.processCreationStatus({
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  await placement.failNextWriterClaim();
  const first = await shard.startFreshProcess(fixture.input).then(
    () => ({ rejected: false, message: "" }),
    (cause: unknown) => ({ rejected: true, message: errorMessage(cause) }),
  );
  await shard.abortIncarnation().catch(() => undefined);
  const reconstructed = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const uncertain = await reconstructed.processCreationStatus({
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  const retry = await reconstructed.startFreshProcess(fixture.input).then(
    () => ({ rejected: false, message: "" }),
    (cause: unknown) => ({ rejected: true, message: errorMessage(cause) }),
  );
  const finalStatus = await reconstructed.processCreationStatus({
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  return {
    kind: "public-c-claim-before-bind-recovery",
    initiallyMissing: before.status === "missing",
    first,
    reconstructedStatus: uncertain,
    retry,
    finalStatus,
    writerClaimFailures: await placement.writerClaimFailureObserved(),
    writer: await placement.writerStatus(fixture.owner),
    peerEvents: await capability.observations(),
    loadedRelease: (await capability.loadedReleaseObservation()) ?? null,
  };
}

async function boundCrashRestore(env: CreationWorkerEnv, drainOperationId?: string) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const request = await offer(env, fixture, "recovered");
  await shard.loseNextCreationReplyAfterBind();
  const lostReply = await shard.startFreshProcess(fixture.input).then(
    () => ({ rejected: false, message: "" }),
    (cause: unknown) => ({ rejected: true, message: errorMessage(cause) }),
  );
  const bound = await shard.processCreationStatus({
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  const beforePlacement = await shard.creationPlacement(fixture.runId);
  if (bound.status !== "bound")
    throw new Error("The injected reply loss did not leave a bound creation.");
  const nextControl = {
    ...fixture.input.controllerClaim,
    incarnationId: secret("recovery-incarnation"),
    epoch: 2,
    controlKey: secret("recovery-control"),
  };
  const recoveryInput: HarnessProcessCreationRecoveryInput = {
    runId: fixture.runId,
    operationId: fixture.input.operationId,
    drainOperationId: drainOperationId ?? `drain-${fixture.runId}`,
    control: fixture.input.controllerClaim,
    nextControl,
  };
  const recovered = await shard.recoverFreshProcess(recoveryInput);
  const replay = await shard.recoverFreshProcess(recoveryInput);
  const afterPlacement = await shard.creationPlacement(fixture.runId);
  const durable = createHarnessDurableState(env, fixture.runId);
  const stopped = await durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: nextControl,
  });
  const resumed = await runNativeJournalRestore({
    env,
    setup: fixture,
    shard,
    request,
    bound,
    nextControl,
  });
  return {
    kind: "public-c-bound-recovery-strict-restore",
    lostReply,
    bound,
    recovered,
    replay,
    beforePlacement,
    afterPlacement,
    stopped: {
      lifecycle: stopped.snapshot.lifecycle,
      stopAcknowledgementId: stopped.snapshot.stopAcknowledgementId,
      nativeSessionId: stopped.snapshot.nativeSessionId,
      checkpoint: stopped.snapshot.checkpoint,
      publisher: stopped.currentPublisher,
    },
    ...resumed,
    terminal: await shard.terminalEvidence(),
  };
}

async function parentDestroyedCrashRestore(env: CreationWorkerEnv) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const capability = env.COLD_CREATION_STORE.getByName("cold-creation");
  const created = await shard.startFreshProcess(fixture.input);
  const beforePlacement = await shard.creationPlacement(fixture.runId);
  const request = await offer(env, fixture, "parent-destroyed");
  const beforeIncarnationNonce = await shard.executionIncarnationNonce();
  const beforeJournal = await createHarnessDurableState(env, fixture.runId).runStore.execute({
    type: "read",
    runId: fixture.runId,
  });
  const beforeObservations = await capability.observations();
  await shard.abortIncarnation().catch(() => undefined);
  const reconstructed = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const afterIncarnationNonce = await reconstructed.executionIncarnationNonce();
  if (afterIncarnationNonce === beforeIncarnationNonce)
    throw new Error("ctx.abort did not create a new C execution incarnation.");
  const bound = await reconstructed.processCreationStatus({
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  if (bound.status !== "bound") throw new Error("The new C incarnation lost the bound identity.");
  const nextControl = {
    ...fixture.input.controllerClaim,
    incarnationId: secret("recovery-incarnation"),
    epoch: 2,
    controlKey: secret("recovery-control"),
  };
  const recoveryInput: HarnessProcessCreationRecoveryInput = {
    runId: fixture.runId,
    operationId: fixture.input.operationId,
    drainOperationId: `drain-${fixture.runId}`,
    control: fixture.input.controllerClaim,
    nextControl,
  };
  const recovered = await reconstructed.recoverFreshProcess(recoveryInput);
  const afterPlacement = await reconstructed.creationPlacement(fixture.runId);
  const settled = await createHarnessDurableState(env, fixture.runId).threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: nextControl,
  });
  const resumed = await runNativeJournalRestore({
    env,
    setup: fixture,
    shard: reconstructed,
    request,
    bound,
    nextControl,
  });
  return {
    kind: "public-c-parent-destroyed-bound-recovery-strict-restore",
    beforeIncarnationNonce,
    afterIncarnationNonce,
    created,
    bound,
    beforePlacement,
    beforeRequestCount: beforeJournal.snapshot.requests?.entries.length ?? null,
    beforeObservations,
    recovered,
    afterPlacement,
    settled: {
      lifecycle: settled.snapshot.lifecycle,
      nativeSessionId: settled.snapshot.nativeSessionId,
      checkpoint: settled.snapshot.checkpoint,
    },
    ...resumed,
    terminal: await reconstructed.terminalEvidence(),
  };
}

async function recoveryRetryFailures(env: CreationWorkerEnv) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const capability = env.COLD_CREATION_STORE.getByName("cold-creation");
  const files = env.HARNESS_FILES_STORE.getByName(fixture.runId);
  const created = await shard.startFreshProcess(fixture.input);
  const nextControl = {
    ...fixture.input.controllerClaim,
    incarnationId: secret("recovery-incarnation"),
    epoch: 2,
    controlKey: secret("recovery-control"),
  };
  const recoveryInput: HarnessProcessCreationRecoveryInput = Object.freeze({
    runId: fixture.runId,
    operationId: fixture.input.operationId,
    drainOperationId: `drain-${fixture.runId}`,
    control: fixture.input.controllerClaim,
    nextControl,
  });

  await files.failNext("syncControl");
  const syncFailure = await shard.recoverFreshProcess(recoveryInput).then(
    () => ({ rejected: false, message: "" }),
    (cause: unknown) => ({ rejected: true, message: errorMessage(cause) }),
  );
  const afterSyncFailure = await shard.creationPlacement(fixture.runId);

  await capability.failNextExactFacetDisposal(created.identity.incarnationNonce);
  const disposeFailure = await shard.recoverFreshProcess(recoveryInput).then(
    () => ({ rejected: false, message: "" }),
    (cause: unknown) => ({ rejected: true, message: errorMessage(cause) }),
  );
  const afterDisposeFailure = await shard.creationPlacement(fixture.runId);

  const recovered = await shard.recoverFreshProcess(recoveryInput);
  const afterPlacement = await shard.creationPlacement(fixture.runId);
  const settled = await createHarnessDurableState(env, fixture.runId).threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: nextControl,
  });
  return {
    kind: "public-c-bound-recovery-retries",
    created,
    recoveryInput,
    syncFailure,
    afterSyncFailure,
    disposeFailure,
    afterDisposeFailure,
    recovered,
    afterPlacement,
    lifecycle: settled.snapshot.lifecycle,
    syncFailures: await files.injectedFailures("syncControl"),
    exactDisposeFailures: await capability.exactFacetDisposalFailures(),
    observations: await capability.observations(),
  };
}

async function firstRequestAdmissionRetry(env: CreationWorkerEnv) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const capability = env.COLD_CREATION_STORE.getByName("cold-creation");
  const files = env.HARNESS_FILES_STORE.getByName(fixture.runId);
  const created = await shard.startFreshProcess(fixture.input);
  const request = await offer(env, fixture, "admission-retry");
  const requestInput = {
    runId: fixture.runId,
    operationId: fixture.input.operationId,
    request: request.offer,
  };
  await files.failNext("admitStep");
  const first = await shard.runCreatedProcess(requestInput, `context-${request.requestId}`).then(
    () => ({ rejected: false, message: "" }),
    (cause: unknown) => ({ rejected: true, message: errorMessage(cause) }),
  );
  const durable = createHarnessDurableState(env, fixture.runId);
  const offered = await durable.runStore.execute({ type: "read", runId: fixture.runId });
  const pending = await durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  const observationsAfterFailure = await capability.observations();

  const running = shard.runCreatedProcess(requestInput, `context-${request.requestId}`);
  const committed = await commitRequest({
    env,
    setup: fixture,
    shard,
    request,
    processOperationId: fixture.input.operationId,
    executionOperationId: fixture.input.operationId,
    nativeSessionId: created.nativeSessionId,
    control: fixture.input.controllerClaim,
    running,
  });
  const executed = await running;
  const journal = await durable.runStore.execute({ type: "read", runId: fixture.runId });
  const after = await durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  return {
    kind: "public-c-first-request-files-admission-retry",
    created,
    requestId: request.requestId,
    first,
    offeredStatus: offered.snapshot.requests?.entries.at(-1)?.status,
    pendingStepId: pending.snapshot.admittedStepId,
    observationsAfterFailure,
    admittedFailures: await files.injectedFailures("admitStep"),
    committed: committed.status,
    executed,
    finalStatus: journal.snapshot.requests?.entries.at(-1)?.status,
    finalLifecycle: after.snapshot.lifecycle,
    observations: await capability.observations(),
  };
}

async function releaseReplyLoss(env: CreationWorkerEnv) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const store = env.PLACEMENT_STORES.getByName(fixture.owner);
  const created = await shard.startFreshProcess(fixture.input);
  const beforeNonce = await shard.executionIncarnationNonce();
  const nextControl = {
    ...fixture.input.controllerClaim,
    epoch: 2,
    incarnationId: secret("release-recovery"),
    controlKey: secret("release-control"),
  };
  const recoveryInput = {
    runId: fixture.runId,
    operationId: fixture.input.operationId,
    drainOperationId: `release-drain-${fixture.runId}`,
    control: fixture.input.controllerClaim,
    nextControl,
  };
  await store.loseNextWriterReleaseReply();
  const lost = await shard.recoverFreshProcess(recoveryInput).then(
    () => ({ rejected: false, message: "" }),
    (cause: unknown) => ({ rejected: true, message: errorMessage(cause) }),
  );
  const writerAfterFailure = await store.writerStatus(fixture.owner);
  const placementAfterFailure = await shard.creationPlacement(fixture.runId);
  await shard.abortIncarnation().catch(() => undefined);
  const recoveredShard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const afterNonce = await recoveredShard.executionIncarnationNonce();
  const recovered = await recoveredShard.recoverFreshProcess(recoveryInput);
  const replay = await recoveredShard.recoverFreshProcess(recoveryInput);
  const bound = await recoveredShard.processCreationStatus({
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  if (bound.status !== "bound")
    throw new Error("Writer reply loss lost the bound native identity.");
  const request = await offer(env, fixture, "release-reply-recovered");
  const restored = await runNativeJournalRestore({
    env,
    setup: fixture,
    shard: recoveredShard,
    request,
    bound,
    nextControl,
  });
  return {
    lost,
    writerAfterFailure,
    placementAfterFailure,
    beforeNonce,
    afterNonce,
    created,
    recovered,
    replay,
    ...restored,
  };
}

async function admissionParentDestruction(env: CreationWorkerEnv, drainOperationId?: string) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const created = await shard.startFreshProcess(fixture.input);
  const beforeNonce = await shard.executionIncarnationNonce();
  const original = await offer(env, fixture, "undispatched");
  await env.HARNESS_FILES_STORE.getByName(fixture.runId).failNext("admitStep");
  const failed = await shard
    .runCreatedProcess(
      { runId: fixture.runId, operationId: fixture.input.operationId, request: original.offer },
      `context-${original.requestId}`,
    )
    .then(
      () => ({ rejected: false }),
      () => ({ rejected: true }),
    );
  const before = await env.COLD_CREATION_STORE.getByName("cold-creation").observations();
  await shard.abortIncarnation().catch(() => undefined);
  const recoveredShard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const afterNonce = await recoveredShard.executionIncarnationNonce();
  const nextControl = {
    ...fixture.input.controllerClaim,
    epoch: 2,
    incarnationId: secret("admission-recovery"),
    controlKey: secret("admission-control"),
  };
  const recoveryInput = {
    runId: fixture.runId,
    operationId: fixture.input.operationId,
    drainOperationId: drainOperationId ?? `admission-drain-${fixture.runId}`,
    control: fixture.input.controllerClaim,
    nextControl,
  };
  const recovered = await recoveredShard.recoverFreshProcess(recoveryInput);
  const replay = await recoveredShard.recoverFreshProcess(recoveryInput);
  const durable = createHarnessDurableState(
    env,
    fixture.runId,
    await recoveredShard.processIncarnationFence(),
  );
  const journal = await durable.runStore.execute({ type: "read", runId: fixture.runId });
  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: nextControl,
  });
  const lateAdmission = await durable.runStore.execute({
    type: "request.admit",
    runId: fixture.runId,
    requestId: original.requestId,
    publisher: {
      generation: 1,
      facetNonce: created.identity.incarnationNonce,
      publisherKey: fixture.input.requestPublisherKey,
    },
  });
  const bound = await recoveredShard.processCreationStatus({
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  if (bound.status !== "bound")
    throw new Error("Admission recovery lost the initial native identity.");
  const request = await offer(env, fixture, "after-admission-retirement");
  const restored = await runNativeJournalRestore({
    env,
    setup: fixture,
    shard: recoveredShard,
    request,
    bound,
    nextControl,
  });
  return {
    failed,
    before,
    beforeNonce,
    afterNonce,
    created,
    recovered,
    replay,
    oldRequestStatus: journal.snapshot.requests?.entries[0]?.status,
    admittedStepId: current.snapshot.admittedStepId,
    evidenceId: current.snapshot.reconciliationEvidenceId,
    lateAdmission: lateAdmission.action,
    ...restored,
  };
}

async function dispatchedCrashRefusal(env: CreationWorkerEnv) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const created = await shard.startFreshProcess(fixture.input);
  const request = await offer(env, fixture, "dispatched");
  const running = shard
    .runCreatedProcess(
      { runId: fixture.runId, operationId: fixture.input.operationId, request: request.offer },
      `context-${request.requestId}`,
    )
    .catch(() => undefined);
  await env.HARNESS_RUN_STORE.getByName(fixture.runId).waitForFinish(request.requestId);
  await shard.abortIncarnation().catch(() => undefined);
  await running;
  const reconstructed = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const nextControl = {
    ...fixture.input.controllerClaim,
    epoch: 2,
    incarnationId: secret("blocked-recovery"),
    controlKey: secret("blocked-control"),
  };
  const recovery = await reconstructed
    .recoverFreshProcess({
      runId: fixture.runId,
      operationId: fixture.input.operationId,
      drainOperationId: `blocked-drain-${fixture.runId}`,
      control: fixture.input.controllerClaim,
      nextControl,
    })
    .then(
      () => ({ rejected: false, message: "" }),
      (cause: unknown) => ({ rejected: true, message: errorMessage(cause) }),
    );
  const state = await createHarnessDurableState(env, fixture.runId).threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: fixture.input.controllerClaim,
  });
  return {
    recovery,
    admittedStepId: state.snapshot.admittedStepId,
    controlEpoch: state.snapshot.controlEpoch,
    requestId: request.requestId,
    observations: await env.COLD_CREATION_STORE.getByName("cold-creation").observations(),
    created,
  };
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: CreationWorkerEnv) {
    try {
      switch (new URL(request.url).pathname) {
        case "/fresh":
          return json(await createdRequest(env));
        case "/claim-crash":
          return json(await claimCrash(env));
        case "/bound-crash":
          return json(
            await boundCrashRestore(
              env,
              new URL(request.url).searchParams.get("drainOperationId") ?? undefined,
            ),
          );
        case "/parent-destroyed-crash":
          return json(await parentDestroyedCrashRestore(env));
        case "/recovery-retries":
          return json(await recoveryRetryFailures(env));
        case "/dispatched-crash":
          return json(await dispatchedCrashRefusal(env));
        case "/release-reply-loss":
          return json(await releaseReplyLoss(env));
        case "/admission-parent-destruction":
          return json(
            await admissionParentDestruction(
              env,
              new URL(request.url).searchParams.get("drainOperationId") ?? undefined,
            ),
          );
        case "/admission-retry":
          return json(await firstRequestAdmissionRetry(env));
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (cause) {
      return new Response(errorMessage(cause), { status: 500 });
    }
  },
};
