import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import {
  HarnessProcessResumeError,
  type HarnessProcessResumeInput,
  type HarnessProcessResumePreparedFacet,
  type HarnessProcessResumePublicationResult,
  type HarnessProcessResumeResult,
} from "../HarnessProcessResume.ts";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const positive = count.check(Schema.isGreaterThan(0));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const SupervisorPolicy = Schema.Struct({
  maxFailedRestarts: positive,
  proactive: Schema.Literal(false),
});
export type HarnessProcessSupervisorPolicy = typeof SupervisorPolicy.Type;

export const SupervisorIncarnation = Schema.Struct({ generation: positive, facetNonce: id });
export const SupervisorCheckpoint = Schema.Struct({
  checkpointId: id,
  manifestSha256: digest,
  nativeSessionId: id,
  completedTurnId: Schema.NullOr(id),
});
export type HarnessProcessSupervisorCheckpoint = typeof SupervisorCheckpoint.Type;

/** Input bodies and credentials stay with the caller. The digest binds its immutable input. */
export const SupervisorTurn = Schema.Struct({ requestId: id, turnId: id, inputSha256: digest });
export type HarnessProcessSupervisorTurn = typeof SupervisorTurn.Type;

export const SupervisorSignal = Schema.Struct({
  eventId: id,
  kind: Schema.Literals(["reset", "exceededMemory"]),
  nativeSessionId: id,
  turnId: id,
  incarnation: SupervisorIncarnation,
});
export type HarnessProcessSupervisorSignal = typeof SupervisorSignal.Type;

export const SupervisorBlocker = Schema.TaggedStruct("Blocker", {
  reason: Schema.Literals([
    "restart-limit",
    "resume-failed",
    "effect-uncertain",
    "identity-mismatch",
    "runtime-failed",
    "ingress-failed",
    "conflicting-id",
    "busy",
    "stale-owner",
    "cancelled",
  ]),
  recovery: Schema.Literals(["retry", "reconcile", "new-owner"]),
  turnId: Schema.NullOr(id),
  operationId: Schema.NullOr(id),
  failedRestarts: count,
  resume: Schema.NullOr(
    Schema.Struct({
      stage: HarnessProcessResumeError.fields.stage,
      reason: HarnessProcessResumeError.fields.reason,
      recovery: HarnessProcessResumeError.fields.recovery,
    }),
  ),
});
export type HarnessProcessSupervisorBlocker = typeof SupervisorBlocker.Type;

const completed = Schema.TaggedStruct("Completed", {
  turnId: id,
  checkpoint: SupervisorCheckpoint,
});
export type HarnessProcessSupervisorOutcome =
  | typeof completed.Type
  | HarnessProcessSupervisorBlocker;

export const SupervisorState = Schema.Struct({
  version: Schema.Literal(1),
  revision: positive,
  ownerId: id,
  policy: SupervisorPolicy,
  incarnation: SupervisorIncarnation,
  checkpoint: SupervisorCheckpoint,
  turn: Schema.NullOr(SupervisorTurn),
  phase: Schema.Literals(["idle", "running", "reset-observed", "resuming", "blocked", "completed"]),
  failedRestarts: count,
  attempt: count,
  operationId: Schema.NullOr(id),
  blocker: Schema.NullOr(SupervisorBlocker),
  turns: Schema.Array(Schema.Struct({ request: SupervisorTurn, result: Schema.NullOr(completed) })),
  retries: Schema.Array(Schema.Struct({ requestId: id, turnId: id })),
  denied: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["run", "retry"]),
      requestId: id,
      turnId: id,
      inputSha256: Schema.NullOr(digest),
      result: SupervisorBlocker,
    }),
  ),
  signals: Schema.Array(
    Schema.Struct({
      signal: SupervisorSignal,
      disposition: Schema.Literals(["accepted", "stale", "inactive", "pending"]),
    }),
  ),
  trace: Schema.Array(
    Schema.Struct({
      revision: positive,
      fact: Schema.Literals([
        "claimed",
        "started",
        "signal-accepted",
        "signal-stale",
        "signal-inactive",
        "signal-pending",
        "restart-intent",
        "resumed",
        "blocked",
        "retried",
        "completed",
        "closed",
        "request-denied",
      ]),
      turnId: Schema.NullOr(id),
      operationId: Schema.NullOr(id),
      attempt: count,
      failedRestarts: count,
      reason: Schema.NullOr(SupervisorBlocker.fields.reason),
      resume: SupervisorBlocker.fields.resume,
    }),
  ),
});
export type HarnessProcessSupervisorState = typeof SupervisorState.Type;

export class HarnessProcessSupervisorError extends Schema.TaggedError<HarnessProcessSupervisorError>()(
  "HarnessProcessSupervisorError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "policy-conflict",
      "invalid-store",
      "stale-owner",
      "closed",
    ]),
  },
) {}

export class HarnessProcessSupervisorPortError extends Schema.TaggedError<HarnessProcessSupervisorPortError>()(
  "HarnessProcessSupervisorPortError",
  { port: Schema.Literals(["store", "ingress", "turn", "operation"]) },
) {}

/** One record per native session; CAS must be durable and linearizable, including null creation.
 * Retain receipts for the record's lifetime. A rejected/lost write is never proof of no effect. */
export interface HarnessProcessSupervisorStore {
  /** null means absent; decoding persisted data belongs to the supervisor. */
  readonly read: Effect.Effect<unknown, HarnessProcessSupervisorPortError>;
  readonly compareAndSet: (
    revision: number | null,
    next: HarnessProcessSupervisorState,
  ) => Effect.Effect<boolean, HarnessProcessSupervisorPortError>;
}

/** Only the platform adapter may supply this ingress. A runtime exception is not a signal.
 * Acquisition must install the subscription before returning; its scope finalizer joins it. */
export interface HarnessProcessSupervisorIngress {
  readonly subscribe: Effect.Effect<
    {
      readonly take: Effect.Effect<
        HarnessProcessSupervisorSignal,
        HarnessProcessSupervisorPortError
      >;
    },
    HarnessProcessSupervisorPortError,
    Scope.Scope
  >;
}

export interface HarnessProcessSupervisorExecution {
  readonly turn: HarnessProcessSupervisorTurn;
  readonly incarnation: typeof SupervisorIncarnation.Type;
  readonly checkpoint: HarnessProcessSupervisorCheckpoint;
  readonly mode: "start" | "resume";
}

export interface HarnessProcessSupervisorCompletion {
  readonly turnId: string;
  readonly incarnation: typeof SupervisorIncarnation.Type;
  /** Returned only after this turn and its checkpoint have committed. */
  readonly checkpoint: HarnessProcessSupervisorCheckpoint;
}

export interface HarnessProcessSupervisorRestart {
  readonly operationId: string;
  readonly attempt: number;
  readonly turn: HarnessProcessSupervisorTurn;
  readonly incarnation: typeof SupervisorIncarnation.Type;
  readonly checkpoint: HarnessProcessSupervisorCheckpoint;
}

export type SupervisorResumeResult = HarnessProcessResumeResult<
  HarnessProcessResumePreparedFacet,
  HarnessProcessResumePublicationResult
>;

/** `resume` is the public createHarnessProcessResume result, or an adapter to that C operation.
 * Builders own capabilities/assets. The supervisor persists only the intent's identity.
 * Caller effects must join owned local control work on interruption. A lost RPC reply
 * is uncertain; cancellation never establishes that C's native resources have stopped. */
export interface HarnessProcessSupervisorCaller {
  readonly turn: (
    execution: HarnessProcessSupervisorExecution,
  ) => Effect.Effect<HarnessProcessSupervisorCompletion, HarnessProcessSupervisorPortError>;
  readonly prepareResume: (
    intent: HarnessProcessSupervisorRestart,
  ) => Effect.Effect<HarnessProcessResumeInput, HarnessProcessSupervisorPortError>;
  readonly processResume: {
    readonly resume: (
      input: HarnessProcessResumeInput,
    ) => Effect.Effect<SupervisorResumeResult, HarnessProcessResumeError>;
  };
}

export interface HarnessProcessSupervisorOptions {
  readonly initial: {
    readonly incarnation: typeof SupervisorIncarnation.Type;
    /** The last COMPLETED committed turn, never an in-progress snapshot. */
    readonly checkpoint: HarnessProcessSupervisorCheckpoint;
  };
  readonly policy?: Partial<HarnessProcessSupervisorPolicy>;
  readonly store: HarnessProcessSupervisorStore;
  readonly ingress: HarnessProcessSupervisorIngress;
  readonly caller: HarnessProcessSupervisorCaller;
}

export const SupervisorRetry = Schema.Struct({ requestId: id, turnId: id });
export type HarnessProcessSupervisorRetry = typeof SupervisorRetry.Type;
