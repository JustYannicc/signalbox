// @effect-diagnostics nodeBuiltinImport:off globalFetch:off cryptoRandomUUID:off - This fixture exercises the real Workerd DO transport.
import * as Effect from "effect/Effect";
import { ProviderDriverKind } from "@t3tools/contracts";
import { dataForDriver } from "../../adapter/tests/data.ts";
import { createHarnessDurableState } from "../../HarnessDurableState.ts";
import { HarnessFilesStoreObject } from "../../HarnessFilesStoreObject.ts";
import { HarnessProcessExecutionShardObject } from "../../HarnessProcessExecutionShardObject.ts";
import type {
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionShardInput,
} from "../../HarnessProcessPlacement.ts";
import { deterministicShardOwner } from "../../HarnessProcessPlacement.ts";
import { HarnessThreadSupervisorObject } from "../../HarnessThreadSupervisorObject.ts";
import type { HarnessRequestOffer } from "../../HarnessRunStore.ts";
import type {
  HarnessRunInitialization,
  HarnessDurableStateBindings,
} from "../../HarnessDurableState.ts";
import type { HarnessProcessCreationInput } from "../contracts.ts";
import type { HarnessProcessCreationEnvironment } from "../contracts.ts";
import { creationPlacementKey } from "../contracts.ts";
import type { HarnessProcessCreationRecoveryInput } from "../recovery.ts";
import { HarnessProcessResumeOwner } from "../../processResume/owner.ts";
import { reference } from "../../processResume/tests/releaseMaterial.ts";
import type { ColdCreationPlacementStore } from "./processCreationStores.fixture.ts";
import { ColdCreationPlacementStore as PlacementStore } from "./processCreationStores.fixture.ts";
import type { ControlledCreationStore } from "./controlledCreationStore.fixture.ts";
import { ControlledCreationStore as CreationStore } from "./controlledCreationStore.fixture.ts";
import { ControlledCreationRunStore } from "./controlledCreationRunStore.fixture.ts";
import { loadControlledCodexRelease } from "./controlledRelease.fixture.ts";

type CreationWorkerEnv = Omit<HarnessProcessExecutionEnvironment, "PLACEMENT_STORES"> &
  Omit<HarnessDurableStateBindings, "HARNESS_RUN_STORE"> & {
    readonly COLD_CREATION_FACET_SOURCE: string;
    readonly COLD_CREATION_STORE: DurableObjectNamespace<ControlledCreationStore>;
    readonly HARNESS_RUN_STORE: DurableObjectNamespace<ControlledCreationRunStore>;
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

  override async recoverFreshProcess(input: HarnessProcessCreationRecoveryInput) {
    const rebuiltOwner = new HarnessProcessResumeOwner(
      this.ctx,
      this.env as HarnessProcessCreationEnvironment,
      this.executionIncarnationNonce(),
    );
    return await rebuiltOwner.recoverFreshProcess(input);
  }

  rehydrate() {
    this.ctx.abort("Reconstruct the C owner after a claim-only creation interruption.");
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
    }>(creationPlacementKey(runId));
    if (record === undefined) return null;
    return {
      owner: record.owner,
      lease: record.lease,
      identity: record.identity ?? null,
      disposed: record.disposed === true,
      released: record.released === true,
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
  HarnessFilesStoreObject,
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
  await shard.rehydrate().catch(() => undefined);
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

async function boundCrashRestore(env: CreationWorkerEnv) {
  const fixture = await setup(env);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const capability = env.COLD_CREATION_STORE.getByName("cold-creation");
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
    drainOperationId: `drain-${fixture.runId}`,
    control: fixture.input.controllerClaim,
    nextControl,
  };
  const recovered = await shard.recoverFreshProcess(recoveryInput);
  const afterPlacement = await shard.creationPlacement(fixture.runId);
  const durable = createHarnessDurableState(env, fixture.runId);
  const stopped = await durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: nextControl,
  });
  const restoreOperationId = `strict-restore-${fixture.runId}`;
  const publisher = {
    generation: 1,
    facetNonce: bound.identity.incarnationNonce,
    publisherKey: fixture.input.publisherKey,
  };
  const requestPublisher = {
    generation: 1,
    facetNonce: bound.identity.incarnationNonce,
    publisherKey: fixture.input.requestPublisherKey,
  };
  const process = {
    ...fixture.input.facet,
    nativeSessionId: bound.nativeSessionId,
    checkpointId: bound.checkpoint.native.id,
    manifestRevision: bound.checkpoint.filesystem.sha256,
    operationId: restoreOperationId,
    priorFacetNonce: bound.identity.incarnationNonce,
    expectedFacetGeneration: 1,
    journal: {
      publisher,
      runStore: {
        runId: fixture.runId,
        processId: fixture.input.facet.processId,
        processOperationId: fixture.input.operationId,
        transitionOperationId: restoreOperationId,
        controlKey: fixture.input.run.controlKey,
        supervisor: {
          epoch: 1,
          claimId: fixture.input.run.claimId,
          supervisorKey: fixture.input.run.supervisorKey,
        },
        currentPublisher: requestPublisher,
        nextPublisherKey: secret("next-request-publisher"),
        request: request.offer,
        checkpoint: bound.checkpoint,
      },
    },
  };
  const shardInput: HarnessProcessExecutionShardInput = {
    executionMode: "native-journal",
    runId: fixture.runId,
    executionOperationId: fixture.placementExecutionId,
    shardOwner: fixture.ownerPrefix,
    controllerClaim: nextControl,
    processes: [process],
  } as HarnessProcessExecutionShardInput;
  const running = shard.runShard(shardInput, `context-${request.requestId}`);
  const committed = await commitRequest({
    env,
    setup: fixture,
    shard,
    request,
    processOperationId: restoreOperationId,
    executionOperationId: fixture.placementExecutionId,
    nativeSessionId: bound.nativeSessionId,
    control: nextControl,
    running,
  });
  const executed = await running;
  const after = await durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control: nextControl,
  });
  const journal = await durable.runStore.execute({ type: "read", runId: fixture.runId });
  return {
    kind: "public-c-bound-recovery-strict-restore",
    lostReply,
    bound,
    recovered,
    beforePlacement,
    afterPlacement,
    stopped: {
      lifecycle: stopped.snapshot.lifecycle,
      nativeSessionId: stopped.snapshot.nativeSessionId,
      checkpoint: stopped.snapshot.checkpoint,
      publisher: stopped.currentPublisher,
    },
    restored: {
      nativeSessionId: after.snapshot.nativeSessionId,
      checkpoint: after.snapshot.checkpoint,
      generation: after.currentPublisher.generation,
      facetNonce: after.currentPublisher.facetNonce,
      requestStatus: journal.snapshot.requests?.entries.at(-1)?.status,
    },
    committed: committed.status,
    executed,
    terminal: await shard.terminalEvidence(),
    observations: await capability.observations(),
    loadedRelease: (await capability.loadedReleaseObservation()) ?? null,
    placementWriter: await env.PLACEMENT_STORES.getByName(fixture.owner).writerStatus(
      fixture.owner,
    ),
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
          return json(await boundCrashRestore(env));
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (cause) {
      return new Response(errorMessage(cause), { status: 500 });
    }
  },
};
