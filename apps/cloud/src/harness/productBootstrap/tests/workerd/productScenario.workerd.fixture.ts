// @effect-diagnostics cryptoRandomUUID:off - The route owns exactly one C proof chain.
import type { ProductWorkerEnv } from "./productBindings.workerd.fixture.ts";
import { setupProductClaudeRun } from "./productScenarioSetup.workerd.fixture.ts";

const publisherFor = (generation: number, facetNonce: string) => ({
  generation,
  facetNonce,
  publisherKey: `product-run-publisher-${generation}-`.repeat(2),
});

const noNativeResume = async (cause: unknown) => ({
  rejected: true,
  message: cause instanceof Error ? cause.message : String(cause),
});

export async function runProductScenario(
  env: ProductWorkerEnv,
  mismatch: boolean,
  materialFault?: string,
) {
  const setup = await setupProductClaudeRun(env);
  const {
    runId,
    capability,
    state,
    processId,
    executionOperationId,
    control2,
    control3,
    controlKey,
    supervisor,
    turnTwo,
    codex,
    firstEntry,
    firstCheckpoint,
    beforeResume,
    shard,
    placement,
  } = setup;
  const actualCodexExpected = structuredClone(codex.expected);
  const targetPreparedRelease = structuredClone(codex.expected);
  if (mismatch)
    Reflect.set(targetPreparedRelease.plan.release, "version", "mismatched-release-version");
  const resumeOperation = {
    runId,
    previousProcessId: processId,
    previousOperationId: "process-one",
    previousStepId: firstEntry.request.requestId,
    runStore: {
      runId,
      processId,
      processOperationId: "process-one",
      transitionOperationId: "resume-one",
      controlKey,
      supervisor,
      currentPublisher: publisherFor(
        beforeResume.currentPublisher.generation,
        beforeResume.currentPublisher.facetNonce,
      ),
      nextPublisherKey: publisherFor(beforeResume.currentPublisher.generation + 1, "next")
        .publisherKey,
      request: firstEntry.request,
      checkpoint: setup.initialReferences,
    },
    productBootstrap: {
      provider: "codex" as const,
      preparedReleaseId: codex.artifact.releaseId,
      restoreMode: "cross-variant-fresh-boot" as const,
    },
    transition: {
      operationId: "resume-one",
      control: control2,
      publisher: beforeResume.currentPublisher,
      nextControl: control3,
      expectedFacetGeneration: beforeResume.currentPublisher.generation,
      targetPreparedRelease,
    },
    facet: {
      processId,
      codeId: codex.artifact.releaseId,
      residentBytes: 1,
      mainModule: "productFacet.mjs",
      modules: {
        "productFacet.mjs": { js: env.PRODUCT_FACET_SOURCE },
        "codex-engine.wasm": (() => {
          const binary = atob(env.PRODUCT_CODEX_WASM);
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          return {
            wasm: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          };
        })(),
      },
      entrypoint: "CodexFacet",
    },
  };

  if (mismatch) {
    const rejected = await shard
      .resumeProcess(resumeOperation)
      .then(() => ({ rejected: false, message: "Resume unexpectedly succeeded." }), noNativeResume);
    const status = await shard.processResumeStatus({
      runId,
      operationId: "resume-one",
      control: control3,
    });
    const after = await state.threadSupervisor.execute({ type: "read", runId, control: control3 });
    return {
      kind: "product-c-workerd-prepublication-mismatch",
      rejected,
      status,
      before: {
        generation: beforeResume.currentPublisher.generation,
        lifecycle: beforeResume.snapshot.lifecycle,
        publication: beforeResume.snapshot.lastPublication,
        preparedFacet: beforeResume.snapshot.preparedFacet,
      },
      after: {
        generation: after.currentPublisher.generation,
        lifecycle: after.snapshot.lifecycle,
        publication: after.snapshot.lastPublication,
        preparedFacet: after.snapshot.preparedFacet,
      },
      unchangedPublication:
        beforeResume.snapshot.lastPublicationOperationId ===
          after.snapshot.lastPublicationOperationId &&
        JSON.stringify(beforeResume.snapshot.lastPublication) ===
          JSON.stringify(after.snapshot.lastPublication),
      expectedCodex: actualCodexExpected.artifact,
      proof: await shard.evidence(),
      observations: await capability.observations(),
      writer: await placement.writerStatus(setup.owner),
    };
  }

  if (materialFault !== undefined) {
    if (
      ![
        "missing-artifact",
        "changed-artifact",
        "missing-native",
        "changed-native",
        "missing-files",
        "changed-files",
      ].includes(materialFault)
    )
      throw new Error("Unknown material failure case.");
    if (materialFault === "missing-files" || materialFault === "changed-files") {
      await env.HARNESS_FILES_STORE.getByName(runId).injectMaterialFault(
        firstCheckpoint.filesystem.id,
        materialFault,
      );
    } else {
      await capability.injectFault(materialFault, firstCheckpoint.native);
    }
    const rejected = await shard
      .resumeProcess(resumeOperation)
      .then(() => ({ rejected: false, message: "Resume unexpectedly succeeded." }), noNativeResume);
    const status = await shard.processResumeStatus({
      runId,
      operationId: "resume-one",
      control: control3,
    });
    const after = await state.threadSupervisor.execute({ type: "read", runId, control: control3 });
    return {
      kind: "product-c-workerd-material-failure",
      materialFault,
      rejected,
      status,
      before: {
        generation: beforeResume.currentPublisher.generation,
        preparedFacet: beforeResume.snapshot.preparedFacet,
      },
      after: {
        generation: after.currentPublisher.generation,
        preparedFacet: after.snapshot.preparedFacet,
        lifecycle: after.snapshot.lifecycle,
      },
      unchangedPublication:
        beforeResume.snapshot.lastPublicationOperationId ===
          after.snapshot.lastPublicationOperationId &&
        JSON.stringify(beforeResume.snapshot.lastPublication) ===
          JSON.stringify(after.snapshot.lastPublication),
      proof: await shard.evidence(),
      writer: await placement.writerStatus(setup.owner),
      observations: await capability.observations(),
    };
  }

  const resumed = await shard.resumeProcess(resumeOperation);
  const active = await state.threadSupervisor.execute({ type: "read", runId, control: control3 });
  const journalAtContinuation = await state.runStore.execute({ type: "read", runId });
  const continuationCheckpoint = journalAtContinuation.snapshot.requests?.checkpoint;
  if (continuationCheckpoint === undefined)
    throw new Error("Resume did not retain the committed checkpoint.");
  const continuation = {
    runId,
    processId,
    executionOperationId,
    resumeOperationId: "resume-one",
    control: control3,
    runStore: {
      controlKey,
      supervisor,
      currentPublisher: publisherFor(
        active.currentPublisher.generation,
        active.currentPublisher.facetNonce,
      ),
      request: { requestId: "turn-two", input: turnTwo },
      checkpoint: continuationCheckpoint,
    },
  };
  const running = shard.continueProcess(continuation, "public-continueProcess-codex");
  await Promise.race([
    env.HARNESS_RUN_STORE.getByName(runId).waitForFinish("turn-two"),
    running.then((result) => {
      throw new Error(`C continuation ended before journal finish: ${JSON.stringify(result)}`);
    }),
  ]);
  await shard.commitProcessCheckpoint({
    runId,
    processId,
    executionOperationId,
    processOperationId: "resume-one",
    requestId: "turn-two",
    nativeSessionId: "product-native-session",
    control: control3,
    publisher: active.currentPublisher,
    checkpoint: await capability.material("turn-two"),
  });
  const continued = await running;
  const last = await state.threadSupervisor.execute({ type: "read", runId, control: control3 });
  const finalJournal = await state.runStore.execute({ type: "read", runId });
  const finalCheckpoint = finalJournal.snapshot.requests?.checkpoint;
  if (finalCheckpoint === undefined)
    throw new Error("The Codex continuation did not commit a checkpoint.");
  const finalFiles = await state.filesStore.execute({
    type: "readCheckpoint",
    runId,
    publisher: last.currentPublisher,
    checkpointId: finalCheckpoint.filesystem.id,
  });
  const fileText = (path: string) => {
    const file = finalFiles.files.find((entry) => entry.path === path);
    return file === undefined ? null : new TextDecoder().decode(file.bytes);
  };
  return {
    kind: "product-c-workerd-public-chain",
    initial: setup.firstProcess,
    resumed,
    continued: continued.processes[0],
    completedRequests: finalJournal.snapshot.requests?.entries.map((entry) => ({
      requestId: entry.request.requestId,
      status: entry.status,
      finishStatus: entry.finish?.status,
    })),
    restoreModes: {
      claude: "same-variant-serialized-checkpoint",
      codex: "cross-variant-fresh-boot",
    },
    currentPublication: last.snapshot.lastPublication,
    checkpoints: {
      initial: setup.initialReferences,
      claude: firstCheckpoint,
      codex: finalCheckpoint,
      files: finalFiles.checkpoint,
    },
    files: {
      workspace: fileText("file.txt"),
      codex: fileText("codex-turn.txt"),
      claudeTranscript: fileText(".claude/projects/-workspace/product-native-session.jsonl"),
    },
    proof: await shard.evidence(),
    observations: await capability.observations(),
    writer: await placement.writerStatus(setup.owner),
  };
}
