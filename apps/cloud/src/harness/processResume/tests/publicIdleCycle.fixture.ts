import { setup, complete, resumeInput, type ProofEnv } from "./publicResumeSetup.fixture.ts";
import { runFirst } from "./publicResumeProof.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";
import { reference } from "./releaseMaterial.ts";

export async function publicIdleCycle(env: ProofEnv) {
  const fixture = await setup(env, "idle-stop-replace-stop");
  const first = await runFirst(fixture);
  let checkpoint = first.committed.material.reference;
  const cycles = [];
  const stopInputs = [];
  for (const step of [1, 2]) {
    const operation = await resumeInput(fixture, { step, observed: true });
    const resumed = await fixture.shard.resumeProcess(operation);
    const requestId = step === 1 ? "turn-two" : "turn-three";
    const request = {
      runId: fixture.runId,
      processId: fixture.process.processId,
      executionOperationId: fixture.shardInput.executionOperationId,
      resumeOperationId: operation.transition.operationId,
      control: fixtureControl(step + 2),
      afterTurn: "keep-alive" as const,
      runStore: {
        controlKey: fixture.controlKey,
        supervisor: fixture.supervisor,
        currentPublisher: {
          generation: step + 2,
          facetNonce: resumed.identity.incarnationNonce,
          publisherKey: fixture.publisherKey(step + 2),
        },
        request: {
          requestId,
          input: await reference(`${requestId}-input`, new TextEncoder().encode(requestId)),
        },
        checkpoint,
      },
    };
    const running = fixture.shard.continueProcess(request, requestId);
    await Promise.race([
      fixture.store.waitForFinish(requestId),
      running.then(() => {
        throw new Error("Idle turn returned before commit");
      }),
    ]);
    const completed = await complete(
      fixture,
      requestId,
      operation.transition.operationId,
      fixtureControl(step + 2),
    );
    const result = await running;
    checkpoint = completed.material.reference;
    const stopInput = { ...request, runStore: { ...request.runStore, checkpoint } };
    stopInputs.push(stopInput);
    const before = await fixture.placement.ownership(fixture.owner);
    const stopped = await fixture.shard.stopIdleProcess(stopInput);
    const duplicate = await fixture.shard.stopIdleProcess(stopInput);
    cycles.push({
      identity: resumed.identity,
      result: result.processes[0]?.status,
      before,
      stopped,
      duplicate,
      after: await fixture.placement.ownership(fixture.owner),
    });
  }
  const firstDuplicate = await fixture.shard.stopIdleProcess(stopInputs[0]);
  const conflict = await fixture.shard
    .stopIdleProcess({ ...stopInputs[0], afterTurn: "dispose" })
    .then(
      () => false,
      () => true,
    );
  return { cycles, firstDuplicate, conflict, evidence: await fixture.shard.evidence() };
}
