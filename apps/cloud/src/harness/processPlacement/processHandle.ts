import type {
  ProcessSlotLease,
  ProcessSlotPermit,
  ProcessSlots,
} from "../../computer/ProcessSlots.ts";
import {
  HarnessProcessPlacementError,
  type HarnessProcessHandle,
  type HarnessProcessInvocationSettlement,
  type HarnessProcessJoined,
  type HarnessProcessPlacementIdentity,
  type HarnessProcessPlacementOptions,
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPreparedFacet,
  type HarnessProcessPublication,
  type HarnessProcessPlacementRequest,
} from "./contracts.ts";
import { confirmedProcessPublication } from "./publication.ts";

interface Attempt {
  rpcReturned: boolean;
  stopAcknowledged: boolean;
  joined: HarnessProcessJoined;
}

const joinedNone: HarnessProcessJoined = Object.freeze({
  invocationRpc: false,
  fetch: false,
  ports: false,
});
const joinedAll: HarnessProcessJoined = Object.freeze({
  invocationRpc: true,
  fetch: true,
  ports: true,
});

export class HarnessProcessHandleImpl<Input> implements HarnessProcessHandle<Input> {
  readonly identity: HarnessProcessPlacementIdentity;
  readonly lease: ProcessSlotLease;
  readonly #slots: ProcessSlots;
  readonly #options: HarnessProcessPlacementOptions;
  readonly #facet: HarnessProcessPreparedFacet<Input>;
  readonly #request: HarnessProcessPlacementRequest;
  readonly #attempts = new Set<Attempt>();
  #permit: ProcessSlotPermit | undefined;
  #parkOutcome:
    | Promise<
        | {
            readonly ok: true;
            readonly value: { readonly value: unknown; readonly permit: ProcessSlotPermit };
          }
        | { readonly ok: false; readonly error: unknown }
      >
    | undefined;
  #parkRelease: ((publication: HarnessProcessPublication) => void) | undefined;
  #state: HarnessProcessPlacementRecoveryRecord["state"] = "preparing";
  #stopAcknowledged = false;
  #joined: HarnessProcessJoined = joinedNone;
  #disposed = false;
  #released = false;
  #lastFailure: string | undefined;

  constructor(input: {
    readonly slots: ProcessSlots;
    readonly options: HarnessProcessPlacementOptions;
    readonly request: HarnessProcessPlacementRequest;
    readonly identity: HarnessProcessPlacementIdentity;
    readonly lease: ProcessSlotLease;
    readonly permit: ProcessSlotPermit;
    readonly facet: HarnessProcessPreparedFacet<Input>;
  }) {
    this.#slots = input.slots;
    this.#options = input.options;
    this.#request = input.request;
    this.identity = input.identity;
    this.lease = input.lease;
    this.#permit = input.permit;
    this.#facet = input.facet;
  }

  async initialize(): Promise<void> {
    try {
      const observed = await this.#facet.prepareInert({
        identity: this.identity,
        operationId: this.#request.operationId,
        nativeSessionId: this.#request.nativeSessionId,
        checkpointId: this.#request.checkpointId,
        manifestRevision: this.#request.manifestRevision,
      });
      if (
        observed.nativeSessionId !== this.#request.nativeSessionId ||
        observed.checkpointId !== this.#request.checkpointId ||
        observed.manifestRevision !== this.#request.manifestRevision ||
        observed.facetKey !== this.identity.facetKey ||
        observed.incarnationNonce !== this.identity.incarnationNonce ||
        !allJoined(observed.joined)
      )
        throw new HarnessProcessPlacementError(
          "prepare-failed",
          "The inert facet did not confirm its native session, checkpoint, identity, and settled open RPC.",
          true,
          this.identity,
          { observed },
        );

      this.#joined = observed.joined;
      await this.#persist("preparing");
      await this.#parkForPublication();
      this.#state = "prepared";
      await this.#persist("prepared");
    } catch (cause) {
      this.#lastFailure = errorText(cause);
      const cleanup = await this.#cleanupInternal(false);
      throw new HarnessProcessPlacementError(
        "prepare-failed",
        cleanup === undefined
          ? "The fresh facet could not be prepared inert."
          : "The fresh facet could not be prepared inert and cleanup is incomplete.",
        cleanup !== undefined,
        this.identity,
        { recoveryId: this.identity.loaderId, cleanupFailure: cleanup, cause: errorText(cause) },
        { cause },
      );
    }
  }

  async activate(
    publication: HarnessProcessPublication | Promise<HarnessProcessPublication>,
  ): Promise<void> {
    if (this.#state !== "prepared") this.#requireState("prepared");
    let receipt: HarnessProcessPublication;
    try {
      receipt = await publication;
    } catch (cause) {
      const cleanup = await this.#cleanupInternal(false);
      throw new HarnessProcessPlacementError(
        "stale-publication",
        cleanup === undefined
          ? "Facet publication failed; the prepared facet was retired."
          : "Facet publication failed and its prepared facet needs recovery.",
        cleanup !== undefined,
        this.identity,
        { recoveryId: this.identity.loaderId, cleanupFailure: cleanup },
        { cause },
      );
    }

    const confirmed = confirmedProcessPublication(receipt, {
      controllerClaim: this.#options.controllerClaim,
      operationId: this.#request.operationId,
      nativeSessionId: this.#request.nativeSessionId,
      checkpointId: this.#request.checkpointId,
      manifestRevision: this.#request.manifestRevision,
      priorFacetNonce: this.#request.priorFacetNonce,
      expectedFacetGeneration: this.#request.expectedFacetGeneration,
      identity: this.identity,
    });
    if (confirmed === undefined) {
      const cleanup = await this.#cleanupInternal(false);
      throw new HarnessProcessPlacementError(
        "stale-publication",
        cleanup === undefined
          ? "The control claim changed before facet activation."
          : "The control claim changed and prepared-facet cleanup needs recovery.",
        cleanup !== undefined,
        this.identity,
        { recoveryId: this.identity.loaderId, cleanupFailure: cleanup },
      );
    }

    const parkRelease = this.#parkRelease;
    const parkOutcome = this.#parkOutcome;
    if (parkRelease === undefined || parkOutcome === undefined)
      throw new HarnessProcessPlacementError(
        "stale-handle",
        "The prepared facet has no pending ProcessSlots admission.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId },
      );

    parkRelease(receipt);
    const admitted = await parkOutcome;
    this.#parkRelease = undefined;
    this.#parkOutcome = undefined;
    if (!admitted.ok) {
      this.#state = "cleanup-required";
      this.#lastFailure = errorText(admitted.error);
      await this.#persist("cleanup-required");
      throw new HarnessProcessPlacementError(
        "cleanup-incomplete",
        "The published facet could not regain ProcessSlots admission.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, failure: this.#lastFailure },
        { cause: admitted.error },
      );
    }
    this.#permit = admitted.value.permit;

    try {
      await this.#facet.activate(confirmed);
    } catch (cause) {
      this.#state = "activation-failed";
      this.#lastFailure = errorText(cause);
      await this.#persist("activation-failed");
      const cleanup = await this.#cleanupInternal(true);
      throw new HarnessProcessPlacementError(
        "activation-failed",
        cleanup === undefined
          ? "The published facet failed activation. Repair its persisted lifecycle before another launch."
          : "The published facet failed activation and cleanup needs persisted repair.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, cleanupFailure: cleanup, failure: this.#lastFailure },
        { cause },
      );
    }
    this.#state = "active";
    await this.#persist("active");
  }

  async invoke(input: Input): Promise<HarnessProcessInvocationSettlement> {
    this.#requireState("active");
    if (this.#permit === undefined || this.#released)
      throw new HarnessProcessPlacementError(
        "stale-handle",
        "The process has no active invocation permit.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId },
      );
    const attempt: Attempt = { rpcReturned: false, stopAcknowledged: false, joined: joinedNone };
    this.#attempts.add(attempt);
    try {
      const settlement = await this.#facet.invoke(input);
      attempt.rpcReturned = true;
      attempt.stopAcknowledged = settlement.stopAcknowledged;
      attempt.joined = settlement.joined;
      this.#joined = settlement.joined;
      this.#pruneSettledAttempts();
      if (!attempt.stopAcknowledged || !allJoined(attempt.joined)) {
        this.#state = "cleanup-required";
        this.#lastFailure =
          "Invocation returned without stop acknowledgement and full joined settlement.";
        await this.#persist("cleanup-required");
        return settlement;
      }
      this.#state = "active";
      await this.#persist("active");
      return settlement;
    } catch (cause) {
      attempt.rpcReturned = true;
      this.#state = "cleanup-required";
      this.#lastFailure = errorText(cause);
      await this.#persist("cleanup-required");
      throw new HarnessProcessPlacementError(
        "invocation-unsettled",
        "The invocation RPC failed before placement could prove it settled.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, failure: this.#lastFailure },
        { cause },
      );
    }
  }

  async park<Value>(
    waitForResume: () => Promise<{
      readonly value: Value;
      readonly publication: HarnessProcessPublication;
    }>,
    signal: AbortSignal,
  ): Promise<Value> {
    this.#requireState("active");
    if (this.#attempts.size > 0)
      throw new HarnessProcessPlacementError(
        "invocation-unsettled",
        "An open or unjoined invocation still owns this process permit.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, openInvocations: this.#attempts.size },
      );
    const permit = this.#permit;
    if (permit === undefined) this.#requireState("active");
    this.#permit = undefined;
    this.#state = "parked";
    const outcome = this.#slots.park(this.lease, permit!, waitForResume, signal).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    this.#parkOutcome = outcome;
    const admitted = await outcome;
    this.#parkOutcome = undefined;
    if (!admitted.ok) {
      this.#state = "cleanup-required";
      this.#lastFailure = errorText(admitted.error);
      await this.#persist("cleanup-required");
      throw new HarnessProcessPlacementError(
        "cleanup-incomplete",
        "The parked process did not resume through ProcessSlots.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, failure: this.#lastFailure },
        { cause: admitted.error },
      );
    }
    this.#permit = admitted.value.permit;
    const publication = admitted.value.value.publication;
    const confirmed = confirmedProcessPublication(publication, {
      controllerClaim: this.#options.controllerClaim,
      operationId: this.#request.operationId,
      nativeSessionId: this.#request.nativeSessionId,
      checkpointId: this.#request.checkpointId,
      manifestRevision: this.#request.manifestRevision,
      priorFacetNonce: this.#request.priorFacetNonce,
      expectedFacetGeneration: this.#request.expectedFacetGeneration,
      identity: this.identity,
    });
    if (confirmed === undefined) {
      const cleanup = await this.#cleanupInternal(false);
      throw new HarnessProcessPlacementError(
        "stale-publication",
        cleanup === undefined
          ? "The resume claim changed before the parked facet could continue."
          : "The resume claim changed and parked-facet cleanup needs recovery.",
        cleanup !== undefined,
        this.identity,
        { recoveryId: this.identity.loaderId, cleanupFailure: cleanup },
      );
    }
    try {
      await this.#facet.activate(confirmed);
    } catch (cause) {
      this.#state = "activation-failed";
      this.#lastFailure = errorText(cause);
      await this.#persist("activation-failed");
      const cleanup = await this.#cleanupInternal(true);
      throw new HarnessProcessPlacementError(
        "activation-failed",
        cleanup === undefined
          ? "The published resume facet failed activation."
          : "The published resume facet failed activation and cleanup needs repair.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, cleanupFailure: cleanup, failure: this.#lastFailure },
        { cause },
      );
    }
    this.#state = "active";
    await this.#persist("active");
    return admitted.value.value.value;
  }

  async stop(): Promise<{ readonly acknowledged: boolean }> {
    if (this.#released) return { acknowledged: true };
    try {
      const result = await this.#facet.stop();
      if (result.acknowledged) {
        this.#stopAcknowledged = true;
        for (const attempt of this.#attempts) attempt.stopAcknowledged = true;
        this.#pruneSettledAttempts();
      }
      await this.#persist(this.#state);
      return result;
    } catch (cause) {
      this.#lastFailure = errorText(cause);
      this.#state = "cleanup-required";
      await this.#persist("cleanup-required");
      return { acknowledged: false };
    }
  }

  async join(): Promise<HarnessProcessJoined> {
    if (this.#released) return joinedAll;
    try {
      const result = await this.#facet.join();
      this.#joined = result;
      for (const attempt of this.#attempts) attempt.joined = result;
      this.#pruneSettledAttempts();
      await this.#persist(this.#state);
      return result;
    } catch (cause) {
      this.#lastFailure = errorText(cause);
      this.#state = "cleanup-required";
      await this.#persist("cleanup-required");
      return joinedNone;
    }
  }

  async cleanup(): Promise<void> {
    const failure = await this.#cleanupInternal(false);
    if (failure !== undefined)
      throw new HarnessProcessPlacementError(
        "cleanup-incomplete",
        "Process placement cannot release this lease until stop, joined settlement, and disposal are confirmed.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, failure },
      );
  }

  async dispose(): Promise<void> {
    await this.cleanup();
  }

  async #parkForPublication(): Promise<void> {
    if (this.#permit === undefined) throw new Error("Missing initial process-slot permit");
    const activation = Promise.withResolvers<HarnessProcessPublication>();
    const committed = Promise.withResolvers<void>();
    this.#parkRelease = activation.resolve;
    const signal = this.#request.signal;
    const outcome = this.#slots
      .park(
        this.lease,
        this.#permit,
        () => {
          committed.resolve();
          return activation.promise;
        },
        signal,
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    this.#parkOutcome = outcome;
    const arrived = await Promise.race([
      committed.promise.then(() => ({ committed: true as const })),
      outcome.then((result) => ({ committed: false as const, result })),
    ]);
    if (!arrived.committed) {
      this.#parkRelease = undefined;
      if (!arrived.result.ok) throw arrived.result.error;
      this.#permit = arrived.result.value.permit;
      throw new Error("ProcessSlots park completed before publication was requested.");
    }
    this.#permit = undefined;
  }

  async #cleanupInternal(keepActivationFailure: boolean): Promise<string | undefined> {
    if (this.#released) {
      if (keepActivationFailure || this.#state === "activation-failed") return undefined;
      try {
        await this.#options.recovery.remove(this.identity.loaderId);
        return undefined;
      } catch (error) {
        this.#state = "cleanup-required";
        this.#lastFailure = errorText(error);
        await this.#persist("cleanup-required");
        return this.#lastFailure;
      }
    }
    let stopError: unknown;
    let joinError: unknown;
    let disposeError: unknown;
    try {
      const stopped = await this.stop();
      if (!stopped.acknowledged) stopError = new Error("Stop was not acknowledged");
    } catch (error) {
      stopError = error;
    }
    try {
      const joined = await this.join();
      if (!allJoined(joined))
        joinError = new Error("Invocation, fetch, and ports have not all joined");
    } catch (error) {
      joinError = error;
    }
    try {
      await this.#facet.dispose();
      this.#disposed = true;
    } catch (error) {
      disposeError = error;
    }

    const settled = this.#stopAcknowledged && allJoined(this.#joined) && this.#attempts.size === 0;
    if (settled && this.#disposed) {
      try {
        await this.#slots.release(this.lease, { acknowledged: true });
        this.#released = true;
        const parkOutcome = this.#parkOutcome;
        if (parkOutcome !== undefined) {
          const result = await parkOutcome;
          if (result.ok && this.#permit === undefined) this.#permit = result.value.permit;
        }
        if (keepActivationFailure) {
          this.#state = "activation-failed";
          await this.#persist("activation-failed");
        } else {
          await this.#options.recovery.remove(this.identity.loaderId);
        }
        return undefined;
      } catch (error) {
        disposeError ??= error;
      }
    }

    this.#state = keepActivationFailure ? "activation-failed" : "cleanup-required";
    const failures = [stopError, joinError, disposeError].filter((error) => error !== undefined);
    this.#lastFailure =
      failures.map(errorText).join("; ") || "Stop and joined settlement are incomplete";
    await this.#persist(this.#state);
    return this.#lastFailure;
  }

  async #persist(state: HarnessProcessPlacementRecoveryRecord["state"]): Promise<void> {
    this.#state = state;
    await this.#options.recovery.save({
      version: 1,
      shardOwner: this.identity.shardOwner,
      controllerClaim: this.#options.controllerClaim,
      operationId: this.#request.operationId,
      nativeSessionId: this.#request.nativeSessionId,
      checkpointId: this.#request.checkpointId,
      manifestRevision: this.#request.manifestRevision,
      priorFacetNonce: this.#request.priorFacetNonce,
      programCodeId: this.#request.codeId,
      loaderId: this.identity.loaderId,
      facetKey: this.identity.facetKey,
      incarnationNonce: this.identity.incarnationNonce,
      lease: this.lease,
      state,
      stopAcknowledged: this.#stopAcknowledged,
      joined: this.#joined,
      ...(this.#lastFailure === undefined ? {} : { lastFailure: this.#lastFailure }),
    });
  }

  #pruneSettledAttempts(): void {
    for (const attempt of this.#attempts) {
      if (attempt.rpcReturned && attempt.stopAcknowledged && allJoined(attempt.joined))
        this.#attempts.delete(attempt);
    }
  }

  #requireState(expected: HarnessProcessPlacementRecoveryRecord["state"]): void {
    if (this.#state !== expected)
      throw new HarnessProcessPlacementError(
        this.#state === "activation-failed" ? "activation-failed" : "stale-handle",
        `Process placement is ${this.#state}, expected ${expected}.`,
        this.#state !== "activation-failed",
        this.identity,
        { recoveryId: this.identity.loaderId, state: this.#state },
      );
  }
}

export function allJoined(joined: HarnessProcessJoined): boolean {
  return joined.invocationRpc && joined.fetch && joined.ports;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
