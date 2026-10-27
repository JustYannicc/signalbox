import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  HarnessProcessSupervisorError,
  SupervisorCheckpoint,
  SupervisorIncarnation,
  SupervisorPolicy,
  SupervisorState,
  type HarnessProcessSupervisorBlocker,
  type HarnessProcessSupervisorOptions,
  type HarnessProcessSupervisorState,
} from "./contracts.ts";

export const parse = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => new HarnessProcessSupervisorError({ reason: "invalid-input" })),
  );

export const blocker = (
  state: HarnessProcessSupervisorState,
  reason: HarnessProcessSupervisorBlocker["reason"],
  recovery: HarnessProcessSupervisorBlocker["recovery"] = "reconcile",
  resume: HarnessProcessSupervisorBlocker["resume"] = null,
): HarnessProcessSupervisorBlocker => ({
  _tag: "Blocker",
  reason,
  recovery,
  resume,
  turnId: state.turn?.turnId ?? null,
  operationId: state.operationId,
  failedRestarts: state.failedRestarts,
});

const traced = (
  state: HarnessProcessSupervisorState,
  fact: HarnessProcessSupervisorState["trace"][number]["fact"],
): HarnessProcessSupervisorState => ({
  ...state,
  trace: [
    ...state.trace,
    {
      revision: state.revision,
      fact,
      turnId: state.turn?.turnId ?? null,
      operationId: state.operationId,
      attempt: state.attempt,
      failedRestarts: state.failedRestarts,
      reason: state.blocker?.reason ?? null,
      resume: state.blocker?.resume ?? null,
    },
  ],
});

export const createJournal = (options: HarnessProcessSupervisorOptions) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const stored = yield* options.store.read;
    const previous =
      stored === null
        ? null
        : yield* parse(SupervisorState, structuredClone(stored)).pipe(
            Effect.mapError(() => new HarnessProcessSupervisorError({ reason: "invalid-store" })),
          );
    if (
      previous !== null &&
      ((previous.phase === "blocked") !== (previous.blocker !== null) ||
        (previous.phase === "idle") !== (previous.turn === null))
    )
      return yield* new HarnessProcessSupervisorError({ reason: "invalid-store" });
    const policy = yield* parse(SupervisorPolicy, {
      maxFailedRestarts: 3,
      proactive: false,
      ...previous?.policy,
      ...options.policy,
    });
    if (previous !== null && policy.maxFailedRestarts !== previous.policy.maxFailedRestarts)
      return yield* new HarnessProcessSupervisorError({ reason: "policy-conflict" });
    const initial = yield* parse(
      Schema.Struct({
        incarnation: SupervisorIncarnation,
        checkpoint: SupervisorCheckpoint,
      }),
      structuredClone(options.initial),
    );
    if (
      previous !== null &&
      initial.checkpoint.nativeSessionId !== previous.checkpoint.nativeSessionId
    )
      return yield* new HarnessProcessSupervisorError({ reason: "invalid-store" });
    const crypto = yield* Crypto.Crypto;
    const ownerId = yield* Effect.orDie(crypto.randomUUIDv4());
    let current: HarnessProcessSupervisorState = previous ?? {
      version: 1,
      revision: 1,
      ownerId,
      policy,
      ...initial,
      turn: null,
      phase: "idle",
      failedRestarts: 0,
      attempt: 0,
      operationId: null,
      blocker: null,
      turns: [],
      retries: [],
      denied: [],
      signals: [],
      trace: [],
    };
    if (["running", "resuming", "reset-observed"].includes(current.phase)) {
      current = { ...current, phase: "blocked", blocker: blocker(current, "effect-uncertain") };
    }
    current = traced({ ...current, ownerId, revision: (previous?.revision ?? 0) + 1 }, "claimed");
    if (!(yield* options.store.compareAndSet(previous?.revision ?? null, structuredClone(current))))
      return yield* new HarnessProcessSupervisorError({ reason: "stale-owner" });
    let closed = false;

    const change = (
      update: (state: HarnessProcessSupervisorState) => HarnessProcessSupervisorState,
      fact:
        | HarnessProcessSupervisorState["trace"][number]["fact"]
        | ((
            state: HarnessProcessSupervisorState,
          ) => HarnessProcessSupervisorState["trace"][number]["fact"]),
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (closed) return yield* new HarnessProcessSupervisorError({ reason: "closed" });
          const draft = structuredClone(current);
          const updated = update(draft);
          if (updated === draft) return structuredClone(current);
          const next = traced(
            { ...updated, revision: current.revision + 1 },
            typeof fact === "function" ? fact(updated) : fact,
          );
          yield* parse(SupervisorState, next);
          if (!(yield* options.store.compareAndSet(current.revision, structuredClone(next))))
            return yield* new HarnessProcessSupervisorError({ reason: "stale-owner" });
          current = next;
          return structuredClone(current);
        }),
      );

    const park = (
      reason: HarnessProcessSupervisorBlocker["reason"],
      recovery: HarnessProcessSupervisorBlocker["recovery"] = "reconcile",
      resume: HarnessProcessSupervisorBlocker["resume"] = null,
      failedAttempt = false,
    ) =>
      change((state) => {
        const countFailure =
          failedAttempt &&
          state.attempt > 0 &&
          (state.phase === "running" || state.phase === "resuming");
        const next = { ...state, failedRestarts: state.failedRestarts + Number(countFailure) };
        return { ...next, phase: "blocked", blocker: blocker(next, reason, recovery, resume) };
      }, "blocked").pipe(Effect.map((state) => state.blocker!));

    const close = lock.withPermit(
      Effect.gen(function* () {
        if (closed) return;
        closed = true;
        if (!["running", "resuming", "reset-observed"].includes(current.phase)) return;
        const next = traced(
          {
            ...current,
            revision: current.revision + 1,
            phase: "blocked",
            blocker: blocker(current, "cancelled"),
          },
          "closed",
        );
        if (yield* options.store.compareAndSet(current.revision, structuredClone(next)))
          current = next;
      }),
    );

    return {
      change,
      park,
      close,
      current: () => structuredClone(current),
      assertOpen: Effect.suspend(() =>
        closed ? Effect.fail(new HarnessProcessSupervisorError({ reason: "closed" })) : Effect.void,
      ),
    };
  });

export type SupervisorJournal = Effect.Success<ReturnType<typeof createJournal>>;

export const sameIncarnation = (
  left: typeof SupervisorIncarnation.Type,
  right: typeof SupervisorIncarnation.Type,
) => left.generation === right.generation && left.facetNonce === right.facetNonce;

export const sameCheckpoint = (
  left: { checkpointId: string; manifestSha256: string },
  right: { checkpointId: string; manifestSha256: string },
) => left.checkpointId === right.checkpointId && left.manifestSha256 === right.manifestSha256;
