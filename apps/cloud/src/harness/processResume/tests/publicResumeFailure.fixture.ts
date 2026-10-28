import {
  setup,
  completionInput,
  complete,
  resumeInput,
  type ProofEnv,
} from "./publicResumeSetup.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";
import { runFirst } from "./publicResumeProof.fixture.ts";
import { createHarnessDurableState } from "../../HarnessDurableState.ts";

const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => false,
    () => true,
  );

export async function completionFailure(env: ProofEnv, scenario: string) {
  const fixture = await setup(env, scenario, { failDispose: scenario === "unjoined" });
  const running = fixture.shard.runShard(fixture.shardInput, "completion-proof");
  await fixture.store.waitForFinish("turn-one");
  const { input } = await completionInput(fixture);
  if (scenario === "wrong-bindings") {
    const mutations = [
      { ...input, requestId: "another-request" },
      {
        ...input,
        publisher: { ...input.publisher, publisherKey: "wrong-publisher-key-".repeat(3) },
      },
      { ...input, nativeSessionId: "another-native-session" },
      { ...input, checkpoint: { ...input.checkpoint, parentCheckpointId: "another-parent" } },
      { ...input, control: { ...input.control, controlKey: "wrong-control-key-".repeat(3) } },
    ];
    const denied = [];
    for (const mutation of mutations)
      denied.push(await rejected(fixture.shard.commitProcessCheckpoint(mutation)));
    const before = await fixture.shard.evidence();
    await fixture.shard.commitProcessCheckpoint(input);
    const duplicate = await fixture.shard.commitProcessCheckpoint(input);
    const changedDuplicate = await rejected(
      fixture.shard.commitProcessCheckpoint({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          files: input.checkpoint.files.map((file) => ({ ...file, bytes: new Uint8Array([9]) })),
        },
      }),
    );
    const result = await running;
    return {
      denied,
      before,
      duplicate: duplicate.status,
      changedDuplicate,
      result,
      releases: await fixture.placement.releases(),
    };
  }
  let supplied = input;
  if (scenario === "changed-bytes")
    supplied = {
      ...input,
      checkpoint: {
        ...input.checkpoint,
        files: input.checkpoint.files.map((file) =>
          file.path === "workspace.txt"
            ? { ...file, bytes: new TextEncoder().encode("different bytes") }
            : file,
        ),
      },
    };
  if (scenario === "wrong-native-envelope")
    supplied = { ...input, checkpoint: { ...input.checkpoint, checkpointId: "another-envelope" } };
  if (scenario === "lost-files") await fixture.files.armFailure("writeCheckpoint", true);
  if (scenario === "partial-supervisor") await fixture.a.armFailure("commitCheckpoint", false);
  if (scenario === "lost-supervisor") await fixture.a.armFailure("commitCheckpoint", true);
  if (scenario === "stale-authority") {
    fixture.durable = createHarnessDurableState(
      fixture.env,
      fixture.runId,
      await fixture.shard.processIncarnationFence(),
    );
    await fixture.durable.beginDrain({
      control: fixtureControl(2),
      publisher: input.publisher,
      expectedGeneration: input.publisher.generation,
      operationId: "external-drain",
      nextControl: fixtureControl(3),
    });
  }
  if (scenario === "terminal-write" || scenario === "terminal-reply")
    await fixture.shard.armTransactionFailure(scenario === "terminal-reply");
  const denied = await rejected(fixture.shard.commitProcessCheckpoint(supplied));
  const result = await running;
  const duplicateDenied = await rejected(fixture.shard.commitProcessCheckpoint(supplied));
  const state = await fixture.a.execute({
    type: "read",
    runId: fixture.runId,
    control: fixtureControl(scenario === "stale-authority" ? 3 : 2),
  });
  return {
    denied,
    duplicateDenied,
    result,
    evidence: await fixture.shard.evidence(),
    releases: await fixture.placement.releases(),
    ownership: await fixture.placement.ownership(fixture.owner),
    checkpoint: state.snapshot.checkpoint.checkpointId,
    observations: await fixture.files.observations(),
  };
}

export async function resumeFailure(env: ProofEnv, scenario: string) {
  const fixture = await setup(env, scenario);
  await runFirst(fixture);
  const operation = await resumeInput(fixture);
  if (scenario === "lost-publication") await fixture.a.armFailure("publishFreshFacet", true);
  if (scenario === "activation-failure") await fixture.a.armFailure("recordActivation", false);
  if (scenario === "unknown-authority") await fixture.a.failPublishedRead();
  const denied = await rejected(fixture.shard.resumeProcess(operation));
  const duplicateDenied = await rejected(fixture.shard.resumeProcess(operation));
  const status = await fixture.shard.processResumeStatus({
    runId: fixture.runId,
    operationId: operation.transition.operationId,
    control: fixtureControl(3),
  });
  return {
    denied,
    duplicateDenied,
    status,
    evidence: await fixture.shard.evidence(),
    releases: await fixture.placement.releases(),
    ownership: await fixture.placement.ownership(fixture.owner),
    observations: await fixture.files.observations(),
  };
}

export async function cancellationProof(env: ProofEnv) {
  const fixture = await setup(env, "cancel");
  await runFirst(fixture);
  const operation = await resumeInput(fixture);
  // The first read is checkpoint verification. Hold its real RPC before any fresh publication.
  await fixture.files.holdCommand("readCheckpoint");
  const resume = rejected(fixture.shard.resumeProcess(operation));
  await fixture.files.wait("command-entered:readCheckpoint");
  let cancelled = false;
  const cancellation = fixture.shard.cancelResumeProcess(operation).then((value) => {
    cancelled = true;
    return value;
  });
  // A round-trip through the owning shard lets cancellation reach its awaited join.
  const during = await fixture.shard.processResumeStatus({
    runId: fixture.runId,
    operationId: operation.transition.operationId,
    control: fixtureControl(3),
  });
  const settledBeforeRelease = cancelled;
  await fixture.files.release("command:readCheckpoint");
  const cancellationResult = await cancellation;
  const denied = await resume;
  const duplicateDenied = await rejected(fixture.shard.resumeProcess(operation));
  const final = await fixture.shard.processResumeStatus({
    runId: fixture.runId,
    operationId: operation.transition.operationId,
    control: fixtureControl(3),
  });
  return {
    during,
    settledBeforeRelease,
    cancellationResult,
    denied,
    duplicateDenied,
    final,
    evidence: await fixture.shard.evidence(),
    releases: await fixture.placement.releases(),
    observations: await fixture.files.observations(),
  };
}

export async function heldWorkProof(env: ProofEnv) {
  const fixture = await setup(env, "held-work", { holdWork: true });
  const running = fixture.shard.runShard(fixture.shardInput, "held-work");
  await fixture.files.wait("fetch-entered:turn-one");
  const beforeFetch = {
    evidence: await fixture.shard.evidence(),
    ownership: await fixture.placement.ownership(fixture.owner),
    releases: await fixture.placement.releases(),
  };
  await fixture.files.release("fetch:turn-one");
  await fixture.files.wait("callback-entered:turn-one");
  const beforeCallback = {
    evidence: await fixture.shard.evidence(),
    ownership: await fixture.placement.ownership(fixture.owner),
    releases: await fixture.placement.releases(),
  };
  await fixture.files.release("callback:turn-one");
  await fixture.store.waitForFinish("turn-one");
  await complete(fixture);
  const result = await running;
  return {
    beforeFetch,
    beforeCallback,
    result,
    releases: await fixture.placement.releases(),
    observations: await fixture.files.observations(),
  };
}

export async function cachedAuthorityProof(env: ProofEnv) {
  const fixture = await setup(env, "cached-authority");
  await runFirst(fixture);
  const operation = await resumeInput(fixture);
  const first = await fixture.shard.resumeProcess(operation);
  fixture.durable = createHarnessDurableState(
    fixture.env,
    fixture.runId,
    await fixture.shard.processIncarnationFence(),
  );
  const state = await fixture.a.execute({
    type: "read",
    runId: fixture.runId,
    control: fixtureControl(3),
  });
  await fixture.durable.beginDrain({
    control: fixtureControl(3),
    publisher: state.currentPublisher,
    expectedGeneration: state.currentPublisher.generation,
    operationId: "external-takeover",
    nextControl: fixtureControl(4),
  });
  const duplicateDenied = await rejected(fixture.shard.resumeProcess(operation));
  const before = await fixture.shard.evidence();
  try {
    await fixture.shard.rehydrate();
  } catch {
    /* ctx.abort rejects its own RPC. */
  }
  const reconstructed = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const after = await reconstructed.evidence();
  const status = await reconstructed.processResumeStatus({
    runId: fixture.runId,
    operationId: operation.transition.operationId,
    control: fixtureControl(4),
  });
  const runDenied = await rejected(reconstructed.runShard(fixture.shardInput, "forbidden-replay"));
  return {
    first,
    duplicateDenied,
    staleWriterRefused: await fixture.placement.staleWriterRefused(fixture.owner),
    before,
    after,
    status,
    runDenied,
    ownership: await fixture.placement.ownership(fixture.owner),
  };
}

export async function publicationCancellationProof(env: ProofEnv) {
  const fixture = await setup(env, "publication-cancel");
  await runFirst(fixture);
  const operation = await resumeInput(fixture);
  await fixture.a.holdPublicationReply();
  const resume = rejected(fixture.shard.resumeProcess(operation));
  await fixture.a.waitPublicationReply();
  let cancelled = false;
  const cancellation = fixture.shard.cancelResumeProcess(operation).then((value) => {
    cancelled = true;
    return value;
  });
  const during = await fixture.shard.processResumeStatus({
    runId: fixture.runId,
    operationId: operation.transition.operationId,
    control: fixtureControl(3),
  });
  const before = { cancelled, releases: await fixture.placement.releases() };
  await fixture.a.releasePublicationReply();
  await cancellation;
  const denied = await resume;
  const duplicateDenied = await rejected(fixture.shard.resumeProcess(operation));
  const final = await fixture.shard.processResumeStatus({
    runId: fixture.runId,
    operationId: operation.transition.operationId,
    control: fixtureControl(3),
  });
  const a = await fixture.a.execute({
    type: "read",
    runId: fixture.runId,
    control: fixtureControl(3),
  });
  return {
    during,
    before,
    denied,
    duplicateDenied,
    final,
    lifecycle: a.snapshot.lifecycle,
    ownership: await fixture.placement.ownership(fixture.owner),
    releases: await fixture.placement.releases(),
    observations: await fixture.files.observations(),
  };
}

export async function invocationFailureProof(
  env: ProofEnv,
  invocationFailure: "reject" | "failed-finish",
) {
  const fixture = await setup(env, invocationFailure, { invocationFailure });
  const result = await fixture.shard.runShard(fixture.shardInput, "invocation-failure");
  const journal = await fixture.store.execute({ type: "read", runId: fixture.runId });
  return {
    result,
    requestStatus: journal.snapshot.requests?.entries.at(-1)?.status,
    finishStatus: journal.snapshot.requests?.entries.at(-1)?.finish?.status,
    evidence: await fixture.shard.evidence(),
    ownership: await fixture.placement.ownership(fixture.owner),
    releases: await fixture.placement.releases(),
  };
}
