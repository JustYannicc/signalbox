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
  type HarnessProcessPlacementOptions,
  type HarnessProcessPlacementRequest,
  type HarnessProcessPreparedFacet,
} from "./contracts.ts";
import { HarnessProcessHandleImpl } from "./processHandle.ts";

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
          undefined,
          { owner: existing.owner, requestedOwner: options.owner },
        ),
      );
    return existing.promise;
  }

  const promise = openPlacement(options);
  allocators.set(options.contextKey, {
    owner: options.owner,
    controllerClaim: options.controllerClaim,
    shardIncarnationNonce: options.shardIncarnationNonce,
    context: options.context,
    promise,
  });
  return promise;
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
  const inFlightLimit = context === "durable-object" ? 10 : 4;
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
      openFacet: (identity: HarnessProcessPlacementIdentity) => HarnessProcessPreparedFacet<Input>,
    ): Promise<HarnessProcessHandle<Input>> {
      if (
        !sameClaim(request.controllerClaim, controllerClaim) ||
        !request.nativeSessionId ||
        !request.checkpointId ||
        !request.manifestRevision ||
        !request.priorFacetNonce ||
        !request.preparedFacetNonce ||
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
              shardOwner: options.owner,
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
              shardOwner: options.owner,
              residentBytes: request.residentBytes,
              route: "different-destination-required",
            },
            { cause },
          );
        }
        throw cause;
      }
      removePressure();

      const identity: HarnessProcessPlacementIdentity = Object.freeze({
        shardOwner: options.owner,
        loaderId: admission.lease.loaderId,
        facetKey: admission.lease.loaderId,
        incarnationNonce: request.preparedFacetNonce,
      });
      let facet: HarnessProcessPreparedFacet<Input>;
      const baseRecord = {
        version: 1 as const,
        shardOwner: options.owner,
        controllerClaim,
        operationId: request.operationId,
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
        await slots.release(admission.lease, { acknowledged: true });
        throw new HarnessProcessPlacementError(
          "prepare-failed",
          "The placement recovery record could not be saved before opening the facet.",
          false,
          identity,
          { loaderId: identity.loaderId },
          { cause },
        );
      }

      try {
        // This factory must only construct a stub. Its first RPC/resource effect is prepareInert().
        facet = openFacet(identity);
      } catch (cause) {
        try {
          await slots.release(admission.lease, { acknowledged: true });
          await recovery.remove(identity.loaderId);
        } catch (cleanupCause) {
          await recovery.save({
            ...baseRecord,
            state: "cleanup-required",
            lastFailure: errorText(cleanupCause),
          });
          throw new HarnessProcessPlacementError(
            "cleanup-incomplete",
            "Facet stub construction failed and the slot needs durable recovery.",
            true,
            identity,
            { recoveryId: identity.loaderId, failure: errorText(cleanupCause) },
            { cause },
          );
        }
        throw new HarnessProcessPlacementError(
          "prepare-failed",
          "Facet stub construction failed before any RPC or resource effect.",
          false,
          identity,
          { loaderId: identity.loaderId },
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

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sameClaim(
  left: HarnessProcessPlacementOptions["controllerClaim"],
  right: HarnessProcessPlacementOptions["controllerClaim"],
) {
  return (
    left.ownerId === right.ownerId &&
    left.incarnationId === right.incarnationId &&
    left.epoch === right.epoch &&
    left.controlKey === right.controlKey
  );
}
