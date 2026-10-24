import {
  clean,
  control1,
  control2,
  durableFor,
  failed,
  initialize,
  joins,
  publisher1,
  publisher2,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";
import { loseNextSupervisorReply } from "./harnessStateWorkerd.faults.ts";

const hasType = (command: unknown, type: string) =>
  typeof command === "object" && command !== null && "type" in command && command.type === type;

async function settleUnknown(durable: ReturnType<typeof durableFor>, runId: string) {
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    outcome: "indeterminate",
    ...joins,
  });
}

export async function reconcileReplayIsolation(env: WorkerdEnv) {
  const runId = "workerd-reconcile-replay-proof";
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  const checkpoint = initialized.files.checkpoint;
  await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "drain-reconcile-replay",
    nextControl: control2,
  });
  await settleUnknown(durable, runId);

  const input = {
    control: control2,
    expectedGeneration: 1,
    evidenceId: "reconcile-replay-evidence",
    outcome: "notApplied" as const,
    checkpoint: null,
    invocationSettlement: joins,
    preparedFacetCleanup: null,
  };
  const lostSupervisorReply = await failed(() =>
    durableFor(
      loseNextSupervisorReply(env, (command) => hasType(command, "reconcile")),
      runId,
    ).reconcile(input),
  );
  const recovered = durableFor(env, runId);
  const afterLostReply = await recovered.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });

  const nextOperationId = "prepared-after-reconcile";
  await recovered.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: nextOperationId,
    preparedPublisher: publisher2,
  });
  await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "publishFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    preparedPublisher: publisher2,
    operationId: nextOperationId,
    checkpoint,
  });

  const replay = await recovered.reconcile(input);
  const changedSettlement = await failed(() =>
    recovered.reconcile({
      ...input,
      invocationSettlement: { ...joins, callbackPortsJoined: false },
    }),
  );
  const changedCheckpoint = await failed(() =>
    recovered.reconcile({
      ...input,
      checkpoint: { checkpointId: "different-checkpoint", manifestSha256: "d".repeat(64) },
    }),
  );
  const changedCleanup = await failed(() =>
    recovered.reconcile({ ...input, preparedFacetCleanup: clean }),
  );
  const pending = await recovered.readPublication({
    control: control2,
    operationId: nextOperationId,
  });
  const supervisor = await recovered.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });

  return {
    lostSupervisorReplyCode: lostSupervisorReply.code,
    persistedEvidence: afterLostReply.snapshot.reconciliationEvidenceId,
    replayAction: replay.supervisor.action,
    changedSettlementCode: changedSettlement.code,
    changedCheckpointCode: changedCheckpoint.code,
    changedCleanupCode: changedCleanup.code,
    pendingReceipt: pending.publication,
    preparedFacet: supervisor.snapshot.preparedFacet,
    lifecycle: supervisor.snapshot.lifecycle,
  };
}
