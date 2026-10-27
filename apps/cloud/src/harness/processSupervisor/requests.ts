import * as Effect from "effect/Effect";
import type {
  HarnessProcessSupervisorBlocker,
  HarnessProcessSupervisorRetry,
  HarnessProcessSupervisorState,
  HarnessProcessSupervisorTurn,
} from "./contracts.ts";
import { blocker, type SupervisorJournal } from "./state.ts";

type Request = Omit<HarnessProcessSupervisorState["denied"][number], "result">;

const priorDenial = (state: HarnessProcessSupervisorState, request: Request) => {
  const prior = state.denied.find((receipt) => receipt.requestId === request.requestId);
  if (prior === undefined) return undefined;
  return prior.kind === request.kind &&
    prior.turnId === request.turnId &&
    prior.inputSha256 === request.inputSha256
    ? prior.result
    : blocker(state, "conflicting-id");
};

const deny = (
  journal: SupervisorJournal,
  request: Request,
  result: HarnessProcessSupervisorBlocker,
) =>
  journal
    .change(
      (state) => ({ ...state, denied: [...state.denied, { ...request, result }] }),
      "request-denied",
    )
    .pipe(Effect.as(result));

export const admitRun = (
  journal: SupervisorJournal,
  turn: HarnessProcessSupervisorTurn,
  busy: boolean,
) =>
  Effect.gen(function* () {
    yield* journal.assertOpen;
    const state = journal.current();
    const request = { ...turn, kind: "run" as const };
    const receipt = state.turns.find((item) => item.request.requestId === turn.requestId);
    if (
      state.retries.some((item) => item.requestId === turn.requestId) ||
      (receipt !== undefined &&
        (receipt.request.turnId !== turn.turnId ||
          receipt.request.inputSha256 !== turn.inputSha256))
    )
      return blocker(state, "conflicting-id");
    if (receipt !== undefined) return { _tag: "Existing" as const, turnId: turn.turnId };
    const denied = priorDenial(state, request);
    if (denied !== undefined) return denied;
    if (state.turns.some((item) => item.request.turnId === turn.turnId))
      return yield* deny(journal, request, blocker(state, "conflicting-id"));
    if (busy || (state.phase !== "idle" && state.phase !== "completed"))
      return yield* deny(journal, request, blocker(state, "busy"));
    if (state.checkpoint.completedTurnId === turn.turnId)
      return yield* deny(journal, request, blocker(state, "conflicting-id"));
    yield* journal.change(
      (prior) => ({
        ...prior,
        turn,
        phase: "running",
        attempt: 0,
        failedRestarts: 0,
        operationId: null,
        blocker: null,
        turns: [...prior.turns, { request: turn, result: null }],
      }),
      "started",
    );
    return { _tag: "Start" as const, turnId: turn.turnId, resumeFirst: false };
  });

export const admitRetry = (
  journal: SupervisorJournal,
  retry: HarnessProcessSupervisorRetry,
  busy: boolean,
) =>
  Effect.gen(function* () {
    yield* journal.assertOpen;
    const state = journal.current();
    const request = { ...retry, kind: "retry" as const, inputSha256: null };
    const receipt = state.retries.find((item) => item.requestId === retry.requestId);
    if (
      state.turns.some((item) => item.request.requestId === retry.requestId) ||
      (receipt !== undefined && receipt.turnId !== retry.turnId)
    )
      return blocker(state, "conflicting-id");
    if (receipt !== undefined) return { _tag: "Existing" as const, turnId: retry.turnId };
    const denied = priorDenial(state, request);
    if (denied !== undefined) return denied;
    if (state.turn?.turnId !== retry.turnId)
      return yield* deny(journal, request, blocker(state, "conflicting-id"));
    if (busy || state.phase !== "blocked" || state.blocker?.recovery !== "retry")
      return yield* deny(journal, request, state.blocker ?? blocker(state, "busy"));
    const admitted = yield* journal.change(
      (prior) =>
        prior.blocker?.recovery !== "retry"
          ? prior
          : {
              ...prior,
              phase: "reset-observed",
              failedRestarts: 0,
              blocker: null,
              retries: [...prior.retries, retry],
            },
      "retried",
    );
    if (admitted.phase === "blocked") return admitted.blocker!;
    return { _tag: "Start" as const, turnId: retry.turnId, resumeFirst: true };
  });
