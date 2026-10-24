import {
  clean,
  control1,
  control2,
  control3,
  durableFor,
  failed,
  initialize,
  incomplete,
  joins,
  publisher1,
  publisher2,
  publisher2b,
  stopAndPrepare,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";

export async function reconcilePrepared(env: WorkerdEnv) {
  const runId = "workerd-reconcile-proof";
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  const checkpoint = initialized.files.checkpoint;
  await stopAndPrepare(durable, runId, control1, publisher1, control2, "resume-1", publisher2);
  await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "publishFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    preparedPublisher: publisher2,
    operationId: "resume-1",
    checkpoint,
  });
  await durable.recordPreparedFacetFailure({
    control: control2,
    operationId: "resume-1",
    phase: "publish",
    failure: { kind: "unknown", message: "publication was interrupted" },
    cleanup: incomplete,
  });
  const incompleteFailure = await failed(() =>
    durable.reconcile({
      control: control2,
      expectedGeneration: 1,
      evidenceId: "reconcile-1",
      outcome: "notApplied",
      checkpoint: null,
      invocationSettlement: joins,
      preparedFacetCleanup: incomplete,
    }),
  );
  const unresolved = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  const pending = await durable.readPublication({ control: control2, operationId: "resume-1" });
  await durable.beginDrain({
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "takeover-before-reconcile",
    nextControl: control3,
  });
  const staleClaim = await failed(() =>
    durable.readPublication({ control: control2, operationId: "resume-1" }),
  );
  const input = {
    control: control3,
    expectedGeneration: 1,
    evidenceId: "reconcile-1",
    outcome: "notApplied" as const,
    checkpoint: null,
    invocationSettlement: joins,
    preparedFacetCleanup: clean,
  };
  // Discard the first result to model a committed reconcile whose reply was lost.
  await durable.reconcile(input);
  const retry = await durable.reconcile(input);
  const receiptAfterRetry = await failed(() =>
    durable.readPublication({ control: control3, operationId: "resume-1" }),
  );
  const next = await durable.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId,
    control: control3,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "resume-2",
    preparedPublisher: publisher2b,
  });
  return {
    incompleteCode: incompleteFailure.code,
    unresolvedLifecycle: unresolved.snapshot.lifecycle,
    unresolvedPreparedFacet: unresolved.snapshot.preparedFacet,
    pendingReceipt: pending.publication,
    staleClaimCode: staleClaim.code,
    abortedReceipt: receiptAfterRetry.code === "MISSING",
    reconciledLifecycle: retry.supervisor.snapshot.lifecycle,
    retryAction: retry.supervisor.action,
    nextPreparedFacet: next.snapshot.preparedFacet,
  };
}

export async function reconcileUnjoined(env: WorkerdEnv) {
  const runId = "workerd-unjoined-proof";
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "drain-unjoined",
    nextControl: control2,
  });
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    outcome: "indeterminate",
    invocationRpcJoined: false,
    fetchJoined: false,
    callbackPortsJoined: false,
  });
  const unresolved = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  const blocked = await failed(() =>
    durable.reconcile({
      control: control2,
      expectedGeneration: 1,
      evidenceId: "reconcile-unjoined",
      outcome: "notApplied",
      checkpoint: null,
      invocationSettlement: null,
      preparedFacetCleanup: null,
    }),
  );
  const replacementBlocked = await failed(() =>
    durable.threadSupervisor.execute({
      type: "prepareFreshFacet",
      runId,
      control: control2,
      publisher: publisher1,
      expectedGeneration: 1,
      operationId: "resume-too-early",
      preparedPublisher: publisher2,
    }),
  );
  await durable.beginDrain({
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "takeover-unjoined",
    nextControl: control3,
  });
  const reconciled = await durable.reconcile({
    control: control3,
    expectedGeneration: 1,
    evidenceId: "reconcile-unjoined",
    outcome: "notApplied",
    checkpoint: null,
    invocationSettlement: joins,
    preparedFacetCleanup: null,
  });
  const prepared = await durable.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId,
    control: control3,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "resume-after-join",
    preparedPublisher: publisher2b,
  });
  return {
    nativeSessionId: reconciled.supervisor.snapshot.nativeSessionId,
    expectedNativeSessionId: "workerd-native-session",
    initialCheckpoint: initialized.files.checkpoint,
    unresolvedLifecycle: unresolved.snapshot.lifecycle,
    unresolvedGeneration: unresolved.snapshot.generation,
    unresolvedFacetNonce: unresolved.snapshot.facetNonce,
    blockedCode: blocked.code,
    replacementBlockedCode: replacementBlocked.code,
    persistedSettlement: reconciled.supervisor.snapshot.settlement,
    preparedLifecycle: prepared.snapshot.lifecycle,
  };
}
