import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

type Transition =
  | "connecting"
  | "resuming"
  | "snapshot"
  | "snapshot_retry"
  | "marker_emitted"
  | "marker_received"
  | "synchronized"
  | "timeout"
  | "failed";

interface SynchronizationContext {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly stream: "thread" | "shell";
  readonly side: "client" | "server";
  readonly mode?: "resume" | "snapshot";
  readonly reason?: string;
  readonly afterSequence?: number;
  readonly elapsedMs?: number;
}

/** One completed span per transition, even while the subscription stays open. */
export const traceSynchronization = (transition: Transition, context: SynchronizationContext) => {
  const attributes = {
    "sync.transition": transition,
    "sync.stream": context.stream,
    "sync.side": context.side,
    ...(context.environmentId === undefined ? {} : { "environment.id": context.environmentId }),
    ...(context.threadId === undefined ? {} : { "thread.id": context.threadId }),
    ...(context.mode === undefined ? {} : { "sync.mode": context.mode }),
    ...(context.reason === undefined ? {} : { "sync.reason": context.reason }),
    ...(context.afterSequence === undefined
      ? {}
      : { "sync.after_sequence": context.afterSequence }),
    ...(context.elapsedMs === undefined ? {} : { "sync.elapsed_ms": context.elapsedMs }),
  };
  return Effect.gen(function* () {
    const span = yield* Effect.currentSpan.pipe(Effect.option);
    yield* (
      transition === "timeout" || transition === "failed"
        ? Effect.logWarning("Synchronization transition")
        : Effect.logInfo("Synchronization transition")
    ).pipe(
      Effect.annotateLogs({
        ...attributes,
        ...(Option.isSome(span) ? { traceId: span.value.traceId } : {}),
      }),
    );
  }).pipe(Effect.withSpan(`orchestration.sync.${transition}`, { attributes }));
};
