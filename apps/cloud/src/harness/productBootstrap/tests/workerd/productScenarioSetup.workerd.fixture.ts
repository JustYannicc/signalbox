// @effect-diagnostics cryptoRandomUUID:off - Each setup owns a fresh C run and deterministic test authority.
import * as Effect from "effect/Effect";
import { ProviderDriverKind, type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type { HarnessCheckpoint } from "../../../Harness.ts";
import { encodeHarnessCProductNativeCheckpoint } from "../../../HarnessCProductCheckpoint.ts";
import { createHarnessDurableState } from "../../../HarnessDurableState.ts";
import { deterministicShardOwner } from "../../../HarnessProcessPlacement.ts";
import type { HarnessProcessExecutionShardInput } from "../../../HarnessProcessPlacement.ts";
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
import { reference as referenceArtifact } from "../../../processResume/tests/releaseMaterial.ts";
import { dataForDriver } from "../../../adapter/tests/data.ts";

const CAPABILITY_NAME = "product-fixture";
const nativeSessionId = "product-native-session";
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

export function productModules(env: ProductWorkerEnv) {
  const binary = atob(env.PRODUCT_CODEX_WASM);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return {
    "productFacet.mjs": { js: env.PRODUCT_FACET_SOURCE },
    "codex-engine.wasm": {
      wasm: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    },
  } as const;
}

export async function setupProductClaudeRun(env: ProductWorkerEnv) {
  const runId = `product-workerd-${crypto.randomUUID()}`;
  const capability = env.PRODUCT_FIXTURE.getByName(
    CAPABILITY_NAME,
  ) as unknown as ProductFixtureCapability;
  const configured = await capability.configure(runId);
  const claude = await capability.release("claude-code");
  const codex = await capability.release("codex");
  const state = createHarnessDurableState(env, runId);
  const processId = "product-native-process";
  const executionOperationId = "product-initial-execution";
  const shardOwner = `product/${runId}`;
  const control1 = controlFor(1);
  const control2 = controlFor(2);
  const control3 = controlFor(3);
  const initialPublisher = publisherFor(1, "product-initial-bootstrap");
  const turnOne = configured.turns["turn-one"];
  const turnTwo = configured.turns["turn-two"];
  const seed = await referenceArtifact(`seed-${runId}`, new TextEncoder().encode(runId));

  const initialData = await Effect.runPromise(
    dataForDriver(ProviderDriverKind.make("claudeAgent")),
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
    release: claude.expected.plan.release,
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
    codeId: claude.artifact.releaseId,
    residentBytes: 1,
    nativeSessionId,
    checkpointId: initialized.files.checkpoint.checkpointId,
    manifestRevision: initialized.files.checkpoint.manifestSha256,
    operationId: "process-one",
    priorFacetNonce: initialPublisher.facetNonce,
    expectedFacetGeneration: 1,
    mainModule: "productFacet.mjs",
    modules: productModules(env),
    entrypoint: "ClaudeFacet",
    productBootstrap: {
      provider: "claude-code" as const,
      preparedReleaseId: claude.artifact.releaseId,
      restoreMode: "same-variant-serialized-checkpoint" as const,
    },
    targetPreparedRelease: claude.expected,
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
  const running = shard.runShard(shardInput, "public-runShard-initial");
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
      `The public Claude runShard did not settle: ${JSON.stringify(firstProcess)}; observations: ${JSON.stringify(await capability.observations())}`,
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
    throw new Error("The Claude request did not commit its public checkpoint.");

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
