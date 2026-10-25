import * as Effect from "effect/Effect";
import { HarnessProcessResumeDriverError } from "./errors.ts";

/** RPC cancellation does not cancel a remote write. Join that exact call before recovery runs. */
export function ownedPromise<A>(
  operation: HarnessProcessResumeDriverError["operation"],
  controller: AbortController,
  run: () => Promise<A>,
  allowCancelled = false,
): Effect.Effect<A, HarnessProcessResumeDriverError> {
  return Effect.suspend(() => {
    const task = Promise.resolve().then(() => {
      if (!allowCancelled) controller.signal.throwIfAborted();
      return run();
    });
    return Effect.tryPromise({
      try: () => task,
      catch: (cause) => new HarnessProcessResumeDriverError({ operation, cause }),
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.promise(async () => {
          controller.abort();
          await task.catch(() => undefined);
        }),
      ),
    );
  });
}
