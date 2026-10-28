import resumeWorker from "./publicResume.workerd.fixture.ts";
import { ProofShard, ProofPlacementStore } from "./publicResumeShard.fixture.ts";
import { ProofFilesStore, ProofRunStore, ProofSupervisor } from "./publicResumeStores.fixture.ts";
import { setup } from "./publicResumeSetup.fixture.ts";
import { runFirst } from "./publicResumeProof.fixture.ts";
import type { ProofEnv } from "./publicResumeSetup.fixture.ts";

export { ProofProcessStoreBinding as HarnessProcessStoreBinding } from "./publicResumeStores.fixture.ts";
export { ProofShard, ProofPlacementStore, ProofFilesStore, ProofRunStore };

export class ReceiptCountingSupervisor extends ProofSupervisor {
  async checkpointCommitCount() {
    return (await this.ctx.storage.get<number>("proof/checkpoint-commit-count")) ?? 0;
  }

  override async execute(command: unknown, fence?: unknown) {
    if (
      typeof command === "object" &&
      command !== null &&
      "type" in command &&
      command.type === "commitCheckpoint"
    ) {
      const count = (await this.checkpointCommitCount()) + 1;
      await this.ctx.storage.put("proof/checkpoint-commit-count", count);
    }
    return super.execute(command, fence);
  }
}

async function cachedCompletionProof(env: ProofEnv) {
  const fixture = await setup(env, "cached-completion-after-reconstruction");
  const initial = await runFirst(fixture);
  const beforeCount = await (
    env.HARNESS_THREAD_SUPERVISOR.getByName(fixture.runId) as unknown as ReceiptCountingSupervisor
  ).checkpointCommitCount();
  const before = await fixture.a.execute({
    type: "read",
    runId: fixture.runId,
    control: fixtureControl,
  });
  const oldNonce = await fixture.shard.executionIncarnationNonce();
  try {
    await fixture.shard.rehydrate();
  } catch {
    // Rehydration aborts its own RPC; the next call constructs the replacement shard.
  }
  fixture.shard = env.PROCESS_EXECUTION_SHARDS.getByName(fixture.owner);
  const newNonce = await fixture.shard.executionIncarnationNonce();
  const recovered = await fixture.shard.commitProcessCheckpoint(initial.committed.input);
  const changed = {
    ...initial.committed.input,
    checkpoint: {
      ...initial.committed.input.checkpoint,
      files: initial.committed.input.checkpoint.files.map((file) =>
        file.path === "workspace.txt"
          ? { ...file, bytes: new TextEncoder().encode("changed after commit") }
          : file,
      ),
    },
  };
  const changedDenied = await fixture.shard.commitProcessCheckpoint(changed).then(
    () => false,
    () => true,
  );
  const after = await fixture.a.execute({
    type: "read",
    runId: fixture.runId,
    control: fixtureControl,
  });
  const afterCount = await (
    env.HARNESS_THREAD_SUPERVISOR.getByName(fixture.runId) as unknown as ReceiptCountingSupervisor
  ).checkpointCommitCount();
  return {
    originalNonce: oldNonce,
    reconstructedNonce: newNonce,
    originalReceipt: initial.committed.result,
    recoveredReceipt: recovered,
    beforeCount,
    afterCount,
    changedDenied,
    beforeCheckpoint: before.snapshot.checkpoint,
    afterCheckpoint: after.snapshot.checkpoint,
  };
}

const fixtureControl = {
  ownerId: "plain-process-owner",
  incarnationId: "controller-2",
  epoch: 2,
  controlKey: "plain-process-a-control-2-".repeat(2),
} as const;

export default {
  async fetch(request: Request, env: ProofEnv) {
    if (new URL(request.url).pathname === "/cached-completion") {
      try {
        return Response.json(await cachedCompletionProof(env));
      } catch (cause) {
        return new Response(
          cause instanceof Error ? cause.stack : "Cached completion proof failed",
          {
            status: 500,
          },
        );
      }
    }
    return resumeWorker.fetch(request, env);
  },
};
export * from "../../../FixtureWorkerExports.ts";
