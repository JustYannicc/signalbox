import { setup, type ProofEnv } from "./publicResumeSetup.fixture.ts";
import { runFirst } from "./publicResumeProof.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";
import {
  continueTurn,
  finalState,
  reconstruct,
  rejected,
  resume,
} from "./publicEvictionProofSupport.fixture.ts";

export const publicEvictionPoints = [
  "before-turn-1",
  "after-turn-1",
  "after-replace",
  "after-turn-2",
  "after-turn-3",
  "before-stop",
  "double",
] as const;
export type PublicEvictionPoint = (typeof publicEvictionPoints)[number];

interface EvictionRecord {
  readonly point: PublicEvictionPoint;
  readonly beforeNonce: string;
  readonly afterNonce: string;
}

async function runSequence(
  env: ProofEnv,
  scenario: string,
  points: readonly PublicEvictionPoint[],
) {
  const fixture = await setup(env, `eviction-${scenario}`);
  const evictions: EvictionRecord[] = [];
  const evict = async (point: PublicEvictionPoint) => {
    if (points.includes(point)) evictions.push(await reconstruct(fixture, point));
  };

  await evict("before-turn-1");
  const first = await runFirst(fixture);
  const initialIdentityNonce = first.result.processes[0]?.identity?.incarnationNonce;
  if (initialIdentityNonce === undefined)
    throw new Error("The initial public C run did not return its process identity.");
  await evict("after-turn-1");

  const replacement = await resume(fixture);
  await evict("after-replace");
  const secondTurn = await continueTurn(fixture, {
    requestId: "turn-two",
    resumeOperationId: "resume-one",
    control: fixtureControl(3),
    publisher: replacement.callerPublisher,
    checkpoint: first.committed.material.reference,
    staleCheckpoint: fixture.initialMaterial.reference,
  });
  await evict("after-turn-2");

  const thirdTurn = await continueTurn(fixture, {
    requestId: "turn-three",
    resumeOperationId: "resume-one",
    control: fixtureControl(3),
    publisher: replacement.callerPublisher,
    checkpoint: secondTurn.completed.material.reference,
    staleCheckpoint: first.committed.material.reference,
  });
  await evict("after-turn-3");

  const status = await fixture.shard.processResumeStatus({
    runId: fixture.runId,
    operationId: replacement.operation.transition.operationId,
    control: fixtureControl(3),
  });
  const staleResumeDenied = await rejected(fixture.shard.resumeProcess(replacement.operation));
  const staleContinueDenied = await rejected(
    fixture.shard.continueProcess(
      {
        ...thirdTurn.request,
        runStore: {
          ...thirdTurn.request.runStore,
          request: {
            ...thirdTurn.request.runStore.request,
            requestId: "after-turn-three-stale-checkpoint",
          },
          checkpoint: secondTurn.completed.material.reference,
        },
      },
      "after-turn-three-stale-checkpoint",
    ),
  );
  const staleStopDenied = await rejected(
    fixture.shard.stopIdleProcess({
      ...thirdTurn.request,
      runStore: {
        ...thirdTurn.request.runStore,
        checkpoint: secondTurn.completed.material.reference,
      },
    }),
  );
  const preparedCountBeforeStop = Object.keys(await fixture.files.observations()).filter((key) =>
    key.includes("/prepared:"),
  ).length;
  await evict("before-stop");

  const stopped = await fixture.shard.stopIdleProcess({
    ...thirdTurn.request,
    runStore: {
      ...thirdTurn.request.runStore,
      checkpoint: thirdTurn.completed.material.reference,
    },
  });
  const duplicateStop = await fixture.shard.stopIdleProcess({
    ...thirdTurn.request,
    runStore: {
      ...thirdTurn.request.runStore,
      checkpoint: thirdTurn.completed.material.reference,
    },
  });
  const preparedCountAfterStop = Object.keys(await fixture.files.observations()).filter((key) =>
    key.includes("/prepared:"),
  ).length;
  const journal = await fixture.store.execute({ type: "read", runId: fixture.runId });
  const requests = journal.snapshot.requests?.entries ?? [];
  return {
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
    evictionRestores: (await fixture.shard.evidence()).evictionRestores,
    resumes: (await fixture.shard.evidence()).resumes.map((resume) => ({
      phase: resume.phase,
      prepared: resume.prepared,
    })),
    evictions,
    replacements: [replacement].map((item) => ({
      incarnationNonce: item.identity.incarnationNonce,
      priorGeneration: item.operation.transition.expectedFacetGeneration,
      publishedFacetNonce: item.physicalPublisher.facetNonce,
      publishedGeneration: item.physicalPublisher.generation,
      callerPublisher: item.callerPublisher,
    })),
    physicalPublicationAfterTurnTwo: secondTurn.physicalPublisher,
    physicalPublicationAfterTurnThree: thirdTurn.physicalPublisher,
    preparedCountBeforeStop,
    preparedCountAfterStop,
    duplicateResumeDenied: replacement.duplicateDenied,
    duplicateContinuationsMatch: secondTurn.duplicateMatches && thirdTurn.duplicateMatches,
    callerPublisherStable:
      JSON.stringify(secondTurn.request.runStore.currentPublisher) ===
      JSON.stringify(thirdTurn.request.runStore.currentPublisher),
    staleCheckpointDenied: secondTurn.staleCheckpointDenied && thirdTurn.staleCheckpointDenied,
    staleResumeDenied,
    staleContinueDenied,
    staleStopDenied,
    statusAvailableAfterTurnThree: status.status !== "missing",
    stopped,
    duplicateStop,
  };
}

export async function publicEvictionMatrixProof(env: ProofEnv, point: PublicEvictionPoint) {
  const points: readonly PublicEvictionPoint[] =
    point === "double" ? ["after-turn-1", "after-replace"] : [point];
  const baseline = await runSequence(env, `${point}-baseline`, []);
  const candidate = await runSequence(env, `${point}-evicted`, points);
  return { baseline, candidate };
}
