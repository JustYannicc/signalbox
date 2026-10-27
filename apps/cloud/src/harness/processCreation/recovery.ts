import * as Schema from "effect/Schema";
import { readCreationPlacement } from "./placementSchema.ts";
import { CreationRecoveryInput } from "./schemas.ts";
import { createProcessSlots } from "../../computer/ProcessSlots.ts";
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import {
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessPlacementStoreClient,
} from "../processPlacement/durableStore.ts";
import { sameControl, samePublisher } from "../processResume/authority.ts";
import { hasCode } from "../durableState/errors.ts";
import { sameData } from "../processResume/checkpointContract.ts";
import { creationInvocationKey } from "./identity.ts";
import { sameWriter } from "../processPlacement/storeSchema.ts";
import { readCreationFacet } from "./placement.ts";
import {
  creationPlacementKey,
  readyCreation,
  type HarnessProcessCreationEnvironment,
  type HarnessProcessCreationPlacement,
} from "./contracts.ts";
import type { HarnessProcessCreationBinding } from "./journal.ts";

export interface HarnessProcessCreationRecoveryInput {
  readonly runId: string;
  readonly operationId: string;
  readonly drainOperationId: string;
  readonly control: HarnessProcessCreationPlacement["input"]["controllerClaim"];
  readonly nextControl: HarnessProcessCreationPlacement["input"]["controllerClaim"];
}

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
  if (
    !journal.snapshot.requests ||
    journal.snapshot.requests.entries.length !== 0 ||
    (await context.storage.get(creationInvocationKey(input.runId))) !== undefined
  )
    throw new Error("A dispatched initial request requires normal request reconciliation.");
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
    current.snapshot.admittedStepId !== null ||
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
  if (!placement.released) {
    const store = environment.PLACEMENT_STORES.getByName(
      placement.owner,
    ) as unknown as HarnessProcessPlacementStoreClient;
    const writer = { ...placement.writer, shardIncarnationNonce: incarnationNonce };
    const currentWriter = await store.readWriter(placement.owner);
    if (!currentWriter) throw new Error("Initial lease release has no known writer disposition.");
    if (!sameWriter(currentWriter, writer)) await store.claimWriter(placement.owner, writer);
    const stores = createHarnessProcessPlacementStoreClient(store, placement.owner, writer);
    const expectedLease = placement.lease;
    await createProcessSlots({
      owner: placement.owner,
      inFlightLimit: 1,
      residentByteLimit: Number(environment.RESIDENT_BYTE_LIMIT),
      store: stores.processSlots,
      scheduleQuantum: (callback) => {
        queueMicrotask(callback);
        return () => {};
      },
      invalidate: (loaderId) => {
        context.facets.abort(loaderId, "Bound initial process stopped.");
        context.facets.delete(loaderId);
      },
      reconcile: async (lease) => {
        if (
          lease.token !== expectedLease.token ||
          lease.loaderId !== expectedLease.loaderId ||
          lease.codeId !== expectedLease.codeId
        )
          throw new Error("Initial recovery encountered another process lease.");
        return { acknowledged: true };
      },
    });
    await store.releaseWriter(placement.owner, writer);
    placement = { ...placement, released: true };
    await context.storage.put(key, placement);
  }
  const settled = await durable.threadSupervisor.execute({
    type: "read",
    runId: input.runId,
    control: input.nextControl,
  });
  if (settled.snapshot.lifecycle === "stopped" || settled.snapshot.lifecycle === "settled")
    return {
      ...readyCreation(input.operationId, binding, "bound"),
      control: input.nextControl,
      lifecycle: settled.snapshot.lifecycle,
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
