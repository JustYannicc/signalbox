import { setup, resumeInput, type ProofEnv } from "./publicResumeSetup.fixture.ts";
import { runFirst } from "./publicResumeProof.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";
import {
  continueTurn,
  finalState,
  readPublisher,
  reconstruct,
  rejected,
  resume,
  type CallerPublisher,
} from "./publicEvictionProofSupport.fixture.ts";

export const publicResumeAfterEvictionCases = [
  "before-turn-two",
  "before-turn-two-dispose",
  "after-turn-two-stop",
  "after-turn-two-dispose",
] as const;
export type PublicResumeAfterEvictionCase = (typeof publicResumeAfterEvictionCases)[number];

async function runSequence(
  env: ProofEnv,
  scenario: PublicResumeAfterEvictionCase,
  evicted: boolean,
) {
  const fixture = await setup(env, `resume-two-${scenario}-${evicted ? "evicted" : "baseline"}`);
  const evictions: {
    readonly point: string;
    readonly beforeNonce: string;
    readonly afterNonce: string;
  }[] = [];
  const first = await runFirst(fixture);
  const initialIdentityNonce = first.result.processes[0]?.identity?.incarnationNonce;
  if (initialIdentityNonce === undefined)
    throw new Error("The initial public C run did not return its process identity.");

  const replacement = await resume(fixture);
  const evictBeforeTurnTwo =
    scenario === "before-turn-two" || scenario === "before-turn-two-dispose";
  if (evicted && evictBeforeTurnTwo) evictions.push(await reconstruct(fixture, "after-replace"));

  const secondTurn = await continueTurn(fixture, {
    requestId: "turn-two",
    resumeOperationId: "resume-one",
    control: fixtureControl(3),
    publisher: replacement.callerPublisher,
    checkpoint: first.committed.material.reference,
    staleCheckpoint: fixture.initialMaterial.reference,
    afterTurn:
      scenario === "before-turn-two-dispose" || scenario === "after-turn-two-dispose"
        ? "dispose"
        : "keep-alive",
  });

  if (evicted && !evictBeforeTurnTwo) evictions.push(await reconstruct(fixture, "after-turn-2"));

  let stoppedAfterTurnTwo: unknown = null;
  let duplicateStopAfterTurnTwo: unknown = null;
  if (scenario !== "before-turn-two-dispose" && scenario !== "after-turn-two-dispose") {
    const stopInput = {
      ...secondTurn.request,
      runStore: {
        ...secondTurn.request.runStore,
        checkpoint: secondTurn.completed.material.reference,
      },
    };
    stoppedAfterTurnTwo = await fixture.shard.stopIdleProcess(stopInput);
    duplicateStopAfterTurnTwo = await fixture.shard.stopIdleProcess(stopInput);
  }

  const currentAPublisher = await readPublisher(fixture, fixtureControl(3));
  const preparedResumeTwo = await resumeInput(fixture, { observed: true, step: 2 });
  if (JSON.stringify(preparedResumeTwo.transition.publisher) !== JSON.stringify(currentAPublisher))
    throw new Error("The resume-two transition did not use the current A publisher.");
  const resumeTwoOperation = {
    ...preparedResumeTwo,
    runStore: {
      ...preparedResumeTwo.runStore,
      // C's eviction restore is private. The caller still identifies the public resume-one op.
      currentPublisher: replacement.callerPublisher,
    },
  };
  const deniedBeforeValid = {
    staleControl: await rejected(
      fixture.shard.resumeProcess({
        ...resumeTwoOperation,
        transition: { ...resumeTwoOperation.transition, control: fixtureControl(2) },
      }),
    ),
    stalePublisher: await rejected(
      fixture.shard.resumeProcess({
        ...resumeTwoOperation,
        runStore: {
          ...resumeTwoOperation.runStore,
          currentPublisher: {
            ...replacement.callerPublisher,
            generation: replacement.callerPublisher.generation - 1,
            facetNonce: fixture.process.priorFacetNonce,
            publisherKey: fixture.publisherKey(2),
          },
        },
      }),
    ),
    staleCheckpoint: await rejected(
      fixture.shard.resumeProcess({
        ...resumeTwoOperation,
        runStore: {
          ...resumeTwoOperation.runStore,
          checkpoint: fixture.initialMaterial.reference,
        },
      }),
    ),
    wrongRequest: await rejected(
      fixture.shard.resumeProcess({
        ...resumeTwoOperation,
        previousStepId: "wrong-request",
      }),
    ),
  };
  const resumedTwo = await fixture.shard.resumeProcess(resumeTwoOperation);
  const publicationAfterResumeTwo = await readPublisher(
    fixture,
    resumeTwoOperation.transition.nextControl,
  );
  if (publicationAfterResumeTwo.facetNonce !== resumedTwo.identity.incarnationNonce)
    throw new Error("The returned resume-two identity was not the published A facet identity.");
  const duplicateResumeTwoDenied = await rejected(fixture.shard.resumeProcess(resumeTwoOperation));
  const resumeTwoCallerPublisher = {
    generation: resumeTwoOperation.transition.expectedFacetGeneration + 1,
    facetNonce: resumedTwo.identity.incarnationNonce,
    publisherKey: resumeTwoOperation.runStore.nextPublisherKey,
  } satisfies CallerPublisher;

  const thirdTurn = await continueTurn(fixture, {
    requestId: "turn-three",
    resumeOperationId: "resume-two",
    control: fixtureControl(4),
    publisher: resumeTwoCallerPublisher,
    checkpoint: secondTurn.completed.material.reference,
    staleCheckpoint: first.committed.material.reference,
    afterTurn: "keep-alive",
  });
  const status = await fixture.shard.processResumeStatus({
    runId: fixture.runId,
    operationId: resumeTwoOperation.transition.operationId,
    control: fixtureControl(4),
  });
  const finalStopInput = {
    ...thirdTurn.request,
    runStore: {
      ...thirdTurn.request.runStore,
      checkpoint: thirdTurn.completed.material.reference,
    },
  };
  const stopped = await fixture.shard.stopIdleProcess(finalStopInput);
  const duplicateStop = await fixture.shard.stopIdleProcess(finalStopInput);
  const journal = await fixture.store.execute({ type: "read", runId: fixture.runId });
  const evidence = await fixture.shard.evidence();
  const requests = journal.snapshot.requests?.entries ?? [];
  return {
    scenario,
    final: finalState(thirdTurn.completed.material.checkpoint),
    initialIdentityNonce,
    thread: {
      threadId: "plain-thread",
      count: requests.length,
      requests: requests.map((entry) => ({
        requestId: entry.request.requestId,
        status: entry.status,
      })),
    },
    evictions,
    evictionRestores: evidence.evictionRestores,
    resumes: evidence.resumes.map((item) => ({ phase: item.phase, prepared: item.prepared })),
    resumeOne: {
      operationId: replacement.operation.transition.operationId,
      callerPublisher: replacement.callerPublisher,
      duplicateDenied: replacement.duplicateDenied,
    },
    resumeTwo: {
      previousOperationId: resumeTwoOperation.previousOperationId,
      previousStepId: resumeTwoOperation.previousStepId,
      runStoreProcessOperationId: resumeTwoOperation.runStore.processOperationId,
      requestId: resumeTwoOperation.runStore.request.requestId,
      requestParentCheckpoint: resumeTwoOperation.runStore.checkpoint,
      callerPublisher: resumeTwoOperation.runStore.currentPublisher,
      transitionPublisher: resumeTwoOperation.transition.publisher,
      currentAPublisher,
      identity: resumedTwo.identity,
      publishedPublisher: {
        generation: publicationAfterResumeTwo.generation,
        facetNonce: publicationAfterResumeTwo.facetNonce,
      },
      duplicateDenied: duplicateResumeTwoDenied,
      deniedBeforeValid,
    },
    turnTwo: {
      parentCheckpoint: first.committed.material.reference,
      completedCheckpoint: secondTurn.completed.material.reference,
      afterTurn: secondTurn.request.afterTurn,
      completed: secondTurn.completed.result.status,
      stopped: stoppedAfterTurnTwo,
      duplicateStop: duplicateStopAfterTurnTwo,
    },
    turnThree: {
      completed: thirdTurn.completed.result.status,
      duplicateMatches: thirdTurn.duplicateMatches,
      staleCheckpointDenied: thirdTurn.staleCheckpointDenied,
    },
    statusAvailableAfterTurnThree: status.status !== "missing",
    stopped,
    duplicateStop,
  };
}

export async function publicResumeAfterEvictionProof(
  env: ProofEnv,
  scenario: PublicResumeAfterEvictionCase,
) {
  const baseline = await runSequence(env, scenario, false);
  const candidate = await runSequence(env, scenario, true);
  return { baseline, candidate };
}
