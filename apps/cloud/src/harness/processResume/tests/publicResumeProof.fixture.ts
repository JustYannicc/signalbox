import { createHarnessDurableState } from "../../HarnessDurableState.ts";
import {
  setup,
  complete,
  resumeInput,
  type ProofEnv,
  type ProofSetup,
} from "./publicResumeSetup.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";
import { reference } from "./releaseMaterial.ts";

const facetTransportObservations = (observations: Readonly<Record<string, unknown>>) =>
  Object.entries(observations)
    .filter(([key]) => key.includes("/facet-transport:"))
    .map(([, value]) => value);

export async function runFirst(fixture: ProofSetup) {
  const running = fixture.shard.runShard(fixture.shardInput, "initial-public-request");
  await Promise.race([
    fixture.store.waitForFinish("turn-one"),
    running.then(async (result) => {
      throw new Error(
        `The first shard finished before checkpoint handoff: ${JSON.stringify({ result, observations: await fixture.files.observations() })}`,
      );
    }),
  ]);
  const committed = await complete(fixture);
  const result = await running;
  return { committed, result };
}

export async function publicResumeProof(
  env: ProofEnv,
  observed: boolean,
  mismatched = false,
  transportOptions: {
    readonly omitInitialBootstrap?: boolean;
  } = {},
) {
  const fixture = await setup(
    env,
    mismatched ? "mismatched-observation" : observed ? "positive" : "missing-observation",
    transportOptions,
  );
  const shardNonce = await fixture.shard.executionIncarnationNonce();
  const initial = await runFirst(fixture);
  const before = await fixture.a.execute({
    type: "read",
    runId: fixture.runId,
    control: fixtureControl(2),
  });
  const beforeInstance = await fixture.a.instance();
  const filesInstance = await fixture.files.instance();
  await fixture.a.rehydrate().catch(() => undefined);
  await fixture.files.rehydrate().catch(() => undefined);
  fixture.a = env.HARNESS_THREAD_SUPERVISOR.getByName(fixture.runId);
  fixture.files = env.HARNESS_FILES_STORE.getByName(fixture.runId);
  fixture.durable = createHarnessDurableState(env, fixture.runId);
  const after = await fixture.a.execute({
    type: "read",
    runId: fixture.runId,
    control: fixtureControl(2),
  });
  const rehydrated =
    beforeInstance !== (await fixture.a.instance()) &&
    filesInstance !== (await fixture.files.instance());
  const operation = await resumeInput(fixture, { observed, mismatched });
  const invalidBefore = await fixture.a.execute({
    type: "read",
    runId: fixture.runId,
    control: fixtureControl(2),
  });
  const invalidBootstrapOperations: unknown[] = [
    { ...operation, productBootstrap: undefined },
    { ...operation, productBootstrap: { ...operation.productBootstrap, provider: "agent-sdk" } },
    {
      ...operation,
      productBootstrap: { ...operation.productBootstrap, provider: "codex" },
    },
    {
      ...operation,
      productBootstrap: { ...operation.productBootstrap, preparedReleaseId: "" },
    },
    {
      ...operation,
      productBootstrap: {
        ...operation.productBootstrap,
        preparedReleaseId: "another-release",
      },
    },
    {
      ...operation,
      productBootstrap: { ...operation.productBootstrap, restoreMode: "inferred" },
    },
    {
      ...operation,
      productBootstrap: { ...operation.productBootstrap, resolveInitialAccess: () => undefined },
    },
    { ...operation, localBindings: { resolveTurnAccess: () => undefined } },
  ];
  const invalidBootstrapRejected = await Promise.all(
    invalidBootstrapOperations.map((invalidOperation) =>
      fixture.shard.resumeProcess(invalidOperation).then(
        () => false,
        () => true,
      ),
    ),
  );
  const invalidAfter = await fixture.a.execute({
    type: "read",
    runId: fixture.runId,
    control: fixtureControl(2),
  });
  const invalidEvidence = await fixture.shard.evidence();
  const invalidBootstrapDidNotDrain =
    JSON.stringify(invalidBefore.snapshot) === JSON.stringify(invalidAfter.snapshot) &&
    invalidBefore.currentPublisher.generation === invalidAfter.currentPublisher.generation &&
    invalidEvidence.resumes.length === 0;
  const resumed = await fixture.shard.resumeProcess(operation).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : "Resume rejected",
    }),
  );
  const status = await fixture.shard.processResumeStatus({
    runId: fixture.runId,
    operationId: operation.transition.operationId,
    control: fixtureControl(3),
  });
  const journal = await fixture.store.execute({ type: "read", runId: fixture.runId });
  const observations = await fixture.files.observations();
  if (!observed || !resumed.ok)
    return {
      kind: "plain-public-root",
      initial: initial.result.processes.map((p) => ({ status: p.status, identity: p.identity })),
      completed: initial.committed.result.status,
      manifestMatches:
        initial.committed.result.files.checkpoint.manifestSha256 ===
        initial.committed.material.reference.filesystem.sha256,
      aRehydrated: rehydrated,
      aSnapshotRetained: JSON.stringify(before.snapshot) === JSON.stringify(after.snapshot),
      sameShard: shardNonce === (await fixture.shard.executionIncarnationNonce()),
      resumed,
      status,
      previousPublisherGeneration: before.currentPublisher.generation,
      previousPublication: before.snapshot.lastPublication,
      previousPublicationOperationId: before.snapshot.lastPublicationOperationId,
      previousPreparedFacet: before.snapshot.preparedFacet,
      postResume: await fixture.a.execute({
        type: "read",
        runId: fixture.runId,
        control: fixtureControl(3),
      }),
      journalFacetCount: journal.snapshot.requests?.facets.length,
      journalRequestCount: journal.snapshot.requests?.entries.length,
      releases: await fixture.placement.releases(),
      evidence: await fixture.shard.evidence(),
      observations,
      transports: facetTransportObservations(observations),
      invalidBootstrapRejected: invalidBootstrapRejected.every(Boolean),
      invalidBootstrapDidNotDrain,
    };

  const duplicate = await fixture.shard.resumeProcess(operation);
  const changed = { ...operation, facet: { ...operation.facet, codeId: "changed-duplicate" } };
  const mutatedRejected = await fixture.shard.resumeProcess(changed).then(
    () => false,
    () => true,
  );
  const changedRestoreMode = {
    ...operation,
    productBootstrap: {
      ...operation.productBootstrap,
      restoreMode: "same-variant-serialized-checkpoint" as const,
    },
  };
  const changedRestoreModeRejected = await fixture.shard.resumeProcess(changedRestoreMode).then(
    () => false,
    () => true,
  );
  const arrived = {
    requestId: "turn-two",
    input: await reference("turn-two-input", new TextEncoder().encode("append two")),
  };
  const continuation = {
    runId: fixture.runId,
    processId: fixture.process.processId,
    executionOperationId: fixture.shardInput.executionOperationId,
    resumeOperationId: operation.transition.operationId,
    control: fixtureControl(3),
    runStore: {
      controlKey: fixture.controlKey,
      supervisor: fixture.supervisor,
      currentPublisher: {
        generation: 3,
        facetNonce: resumed.value.identity.incarnationNonce,
        publisherKey: fixture.publisherKey(3),
      },
      request: arrived,
      checkpoint: initial.committed.material.reference,
    },
  };
  const next = fixture.shard.continueProcess(continuation, "continuation-public-request");
  const duplicateNext = fixture.shard.continueProcess(continuation, "duplicate-public-request");
  await Promise.race([
    fixture.store.waitForFinish(arrived.requestId),
    next.then((result) => {
      throw new Error(
        `Continuation completed before checkpoint handoff: ${JSON.stringify(result)}`,
      );
    }),
  ]);
  const nextCompleted = await complete(fixture, "turn-two", "resume-one", fixtureControl(3));
  const nextResult = await next;
  await duplicateNext;
  const secondOperation = await resumeInput(fixture, { step: 2 });
  const secondResume = await fixture.shard.resumeProcess(secondOperation);
  const finalJournal = await fixture.store.execute({ type: "read", runId: fixture.runId });
  const finalObservations = await fixture.files.observations();
  return {
    kind: "plain-public-root",
    initial: initial.result.processes.map((p) => ({ status: p.status, identity: p.identity })),
    completed: initial.committed.result.status,
    manifestMatches:
      initial.committed.result.files.checkpoint.manifestSha256 ===
      initial.committed.material.reference.filesystem.sha256,
    aRehydrated: rehydrated,
    aSnapshotRetained: JSON.stringify(before.snapshot) === JSON.stringify(after.snapshot),
    sameShard: shardNonce === (await fixture.shard.executionIncarnationNonce()),
    resumed,
    duplicateIdentityMatches:
      duplicate.identity.incarnationNonce === resumed.value.identity.incarnationNonce,
    mutatedRejected,
    changedRestoreModeRejected,
    invalidBootstrapRejected: invalidBootstrapRejected.every(Boolean),
    invalidBootstrapDidNotDrain,
    nextCompleted: nextCompleted.result.status,
    nextStatus: nextResult.processes[0]?.status,
    secondResume,
    initialNative: initial.committed.material.reference.native,
    nextNative: nextCompleted.material.reference.native,
    journalFacetCount: finalJournal.snapshot.requests?.facets.length,
    journalRequestCount: finalJournal.snapshot.requests?.entries.length,
    finishes: finalJournal.snapshot.requests?.entries.map((entry) => ({
      requestId: entry.request.requestId,
      status: entry.status,
      generation: entry.generation,
    })),
    releases: await fixture.placement.releases(),
    evidence: await fixture.shard.evidence(),
    observations: finalObservations,
    transports: facetTransportObservations(finalObservations),
    expectedProductTransports: [
      {
        productBootstrap: fixture.process.productBootstrap ?? null,
        targetPreparedRelease: fixture.process.targetPreparedRelease ?? null,
      },
      {
        productBootstrap: operation.productBootstrap,
        targetPreparedRelease: operation.transition.targetPreparedRelease,
      },
      {
        productBootstrap: secondOperation.productBootstrap,
        targetPreparedRelease: secondOperation.transition.targetPreparedRelease,
      },
    ],
  };
}
