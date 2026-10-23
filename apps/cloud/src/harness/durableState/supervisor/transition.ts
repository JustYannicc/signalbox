import { fail } from "./errors.ts";
import type { HarnessThreadSupervisorCommand } from "./contracts.ts";
import type { HarnessThreadSupervisorResult } from "./contracts.ts";
import type { State } from "./state.ts";

type Decision = {
  readonly state: State;
  readonly action: HarnessThreadSupervisorResult["action"];
  readonly revealPreparedPublisher: boolean;
};
const decide = (
  state: State,
  action: Decision["action"] = "recorded",
  revealPreparedPublisher = true,
): Decision => ({ state, action, revealPreparedPublisher });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const allJoined = (value: {
  readonly invocationRpcJoined: boolean;
  readonly fetchJoined: boolean;
  readonly callbackPortsJoined: boolean;
}) => value.invocationRpcJoined && value.fetchJoined && value.callbackPortsJoined;
const allClean = (value: {
  readonly stopAcknowledged: boolean;
  readonly invocationRpcJoined: boolean;
  readonly fetchJoined: boolean;
  readonly callbackPortsJoined: boolean;
  readonly disposed: boolean;
}) =>
  value.stopAcknowledged &&
  value.invocationRpcJoined &&
  value.fetchJoined &&
  value.callbackPortsJoined &&
  value.disposed;

const requireControl = (state: State, control: State["control"]) => {
  if (!same(state.control, control)) return fail("STALE_CONTROL");
};

const requirePublisher = (state: State, publisher: State["publisher"]) => {
  if (!same(state.publisher, publisher)) return fail("STALE_PUBLISHER");
};

const requireGeneration = (state: State, generation: number) => {
  if (state.publisher.generation !== generation) return fail("OUT_OF_ORDER");
};

export function transition(state: State | null, command: HarnessThreadSupervisorCommand): Decision {
  if (command.type === "initialize") {
    if (state) {
      requireControl(state, command.control);
      requirePublisher(state, command.publisher);
      if (
        state.nativeSessionId !== command.nativeSessionId ||
        !same(state.initialCheckpoint, command.checkpoint)
      )
        return fail("CONFLICT");
      return decide(state, "unchanged");
    }
    if (
      command.control.epoch !== 1 ||
      command.publisher.generation !== 1 ||
      command.control.controlKey === command.publisher.publisherKey
    )
      return fail("INVALID");
    return decide({
      version: 1,
      runId: command.runId,
      nativeSessionId: command.nativeSessionId,
      control: command.control,
      publisher: command.publisher,
      checkpoint: command.checkpoint,
      initialCheckpoint: command.checkpoint,
      lifecycle: "accepting",
      admittedStepId: null,
      lastCommittedStepId: null,
      prepared: null,
      drainOperationId: null,
      lastPublication: null,
      lastPublicationOperationId: null,
      pendingControlSync: null,
      stopAcknowledgement: null,
      settlement: null,
      lastFailure: null,
      reconciliationEvidenceId: null,
      reconciliationControl: null,
      reconciliationExpectedGeneration: null,
      reconciliationOutcome: null,
      reconciliationCheckpoint: null,
      reconciliationInvocationSettlement: null,
      reconciliationPreparedFacetCleanup: null,
      reconciliationAdmissionResolution: null,
    });
  }

  if (!state) return fail("MISSING");
  if (command.type === "read") {
    requireControl(state, command.control);
    return decide(state, "unchanged");
  }

  switch (command.type) {
    case "beginDrain": {
      if (
        state.pendingControlSync &&
        state.drainOperationId === command.operationId &&
        same(state.pendingControlSync.fromControl, command.control) &&
        same(state.control, command.nextControl) &&
        state.publisher.generation === command.expectedGeneration &&
        same(state.publisher, command.publisher)
      )
        return decide(state, "unchanged", false);
      if (state.pendingControlSync) return fail("OUT_OF_ORDER");
      requireControl(state, command.control);
      requirePublisher(state, command.publisher);
      requireGeneration(state, command.expectedGeneration);
      if (
        command.nextControl.ownerId !== state.control.ownerId ||
        command.nextControl.epoch !== state.control.epoch + 1 ||
        command.nextControl.incarnationId === state.control.incarnationId ||
        command.nextControl.controlKey === state.control.controlKey ||
        command.nextControl.controlKey === state.publisher.publisherKey
      )
        return fail("CONFLICT");
      return decide(
        {
          ...state,
          control: command.nextControl,
          lifecycle: state.lifecycle === "accepting" ? "draining" : state.lifecycle,
          drainOperationId: command.operationId,
          pendingControlSync: {
            fromControl: state.control,
            operationId: command.operationId,
            expectedGeneration: command.expectedGeneration,
            publication: state.lastPublication,
            preparedPublication: state.prepared
              ? {
                  operationId: state.prepared.operationId,
                  fromGeneration: state.publisher.generation,
                  toGeneration: state.prepared.publisher.generation,
                  priorFacetNonce: state.publisher.facetNonce,
                  preparedFacetNonce: state.prepared.publisher.facetNonce,
                  checkpoint: state.prepared.checkpoint,
                }
              : null,
          },
          stopAcknowledgement: null,
          settlement: null,
        },
        "draining",
      );
    }
    case "confirmControlSync": {
      requireControl(state, command.control);
      const pending = state.pendingControlSync;
      if (
        !pending ||
        pending.operationId !== command.operationId ||
        pending.fromControl.epoch !== command.fromEpoch ||
        pending.fromControl.incarnationId !== command.fromIncarnationId ||
        pending.expectedGeneration !== command.expectedGeneration ||
        !same(pending.publication, command.publication) ||
        !same(pending.preparedPublication, command.preparedPublication)
      )
        return fail("CONFLICT");
      return decide({ ...state, pendingControlSync: null }, "control-synced");
    }
    case "admitStep": {
      requirePublisher(state, command.publisher);
      if (state.lifecycle !== "accepting") return fail("OUT_OF_ORDER");
      if (state.checkpoint.checkpointId !== command.expectedCheckpointId)
        return fail("OUT_OF_ORDER");
      if (state.admittedStepId) {
        if (state.admittedStepId === command.stepId) return decide(state, "unchanged");
        return fail("CONFLICT");
      }
      return decide({ ...state, admittedStepId: command.stepId }, "admitted");
    }
    case "commitCheckpoint": {
      requirePublisher(state, command.publisher);
      if (state.lifecycle !== "accepting" && state.lifecycle !== "draining")
        return fail("OUT_OF_ORDER");
      if (
        state.lastCommittedStepId === command.stepId &&
        state.checkpoint.checkpointId === command.checkpoint.checkpointId &&
        same(state.checkpoint, command.checkpoint)
      )
        return decide(state, "unchanged");
      if (
        state.admittedStepId !== command.stepId ||
        state.checkpoint.checkpointId !== command.expectedCheckpointId ||
        command.checkpoint.checkpointId === command.expectedCheckpointId
      )
        return fail("OUT_OF_ORDER");
      return decide(
        {
          ...state,
          checkpoint: command.checkpoint,
          admittedStepId: null,
          lastCommittedStepId: command.stepId,
        },
        "checkpointed",
      );
    }
    case "recordStopAcknowledgement": {
      requireControl(state, command.control);
      requirePublisher(state, command.publisher);
      requireGeneration(state, command.expectedGeneration);
      if (state.lifecycle !== "draining") return fail("OUT_OF_ORDER");
      const acknowledgement = {
        requestId: command.requestId,
        acknowledgementId: command.acknowledgementId,
      };
      if (state.stopAcknowledgement) {
        if (!same(state.stopAcknowledgement, acknowledgement)) return fail("CONFLICT");
        return decide(state, "unchanged");
      }
      return decide({ ...state, stopAcknowledgement: acknowledgement });
    }
    case "settleInvocation": {
      requireControl(state, command.control);
      requirePublisher(state, command.publisher);
      requireGeneration(state, command.expectedGeneration);
      const settlement = {
        outcome: command.outcome,
        invocationRpcJoined: command.invocationRpcJoined,
        fetchJoined: command.fetchJoined,
        callbackPortsJoined: command.callbackPortsJoined,
      };
      if (state.settlement && same(state.settlement, settlement)) return decide(state, "unchanged");
      if (state.lifecycle !== "draining") return fail("OUT_OF_ORDER");
      if (command.outcome !== "indeterminate" && !allJoined(settlement)) return fail("CONFLICT");
      if (command.outcome !== "indeterminate" && state.admittedStepId !== null)
        return fail("OUT_OF_ORDER");
      if (command.outcome === "stopped" && state.stopAcknowledgement === null)
        return fail("CONFLICT");
      const lifecycle =
        command.outcome === "settled"
          ? "settled"
          : command.outcome === "stopped"
            ? "stopped"
            : "indeterminate";
      return decide({ ...state, lifecycle, settlement }, lifecycle);
    }
    case "prepareFreshFacet": {
      requireControl(state, command.control);
      requirePublisher(state, command.publisher);
      requireGeneration(state, command.expectedGeneration);
      if (
        state.lifecycle === "preparing" &&
        state.prepared?.operationId === command.operationId &&
        same(state.prepared.publisher, command.preparedPublisher)
      )
        return decide(state, "unchanged");
      if (
        state.lifecycle !== "settled" &&
        state.lifecycle !== "stopped" &&
        state.lifecycle !== "recoverable"
      )
        return fail(state.lifecycle === "indeterminate" ? "INDETERMINATE" : "OUT_OF_ORDER");
      if (state.admittedStepId !== null) return fail("OUT_OF_ORDER");
      if (
        command.preparedPublisher.generation !== state.publisher.generation + 1 ||
        command.preparedPublisher.facetNonce === state.publisher.facetNonce ||
        command.preparedPublisher.publisherKey === state.publisher.publisherKey ||
        command.preparedPublisher.publisherKey === state.control.controlKey
      )
        return fail("CONFLICT");
      return decide(
        {
          ...state,
          lifecycle: "preparing",
          prepared: {
            operationId: command.operationId,
            publisher: command.preparedPublisher,
            checkpoint: state.checkpoint,
          },
          pendingControlSync: state.pendingControlSync
            ? {
                ...state.pendingControlSync,
                preparedPublication: {
                  operationId: command.operationId,
                  fromGeneration: state.publisher.generation,
                  toGeneration: command.preparedPublisher.generation,
                  priorFacetNonce: state.publisher.facetNonce,
                  preparedFacetNonce: command.preparedPublisher.facetNonce,
                  checkpoint: state.checkpoint,
                },
              }
            : null,
          lastFailure: null,
        },
        "prepared",
      );
    }
    case "publishFreshFacet": {
      requireControl(state, command.control);
      if (state.pendingControlSync) return fail("OUT_OF_ORDER");
      if (
        (state.lifecycle === "published" ||
          state.lifecycle === "activation-failed" ||
          state.lifecycle === "accepting") &&
        state.lastPublicationOperationId === command.operationId &&
        same(state.publisher, command.preparedPublisher) &&
        same(state.publisher, command.publisher) &&
        state.lastPublication?.fromGeneration === command.expectedGeneration &&
        same(state.checkpoint, command.checkpoint) &&
        state.nativeSessionId === command.verifiedNativeSessionId
      )
        return decide(state, "unchanged");
      requirePublisher(state, command.publisher);
      requireGeneration(state, command.expectedGeneration);
      if (state.lifecycle !== "preparing" || !state.prepared) return fail("OUT_OF_ORDER");
      if (
        state.prepared.operationId !== command.operationId ||
        !same(state.prepared.publisher, command.preparedPublisher) ||
        !same(state.prepared.checkpoint, command.checkpoint) ||
        state.nativeSessionId !== command.verifiedNativeSessionId
      )
        return fail("CONFLICT");
      return decide(
        {
          ...state,
          publisher: state.prepared.publisher,
          checkpoint: state.prepared.checkpoint,
          lifecycle: "published",
          prepared: null,
          lastPublication: {
            operationId: command.operationId,
            fromGeneration: command.expectedGeneration,
            toGeneration: command.preparedPublisher.generation,
            priorFacetNonce: command.publisher.facetNonce,
            preparedFacetNonce: command.preparedPublisher.facetNonce,
            checkpoint: command.checkpoint,
          },
          lastPublicationOperationId: command.operationId,
          lastFailure: null,
        },
        "published",
      );
    }
    case "recordActivation": {
      requireControl(state, command.control);
      if (state.pendingControlSync) return fail("OUT_OF_ORDER");
      requirePublisher(state, command.publisher);
      requireGeneration(state, command.expectedGeneration);
      if (
        state.lifecycle === "accepting" &&
        state.lastPublicationOperationId === command.operationId
      )
        return decide(state, "unchanged");
      if (
        (state.lifecycle !== "published" && state.lifecycle !== "activation-failed") ||
        state.lastPublicationOperationId !== command.operationId
      )
        return fail("OUT_OF_ORDER");
      return decide({ ...state, lifecycle: "accepting", lastFailure: null }, "activated");
    }
    case "recordActivationFailure": {
      requireControl(state, command.control);
      if (state.pendingControlSync) return fail("OUT_OF_ORDER");
      requirePublisher(state, command.publisher);
      requireGeneration(state, command.expectedGeneration);
      if (state.lifecycle !== "published" && state.lifecycle !== "activation-failed")
        return fail("OUT_OF_ORDER");
      if (state.lastPublicationOperationId !== command.operationId) return fail("CONFLICT");
      const lastFailure = {
        phase: "activate" as const,
        operationId: command.operationId,
        failure: command.failure,
        cleanup: null,
      };
      if (same(state.lastFailure, lastFailure)) return decide(state, "unchanged");
      return decide({ ...state, lifecycle: "activation-failed", lastFailure }, "activation-failed");
    }
    case "recordPreparedFacetFailure": {
      requireControl(state, command.control);
      if (state.pendingControlSync) return fail("OUT_OF_ORDER");
      requirePublisher(state, command.publisher);
      requireGeneration(state, command.expectedGeneration);
      if (
        state.lifecycle !== "preparing" ||
        state.prepared?.operationId !== command.operationId ||
        !same(state.prepared.publisher, command.preparedPublisher)
      )
        return fail("OUT_OF_ORDER");
      const recoverable = allClean(command.cleanup);
      return decide(
        {
          ...state,
          lifecycle: recoverable ? "recoverable" : "indeterminate",
          prepared: recoverable ? null : state.prepared,
          lastFailure: {
            phase: command.phase,
            operationId: command.operationId,
            failure: command.failure,
            cleanup: command.cleanup,
          },
        },
        recoverable ? "recoverable" : "indeterminate",
      );
    }
    case "reconcile": {
      requireControl(state, command.control);
      requireGeneration(state, command.expectedGeneration);
      if (state.reconciliationEvidenceId === command.evidenceId) {
        if (
          !same(state.reconciliationControl, command.control) ||
          state.reconciliationExpectedGeneration !== command.expectedGeneration ||
          state.reconciliationOutcome !== command.outcome ||
          !same(state.reconciliationCheckpoint, command.checkpoint) ||
          !same(state.reconciliationInvocationSettlement, command.invocationSettlement) ||
          !same(state.reconciliationPreparedFacetCleanup, command.preparedFacetCleanup) ||
          !same(state.reconciliationAdmissionResolution, command.admissionResolution)
        )
          return fail("CONFLICT");
        return decide(state, "unchanged");
      }
      if (state.lifecycle !== "indeterminate" && state.lifecycle !== "recoverable")
        return fail("OUT_OF_ORDER");
      if (state.pendingControlSync) return fail("OUT_OF_ORDER");
      if (
        command.outcome !== "unknown" &&
        (!command.invocationSettlement || !allJoined(command.invocationSettlement))
      )
        return fail("INDETERMINATE");
      if (
        state.prepared &&
        (!command.preparedFacetCleanup || !allClean(command.preparedFacetCleanup))
      )
        return fail("INDETERMINATE");
      if (!state.prepared && command.preparedFacetCleanup !== null) return fail("CONFLICT");
      if ((command.outcome === "completed") !== (command.checkpoint !== null))
        return fail("INVALID");
      if (command.outcome === "unknown") {
        if (command.admissionResolution !== null) return fail("CONFLICT");
      } else {
        const resolution = command.admissionResolution;
        if (
          !resolution ||
          resolution.evidenceId !== command.evidenceId ||
          resolution.outcome !== command.outcome ||
          resolution.stepId !== state.admittedStepId ||
          !same(resolution.expectedCheckpoint, state.checkpoint) ||
          (command.outcome === "notApplied" && !same(resolution.checkpoint, state.checkpoint)) ||
          (command.outcome === "completed" && !same(resolution.checkpoint, command.checkpoint))
        )
          return fail("CONFLICT");
      }
      const settlement = command.invocationSettlement
        ? {
            outcome:
              command.outcome === "completed"
                ? ("settled" as const)
                : command.outcome === "notApplied"
                  ? ("stopped" as const)
                  : ("indeterminate" as const),
            ...command.invocationSettlement,
          }
        : state.settlement;
      return decide(
        {
          ...state,
          lifecycle: command.outcome === "unknown" ? "indeterminate" : "recoverable",
          ...(command.outcome === "completed" && command.checkpoint
            ? { checkpoint: command.checkpoint, admittedStepId: null }
            : command.outcome === "notApplied"
              ? { admittedStepId: null }
              : {}),
          prepared:
            command.outcome !== "unknown" &&
            command.preparedFacetCleanup &&
            allClean(command.preparedFacetCleanup)
              ? null
              : state.prepared,
          reconciliationEvidenceId: command.evidenceId,
          reconciliationControl: command.control,
          reconciliationExpectedGeneration: command.expectedGeneration,
          reconciliationOutcome: command.outcome,
          reconciliationCheckpoint: command.checkpoint,
          reconciliationInvocationSettlement: command.invocationSettlement,
          reconciliationPreparedFacetCleanup: command.preparedFacetCleanup,
          reconciliationAdmissionResolution: command.admissionResolution,
          settlement,
        },
        "reconciled",
      );
    }
  }
}

export function snapshot(state: State) {
  return {
    runId: state.runId,
    ownerId: state.control.ownerId,
    controlIncarnationId: state.control.incarnationId,
    controlEpoch: state.control.epoch,
    nativeSessionId: state.nativeSessionId,
    checkpoint: state.checkpoint,
    generation: state.publisher.generation,
    facetNonce: state.publisher.facetNonce,
    lifecycle: state.lifecycle,
    admittedStepId: state.admittedStepId,
    preparedFacet:
      state.prepared === null
        ? null
        : {
            operationId: state.prepared.operationId,
            generation: state.prepared.publisher.generation,
            facetNonce: state.prepared.publisher.facetNonce,
            checkpoint: state.prepared.checkpoint,
          },
    lastPublication: state.lastPublication,
    pendingControlSync:
      state.pendingControlSync === null
        ? null
        : {
            operationId: state.pendingControlSync.operationId,
            fromEpoch: state.pendingControlSync.fromControl.epoch,
            fromIncarnationId: state.pendingControlSync.fromControl.incarnationId,
            toEpoch: state.control.epoch,
            toIncarnationId: state.control.incarnationId,
            expectedGeneration: state.pendingControlSync.expectedGeneration,
            publication: state.pendingControlSync.publication,
            preparedPublication: state.pendingControlSync.preparedPublication,
          },
    lastPublicationOperationId: state.lastPublicationOperationId,
    stopAcknowledgementId: state.stopAcknowledgement?.acknowledgementId ?? null,
    settlement: state.settlement,
    lastFailure: state.lastFailure,
    reconciliationEvidenceId: state.reconciliationEvidenceId,
    reconciliationExpectedGeneration: state.reconciliationExpectedGeneration,
    reconciliationAdmissionResolution: state.reconciliationAdmissionResolution,
    reconciliationOutcome: state.reconciliationOutcome,
    reconciliationCheckpoint: state.reconciliationCheckpoint,
    reconciliationInvocationSettlement: state.reconciliationInvocationSettlement,
    reconciliationPreparedFacetCleanup: state.reconciliationPreparedFacetCleanup,
  };
}

export function result(
  state: State,
  action: HarnessThreadSupervisorResult["action"],
  revealPreparedPublisher = true,
): HarnessThreadSupervisorResult {
  return {
    action,
    snapshot: snapshot(state),
    currentPublisher: state.publisher,
    preparedPublisher: revealPreparedPublisher ? (state.prepared?.publisher ?? null) : null,
  };
}
