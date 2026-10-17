import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ThreadObjectError } from "../ThreadAccess.ts";

/**
 * How long a subscription waits before resuming after its thread object went
 * away: quick for an eviction, backing off to 5 s while the object stays down.
 */
const resumeDelay = (failed: number) => Math.min(250 * 2 ** (failed - 1), 5_000);
const MAX_FAILED_RESUMES = 20;
const isThreadObjectError = Schema.is(ThreadObjectError);

/**
 * A thread object's live stream that survives the object: when it is evicted
 * or redeployed mid-stream, `open` runs again after a backoff. A live stream
 * only ends because its object went away. `delivered` sees every item, so
 * `open` can resume after the last one.
 */
export const resuming = <A, E>(input: {
  readonly operation: string;
  readonly threadId: ThreadId;
  readonly open: Stream.Stream<A, E | ThreadObjectError>;
  readonly delivered: (item: A) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    // Failed attempts in a row; any delivered item resets it.
    const failures = yield* Ref.make(0);
    const attempt = (): Stream.Stream<A, E | ThreadObjectError> =>
      input.open.pipe(
        Stream.tap((item) => Ref.set(failures, 0).pipe(Effect.andThen(input.delivered(item)))),
        Stream.concat(
          Stream.fail(
            new ThreadObjectError({
              operation: input.operation,
              cause: "The thread object closed the stream.",
            }),
          ),
        ),
        Stream.catchIf(
          (error): error is ThreadObjectError => isThreadObjectError(error),
          (error) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const failed = yield* Ref.updateAndGet(failures, (count) => count + 1);
                // An object that keeps failing without delivering anything is broken, not busy.
                if (failed > MAX_FAILED_RESUMES) return Stream.fail(error);
                yield* Effect.logWarning(`thread ${input.operation} interrupted; resuming`, {
                  threadId: input.threadId,
                  attempt: failed,
                  cause: error,
                });
                yield* Effect.sleep(resumeDelay(failed));
                return Stream.suspend(attempt);
              }),
            ),
        ),
      );
    return attempt();
  });
