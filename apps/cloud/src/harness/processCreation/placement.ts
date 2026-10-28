// @effect-diagnostics cryptoRandomUUID:off - a process lease uses an opaque code namespace.
import { createProcessSlots } from "../../computer/ProcessSlots.ts";
import { processFacetStores } from "../processOwnership/bindings.ts";
import {
  createHarnessProcessPlacementStoreClient,
  type HarnessProcessPlacementStoreClient,
} from "../processPlacement/durableStore.ts";
import { createHarnessProcessFacetStub } from "../processPlacement/facetLoader.ts";
import type { HarnessProcessFacetStub } from "../processPlacement/facetLoader.ts";
import type { HarnessProcessPlacementIdentity } from "../processPlacement/contracts.ts";
import { DURABLE_OBJECT_INVOCATION_LIMIT } from "../processPlacement/limits.ts";
import {
  creationPlacementKey,
  type HarnessProcessCreationInput,
  type HarnessProcessCreationEnvironment,
  type HarnessProcessCreationPlacement,
} from "./contracts.ts";

export async function openCreationPlacement(
  context: DurableObjectState,
  environment: HarnessProcessCreationEnvironment,
  incarnationNonce: string,
  input: HarnessProcessCreationInput,
) {
  const owner = context.id.name;
  if (!owner?.includes("/")) throw new Error("Cold creation requires a named execution shard.");
  const writer = {
    executionOperationId: input.operationId,
    shardIndex: 0,
    shardIncarnationNonce: incarnationNonce,
    controllerClaim: input.controllerClaim,
  };
  const store = environment.PLACEMENT_STORES.getByName(
    owner,
  ) as unknown as HarnessProcessPlacementStoreClient;
  const residentByteLimit = Number(environment.RESIDENT_BYTE_LIMIT);
  if (!Number.isSafeInteger(residentByteLimit) || residentByteLimit <= 0)
    throw new Error("Invalid creation residency limit.");
  await store.claimWriter(owner, writer);
  const stores = createHarnessProcessPlacementStoreClient(store, owner, writer);
  const slots = await createProcessSlots({
    owner,
    inFlightLimit: DURABLE_OBJECT_INVOCATION_LIMIT,
    residentByteLimit,
    store: stores.processSlots,
    scheduleQuantum: (callback) => {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
      return () => {
        cancelled = true;
      };
    },
    invalidate: (loaderId) => {
      context.facets.abort(loaderId, "Cold process lease retired.");
      context.facets.delete(loaderId);
    },
    reconcile: async () => {
      throw new Error("A prior creation lease requires exact bound recovery.");
    },
  });
  const admission = await slots.acquire({
    owner,
    codeId: `process-${crypto.randomUUID()}`,
    residentBytes: input.facet.residentBytes,
    signal: new AbortController().signal,
  });
  const locator = {
    shardOwner: owner,
    loaderId: admission.lease.loaderId,
    facetKey: admission.lease.loaderId,
  };
  let record: HarnessProcessCreationPlacement = {
    version: 1,
    operationId: input.operationId,
    owner,
    writer,
    lease: admission.lease,
    input,
  };
  await context.storage.put(creationPlacementKey(input.runId), record);
  const process = await creationFacetInput(input, environment);
  const stub = createHarnessProcessFacetStub(context, environment, process, locator);
  const observed = await stub.identity();
  if (!observed.facetNonce) throw new Error("The created facet has no constructor identity.");
  const identity = Object.freeze({ ...locator, incarnationNonce: observed.facetNonce });
  record = { ...record, identity };
  await context.storage.put(creationPlacementKey(input.runId), record);
  let disposed = false;
  let active: Promise<unknown> | undefined;
  let released = false;
  const stop = async () => {
    if (!disposed) {
      await stub.dispose(identity.incarnationNonce);
      disposed = true;
      record = {
        ...record,
        disposed: true,
        termination: { kind: "disposed", facetNonce: identity.incarnationNonce },
      };
      await context.storage.put(creationPlacementKey(input.runId), record);
    }
    return { acknowledged: true as const };
  };
  const join = async () => {
    if (active !== undefined) await active;
    return { invocationRpc: active === undefined, fetch: disposed, ports: disposed };
  };
  const handle = {
    identity,
    stop,
    join,
    async cleanup() {
      if (released) return;
      await stop();
      const joined = await join();
      if (!joined.invocationRpc || !joined.fetch || !joined.ports)
        throw new Error("Cold process resources have not joined.");
      context.facets.abort(locator.loaderId, "Cold process stopped and joined.");
      context.facets.delete(locator.loaderId);
      await slots.release(admission.lease, { acknowledged: true });
      await store.releaseWriter(owner, writer);
      released = true;
      record = { ...record, released: true };
      await context.storage.put(creationPlacementKey(input.runId), record);
    },
  };
  return {
    input,
    identity,
    stub,
    handle,
    async invoke(request: Parameters<HarnessProcessFacetStub["run"]>[0]) {
      if (active !== undefined || disposed || released)
        throw new Error("Cold process invocation is not available.");
      const running = stub.run(request);
      active = running;
      try {
        return {
          value: await running,
          stopAcknowledged: false,
          joined: { invocationRpc: true, fetch: false, ports: false },
          processRetained: true as const,
        };
      } finally {
        active = undefined;
      }
    },
  };
}

export type HarnessCreatedProcessPlacement = Awaited<ReturnType<typeof openCreationPlacement>>;

export async function readCreationFacet(
  context: DurableObjectState,
  environment: HarnessProcessCreationEnvironment,
  record: HarnessProcessCreationPlacement & { readonly identity: HarnessProcessPlacementIdentity },
) {
  const input = record.input;
  return createHarnessProcessFacetStub(
    context,
    environment,
    await creationFacetInput(input, environment),
    record.identity,
  );
}

async function creationFacetInput(
  input: HarnessProcessCreationInput,
  environment: HarnessProcessCreationEnvironment,
) {
  return {
    ...input.facet,
    resumeFacetEnv: {
      HARNESS_RESUME_CREATION: true as const,
      HARNESS_RESUME_RUN_ID: input.runId,
      HARNESS_RESUME_CONTROL: input.controllerClaim,
      ...(await processFacetStores(environment, input.runId)),
    },
  };
}
