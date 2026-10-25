import {
  clean,
  control2,
  durableFor,
  errorCode,
  failed,
  incomplete,
  publisher1,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";
import type { HarnessThreadSupervisorPublisher } from "../../HarnessThreadSupervisor.ts";
import {
  inspectOverlappingReconciliation,
  overlappingReconciliationRunId,
} from "./harnessStateWorkerd.reconciliationOverlapR4.ts";
import { legacyR5EvidenceId, legacyR5Input } from "./harnessStateWorkerd.reconciliationLegacyR5.ts";

interface ReservationGate {
  readonly reached: Promise<void>;
  readonly released: Promise<void>;
  signalReached(): void;
  open(): void;
  reservationStatus: "missing" | "pending" | "committed" | null;
  delayedFilesAction: string | null;
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
    delayedFilesAction: null,
  };
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
                typeof request === "object" &&
                request !== null &&
                "evidenceId" in request &&
                request.evidenceId === legacyR5EvidenceId
              ) {
                gate.reservationStatus = reservation.status;
                if ("reserve" in request && request.reserve) {
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
  const filesNamespace = new Proxy(env.HARNESS_FILES_STORE, {
    get(target, property, receiver) {
      if (property !== "getByName") return Reflect.get(target, property, receiver);
      return (name: string) => {
        const stub = target.getByName(name);
        return new Proxy(stub, {
          get(stubTarget, method, stubReceiver) {
            if (method !== "execute") return Reflect.get(stubTarget, method, stubReceiver);
            return async (command: unknown) => {
              const result = await stubTarget.execute(command);
              if (
                name === overlappingReconciliationRunId &&
                typeof command === "object" &&
                command !== null &&
                "type" in command &&
                command.type === "reconcileAdmission" &&
                "evidenceId" in command &&
                command.evidenceId === legacyR5EvidenceId &&
                !("validateOnly" in command && command.validateOnly === true)
              )
                gate.delayedFilesAction = result.action;
              return result;
            };
          },
        });
      };
    },
  });
  return {
    ...env,
    HARNESS_FILES_STORE: filesNamespace,
    HARNESS_THREAD_SUPERVISOR: supervisorNamespace,
  };
}

async function prepareFailedStep(
  env: WorkerdEnv,
  operationId: string,
  preparedPublisher: HarnessThreadSupervisorPublisher,
) {
  const durable = durableFor(env, overlappingReconciliationRunId);
  const current = await durable.threadSupervisor.execute({
    type: "read",
    runId: overlappingReconciliationRunId,
    control: control2,
  });
  await durable.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId: overlappingReconciliationRunId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId,
    preparedPublisher,
  });
  await env.HARNESS_FILES_STORE.getByName(overlappingReconciliationRunId).execute({
    type: "publishFacet",
    runId: overlappingReconciliationRunId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    preparedPublisher,
    operationId,
    checkpoint: current.snapshot.checkpoint,
  });
  await durable.recordPreparedFacetFailure({
    control: control2,
    operationId,
    phase: "publish",
    failure: { kind: "unknown", message: "facet publication outcome was interrupted" },
    cleanup: incomplete,
  });
}

async function reconcileF(env: WorkerdEnv) {
  const durable = durableFor(env, overlappingReconciliationRunId);
  const reconciled = await durable.reconcile(legacyR5Input("overlap-r4-evidence-f"));
  const latest = await durable.threadSupervisor.execute({
    type: "read",
    runId: overlappingReconciliationRunId,
    control: control2,
  });
  return {
    action: reconciled.supervisor.action,
    evidenceId: latest.snapshot.reconciliationEvidenceId,
    lifecycle: latest.snapshot.lifecycle,
    preparedFacet: latest.snapshot.preparedFacet,
  };
}

export async function runLegacyR5Overlap(env: WorkerdEnv) {
  const gate = createReservationGate();
  const durable = durableFor(gatedBindings(env, gate), overlappingReconciliationRunId);
  const older = (async () => {
    try {
      return {
        error: null,
        result: await durable.reconcile(legacyR5Input(legacyR5EvidenceId)),
      };
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
    legacyR5Input(legacyR5EvidenceId),
  );
  const afterE = await durableFor(env, overlappingReconciliationRunId).threadSupervisor.execute({
    type: "read",
    runId: overlappingReconciliationRunId,
    control: control2,
  });

  await prepareFailedStep(env, "overlap-r4-prepared-b", {
    generation: 2,
    facetNonce: "workerd-overlap-r4-facet-2b",
    publisherKey: "workerd-overlap-r4-publisher-2b-",
  });
  const later = await reconcileF(env);
  await prepareFailedStep(env, "overlap-r4-prepared-c", {
    generation: 2,
    facetNonce: "workerd-overlap-r4-facet-2c",
    publisherKey: "workerd-overlap-r4-publisher-2c-",
  });
  const before = await inspectOverlappingReconciliation(env);

  gate.open();
  const delayed = await older;
  const after = await inspectOverlappingReconciliation(env);
  const alteredE = await failed(() =>
    durableFor(env, overlappingReconciliationRunId).reconcile(
      legacyR5Input(legacyR5EvidenceId, { ...clean, disposed: false }),
    ),
  );
  const afterAltered = await inspectOverlappingReconciliation(env);

  return {
    reservationStatus: gate.reservationStatus,
    otherEAction: otherE.supervisor.action,
    otherEFilesAction: otherE.files?.action ?? null,
    afterE: {
      lifecycle: afterE.snapshot.lifecycle,
      reconciliationEvidenceId: afterE.snapshot.reconciliationEvidenceId,
      preparedFacet: afterE.snapshot.preparedFacet,
    },
    later,
    delayed: {
      error: delayed.error,
      filesAction: gate.delayedFilesAction ?? delayed.result?.files?.action ?? null,
      supervisorAction: delayed.result?.supervisor.action ?? null,
    },
    alteredECode: alteredE.code,
    before,
    after,
    afterAltered,
  };
}

export async function replayLegacyR5AfterEviction(env: WorkerdEnv) {
  const durable = durableFor(env, overlappingReconciliationRunId);
  const before = await inspectOverlappingReconciliation(env);
  const exactSupervisor = await durable.reconcile(legacyR5Input(legacyR5EvidenceId));
  const checkpoint = await env.HARNESS_FILES_STORE.getByName(
    overlappingReconciliationRunId,
  ).execute({
    type: "readCheckpoint",
    runId: overlappingReconciliationRunId,
    publisher: publisher1,
    checkpointId: "workerd-checkpoint-1",
  });
  const exactFiles = await env.HARNESS_FILES_STORE.getByName(
    overlappingReconciliationRunId,
  ).execute({
    type: "reconcileAdmission",
    runId: overlappingReconciliationRunId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    evidenceId: legacyR5EvidenceId,
    stepId: null,
    outcome: "notApplied",
    expectedCheckpoint: checkpoint.checkpoint,
    checkpoint: null,
  });
  const alteredFiles = await failed(() =>
    env.HARNESS_FILES_STORE.getByName(overlappingReconciliationRunId).execute({
      type: "reconcileAdmission",
      runId: overlappingReconciliationRunId,
      control: control2,
      publisher: publisher1,
      expectedGeneration: 1,
      evidenceId: legacyR5EvidenceId,
      stepId: null,
      outcome: "notApplied",
      expectedCheckpoint: { ...checkpoint.checkpoint, manifestSha256: "d".repeat(64) },
      checkpoint: null,
    }),
  );
  const afterReplay = await inspectOverlappingReconciliation(env);
  const blockedReplacement = await failed(() =>
    durable.threadSupervisor.execute({
      type: "prepareFreshFacet",
      runId: overlappingReconciliationRunId,
      control: control2,
      publisher: publisher1,
      expectedGeneration: 1,
      operationId: "overlap-r5-replacement-before-c",
      preparedPublisher: {
        generation: 2,
        facetNonce: "workerd-overlap-r5-facet-2d",
        publisherKey: "workerd-overlap-r5-publisher-2d-key",
      },
    }),
  );
  const reconciledC = await durable.reconcile(legacyR5Input("overlap-r4-evidence-c"));
  const replacement = await durable.threadSupervisor.execute({
    type: "prepareFreshFacet",
    runId: overlappingReconciliationRunId,
    control: control2,
    publisher: publisher1,
    expectedGeneration: 1,
    operationId: "overlap-r5-replacement-after-c",
    preparedPublisher: {
      generation: 2,
      facetNonce: "workerd-overlap-r5-facet-2d",
      publisherKey: "workerd-overlap-r5-publisher-2d-key",
    },
  });
  return {
    supervisorAction: exactSupervisor.supervisor.action,
    supervisorFiles: exactSupervisor.files,
    exactFilesAction: exactFiles.action,
    exactFilesResolution: exactFiles.admissionResolution,
    alteredFilesCode: alteredFiles.code,
    before,
    afterReplay,
    blockedReplacementCode: blockedReplacement.code,
    cSpecificReconcile: reconciledC.supervisor.action,
    replacementAction: replacement.action,
  };
}
