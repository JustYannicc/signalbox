// @effect-diagnostics cryptoRandomUUID:off - each local Workerd scenario owns fresh isolated DO names.
import { createHarnessDurableState } from "../../HarnessDurableState.ts";
import type {
  HarnessProcessExecutionProcessInput,
  HarnessProcessExecutionShardInput,
} from "../../HarnessProcessPlacement.ts";
import { deterministicShardOwner } from "../../HarnessProcessPlacement.ts";
import type {
  HarnessProcessResumeOperationInput,
  HarnessProcessCheckpointInput,
} from "../../HarnessProcessResume.ts";
import {
  fixtureControl,
  fixturePublisher,
  type ProofFilesStore,
  type ProofRunStore,
  type ProofSupervisor,
} from "./publicResumeStores.fixture.ts";
import type { ProofShard, ProofPlacementStore } from "./publicResumeShard.fixture.ts";
import { jsonBytes, reference, releaseMaterial, loadMaterial } from "./releaseMaterial.ts";
import { transportWasmBytes } from "./transportModule.fixture.ts";

export interface ProofEnv {
  readonly HARNESS_FILES_STORE: DurableObjectNamespace<ProofFilesStore>;
  readonly HARNESS_RUN_STORE: DurableObjectNamespace<ProofRunStore>;
  readonly HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace<ProofSupervisor>;
  readonly PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<ProofShard>;
  readonly PLACEMENT_STORES: DurableObjectNamespace<ProofPlacementStore>;
  readonly OLD_SOURCE: string;
  readonly NEW_SOURCE: string;
  readonly THIRD_SOURCE: string;
}
const controlKey = "plain-run-control-key-".repeat(3);
const supervisor = {
  epoch: 1,
  claimId: "plain-owner",
  supervisorKey: "plain-run-supervisor-key-".repeat(3),
};
const publisherKey = (generation: number) => `plain-run-publisher-${generation}-`.repeat(3);

export async function setup(
  env: ProofEnv,
  scenario: string,
  options: {
    readonly holdWork?: boolean;
    readonly failDispose?: boolean;
    readonly invocationFailure?: "reject" | "failed-finish";
    readonly omitInitialBootstrap?: boolean;
  } = {},
) {
  const runId = `plain-${scenario}-${crypto.randomUUID()}`;
  const durable = createHarnessDurableState(env, runId);
  const files = env.HARNESS_FILES_STORE.getByName(runId);
  const store = env.HARNESS_RUN_STORE.getByName(runId);
  const a = env.HARNESS_THREAD_SUPERVISOR.getByName(runId);
  const initialCheckpoint = {
    checkpointId: "initial-native",
    parentCheckpointId: null,
    files: [
      {
        path: "native.json",
        mode: 0o644,
        bytes: jsonBytes({ nativeSessionId: "plain-native-session", transcript: [] }),
      },
      { path: "workspace.txt", mode: 0o644, bytes: new TextEncoder().encode("initial workspace") },
      { path: "index.bin", mode: 0o644, bytes: new Uint8Array([68, 73, 82, 67, 0, 0, 0, 2]) },
    ],
  };
  const old = await releaseMaterial(env.OLD_SOURCE, "old");
  const next = await releaseMaterial(env.NEW_SOURCE, "next");
  const third = await releaseMaterial(env.THIRD_SOURCE, "third");
  const initialPreparedRelease = await loadMaterial(old);
  await files.configure({ artifacts: { old, next, third }, ...options });
  const initialMaterial = await files.produce("initial", initialCheckpoint);
  const seed = await reference("seed", jsonBytes({ runId }));
  await durable.initialize({
    run: {
      type: "initialize",
      seed: {
        identity: {
          runId,
          hostId: "plain-host",
          threadId: "plain-thread",
          logicalTurnId: "plain-turn",
          filesystemId: "plain-files",
        },
        locator: seed,
        config: seed,
        artifacts: [seed],
      },
      controlKey,
      supervisorKey: supervisor.supervisorKey,
      claimId: supervisor.claimId,
      requestId: "initialize",
    },
    nativeSessionId: "plain-native-session",
    control: fixtureControl(1),
    publisher: fixturePublisher,
    checkpoint: initialCheckpoint,
  });
  await store.execute({
    type: "request.mode",
    runId,
    controlKey,
    requestId: "request-mode",
    checkpoint: initialMaterial.reference,
  });
  await store.execute({
    type: "request.replaceFacet",
    runId,
    controlKey,
    expectedGeneration: 0,
    operationId: "bootstrap",
    facetNonce: fixturePublisher.facetNonce,
    publisherKey: publisherKey(1),
  });
  // Initialization admitted no invocation and opened no process. This is the empty bootstrap boundary.
  await durable.beginDrain({
    control: fixtureControl(1),
    publisher: fixturePublisher,
    expectedGeneration: 1,
    operationId: "bootstrap-drain",
    nextControl: fixtureControl(2),
  });
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId,
    control: fixtureControl(2),
    publisher: fixturePublisher,
    expectedGeneration: 1,
    outcome: "settled",
    invocationRpcJoined: true,
    fetchJoined: true,
    callbackPortsJoined: true,
  });
  const request = {
    requestId: "turn-one",
    input: await reference("turn-one-input", new TextEncoder().encode("append one")),
  };
  const process: HarnessProcessExecutionProcessInput = {
    processId: "plain-process",
    codeId: old.artifact.releaseId,
    residentBytes: 1,
    nativeSessionId: "plain-native-session",
    checkpointId: initialMaterial.reference.native.id,
    manifestRevision: initialMaterial.reference.filesystem.sha256,
    operationId: "process-one",
    priorFacetNonce: fixturePublisher.facetNonce,
    expectedFacetGeneration: 1,
    mainModule: "plain.mjs",
    modules: {
      "plain.mjs": { js: env.OLD_SOURCE },
      "transport.wasm": { wasm: transportWasmBytes() },
    },
    entrypoint: "PlainFacet",
    ...(options.omitInitialBootstrap === true
      ? {}
      : {
          productBootstrap: {
            provider: "claude-code",
            preparedReleaseId: initialPreparedRelease.artifact.releaseId,
            restoreMode: "same-variant-serialized-checkpoint",
          },
          targetPreparedRelease: initialPreparedRelease,
        }),
    facetEnv: {
      HARNESS_C_PRODUCT_BOOTSTRAP: "caller-descriptor",
      HARNESS_C_TARGET_PREPARED_RELEASE: "caller-target",
      HARNESS_C_PRODUCT_CAPABILITIES: { "proof-platform": "caller-binding" },
      HARNESS_PROCESS_ID: "caller-process",
      HARNESS_PROCESS_SHARD_OWNER: "caller-owner",
      HARNESS_PROCESS_LOADER_ID: "caller-loader",
      HARNESS_PROCESS_FACET_KEY: "caller-facet",
      HARNESS_REQUEST_PUBLISHER: { generation: 99, publisherKey: "caller-publisher" },
      HARNESS_RESUME_RUN_ID: "caller-run",
      HARNESS_RESUME_CONTROL: "caller-control",
      HARNESS_RESUME_PUBLISHER: "caller-a-publisher",
      HARNESS_RESUME_RUN_STORE: "caller-run-store",
      HARNESS_RESUME_FILES_STORE: "caller-files-store",
      HARNESS_RESUME_SUPERVISOR: "caller-supervisor",
    },
    journal: {
      publisher: fixturePublisher,
      runStore: {
        runId,
        processId: "plain-process",
        processOperationId: "bootstrap",
        transitionOperationId: "process-one",
        controlKey,
        supervisor,
        currentPublisher: {
          generation: 1,
          facetNonce: fixturePublisher.facetNonce,
          publisherKey: publisherKey(1),
        },
        nextPublisherKey: publisherKey(2),
        request,
        checkpoint: initialMaterial.reference,
      },
    },
  };
  const shardInput: HarnessProcessExecutionShardInput = {
    executionMode: "native-journal",
    runId,
    executionOperationId: "plain-execution",
    shardOwner: `plain/${runId}`,
    controllerClaim: fixtureControl(2),
    processes: [process],
  };
  const owner = await deterministicShardOwner(
    shardInput.shardOwner,
    shardInput.executionOperationId,
    0,
  );
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(owner) as unknown as Pick<
    ProofShard,
    | "runShard"
    | "resumeProcess"
    | "continueProcess"
    | "commitProcessCheckpoint"
    | "processResumeStatus"
    | "cancelResumeProcess"
    | "executionIncarnationNonce"
    | "evidence"
    | "armTransactionFailure"
    | "rehydrate"
  >;
  const placement = env.PLACEMENT_STORES.getByName(owner);
  return {
    env,
    runId,
    durable,
    files,
    store,
    a,
    shard,
    placement,
    owner,
    shardInput,
    process,
    initialMaterial,
    next,
    third,
    controlKey,
    supervisor,
    publisherKey,
  };
}
export type ProofSetup = Awaited<ReturnType<typeof setup>>;

export async function completionInput(
  fixture: ProofSetup,
  requestId = "turn-one",
  processOperationId = "process-one",
  control = fixtureControl(2),
) {
  const material = await fixture.files.material(requestId);
  const current = await fixture.durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control,
  });
  const input: HarnessProcessCheckpointInput = {
    runId: fixture.runId,
    processId: fixture.process.processId,
    executionOperationId: fixture.shardInput.executionOperationId,
    processOperationId,
    requestId,
    nativeSessionId: fixture.process.nativeSessionId,
    control,
    publisher: current.currentPublisher,
    checkpoint: material.checkpoint,
  };
  return { input, material };
}

export async function complete(
  fixture: ProofSetup,
  requestId = "turn-one",
  processOperationId = "process-one",
  control = fixtureControl(2),
) {
  const { input, material } = await completionInput(
    fixture,
    requestId,
    processOperationId,
    control,
  );
  return { input, result: await fixture.shard.commitProcessCheckpoint(input), material };
}

export async function resumeInput(
  fixture: ProofSetup,
  options: {
    readonly observed?: boolean;
    readonly step?: number;
    readonly mismatched?: boolean;
  } = {},
): Promise<HarnessProcessResumeOperationInput> {
  const step = options.step ?? 1;
  const control = fixtureControl(step + 1);
  const current = await fixture.durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control,
  });
  const journal = await fixture.store.execute({ type: "read", runId: fixture.runId });
  const entry = journal.snapshot.requests!.entries.at(-1)!;
  const parent = step === 1 ? fixture.initialMaterial : await fixture.files.material("turn-one");
  const target = step === 1 ? fixture.next : fixture.third;
  const loaded = await loadMaterial(target);
  // The target's member order differs from the facet's independent verified-load order.
  const reordered = {
    ...loaded,
    plan: {
      ...loaded.plan,
      preparedModules: Object.fromEntries(Object.entries(loaded.plan.preparedModules).toReversed()),
      release: {
        ...loaded.plan.release,
        modules: Object.fromEntries(Object.entries(loaded.plan.release.modules).toReversed()),
      },
    },
  };
  return {
    runId: fixture.runId,
    previousProcessId: fixture.process.processId,
    previousOperationId: step === 1 ? "process-one" : "resume-one",
    previousStepId: entry.request.requestId,
    runStore: {
      runId: fixture.runId,
      processId: fixture.process.processId,
      processOperationId: step === 1 ? "process-one" : "resume-one",
      transitionOperationId: step === 1 ? "resume-one" : "resume-two",
      controlKey: fixture.controlKey,
      supervisor: fixture.supervisor,
      currentPublisher: {
        generation: current.currentPublisher.generation,
        facetNonce: current.currentPublisher.facetNonce,
        publisherKey: fixture.publisherKey(step + 1),
      },
      nextPublisherKey: fixture.publisherKey(step + 2),
      request: entry.request,
      checkpoint: parent.reference,
    },
    productBootstrap: {
      provider: "claude-code",
      preparedReleaseId: target.artifact.releaseId,
      restoreMode: "cross-variant-fresh-boot",
    },
    transition: {
      operationId: step === 1 ? "resume-one" : "resume-two",
      control,
      publisher: current.currentPublisher,
      nextControl: fixtureControl(step + 2),
      expectedFacetGeneration: current.currentPublisher.generation,
      targetPreparedRelease: reordered,
    },
    facet: {
      processId: fixture.process.processId,
      codeId: target.artifact.releaseId,
      residentBytes: 1,
      mainModule: "plain.mjs",
      modules: {
        "transport.wasm": { wasm: transportWasmBytes() },
        "plain.mjs": {
          js:
            options.mismatched === true
              ? fixture.env.THIRD_SOURCE
              : step === 1
                ? fixture.env.NEW_SOURCE
                : fixture.env.THIRD_SOURCE,
        },
      },
      entrypoint: options.observed === false ? "PlainFacet" : "ObservedPlainFacet",
    },
  };
}
