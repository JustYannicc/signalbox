import {
  clean,
  control1,
  control2,
  durableFor,
  errorCode,
  failed,
  incomplete,
  initialize,
  joins,
  publisher1,
  publisher2,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";
import type { HarnessThreadSupervisorPublisher } from "../../HarnessThreadSupervisor.ts";

export const overlappingReconciliationRunId = "workerd-reconciliation-overlap-r4";
const evidenceE = "overlap-r4-evidence-e";
const publisher2b = {
  generation: 2,
  facetNonce: "workerd-overlap-r4-facet-2b",
  publisherKey: "workerd-overlap-r4-publisher-2b-",
};
const publisher2c = {
  generation: 2,
  facetNonce: "workerd-overlap-r4-facet-2c",
  publisherKey: "workerd-overlap-r4-publisher-2c-",
};

interface ReservationGate {
  readonly reached: Promise<void>;
  readonly released: Promise<void>;
  signalReached(): void;
  open(): void;
  reservationStatus: "missing" | "pending" | "committed" | null;
}

function createReservationGate(): ReservationGate {
  let signal!: () => void;
  let open!: () => void;
  return {
    reached: new Promise<void>((resolve) => (signal = resolve)),
    released: new Promise<void>((resolve) => (open = resolve)),
    signalReached: () => signal(),
    open: () => open(),
    reservationStatus: null,
  };
}

function isReservationForEvidence(
  input: unknown,
  evidenceId: string,
): input is { readonly evidenceId: string; readonly reserve: boolean } {
  return (
    typeof input === "object" &&
    input !== null &&
    "evidenceId" in input &&
    input.evidenceId === evidenceId &&
    "reserve" in input &&
    typeof input.reserve === "boolean"
  );
}

function gatedBindings(env: WorkerdEnv, gate: ReservationGate): WorkerdEnv {
  const namespace = env.HARNESS_THREAD_SUPERVISOR;
  const supervisorNamespace = new Proxy(namespace, {
    get(target, property, receiver) {
      if (property !== "getByName") return Reflect.get(target, property, receiver);
      return (name: string) => {
        const stub = target.getByName(name);
        const reserve = (...args: Parameters<typeof stub.reserveReconciliation>) =>
          stub.reserveReconciliation(...args);
        return new Proxy(stub, {
          get(stubTarget, method, stubReceiver) {
            if (method !== "reserveReconciliation")
              return Reflect.get(stubTarget, method, stubReceiver);
            return async (...args: Parameters<typeof reserve>) => {
              const reservation = await reserve(...args);
              const request = args[0];
              if (
                name === overlappingReconciliationRunId &&
                isReservationForEvidence(request, evidenceE)
              ) {
                gate.reservationStatus = reservation.status;
                if (request.reserve) {
                  gate.signalReached();
                  if (reservation.status === "pending") await gate.released;
                }
              }
              return reservation;
            };
          },
        });
      };
    },
  });
  return { ...env, HARNESS_THREAD_SUPERVISOR: supervisorNamespace };
}

function reconciliationInput(evidenceId: string, preparedFacetCleanup = clean) {
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

async function prepareFailedPublication(
  env: WorkerdEnv,
  runId: string,
  checkpoint: Awaited<ReturnType<typeof initialize>>["files"]["checkpoint"],
  operationId: string,
  preparedPublisher: HarnessThreadSupervisorPublisher,
) {
  const durable = durableFor(env, runId);
  await durable.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId,
    preparedPublisher,
  });
  await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "publishFacet",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    preparedPublisher,
    operationId,
    checkpoint,
  });
  await durable.recordPreparedFacetFailure({
    control: control2,
    operationId,
    phase: "publish",
    failure: { kind: "unknown", message: "facet publication outcome was interrupted" },
    cleanup: incomplete,
  });
}

export async function prepareOverlappingReconciliation(env: WorkerdEnv) {
  const runId = overlappingReconciliationRunId;
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  await durable.beginDrain({
    control: control1,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "overlap-r4-initial-drain",
    nextControl: control2,
  });
  await durable.threadSupervisor.execute({
    type: "recordStopAcknowledgement",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    requestId: "overlap-r4-stop-request",
    acknowledgementId: "overlap-r4-stop-acknowledgement",
  });
  await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    outcome: "stopped",
    ...joins,
  });
  await prepareFailedPublication(
    env,
    runId,
    initialized.files.checkpoint,
    "overlap-r4-prepared-a",
    publisher2,
  );
  return { prepared: "A", checkpoint: initialized.files.checkpoint.checkpointId };
}

async function prepareFailedStep(
  env: WorkerdEnv,
  operationId: string,
  publisher: HarnessThreadSupervisorPublisher,
) {
  const runId = overlappingReconciliationRunId;
  const durable = durableFor(env, runId);
  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  await prepareFailedPublication(env, runId, current.snapshot.checkpoint, operationId, publisher);
}

async function finishFAndLeaveCPending(env: WorkerdEnv) {
  const durable = durableFor(env, overlappingReconciliationRunId);
  const reconciled = await durable.reconcile(reconciliationInput("overlap-r4-evidence-f"));
  const latest = await durable.threadSupervisor.execute({
    type: "read",
    runId: overlappingReconciliationRunId,
    control: control2,
  });
  return {
    replayFAction: reconciled.supervisor.action,
    latestEvidenceId: latest.snapshot.reconciliationEvidenceId,
    lifecycle: latest.snapshot.lifecycle,
    preparedFacet: latest.snapshot.preparedFacet,
  };
}

export async function inspectOverlappingReconciliation(env: WorkerdEnv) {
  const runId = overlappingReconciliationRunId;
  const durable = durableFor(env, runId);
  const supervisor = await durable.threadSupervisor.execute({
    type: "read",
    runId,
    control: control2,
  });
  const files = await durable.filesStore.execute({
    type: "readCheckpoint",
    runId,
    publisher: publisher1,
    checkpointId: "workerd-checkpoint-1",
  });
  const publication = await durable.readPublication({
    control: control2,
    operationId: "overlap-r4-prepared-c",
  });
  return {
    supervisor: {
      lifecycle: supervisor.snapshot.lifecycle,
      generation: supervisor.snapshot.generation,
      checkpoint: supervisor.snapshot.checkpoint,
      preparedFacet: supervisor.snapshot.preparedFacet,
      admittedStepId: supervisor.snapshot.admittedStepId,
      reconciliationEvidenceId: supervisor.snapshot.reconciliationEvidenceId,
      reconciliationAdmissionResolution: supervisor.snapshot.reconciliationAdmissionResolution,
      settlement: supervisor.snapshot.settlement,
    },
    files: {
      checkpoint: files.checkpoint,
      activeStepId: files.activeStepId,
      admissionResolution: files.admissionResolution,
      publication: publication.publication,
    },
  };
}

export async function runOverlappingReconciliation(env: WorkerdEnv) {
  const gate = createReservationGate();
  const durable = durableFor(gatedBindings(env, gate), overlappingReconciliationRunId);
  const older = (async () => {
    try {
      return { error: null, result: await durable.reconcile(reconciliationInput(evidenceE)) };
    } catch (error) {
      gate.signalReached();
      return {
        error: {
          code: errorCode(error),
          message: error instanceof Error ? error.message : "Reconciliation failed.",
        },
        result: null,
      };
    }
  })();
  await gate.reached;
  const otherE = await durableFor(env, overlappingReconciliationRunId).reconcile(
    reconciliationInput(evidenceE),
  );
  await prepareFailedStep(env, "overlap-r4-prepared-b", publisher2b);
  const newer = await finishFAndLeaveCPending(env);
  await prepareFailedStep(env, "overlap-r4-prepared-c", publisher2c);
  const before = await inspectOverlappingReconciliation(env);

  gate.open();
  const delayed = await older;
  const after = await inspectOverlappingReconciliation(env);
  const alteredE = await failed(() =>
    durableFor(env, overlappingReconciliationRunId).reconcile(
      reconciliationInput(evidenceE, { ...clean, disposed: false }),
    ),
  );
  const afterAltered = await inspectOverlappingReconciliation(env);

  return {
    reservationStatus: gate.reservationStatus,
    otherEAction: otherE.supervisor.action,
    otherEFilesAction: otherE.files?.action ?? null,
    newer,
    delayed,
    before,
    after,
    alteredECode: alteredE.code,
    afterAltered,
  };
}

export async function replayFilesAdmissionAfterEviction(env: WorkerdEnv) {
  const runId = overlappingReconciliationRunId;
  const durable = durableFor(env, runId);
  const checkpoint = await durable.filesStore.execute({
    type: "readCheckpoint",
    runId,
    publisher: publisher1,
    checkpointId: "workerd-checkpoint-1",
  });
  const replay = await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "reconcileAdmission",
    runId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    evidenceId: evidenceE,
    stepId: null,
    outcome: "notApplied",
    expectedCheckpoint: checkpoint.checkpoint,
    checkpoint: null,
  });
  return {
    action: replay.action,
    admissionResolution: replay.admissionResolution,
  };
}
