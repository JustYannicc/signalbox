import { setup, complete, resumeInput, type ProofEnv } from "./publicResumeSetup.fixture.ts";
import { runFirst } from "./publicResumeProof.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";
import { reference } from "./releaseMaterial.ts";

export async function publicIdleFailure(env: ProofEnv, failure: "invocation" | "checkpoint") {
  const fixture = await setup(env, `idle-failure-${failure}`);
  const first = await runFirst(fixture);
  if (failure === "invocation")
    await fixture.files.configure({
      ...(await fixture.files.configuration()),
      invocationFailure: "reject",
    });
  const operation = await resumeInput(fixture, { observed: true });
  const resumed = await fixture.shard.resumeProcess(operation);
  const request = {
    runId: fixture.runId,
    processId: fixture.process.processId,
    executionOperationId: fixture.shardInput.executionOperationId,
    resumeOperationId: operation.transition.operationId,
    control: fixtureControl(3),
    afterTurn: "keep-alive" as const,
    runStore: {
      controlKey: fixture.controlKey,
      supervisor: fixture.supervisor,
      currentPublisher: {
        generation: 3,
        facetNonce: resumed.identity.incarnationNonce,
        publisherKey: fixture.publisherKey(3),
      },
      request: {
        requestId: "turn-two",
        input: await reference("turn-two-input", new TextEncoder().encode("turn-two")),
      },
      checkpoint: first.committed.material.reference,
    },
  };
  const running = fixture.shard.continueProcess(request, "failure-turn-two").then(
    () => false,
    () => true,
  );
  let completionDenied = false;
  if (failure === "checkpoint") {
    await fixture.store.waitForFinish("turn-two");
    await fixture.files.armFailure("writeCheckpoint", true);
    completionDenied = await complete(fixture, "turn-two", "resume-one", fixtureControl(3)).then(
      () => false,
      () => true,
    );
  }
  const denied = await running;
  const duplicateDenied = await fixture.shard.continueProcess(request, "duplicate-failed").then(
    () => false,
    () => true,
  );
  const nextDenied = await fixture.shard
    .continueProcess(
      {
        ...request,
        runStore: {
          ...request.runStore,
          request: { ...request.runStore.request, requestId: "turn-three" },
        },
      },
      "after-failure",
    )
    .then(
      () => false,
      () => true,
    );
  const stopDenied = await fixture.shard.stopIdleProcess(request).then(
    () => false,
    () => true,
  );
  const journal = await fixture.store.execute({ type: "read", runId: fixture.runId });
  return {
    denied,
    duplicateDenied,
    nextDenied,
    stopDenied,
    completionDenied,
    ownership: await fixture.placement.ownership(fixture.owner),
    evidence: await fixture.shard.evidence(),
    releases: await fixture.placement.releases(),
    requests: journal.snapshot.requests?.entries.map((entry) => entry.request.requestId),
  };
}
