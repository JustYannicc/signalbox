import { complete, resumeInput, type ProofSetup } from "./publicResumeSetup.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";
import { reference } from "./releaseMaterial.ts";

export type CallerPublisher = {
  readonly generation: number;
  readonly facetNonce: string;
  readonly publisherKey: string;
};

export const readPublisher = async (
  fixture: ProofSetup,
  control: ReturnType<typeof fixtureControl>,
) => {
  const state = await fixture.durable.threadSupervisor.execute({
    type: "read",
    runId: fixture.runId,
    control,
  });
  return state.currentPublisher;
};

export async function reconstruct<T extends string>(fixture: ProofSetup, point: T) {
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
  return { point, beforeNonce, afterNonce };
}

export const rejected = (operation: Promise<unknown>) =>
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

export async function resume(fixture: ProofSetup) {
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

export async function continueTurn(
  fixture: ProofSetup,
  input: {
    readonly requestId: string;
    readonly resumeOperationId: string;
    readonly control: ReturnType<typeof fixtureControl>;
    readonly publisher: CallerPublisher;
    readonly checkpoint: Awaited<ReturnType<typeof complete>>["material"]["reference"];
    readonly staleCheckpoint: Awaited<ReturnType<typeof complete>>["material"]["reference"];
    readonly afterTurn?: "keep-alive" | "dispose";
  },
) {
  const request = {
    ...(await continuationInput(fixture, input)),
    afterTurn: input.afterTurn ?? "keep-alive",
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

export function finalState(
  checkpoint: Awaited<ReturnType<typeof complete>>["material"]["checkpoint"],
) {
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
