// @effect-diagnostics cryptoRandomUUID:off - process identity namespaces use platform randomness.
import { createProcessSlots } from "../../computer/ProcessSlots.ts";
import type {
  ProcessSlotPressure,
  ProcessSlotRequest,
  ProcessSlots,
} from "../../computer/ProcessSlots.ts";
import {
  HarnessProcessPlacementError,
  type HarnessProcessHandle,
  type HarnessProcessPlacement,
  type HarnessProcessPlacementIdentity,
  type HarnessProcessFacetLocator,
  type HarnessProcessPlacementOptions,
  type HarnessProcessPlacementRequest,
  type HarnessProcessPreparedFacet,
} from "./contracts.ts";
import { HarnessProcessHandleImpl } from "./processHandle.ts";
import { DURABLE_OBJECT_INVOCATION_LIMIT, WORKER_REQUEST_INVOCATION_LIMIT } from "./limits.ts";
import { sameClaim } from "./storeSchema.ts";

interface ContextAllocator {
  readonly owner: string;
  readonly controllerClaim: HarnessProcessPlacementOptions["controllerClaim"];
  readonly shardIncarnationNonce: string;
  readonly context: HarnessProcessPlacementOptions["context"];
  readonly promise: Promise<HarnessProcessPlacement>;
}

const allocators = new WeakMap<object, ContextAllocator>();
type UnplaceableRequestPressure = Extract<
  ProcessSlotPressure,
  { readonly kind: "unplaceable"; readonly request: ProcessSlotRequest }
>;

export function createHarnessProcessPlacement(
  options: HarnessProcessPlacementOptions,
): Promise<HarnessProcessPlacement> {
  const existing = allocators.get(options.contextKey);
  if (existing !== undefined) {
    if (
      existing.owner !== options.owner ||
      !sameClaim(existing.controllerClaim, options.controllerClaim) ||
      existing.shardIncarnationNonce !== options.shardIncarnationNonce ||
      existing.context !== options.context
    )
      return Promise.reject(
        new HarnessProcessPlacementError(
          "stale-handle",
          "This runtime context already owns another ProcessSlots writer.",
          true,
        ),
      );
    return existing.promise;
  }

  const entry: ContextAllocator = {
    owner: options.owner,
    controllerClaim: options.controllerClaim,
    shardIncarnationNonce: options.shardIncarnationNonce,
    context: options.context,
    promise: openPlacement(options),
  };
  allocators.set(options.contextKey, entry);
  void entry.promise.catch(() => {
    if (allocators.get(options.contextKey) === entry) allocators.delete(options.contextKey);
  });
  return entry.promise;
}

export function forgetHarnessProcessPlacement(
  contextKey: object,
  placement: Promise<HarnessProcessPlacement>,
): void {
  const current = allocators.get(contextKey);
  if (current?.promise === placement) allocators.delete(contextKey);
}

async function openPlacement(
  options: HarnessProcessPlacementOptions,
): Promise<HarnessProcessPlacement> {
  const {
    contextKey: _contextKey,
    context,
    shardIncarnationNonce,
    controllerClaim,
    recovery,
    onCapacity,
    onUnplaceable,
    ...processSlotOptions
  } = options;
  if (
    !shardIncarnationNonce ||
    !controllerClaim.ownerId ||
    !controllerClaim.incarnationId ||
    !controllerClaim.controlKey ||
    !Number.isSafeInteger(controllerClaim.epoch) ||
    !options.owner.includes("/")
  )
    throw new TypeError("Process placement needs a stable shard owner, incarnation, and claim.");

  // The owner-supplied dw-cap-probe measured these caller-context limits, not global agent caps.
  // A DO context admits 10 distinct loader IDs. A plain Worker request admits four.
  const inFlightLimit =
    context === "durable-object"
      ? DURABLE_OBJECT_INVOCATION_LIMIT
      : WORKER_REQUEST_INVOCATION_LIMIT;
  const slots = await createProcessSlots({ ...processSlotOptions, inFlightLimit });
  slots.signals.onPressure((pressure) => {
    if (pressure.kind !== "capacity") return;
    try {
      onCapacity?.(pressure);
    } catch {
      // Capacity notification cannot poison the allocator that reported it.
    }
  });

  const service: HarnessProcessPlacement = {
    signals: slots.signals,
    shardOwner: options.owner,
    shardIncarnationNonce,
    async recoverable() {
      return await recovery.list();
    },
    async prepareInert<Input>(
      request: HarnessProcessPlacementRequest,
      openFacet: (identity: HarnessProcessFacetLocator) => HarnessProcessPreparedFacet<Input>,
    ): Promise<HarnessProcessHandle<Input>> {
      if (
        !sameClaim(request.controllerClaim, controllerClaim) ||
        !request.processId ||
        !request.nativeSessionId ||
        !request.checkpointId ||
        !request.manifestRevision ||
        !request.priorFacetNonce ||
        !request.operationId ||
        !request.codeId ||
        !Number.isSafeInteger(request.expectedFacetGeneration) ||
        request.expectedFacetGeneration < 0
      )
        throw new HarnessProcessPlacementError(
          "stale-publication",
          "Process placement request does not match the active shard claim.",
          true,
        );

      const interrupted = new AbortController();
      const signal = AbortSignal.any([request.signal, interrupted.signal]);
      let unplaceable: UnplaceableRequestPressure | undefined;
      const removePressure = slots.signals.onPressure((pressure) => {
        if (pressure.kind !== "unplaceable" || !("request" in pressure)) return;
        if (pressure.request.signal !== signal) return;
        unplaceable = pressure;
        interrupted.abort(
          new HarnessProcessPlacementError(
            "unplaceable",
            "The process exceeds this isolate's resident-byte limit and needs a different execution destination.",
            true,
            undefined,
            {
              residentBytes: pressure.request.residentBytes,
              route: "different-destination-required",
            },
          ),
        );
      });

      let admission: Awaited<ReturnType<ProcessSlots["acquire"]>>;
      const slotCodeId = `process-${crypto.randomUUID()}`;
      try {
        admission = await slots.acquire({
          owner: options.owner,
          codeId: slotCodeId,
          residentBytes: request.residentBytes,
          signal,
        });
      } catch (cause) {
        removePressure();
        if (unplaceable !== undefined) {
          try {
            onUnplaceable?.(unplaceable.request, unplaceable);
          } catch {
            // Routing advice is advisory; the typed outcome remains authoritative.
          }
          throw new HarnessProcessPlacementError(
            "unplaceable",
            "No fitting slot exists in this execution shard. Route the process once to another destination.",
            true,
            undefined,
            {
              residentBytes: request.residentBytes,
              route: "different-destination-required",
            },
            { cause },
          );
        }
        throw cause;
      }
      removePressure();

      const locator: HarnessProcessFacetLocator = Object.freeze({
        shardOwner: options.owner,
        loaderId: admission.lease.loaderId,
        facetKey: admission.lease.loaderId,
      });
      let facet: HarnessProcessPreparedFacet<Input>;
      let identity: HarnessProcessPlacementIdentity;
      try {
        facet = openFacet(locator);
        const observed = await facet.identity();
        if (observed.facetKey !== locator.facetKey || !observed.incarnationNonce)
          throw new HarnessProcessPlacementError(
            "prepare-failed",
            "The constructed facet did not provide its actual constructor identity.",
            true,
            undefined,
            { recoveryId: locator.loaderId, causeCode: "IDENTITY_MISMATCH" },
          );
        identity = Object.freeze({ ...locator, incarnationNonce: observed.incarnationNonce });
      } catch (cause) {
        await slots.release(admission.lease, { acknowledged: true });
        throw new HarnessProcessPlacementError(
          "prepare-failed",
          "The fresh facet could not expose its constructor identity before preparation.",
          false,
          undefined,
          { recoveryId: locator.loaderId },
          { cause },
        );
      }
      const baseRecord = {
        version: 1 as const,
        shardOwner: options.owner,
        controllerClaim,
        operationId: request.operationId,
        processId: request.processId,
        nativeSessionId: request.nativeSessionId,
        checkpointId: request.checkpointId,
        manifestRevision: request.manifestRevision,
        priorFacetNonce: request.priorFacetNonce,
        programCodeId: request.codeId,
        loaderId: identity.loaderId,
        facetKey: identity.facetKey,
        incarnationNonce: identity.incarnationNonce,
        lease: admission.lease,
        state: "preparing" as const,
        stopAcknowledged: false,
        joined: { invocationRpc: false, fetch: false, ports: false },
      };
      try {
        await recovery.save(baseRecord);
      } catch (cause) {
        await facet.dispose();
        await slots.release(admission.lease, { acknowledged: true });
        throw new HarnessProcessPlacementError(
          "prepare-failed",
          "The placement recovery record could not be saved before opening the facet.",
          false,
          identity,
          { recoveryId: identity.loaderId },
          { cause },
        );
      }

      const handle = new HarnessProcessHandleImpl({
        slots,
        options,
        request,
        identity,
        lease: admission.lease,
        permit: admission.permit,
        facet,
      });
      await handle.initialize();
      return handle;
    },
  };
  return service;
}
