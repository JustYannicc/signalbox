import {
  setup,
  complete,
  resumeInput,
  type ProofEnv,
  type ProofSetup,
} from "./publicResumeSetup.fixture.ts";
import { runFirst } from "./publicResumeProof.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";
import { reference } from "./releaseMaterial.ts";

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

type CallerPublisher = {
  readonly generation: number;
  readonly facetNonce: string;
  readonly publisherKey: string;
};

const readPublisher = async (fixture: ProofSetup, control: ReturnType<typeof fixtureControl>) => {
  const state = await fixture.durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control,
  });
  return state.currentPublisher;
};

async function reconstruct(fixture: ProofSetup, point: PublicEvictionPoint) {
  const beforeNonce = await fixture.shard.executionIncarnationNonce();
  try {
    await fixture.shard.rehydrate();
  } catch {
    // rehydrate aborts its own RPC; the next namespace call constructs the replacement.
  }
  fixture.shard = fixture.env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const afterNonce = await fixture.shard.executionIncarnationNonce();
  if (beforeNonce === afterNonce)
    throw new Error(`The public C shard was not reconstructed at ${point}.`);
  return { point, beforeNonce, afterNonce } satisfies EvictionRecord;
}

const rejected = async (operation: Promise<unknown>) =>
  operation.then(
    () => false,
    () => true,
  );

async function continuationInput(
  fixture: ProofSetup,
  input: {
    readonly requestId: string;
    readonly control: ReturnType<typeof fixtureControl>;
    readonly resumeOperationId: string;
    readonly publisher: CallerPublisher;
    readonly checkpoint: Awaited<ReturnType<typeof complete>>["material"]["reference"];
  },
) {
  return {
    runId: fixture.runId,
    processId: fixture.process.processId,
    executionOperationId: fixture.shardInput.executionOperationId,
    resumeOperationId: input.resumeOperationId,
    control: input.control,
    runStore: {
      controlKey: fixture.controlKey,
      supervisor: fixture.supervisor,
      currentPublisher: input.publisher,
      request: {
        requestId: input.requestId,
        input: await reference(
          `${input.requestId}-input`,
          new TextEncoder().encode(input.requestId),
        ),
      },
      checkpoint: input.checkpoint,
    },
  };
}

async function resume(fixture: ProofSetup) {
  const operation = await resumeInput(fixture, { observed: true });
  const result = await fixture.shard.resumeProcess(operation);
  const publisher = await readPublisher(fixture, operation.transition.nextControl);
  if (publisher.facetNonce !== result.identity.incarnationNonce)
    throw new Error("The returned C resume identity was not the published facet identity.");
  const duplicateDenied = await rejected(fixture.shard.resumeProcess(operation));
  const callerPublisher = {
    generation: operation.transition.expectedFacetGeneration + 1,
    facetNonce: result.identity.incarnationNonce,
    publisherKey: operation.runStore.nextPublisherKey,
  } satisfies CallerPublisher;
  return {
    operation,
    identity: result.identity,
    callerPublisher,
    physicalPublisher: {
      generation: publisher.generation,
      facetNonce: publisher.facetNonce,
    },
    duplicateDenied,
  };
}

async function continueTurn(
  fixture: ProofSetup,
  input: {
    readonly requestId: "turn-two" | "turn-three";
    readonly resumeOperationId: "resume-one";
    readonly control: ReturnType<typeof fixtureControl>;
    readonly publisher: CallerPublisher;
    readonly checkpoint: Awaited<ReturnType<typeof complete>>["material"]["reference"];
    readonly staleCheckpoint: Awaited<ReturnType<typeof complete>>["material"]["reference"];
  },
) {
  const request = {
    ...(await continuationInput(fixture, input)),
    afterTurn: "keep-alive" as const,
  };
  const staleRequest = {
    ...request,
    runStore: {
      ...request.runStore,
      request: {
        ...request.runStore.request,
        requestId: `${input.requestId}-stale-checkpoint`,
      },
      checkpoint: input.staleCheckpoint,
    },
  };
  const staleCheckpointDenied = await rejected(
    fixture.shard.continueProcess(staleRequest, `${input.requestId}-stale-checkpoint`),
  );
  const running = fixture.shard.continueProcess(request, `${input.requestId}-public-request`);
  const duplicate = fixture.shard.continueProcess(request, `${input.requestId}-duplicate`);
  await Promise.race([
    fixture.store.waitForFinish(input.requestId),
    running.then((result) => {
      throw new Error(
        `Turn ${input.requestId} returned before checkpoint handoff: ${JSON.stringify(result)}`,
      );
    }),
  ]);
  const completed = await complete(
    fixture,
    input.requestId,
    input.resumeOperationId,
    input.control,
  );
  const result = await running;
  const duplicateResult = await duplicate;
  const physicalPublisher = await readPublisher(fixture, input.control);
  return {
    request,
    result,
    physicalPublisher: {
      generation: physicalPublisher.generation,
      facetNonce: physicalPublisher.facetNonce,
    },
    duplicateMatches: JSON.stringify(result) === JSON.stringify(duplicateResult),
    staleCheckpointDenied,
    completed,
  };
}

function finalState(checkpoint: Awaited<ReturnType<typeof complete>>["material"]["checkpoint"]) {
  const nativeFile = checkpoint.files.find((file) => file.path === "native.json");
  const workspaceFile = checkpoint.files.find((file) => file.path === "workspace.txt");
  if (nativeFile === undefined || workspaceFile === undefined)
    throw new Error("The final public C checkpoint omitted conversation or workspace state.");
  const native = JSON.parse(new TextDecoder().decode(nativeFile.bytes)) as {
    readonly nativeSessionId: string;
    readonly transcript: readonly string[];
  };
  return {
    nativeSessionId: native.nativeSessionId,
    conversation: native.transcript,
    workspace: new TextDecoder().decode(workspaceFile.bytes),
  };
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
