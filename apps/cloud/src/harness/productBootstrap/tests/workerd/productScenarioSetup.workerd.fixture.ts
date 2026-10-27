// @effect-diagnostics cryptoRandomUUID:off - Each setup owns a fresh C run and deterministic test authority.
import * as Effect from "effect/Effect";
import { ProviderDriverKind, type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type { HarnessCheckpoint } from "../../../Harness.ts";
import { encodeHarnessCProductNativeCheckpoint } from "../../../HarnessCProductCheckpoint.ts";
import { createHarnessDurableState } from "../../../HarnessDurableState.ts";
import { deterministicShardOwner } from "../../../HarnessProcessPlacement.ts";
import type { HarnessProcessExecutionShardInput } from "../../../HarnessProcessPlacement.ts";
import type { HarnessProcessFacetModule } from "../../../HarnessProcessPlacement.ts";
import type { HarnessProcessPreparedRelease } from "../../../HarnessProcessPlacement.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../../../HarnessThreadSupervisor.ts";
import type { HarnessRunArtifact } from "../../../HarnessRunStore.ts";
import type { HarnessFilesCheckpoint } from "../../../HarnessFilesStore.ts";
import type { ProductFixtureCapability } from "./productCapability.workerd.fixture.ts";
import type {
  ProductFixtureShard,
  ProductFixturePlacementStore,
  ProductWorkerEnv,
} from "./productBindings.workerd.fixture.ts";
import type { FixtureRelease } from "./productInputs.workerd.fixture.ts";
import { reference as referenceArtifact } from "../../../processResume/tests/releaseMaterial.ts";
import { dataForDriver } from "../../../adapter/tests/data.ts";
import { preparedReleaseAsset } from "../../../HarnessProcessPlacement.ts";
import { supplementaryMemoryModules } from "./memoryModules.workerd.fixture.ts";
import { memoryNativeModule } from "./memoryNative.workerd.fixture.ts";

const CAPABILITY_NAME = "product-fixture";
const controlKey = "product-run-control-key-".repeat(2);
const supervisor = {
  epoch: 1,
  claimId: "product-run-owner",
  supervisorKey: "product-supervisor-key-".repeat(2),
};
const publisherFor = (
  generation: number,
  facetNonce: string,
): HarnessThreadSupervisorPublisher => ({
  generation,
  facetNonce,
  publisherKey: `product-run-publisher-${generation}-`.repeat(2),
});
const controlFor = (epoch: number): HarnessThreadSupervisorControlClaim => ({
  ownerId: "product-run-owner",
  incarnationId: `product-controller-${epoch}`,
  epoch,
  controlKey: `product-controller-key-${epoch}-`.repeat(2),
});

export function productModules(
  env: ProductWorkerEnv,
  provider: "claude-code" | "codex",
  release: FixtureRelease["expected"],
) {
  return {
    "productFacet.mjs": { js: env.PRODUCT_FACET_SOURCE },
    "codex-engine.wasm":
      provider === "codex"
        ? preparedReleaseAsset(release, "codex/engine.wasm")
        : { wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer },
  } as const;
}

async function memoryProofModules(
  env: ProductWorkerEnv,
  release: HarnessProcessPreparedRelease,
): Promise<Readonly<Record<string, HarnessProcessFacetModule>>> {
  const modules: Record<string, HarnessProcessFacetModule> = {
    "productFacet.mjs": { js: env.PRODUCT_FACET_SOURCE },
    ...memoryNativeModule(env),
    ...(await supplementaryMemoryModules(env.PRODUCT_FIXTURE.getByName("product-fixture"))),
  };
  for (const moduleKey of Object.keys(release.plan.preparedModules))
    modules[moduleKey === "codex/engine.wasm" ? "codex-engine.wasm" : moduleKey] =
      preparedReleaseAsset(release, moduleKey);
  return Object.freeze(modules);
}

type ProductMemoryProofRequest = {
  readonly mode: "before" | "after";
  readonly runId: string;
  readonly waitUntil: (promise: Promise<unknown>) => void;
};

type ProductRunSetup = Extract<
  Awaited<ReturnType<typeof setupProductRunInternal>>,
  { readonly capability: ProductFixtureCapability }
>;

export function setupProductRun(
  env: ProductWorkerEnv,
  initialProvider?: "claude-code" | "codex",
): Promise<ProductRunSetup>;
export function setupProductRun(
  env: ProductWorkerEnv,
  initialProvider: "claude-code" | "codex",
  memoryProof: ProductMemoryProofRequest,
): Promise<{ readonly runId: string; readonly owner: string }>;
export async function setupProductRun(
  env: ProductWorkerEnv,
  initialProvider: "claude-code" | "codex" = "claude-code",
  memoryProof?: ProductMemoryProofRequest,
) {
  const result = await setupProductRunInternal(env, initialProvider, memoryProof);
  if (memoryProof === undefined) {
    if (!("capability" in result))
      throw new Error("Product C setup returned before its first run.");
    return result;
  }
  if ("capability" in result)
    throw new Error("Product C memory proof unexpectedly completed its run.");
  return result;
}

async function setupProductRunInternal(
  env: ProductWorkerEnv,
  initialProvider: "claude-code" | "codex",
  memoryProof?: ProductMemoryProofRequest,
) {
  const runId = memoryProof?.runId ?? `product-workerd-${crypto.randomUUID()}`;
  const nativeSessionId = "product-native-session";
  const capability = env.PRODUCT_FIXTURE.getByName(
    CAPABILITY_NAME,
  ) as unknown as ProductFixtureCapability;
  const configured = await capability.configure(runId, initialProvider, memoryProof !== undefined);
  const claude = await capability.release("claude-code");
  const codex = await capability.release("codex");
  const initialRelease = initialProvider === "codex" ? codex : claude;
  const state = createHarnessDurableState(env, runId);
  const processId = memoryProof === undefined ? "product-native-process" : "product-memory-proof";
  const executionOperationId =
    memoryProof === undefined ? "product-initial-execution" : "product-memory-proof-execution";
  const shardOwner = `product/${runId}`;
  const control1 = controlFor(1);
  const control2 = controlFor(2);
  const control3 = controlFor(3);
  const initialPublisher = publisherFor(1, "product-initial-bootstrap");
  const turnOne = configured.turns["turn-one"];
  const turnTwo = configured.turns["turn-two"];
  const seed = await referenceArtifact(`seed-${runId}`, new TextEncoder().encode(runId));

  const initialData = await Effect.runPromise(
    dataForDriver(ProviderDriverKind.make(initialProvider === "codex" ? "codex" : "claudeAgent")),
  );
  const initialThread: OrchestrationV2ProviderThread = {
    ...initialData.providerThread,
    nativeThreadRef: {
      driver: initialData.providerThread.driver,
      nativeId: nativeSessionId,
      strength: "strong",
    },
  };
  const initialCheckpoint: HarnessCheckpoint = {
    release: initialRelease.expected.plan.release,
    providerSession: initialData.providerSession,
    snapshot: {
      providerThread: initialThread,
      providerTurns: [],
      messages: [],
      runtimeRequests: [],
    },
    revision: { commit: "initial-fixture-commit" },
  };
  const nativeBytes = new TextEncoder().encode(
    encodeHarnessCProductNativeCheckpoint({
      schemaVersion: 1,
      nativeSessionId,
      checkpoint: initialCheckpoint,
    }),
  );
  const nativeReference = await referenceArtifact(`native-initial-${runId}`, nativeBytes);
  await capability.putNative(nativeReference.id, nativeBytes);
  const initialFiles: HarnessFilesCheckpoint = {
    checkpointId: nativeReference.id,
    parentCheckpointId: null,
    files: [{ path: "file.txt", mode: 0o644, bytes: new TextEncoder().encode("before\n") }],
  };
  const initialized = await state.initialize({
    run: {
      type: "initialize",
      seed: {
        identity: {
          runId,
          hostId: "product-workerd-host",
          threadId: initialData.threadId,
          logicalTurnId: "product-logical-turn",
          filesystemId: "product-workerd-files",
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
    nativeSessionId,
    control: control1,
    publisher: initialPublisher,
    checkpoint: initialFiles,
  });
  const initialReferences = {
    native: nativeReference,
    filesystem: {
      id: initialized.files.checkpoint.checkpointId,
      bytes: initialFiles.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
      sha256: initialized.files.checkpoint.manifestSha256,
    },
  } satisfies { readonly native: HarnessRunArtifact; readonly filesystem: HarnessRunArtifact };
  await capability.registerFiles(initialReferences.filesystem, runId, initialPublisher);
  await state.runStore.execute({
    type: "request.mode",
    runId,
    controlKey,
    requestId: "request-mode",
    checkpoint: initialReferences,
  });
  await state.runStore.execute({
    type: "request.replaceFacet",
    runId,
    controlKey,
    expectedGeneration: 0,
    operationId: "bootstrap",
    facetNonce: initialPublisher.facetNonce,
    publisherKey: initialPublisher.publisherKey,
  });
  const drain = await state.beginDrain({
    control: control1,
    publisher: initialPublisher,
    expectedGeneration: 1,
    operationId: "initial-bootstrap-drain",
    nextControl: control2,
  });
  if (drain.status !== "draining")
    throw new Error("Initial C owner did not drain bootstrap state.");
  await state.threadSupervisor.execute({
    type: "settleInvocation",
    runId,
    control: control2,
    publisher: initialPublisher,
    expectedGeneration: 1,
    outcome: "settled",
    invocationRpcJoined: true,
    fetchJoined: true,
    callbackPortsJoined: true,
  });

  const process = {
    processId,
    codeId: initialRelease.artifact.releaseId,
    residentBytes: 1,
    nativeSessionId,
    checkpointId: initialized.files.checkpoint.checkpointId,
    manifestRevision: initialized.files.checkpoint.manifestSha256,
    operationId: "process-one",
    priorFacetNonce: initialPublisher.facetNonce,
    expectedFacetGeneration: 1,
    mainModule: "productFacet.mjs",
    modules:
      memoryProof === undefined
        ? productModules(env, initialProvider, initialRelease.expected)
        : await memoryProofModules(env, initialRelease.expected),
    entrypoint: initialProvider === "codex" ? "CodexFacet" : "ClaudeFacet",
    productBootstrap: {
      provider: initialProvider,
      preparedReleaseId: initialRelease.artifact.releaseId,
      restoreMode: "same-variant-serialized-checkpoint" as const,
    },
    targetPreparedRelease: initialRelease.expected,
    journal: {
      publisher: initialPublisher,
      runStore: {
        runId,
        processId,
        processOperationId: "bootstrap",
        transitionOperationId: "process-one",
        controlKey,
        supervisor,
        currentPublisher: initialPublisher,
        nextPublisherKey: publisherFor(2, "next").publisherKey,
        request: { requestId: "turn-one", input: turnOne },
        checkpoint: initialReferences,
      },
    },
  };
  const shardInput: HarnessProcessExecutionShardInput = {
    executionMode: "native-journal",
    runId,
    executionOperationId,
    shardOwner,
    controllerClaim: control2,
    processes: [process],
  };
  const owner = await deterministicShardOwner(shardOwner, executionOperationId, 0);
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(owner) as unknown as ProductFixtureShard;
  const placement = env.PLACEMENT_STORES.getByName(
    owner,
  ) as unknown as ProductFixturePlacementStore;
  if (memoryProof?.mode === "before") {
    await shard.startLegacyMemoryProof(shardInput, "local-legacy-runShard-baseline");
    return { runId, owner };
  }
  const running = shard.runShard(shardInput, "public-runShard-initial");
  if (memoryProof !== undefined) {
    memoryProof.waitUntil(running);
    return { runId, owner };
  }
  await Promise.race([
    env.HARNESS_RUN_STORE.getByName(runId).waitForFinish("turn-one"),
    running.then(async (result) => {
      throw new Error(
        `C ended before the journal finish: ${JSON.stringify(result)}; observations: ${JSON.stringify(await capability.observations())}`,
      );
    }),
  ]);
  const published = await state.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  await shard.commitProcessCheckpoint({
    runId,
    processId,
    executionOperationId,
    processOperationId: "process-one",
    requestId: "turn-one",
    nativeSessionId,
    control: control2,
    publisher: published.currentPublisher,
    checkpoint: await capability.material("turn-one"),
  });
  const initialResult = await running;
  const firstProcess = initialResult.processes[0];
  if (firstProcess?.status !== "settled")
    throw new Error(
      `The public initial runShard did not settle: ${JSON.stringify(firstProcess)}; observations: ${JSON.stringify(await capability.observations())}`,
    );

  const beforeResume = await state.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  const journalBeforeResume = await state.runStore.execute({ type: "read", runId });
  const firstEntry = journalBeforeResume.snapshot.requests?.entries.at(-1);
  const firstCheckpoint = journalBeforeResume.snapshot.requests?.checkpoint;
  if (firstEntry === undefined || firstCheckpoint === undefined)
    throw new Error("The initial request did not commit its public checkpoint.");

  return {
    runId,
    capability,
    state,
    processId,
    executionOperationId,
    shardOwner,
    owner,
    control2,
    control3,
    controlKey,
    supervisor,
    turnTwo,
    codex,
    initialReferences,
    firstProcess,
    firstEntry,
    firstCheckpoint,
    beforeResume,
    shard,
    placement,
  };
}
