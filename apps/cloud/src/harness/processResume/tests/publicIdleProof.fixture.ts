import { setup, complete, resumeInput, type ProofEnv } from "./publicResumeSetup.fixture.ts";
import { runFirst } from "./publicResumeProof.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";
import { reference } from "./releaseMaterial.ts";

export async function publicIdleProof(
  env: ProofEnv,
  mode: "continue" | "stop" | "reconstruct" = "continue",
) {
  const fixture = await setup(env, `retained-idle-${mode}`);
  const first = await runFirst(fixture);
  const operation = await resumeInput(fixture, { observed: true });
  const resumed = await fixture.shard.resumeProcess(operation);
  const currentPublisher = {
    generation: 3,
    facetNonce: resumed.identity.incarnationNonce,
    publisherKey: fixture.publisherKey(3),
  };
  const request = async (id: string, checkpoint: typeof first.committed.material.reference) => ({
    runId: fixture.runId,
    processId: fixture.process.processId,
    executionOperationId: fixture.shardInput.executionOperationId,
    resumeOperationId: operation.transition.operationId,
    control: fixtureControl(3),
    runStore: {
      controlKey: fixture.controlKey,
      supervisor: fixture.supervisor,
      currentPublisher,
      request: {
        requestId: id,
        input: await reference(id + "-input", new TextEncoder().encode(id)),
      },
      checkpoint,
    },
  });
  const secondInput = {
    ...(await request("turn-two", first.committed.material.reference)),
    afterTurn: "keep-alive" as const,
  };
  const second = fixture.shard.continueProcess(secondInput, "retained-turn-two");
  const duplicate = fixture.shard.continueProcess(secondInput, "duplicate-turn-two");
  const concurrent = await fixture.shard
    .continueProcess(
      {
        ...secondInput,
        runStore: {
          ...secondInput.runStore,
          request: { ...secondInput.runStore.request, requestId: "concurrent-turn" },
        },
      },
      "concurrent-turn",
    )
    .then(
      () => false,
      () => true,
    );
  const conflicting = await fixture.shard
    .continueProcess({ ...secondInput, afterTurn: "dispose" }, "changed-turn-two")
    .then(
      () => false,
      () => true,
    );
  await Promise.race([
    fixture.store.waitForFinish("turn-two"),
    second.then(() => {
      throw new Error("Turn two returned before checkpoint commit");
    }),
  ]);
  const secondCompleted = await complete(fixture, "turn-two", "resume-one", fixtureControl(3));
  const secondResult = await second;
  const duplicateResult = await duplicate;
  const idleEvidence = await fixture.shard.evidence();
  const idleOwnership = await fixture.placement.ownership(fixture.owner);
  const idleObservations = await fixture.files.observations();
  const duplicateAfter = await fixture.shard.continueProcess(secondInput, "duplicate-after-idle");
  if (mode !== "continue") {
    const stopInput = {
      ...secondInput,
      runStore: { ...secondInput.runStore, checkpoint: secondCompleted.material.reference },
    };
    const staleStop = await fixture.shard
      .stopIdleProcess({
        ...stopInput,
        runStore: { ...stopInput.runStore, checkpoint: first.committed.material.reference },
      })
      .then(
        () => false,
        () => true,
      );
    if (mode === "reconstruct") {
      const nonce = await fixture.shard.executionIncarnationNonce();
      try {
        await fixture.shard.rehydrate();
      } catch {
        /* The test deliberately evicts C. */
      }
      const reconstructed = fixture.env.PROCESS_EXECUTION_SHARDS.getByName(
        fixture.owner,
      ) as unknown as typeof fixture.shard;
      const currentNonce = await reconstructed.executionIncarnationNonce();
      const stopped = await reconstructed.stopIdleProcess(stopInput);
      const duplicateStop = await reconstructed.stopIdleProcess(stopInput);
      const continuationDenied = await reconstructed
        .continueProcess(stopInput, "after-reconstruction")
        .then(
          () => false,
          () => true,
        );
      return {
        stopped,
        duplicateStop,
        continuationDenied,
        changed: nonce !== currentNonce,
        staleStop,
        finalOwnership: await fixture.placement.ownership(fixture.owner),
        terminalCount: (await reconstructed.evidence()).terminal.length,
      };
    }
    const stopped = await fixture.shard.stopIdleProcess(stopInput);
    const duplicateStop = await fixture.shard.stopIdleProcess(stopInput);
    const conflictStop = await fixture.shard
      .stopIdleProcess({ ...stopInput, control: fixtureControl(4) })
      .then(
        () => false,
        () => true,
      );
    const afterStopDenied = await fixture.shard
      .continueProcess(
        {
          ...stopInput,
          runStore: {
            ...stopInput.runStore,
            request: { ...stopInput.runStore.request, requestId: "after-stop" },
          },
        },
        "after-stop",
      )
      .then(
        () => false,
        () => true,
      );
    return {
      stopped,
      duplicateStop,
      conflictStop,
      afterStopDenied,
      staleStop,
      idleOwnership,
      finalOwnership: await fixture.placement.ownership(fixture.owner),
      finalEvidence: await fixture.shard.evidence(),
      observations: await fixture.files.observations(),
      releases: await fixture.placement.releases(),
      identity: resumed.identity,
    };
  }
  const thirdInput = {
    ...(await request("turn-three", secondCompleted.material.reference)),
    afterTurn: "dispose" as const,
  };
  const stale = await fixture.shard
    .continueProcess(
      {
        ...thirdInput,
        runStore: { ...thirdInput.runStore, checkpoint: first.committed.material.reference },
      },
      "stale-turn-three",
    )
    .then(
      () => false,
      () => true,
    );
  const third = fixture.shard.continueProcess(thirdInput, "continued-turn-three");
  await Promise.race([
    fixture.store.waitForFinish("turn-three"),
    third.then(() => {
      throw new Error("Turn three returned before checkpoint commit");
    }),
  ]);
  await complete(fixture, "turn-three", "resume-one", fixtureControl(3));
  const thirdResult = await third;
  const { afterTurn: _afterTurn, ...defaultThirdInput } = thirdInput;
  const normalizedDuplicate = await fixture.shard.continueProcess(
    defaultThirdInput,
    "omitted-dispose",
  );
  const earlierDuplicate = await fixture.shard.continueProcess(secondInput, "earlier-after-final");
  const finalModeConflict = await fixture.shard
    .continueProcess({ ...thirdInput, afterTurn: "keep-alive" }, "changed-final-mode")
    .then(
      () => false,
      () => true,
    );
  const journal = await fixture.store.execute({ type: "read", runId: fixture.runId });
  const finalOwnership = await fixture.placement.ownership(fixture.owner);
  const observations = await fixture.files.observations();
  return {
    resumed,
    second: secondResult.processes[0],
    third: thirdResult.processes[0],
    conflicting,
    concurrent,
    finalModeConflict,
    normalizedMatch: JSON.stringify(thirdResult) === JSON.stringify(normalizedDuplicate),
    earlierMatch: JSON.stringify(secondResult) === JSON.stringify(earlierDuplicate),
    stale,
    duplicatesMatch:
      JSON.stringify(secondResult) === JSON.stringify(duplicateResult) &&
      JSON.stringify(secondResult) === JSON.stringify(duplicateAfter),
    idleEvidence,
    idleOwnership,
    idleObservations,
    finalOwnership,
    observations,
    finalEvidence: await fixture.shard.evidence(),
    requests: journal.snapshot.requests?.entries.map((entry) => ({
      requestId: entry.request.requestId,
      generation: entry.generation,
      status: entry.status,
    })),
  };
}
