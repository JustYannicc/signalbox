import { releaseCreationPlacement } from "./releasePlacement.ts";
import { readUndispatchedCreation, retireUndispatchedCreation } from "./undispatched.ts";
import * as Schema from "effect/Schema";
import { readCreationPlacement } from "./placementSchema.ts";
import { CreationRecoveryInput } from "./schemas.ts";
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import { sameControl, samePublisher } from "../processResume/authority.ts";
import { hasCode } from "../durableState/errors.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import { readCreationFacet } from "./placement.ts";
import {
  creationPlacementKey,
  readyCreation,
  type HarnessProcessCreationEnvironment,
  type HarnessProcessCreationRecoveryInput,
} from "./contracts.ts";
import type { HarnessProcessCreationBinding } from "./journal.ts";

export type { HarnessProcessCreationRecoveryInput } from "./contracts.ts";

const decodeRecovery = Schema.decodeUnknownSync(CreationRecoveryInput, {
  onExcessProperty: "error",
});

/** Before the first request, retire the observed initial process so ordinary strict restore can run. */
export async function recoverBoundCreation(
  context: DurableObjectState,
  environment: HarnessProcessCreationEnvironment,
  incarnationNonce: string,
  supplied: HarnessProcessCreationRecoveryInput,
  binding: HarnessProcessCreationBinding,
) {
  const input = structuredClone(decodeRecovery(supplied));
  const key = creationPlacementKey(input.runId);
  let placement = readCreationPlacement(await context.storage.get<unknown>(key));
  if (
    !placement?.identity ||
    placement.operationId !== input.operationId ||
    placement.owner !== context.id.name ||
    !sameControl(placement.input.controllerClaim, input.control) ||
    placement.identity.incarnationNonce !== binding.identity.incarnationNonce
  )
    throw new Error("Recovery does not identify the exact bound initial placement.");
  const durable = createHarnessDurableState(environment, input.runId);
  const journal = await durable.runStore.execute({ type: "read", runId: input.runId });
  const admission = await readUndispatchedCreation(context.storage, input, journal, binding);
  const recoveryKey = `harness-process-creation-recovery/v1/${encodeURIComponent(input.runId)}`;
  await context.storage.transaction(async (transaction) => {
    const prior = await transaction.get<unknown>(recoveryKey);
    if (prior !== undefined && !sameData(prior, input))
      throw new Error("Another immutable initial recovery owns this process.");
    await transaction.put(recoveryKey, input);
  });
  let current;
  try {
    current = await durable.threadSupervisor.execute({
      type: "read",
      runId: input.runId,
      control: input.control,
    });
  } catch (cause) {
    if (!hasCode(cause, "STALE_CONTROL")) throw cause;
    current = await durable.threadSupervisor.execute({
      type: "read",
      runId: input.runId,
      control: input.nextControl,
    });
  }
  if (
    current.snapshot.nativeSessionId !== binding.nativeSessionId ||
    !samePublisher(current.currentPublisher, binding.initialization.publisher) ||
    (current.snapshot.admittedStepId !== null &&
      current.snapshot.admittedStepId !== admission?.request.request.requestId) ||
    current.snapshot.checkpoint.checkpointId !== binding.checkpoint.native.id ||
    current.snapshot.checkpoint.manifestSha256 !== binding.checkpoint.filesystem.sha256
  )
    throw new Error("Bound recovery cannot change the native session or initial checkpoint.");
  if (
    current.snapshot.controlEpoch !== input.nextControl.epoch ||
    current.snapshot.pendingControlSync !== null
  ) {
    const drained = await durable.beginDrain({
      control: input.control,
      publisher: binding.initialization.publisher,
      expectedGeneration: 1,
      operationId: input.drainOperationId,
      nextControl: input.nextControl,
    });
    if (drained.status !== "draining")
      throw new Error("Initial recovery control synchronization is incomplete.");
  }
  if (!placement.termination) {
    if (placement.writer.shardIncarnationNonce !== incarnationNonce) {
      // A DO incarnation owns its facets. Reconstructing the parent aborts those children.
      // No request was dispatched, so there are no invocation callbacks to reconcile.
      context.facets.abort(placement.lease.loaderId, "The prior creation parent was destroyed.");
      context.facets.delete(placement.lease.loaderId);
      placement = {
        ...placement,
        termination: { kind: "parent-destroyed", observedByIncarnationNonce: incarnationNonce },
      };
    } else {
      const stub = readCreationFacet(context, environment, {
        ...placement,
        identity: placement.identity,
      });
      const actual = await stub.identity();
      if (actual.facetNonce !== placement.identity.incarnationNonce)
        throw new Error("Initial recovery cannot prove the retained native incarnation stopped.");
      await stub.dispose(actual.facetNonce);
      placement = {
        ...placement,
        disposed: true,
        termination: { kind: "disposed", facetNonce: actual.facetNonce },
      };
    }
    await context.storage.put(key, placement);
  }
  placement = await releaseCreationPlacement(context, environment, incarnationNonce, placement);
  if (admission !== undefined) {
    await retireUndispatchedCreation(
      context.storage,
      environment,
      input,
      admission,
      placement.input.run.controlKey,
    );
    const state = await durable.threadSupervisor.execute({
      type: "read",
      runId: input.runId,
      control: input.nextControl,
    });
    if (state.snapshot.admittedStepId !== null || state.snapshot.lifecycle === "indeterminate") {
      if (state.snapshot.lifecycle === "draining")
        await durable.threadSupervisor.execute({
          type: "settleInvocation",
          runId: input.runId,
          control: input.nextControl,
          publisher: binding.initialization.publisher,
          expectedGeneration: 1,
          outcome: "indeterminate",
          invocationRpcJoined: true,
          fetchJoined: true,
          callbackPortsJoined: true,
        });
      await durable.reconcile({
        control: input.nextControl,
        expectedGeneration: 1,
        evidenceId: `${input.drainOperationId}/undispatched`,
        outcome: "notApplied",
        checkpoint: null,
        invocationSettlement: {
          invocationRpcJoined: true,
          fetchJoined: true,
          callbackPortsJoined: true,
        },
        preparedFacetCleanup: null,
      });
    }
  }
  const terminal = await durable.threadSupervisor.execute({
    type: "read",
    runId: input.runId,
    control: input.nextControl,
  });
  if (
    ["stopped", "settled", "recoverable"].includes(terminal.snapshot.lifecycle) &&
    terminal.snapshot.admittedStepId === null
  )
    return {
      ...readyCreation(input.operationId, binding, "bound"),
      control: input.nextControl,
      lifecycle: terminal.snapshot.lifecycle,
    };
  const graceful = placement.termination?.kind === "disposed";
  if (graceful)
    await durable.threadSupervisor.execute({
      type: "recordStopAcknowledgement",
      runId: input.runId,
      control: input.nextControl,
      publisher: binding.initialization.publisher,
      expectedGeneration: 1,
      requestId: input.operationId,
      acknowledgementId: `${input.drainOperationId}/initial-disposed`,
    });
  const stopped = await durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId: input.runId,
    control: input.nextControl,
    publisher: binding.initialization.publisher,
    expectedGeneration: 1,
    outcome: graceful ? "stopped" : "settled",
    invocationRpcJoined: true,
    fetchJoined: true,
    callbackPortsJoined: true,
  });
  if (
    (stopped.snapshot.lifecycle !== "stopped" && stopped.snapshot.lifecycle !== "settled") ||
    stopped.snapshot.nativeSessionId !== binding.nativeSessionId
  )
    throw new Error("Initial recovery did not confirm the strict resume boundary.");
  return {
    ...readyCreation(input.operationId, binding, "bound"),
    control: input.nextControl,
    lifecycle: stopped.snapshot.lifecycle,
  };
}
