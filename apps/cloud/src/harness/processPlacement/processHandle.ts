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
  type HarnessProcessFailureRecord,
  type HarnessProcessFailureStage,
  type HarnessProcessPlacementIdentity,
  type HarnessProcessPlacementOptions,
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPreparedFacet,
  type HarnessProcessPublication,
  type HarnessProcessPublicationRequest,
  type HarnessProcessPublishedActivation,
  type HarnessProcessPublicationPublisher,
  type HarnessProcessPlacementRequest,
} from "./contracts.ts";
import { confirmedProcessPublication } from "./publication.ts";
import { failureRecord } from "./storeSchema.ts";

interface Attempt {
  rpcReturned: boolean;
  stopAcknowledged: boolean;
  joined: HarnessProcessJoined;
}

interface CleanupResult {
  readonly failure: HarnessProcessFailureRecord;
  readonly cause?: unknown;
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
  #invocationMayHaveStarted = false;
  #invocationRequestId: string | undefined;
  #invocationReply: HarnessProcessPlacementRecoveryRecord["invocationReply"];
  #lastFailure: HarnessProcessFailureRecord | undefined;
  #terminalFailure: HarnessProcessFailureRecord | undefined;
  #publicationState: HarnessProcessPlacementRecoveryRecord["publicationState"];
  #publicationReceipt: HarnessProcessPlacementRecoveryRecord["publicationReceipt"];
  #lastCause: unknown;

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
    let facetFailureAt: "identity" | "prepare" | "persist" | "park" = "identity";
    try {
      const actual = await this.#facet.identity();
      if (
        actual.facetKey !== this.identity.facetKey ||
        actual.incarnationNonce !== this.identity.incarnationNonce
      )
        throw new HarnessProcessPlacementError(
          "prepare-failed",
          "The constructed facet identity did not match its lease.",
          true,
          this.identity,
          {
            recoveryId: this.identity.loaderId,
            identityMismatch:
              actual.facetKey !== this.identity.facetKey ? "facet-key" : "incarnation",
            causeCode: "IDENTITY_MISMATCH",
          },
        );
      facetFailureAt = "prepare";
      const observed = await this.#facet.prepareInert({
        operationId: this.#request.operationId,
        targetFacetNonce: this.identity.incarnationNonce,
        nativeSessionId: this.#request.nativeSessionId,
        checkpointId: this.#request.checkpointId,
        manifestRevision: this.#request.manifestRevision,
        priorFacetNonce: this.#request.priorFacetNonce,
        expectedFacetGeneration: this.#request.expectedFacetGeneration,
      });
      if (
        observed.facetNonce !== this.identity.incarnationNonce ||
        observed.nativeSessionId !== this.#request.nativeSessionId ||
        observed.checkpoint.native.id !== this.#request.checkpointId ||
        observed.checkpoint.filesystem.sha256 !== this.#request.manifestRevision ||
        observed.manifestRevision !== this.#request.manifestRevision ||
        !allJoined(observed.joined)
      )
        throw new HarnessProcessPlacementError(
          "prepare-failed",
          "The inert facet did not confirm its native session, checkpoint, identity, and settled open RPC.",
          true,
          this.identity,
          {
            recoveryId: this.identity.loaderId,
            identityMismatch:
              observed.nativeSessionId !== this.#request.nativeSessionId
                ? "native-session"
                : observed.checkpoint.native.id !== this.#request.checkpointId ||
                    observed.checkpoint.filesystem.sha256 !== this.#request.manifestRevision ||
                    observed.manifestRevision !== this.#request.manifestRevision
                  ? "checkpoint"
                  : "incarnation",
            causeCode: "IDENTITY_MISMATCH",
          },
        );

      this.#joined = observed.joined;
      facetFailureAt = "persist";
      await this.#persist("preparing");
      facetFailureAt = "park";
      await this.#parkForPublication();
      this.#state = "prepared";
      facetFailureAt = "persist";
      await this.#persist("prepared");
    } catch (cause) {
      this.#lastCause = cause;
      this.#lastFailure = failureRecord("prepare", "RPC_FAILED");
      const cleanup = await this.#cleanupInternal(false);
      throw new HarnessProcessPlacementError(
        "prepare-failed",
        cleanup === undefined
          ? "The fresh facet could not be prepared inert."
          : "The fresh facet could not be prepared inert and cleanup is incomplete.",
        cleanup !== undefined,
        this.identity,
        {
          recoveryId: this.identity.loaderId,
          ...(cleanup === undefined ? {} : { causeCode: cleanup.failure.code }),
          facetFailureAt,
          facetFailureCode: facetFailureCode(cause),
          ...(cause instanceof HarnessProcessPlacementError &&
          cause.details?.identityMismatch !== undefined
            ? { identityMismatch: cause.details.identityMismatch }
            : {}),
        },
        { cause: cleanup?.cause ?? cause },
      );
    }
  }

  async activate(
    publisher: HarnessProcessPublicationPublisher,
  ): Promise<HarnessProcessPublishedActivation> {
    if (this.#state !== "prepared") this.#requireState("prepared");
    if (this.#publicationState !== undefined)
      throw new HarnessProcessPlacementError(
        "publication-unknown",
        "This process already has a publication attempt and needs reconciliation.",
        true,
        this.identity,
        {
          recoveryId: this.identity.loaderId,
          publicationState: this.#publicationState,
        },
      );

    const request: HarnessProcessPublicationRequest = {
      identity: this.identity,
      controllerClaim: this.#options.controllerClaim,
      operationId: this.#request.operationId,
      nativeSessionId: this.#request.nativeSessionId,
      checkpointId: this.#request.checkpointId,
      manifestRevision: this.#request.manifestRevision,
      priorFacetNonce: this.#request.priorFacetNonce,
      expectedFacetGeneration: this.#request.expectedFacetGeneration,
    };
    this.#publicationState = "in-progress";
    try {
      await this.#persist("prepared");
    } catch (cause) {
      this.#publicationState = undefined;
      const cleanup = await this.#cleanupInternal(false);
      throw new HarnessProcessPlacementError(
        "stale-publication",
        cleanup === undefined
          ? "Publication could not be recorded before sending."
          : "Publication could not be recorded; local cleanup needs recovery.",
        cleanup !== undefined,
        this.identity,
        {
          recoveryId: this.identity.loaderId,
          ...(cleanup === undefined ? {} : { causeCode: cleanup.failure.code }),
        },
        { cause: cleanup?.cause ?? cause },
      );
    }

    let activation: HarnessProcessPublishedActivation;
    try {
      activation = await publisher.publishProcessFacet(request);
    } catch (cause) {
      await this.#markPublicationUnresolved("unknown", cause);
      throw new HarnessProcessPlacementError(
        "publication-unknown",
        "The publication reply was lost; ownership stays reserved for reconciliation.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, publicationState: "unknown" },
        { cause },
      );
    }

    const confirmed = this.#confirmPublication(activation.publication);
    if (
      confirmed === undefined ||
      activation.publisher.generation !== confirmed.toGeneration ||
      activation.publisher.facetNonce !== this.identity.incarnationNonce ||
      !activation.publisher.publisherKey ||
      !activation.requestId
    ) {
      const pending =
        activation.publication.status === "supervisor-pending" ||
        activation.publication.status === "files-pending";
      const state = pending ? "pending" : "unknown";
      await this.#markPublicationUnresolved(
        state,
        new Error("Publication response was not authoritative."),
      );
      throw new HarnessProcessPlacementError(
        "publication-unknown",
        pending
          ? "Publication is pending; ownership stays reserved for reconciliation."
          : "Publication evidence was incomplete or stale; ownership stays reserved for reconciliation.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, publicationState: state },
      );
    }

    this.#publicationState = "confirmed";
    this.#publicationReceipt = confirmed;
    this.#invocationRequestId = activation.requestId;
    try {
      await this.#persist("prepared");
    } catch (cause) {
      this.#publicationState = "unknown";
      this.#publicationReceipt = undefined;
      throw new HarnessProcessPlacementError(
        "publication-unknown",
        "Publication was confirmed, but its receipt could not be persisted. Ownership stays reserved.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, publicationState: "unknown" },
        { cause },
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

    parkRelease(activation.publication);
    const admitted = await parkOutcome;
    this.#parkRelease = undefined;
    this.#parkOutcome = undefined;
    if (!admitted.ok) {
      this.#state = "cleanup-required";
      this.#lastCause = admitted.error;
      this.#lastFailure = failureRecord("recovery", "RECOVERY_UNKNOWN");
      await this.#persist("cleanup-required");
      throw new HarnessProcessPlacementError(
        "cleanup-incomplete",
        "The published facet could not regain ProcessSlots admission.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, causeCode: this.#lastFailure.code },
        { cause: admitted.error },
      );
    }
    this.#permit = admitted.value.permit;

    try {
      await this.#facet.activate(confirmed);
    } catch (cause) {
      this.#terminalFailure = failureRecord("activation", "RPC_FAILED");
      this.#lastFailure = this.#terminalFailure;
      this.#lastCause = cause;
      await this.#persist("activation-failed");
      const cleanup = await this.#cleanupInternal(true);
      throw new HarnessProcessPlacementError(
        "activation-failed",
        cleanup === undefined
          ? "The published facet failed activation. Repair its persisted lifecycle before another launch."
          : "The published facet failed activation and cleanup needs persisted repair.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, causeCode: cleanup?.failure.code ?? "RPC_FAILED" },
        { cause: cleanup?.cause ?? cause },
      );
    }
    this.#state = "active";
    await this.#persist("active");
    return activation;
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
    const suppliedRequestId = invocationRequestId(input);
    if (
      this.#invocationRequestId !== undefined &&
      suppliedRequestId !== undefined &&
      suppliedRequestId !== this.#invocationRequestId
    )
      throw new HarnessProcessPlacementError(
        "stale-publication",
        "The invocation request does not match the prepared publisher response.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId },
      );
    // Persist before the RPC so a restart never replays an invocation whose reply may be lost.
    this.#invocationMayHaveStarted = true;
    this.#invocationReply = "unresolved";
    try {
      await this.#persist("active");
    } catch (cause) {
      this.#state = "cleanup-required";
      this.#lastCause = cause;
      this.#lastFailure = failureRecord("recovery", "RPC_FAILED");
      throw new HarnessProcessPlacementError(
        "invocation-unsettled",
        "The invocation may have started, but its attempt marker could not be confirmed.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, causeCode: this.#lastFailure.code },
        { cause },
      );
    }
    const attempt: Attempt = { rpcReturned: false, stopAcknowledged: false, joined: joinedNone };
    this.#attempts.add(attempt);
    let settlement: HarnessProcessInvocationSettlement;
    try {
      settlement = await this.#facet.invoke(input);
    } catch (cause) {
      attempt.rpcReturned = true;
      this.#state = "cleanup-required";
      this.#lastCause = cause;
      this.#lastFailure = failureRecord("invocation", "RPC_FAILED");
      await this.#persist("cleanup-required");
      throw new HarnessProcessPlacementError(
        "invocation-unsettled",
        "The invocation RPC failed before placement could prove it settled.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, causeCode: this.#lastFailure.code },
        { cause },
      );
    }

    attempt.rpcReturned = true;
    attempt.stopAcknowledged = settlement.stopAcknowledged;
    attempt.joined = settlement.joined;
    this.#joined = settlement.joined;
    this.#invocationReply = "received";
    this.#pruneSettledAttempts();
    if (!attempt.stopAcknowledged || !allJoined(attempt.joined)) {
      this.#state = "cleanup-required";
      this.#lastFailure = failureRecord(
        "invocation",
        !attempt.stopAcknowledged ? "STOP_UNACKNOWLEDGED" : "JOIN_INCOMPLETE",
      );
      await this.#persist("cleanup-required");
      return settlement;
    }
    this.#state = "active";
    try {
      await this.#persist("active");
    } catch (cause) {
      this.#state = "cleanup-required";
      this.#lastCause = cause;
      this.#lastFailure = failureRecord("recovery", "RPC_FAILED");
      throw new HarnessProcessPlacementError(
        "invocation-unsettled",
        "The invocation reply arrived, but its placement state could not be recorded.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, causeCode: this.#lastFailure.code },
        { cause },
      );
    }
    return settlement;
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
    const outcome = this.#slots
      .park(
        this.lease,
        permit!,
        async () => {
          const resumed = await waitForResume();
          if (this.#confirmPublication(resumed.publication) === undefined)
            throw new HarnessProcessPlacementError(
              "stale-publication",
              "The control claim changed before the parked facet could resume.",
              true,
              this.identity,
              { recoveryId: this.identity.loaderId, causeCode: "PUBLICATION_UNCONFIRMED" },
            );
          return resumed;
        },
        signal,
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    this.#parkOutcome = outcome;
    const admitted = await outcome;
    this.#parkOutcome = undefined;
    if (!admitted.ok) {
      this.#state = "cleanup-required";
      this.#lastCause = admitted.error;
      this.#lastFailure = failureRecord("recovery", "RECOVERY_UNKNOWN");
      await this.#persist("cleanup-required");
      if (
        admitted.error instanceof HarnessProcessPlacementError &&
        admitted.error.kind === "stale-publication"
      )
        throw admitted.error;
      throw new HarnessProcessPlacementError(
        "cleanup-incomplete",
        "The parked process did not resume through ProcessSlots.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, causeCode: this.#lastFailure.code },
        { cause: admitted.error },
      );
    }
    this.#permit = admitted.value.permit;
    const publication = admitted.value.value.publication;
    const confirmed = this.#confirmPublication(publication);
    if (confirmed === undefined) {
      const cleanup = await this.#cleanupInternal(false);
      throw new HarnessProcessPlacementError(
        "stale-publication",
        cleanup === undefined
          ? "The resume claim changed before the parked facet could continue."
          : "The resume claim changed and parked-facet cleanup needs recovery.",
        cleanup !== undefined,
        this.identity,
        {
          recoveryId: this.identity.loaderId,
          ...(cleanup === undefined ? {} : { causeCode: cleanup.failure.code }),
        },
        cleanup === undefined ? undefined : { cause: cleanup.cause },
      );
    }
    try {
      await this.#facet.activate(confirmed);
    } catch (cause) {
      this.#terminalFailure = failureRecord("activation", "RPC_FAILED");
      this.#lastFailure = this.#terminalFailure;
      this.#lastCause = cause;
      await this.#persist("activation-failed");
      const cleanup = await this.#cleanupInternal(true);
      throw new HarnessProcessPlacementError(
        "activation-failed",
        cleanup === undefined
          ? "The published resume facet failed activation."
          : "The published resume facet failed activation and cleanup needs repair.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, causeCode: cleanup?.failure.code ?? "RPC_FAILED" },
        { cause: cleanup?.cause ?? cause },
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
      this.#lastCause = cause;
      this.#lastFailure = failureRecord("stop", "RPC_FAILED");
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
      this.#lastCause = cause;
      this.#lastFailure = failureRecord("join", "RPC_FAILED");
      this.#state = "cleanup-required";
      await this.#persist("cleanup-required");
      return joinedNone;
    }
  }

  async cleanup(options: { readonly retainPublishedOwnership?: boolean } = {}): Promise<void> {
    if (
      options.retainPublishedOwnership === true &&
      this.#publicationState === "confirmed" &&
      !this.#invocationMayHaveStarted &&
      this.#terminalFailure === undefined
    )
      throw new HarnessProcessPlacementError(
        "cleanup-incomplete",
        "Confirmed publication ownership stays reserved until invocation or explicit repair.",
        true,
        this.identity,
        {
          recoveryId: this.identity.loaderId,
          publicationState: "confirmed",
          causeCode: "PUBLICATION_REQUIRES_REPAIR",
        },
      );
    const failure = await this.#cleanupInternal(false);
    if (failure !== undefined)
      throw new HarnessProcessPlacementError(
        "cleanup-incomplete",
        "Process placement cannot release this lease until stop, joined settlement, and disposal are confirmed.",
        true,
        this.identity,
        { recoveryId: this.identity.loaderId, causeCode: failure.failure.code },
        { cause: failure.cause },
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

  async #cleanupInternal(keepActivationFailure: boolean): Promise<CleanupResult | undefined> {
    if (
      this.#publicationState === "in-progress" ||
      this.#publicationState === "unknown" ||
      this.#publicationState === "pending"
    )
      return {
        failure: failureRecord("recovery", "PUBLICATION_UNCONFIRMED"),
        cause: this.#lastCause,
      };
    if (this.#released) {
      if (keepActivationFailure || this.#terminalFailure !== undefined) return undefined;
      try {
        await this.#options.recovery.remove(this.identity.loaderId);
        return undefined;
      } catch (error) {
        this.#state = "cleanup-required";
        this.#lastCause = error;
        this.#lastFailure = failureRecord("recovery", "RPC_FAILED");
        await this.#persist("cleanup-required");
        return { failure: this.#lastFailure, cause: error };
      }
    }
    let cleanupCause: unknown;
    let cleanupCode: HarnessProcessFailureRecord["code"] | undefined;
    try {
      const stopped = await this.stop();
      if (!stopped.acknowledged) {
        cleanupCode = "STOP_UNACKNOWLEDGED";
        cleanupCause = this.#lastCause;
      }
    } catch (error) {
      cleanupCode = "RPC_FAILED";
      cleanupCause = error;
    }
    try {
      const joined = await this.join();
      if (!allJoined(joined)) {
        cleanupCode ??= "JOIN_INCOMPLETE";
        cleanupCause ??= this.#lastCause;
      }
    } catch (error) {
      cleanupCode ??= "RPC_FAILED";
      cleanupCause ??= error;
    }
    try {
      await this.#facet.dispose();
      this.#disposed = true;
    } catch (error) {
      cleanupCode ??= "DISPOSE_FAILED";
      cleanupCause ??= error;
    }

    if (
      this.#publicationState === "confirmed" &&
      this.#invocationMayHaveStarted &&
      this.#invocationReply !== "received" &&
      this.#terminalFailure === undefined
    ) {
      this.#state = "cleanup-required";
      this.#lastFailure = failureRecord("recovery", "INVOCATION_OUTCOME_UNKNOWN");
      this.#lastCause ??= cleanupCause;
      await this.#persist(this.#state);
      return { failure: this.#lastFailure, cause: this.#lastCause };
    }

    const settled = this.#stopAcknowledged && allJoined(this.#joined) && this.#attempts.size === 0;
    if (settled && this.#disposed) {
      try {
        await this.#options.invalidate(this.identity.loaderId);
        await this.#slots.release(this.lease, { acknowledged: true });
        this.#released = true;
        const parkOutcome = this.#parkOutcome;
        if (parkOutcome !== undefined) {
          const result = await parkOutcome;
          if (result.ok && this.#permit === undefined) this.#permit = result.value.permit;
        }
        if (keepActivationFailure || this.#terminalFailure !== undefined) {
          this.#state = "activation-failed";
          await this.#persist("activation-failed");
        } else {
          await this.#options.recovery.remove(this.identity.loaderId);
        }
        return undefined;
      } catch (error) {
        cleanupCode ??= "RPC_FAILED";
        cleanupCause ??= error;
      }
    }

    this.#state = "cleanup-required";
    this.#lastFailure = failureRecord(
      this.#failureStage(cleanupCode),
      cleanupCode ?? "RECOVERY_UNKNOWN",
    );
    this.#lastCause = cleanupCause;
    await this.#persist(this.#state);
    return { failure: this.#lastFailure, cause: cleanupCause };
  }

  async #persist(state: HarnessProcessPlacementRecoveryRecord["state"]): Promise<void> {
    this.#state = state;
    await this.#options.recovery.save({
      version: 1,
      shardOwner: this.identity.shardOwner,
      controllerClaim: this.#options.controllerClaim,
      operationId: this.#request.operationId,
      processId: this.#request.processId,
      nativeSessionId: this.#request.nativeSessionId,
      checkpointId: this.#request.checkpointId,
      manifestRevision: this.#request.manifestRevision,
      priorFacetNonce: this.#request.priorFacetNonce,
      expectedFacetGeneration: this.#request.expectedFacetGeneration,
      programCodeId: this.#request.codeId,
      loaderId: this.identity.loaderId,
      facetKey: this.identity.facetKey,
      identityState: "observed",
      incarnationNonce: this.identity.incarnationNonce,
      lease: this.lease,
      state,
      stopAcknowledged: this.#stopAcknowledged,
      joined: this.#joined,
      ...(this.#publicationState === undefined ? {} : { publicationState: this.#publicationState }),
      ...(this.#publicationReceipt === undefined
        ? {}
        : { publicationReceipt: this.#publicationReceipt }),
      invocationMayHaveStarted: this.#invocationMayHaveStarted,
      ...(this.#invocationRequestId === undefined
        ? {}
        : { invocationRequestId: this.#invocationRequestId }),
      ...(this.#invocationReply === undefined ? {} : { invocationReply: this.#invocationReply }),
      ...(this.#lastFailure === undefined ? {} : { lastFailure: this.#lastFailure }),
      ...(this.#terminalFailure === undefined ? {} : { terminalFailure: this.#terminalFailure }),
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
        { recoveryId: this.identity.loaderId, expectedState: expected, actualState: this.#state },
      );
  }

  #confirmPublication(publication: HarnessProcessPublication) {
    return confirmedProcessPublication(publication, {
      controllerClaim: this.#options.controllerClaim,
      operationId: this.#request.operationId,
      nativeSessionId: this.#request.nativeSessionId,
      checkpointId: this.#request.checkpointId,
      manifestRevision: this.#request.manifestRevision,
      priorFacetNonce: this.#request.priorFacetNonce,
      expectedFacetGeneration: this.#request.expectedFacetGeneration,
      identity: this.identity,
    });
  }

  async #markPublicationUnresolved(state: "unknown" | "pending", cause: unknown): Promise<void> {
    this.#publicationState = state;
    this.#lastFailure = failureRecord("activation", "PUBLICATION_UNCONFIRMED");
    this.#lastCause = cause;
    try {
      await this.#persist("prepared");
    } catch (persistCause) {
      // The durable in-progress marker still prevents cleanup if this write also lost its reply.
      this.#lastCause = persistCause;
      this.#publicationState = "unknown";
    }
  }

  #failureStage(code: HarnessProcessFailureRecord["code"] | undefined): HarnessProcessFailureStage {
    if (code === "STOP_UNACKNOWLEDGED") return "stop";
    if (code === "JOIN_INCOMPLETE") return "join";
    if (code === "DISPOSE_FAILED") return "dispose";
    return this.#terminalFailure === undefined ? "recovery" : "activation";
  }
}

function invocationRequestId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("requestId" in input)) return undefined;
  const requestId = input.requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function allJoined(joined: HarnessProcessJoined): boolean {
  return joined.invocationRpc && joined.fetch && joined.ports;
}

function facetFailureCode(
  cause: unknown,
): "type-error" | "range-error" | "syntax-error" | "rpc-not-found" | "rpc-error" | "unknown" {
  if (cause instanceof TypeError || (cause instanceof Error && cause.name === "TypeError"))
    return "type-error";
  if (cause instanceof RangeError || (cause instanceof Error && cause.name === "RangeError"))
    return "range-error";
  if (cause instanceof Error && cause.name === "SyntaxError") return "syntax-error";
  if (cause instanceof Error && cause.name === "ProcessFacetRpcNotFound") return "rpc-not-found";
  if (cause instanceof Error) return "rpc-error";
  return "unknown";
}
