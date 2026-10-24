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
import {
  overlappingReconciliationRunId,
  prepareOverlappingReconciliation,
} from "./harnessStateWorkerd.reconciliationOverlapR4.ts";
import { sourceFromSnapshot } from "./supervisor/reconciliationReceipts.ts";

export const legacyR5EvidenceId = "overlap-r4-evidence-e";
export const legacyR5UnboundRunId = "workerd-unbound-legacy-r5";
export const legacyR5UnboundEvidenceId = "unbound-legacy-r5-evidence-e";

export function legacyR5Input(
  evidenceId: string,
  preparedFacetCleanup: typeof clean | null = clean,
) {
  return {
    control: control2,
    expectedGeneration: 1,
    evidenceId,
    outcome: "notApplied" as const,
    checkpoint: null,
    invocationSettlement: joins,
    preparedFacetCleanup,
  };
}

export async function prepareLegacyR5Files(env: WorkerdEnv) {
  const prepared = await prepareOverlappingReconciliation(env);
  const files = await env.HARNESS_FILES_STORE.getByName(overlappingReconciliationRunId).execute({
    type: "abortFacetPublication",
    runId: overlappingReconciliationRunId,
    control: control2,
    expectedGeneration: 1,
    preparedPublisher: publisher2,
    operationId: "overlap-r4-prepared-a",
  });
  return {
    runId: overlappingReconciliationRunId,
    checkpoint: prepared.checkpoint,
    publicationAction: files.action,
  };
}

export async function reserveLegacyR5Supervisor(env: WorkerdEnv) {
  const durable = durableFor(env, overlappingReconciliationRunId);
  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId: overlappingReconciliationRunId,
    control: control2,
  });
  const pending = await env.HARNESS_THREAD_SUPERVISOR.getByName(
    overlappingReconciliationRunId,
  ).reserveReconciliation({
    runId: overlappingReconciliationRunId,
    ...legacyR5Input(legacyR5EvidenceId),
    expectedSource: sourceFromSnapshot(current.snapshot),
    reserve: true,
  });
  return {
    status: pending.status,
    preparedFacet: pending.supervisor.snapshot.preparedFacet,
    admissionBinding: pending.admissionBinding,
  };
}

export async function prepareUnboundLegacyR5(env: WorkerdEnv) {
  const durable = durableFor(env, legacyR5UnboundRunId);
  const initialized = await initialize(durable, legacyR5UnboundRunId);
  await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "unbound-legacy-r5-drain",
    nextControl: control2,
  });
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId: legacyR5UnboundRunId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    outcome: "indeterminate",
    ...joins,
  });
  return { runId: legacyR5UnboundRunId, checkpoint: initialized.files.checkpoint };
}

export async function attemptUnboundLegacyR5(env: WorkerdEnv) {
  const durable = durableFor(env, legacyR5UnboundRunId);
  const checkpoint = await env.HARNESS_FILES_STORE.getByName(legacyR5UnboundRunId).execute({
    type: "readCheckpoint",
    runId: legacyR5UnboundRunId,
    publisher: {
      generation: 1,
      facetNonce: "workerd-facet-nonce-1",
      publisherKey: "workerd-facet-publisher-1-workerd-facet-publisher-1-",
    },
    checkpointId: "workerd-checkpoint-1",
  });
  const rejected = await failed(() =>
    durable.reconcile({
      ...legacyR5Input(legacyR5UnboundEvidenceId, null),
      expectedGeneration: 1,
      checkpoint: null,
    }),
  );
  const supervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId: legacyR5UnboundRunId,
    control: control2,
  });
  const files = await env.HARNESS_FILES_STORE.getByName(legacyR5UnboundRunId).execute({
    type: "readCheckpoint",
    runId: legacyR5UnboundRunId,
    publisher: {
      generation: 1,
      facetNonce: "workerd-facet-nonce-1",
      publisherKey: "workerd-facet-publisher-1-workerd-facet-publisher-1-",
    },
    checkpointId: checkpoint.checkpoint.checkpointId,
  });
  return {
    code: rejected.code,
    supervisorEvidenceId: supervisor.snapshot.reconciliationEvidenceId,
    lifecycle: supervisor.snapshot.lifecycle,
    admissionResolution: files.admissionResolution,
  };
}
