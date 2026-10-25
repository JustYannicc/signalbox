import type { OrchestrationV2CommandOutputFrame } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** Replace snapshots cost more than appends, so match the hub's slower resync cadence. */
export const COMMAND_OUTPUT_REPLACE_INTERVAL_MS = 500;

/** Called under the engine lock, so the initial read and subscription cannot miss a commit. */
export const commandOutputStream = (
  initial: OrchestrationV2CommandOutputFrame,
  invalidations: PubSub.PubSub<void>,
  read: Effect.Effect<OrchestrationV2CommandOutputFrame>,
) =>
  Effect.gen(function* () {
    if (!initial.running) return Stream.succeed(initial);
    const scope = yield* Scope.make();
    const subscription = yield* PubSub.subscribe(invalidations).pipe(Scope.provide(scope));
    let previous = initial;
    return Stream.concat(
      Stream.succeed(initial),
      Stream.fromSubscription(subscription).pipe(
        Stream.mapEffect(() =>
          Effect.sleep(COMMAND_OUTPUT_REPLACE_INTERVAL_MS).pipe(Effect.andThen(read)),
        ),
        Stream.filter(
          (frame) =>
            frame.text !== previous.text ||
            frame.truncated !== previous.truncated ||
            frame.running !== previous.running,
        ),
        Stream.map((frame) => {
          const before = previous;
          previous = frame;
          const suffix = frame.text.slice(before.text.length);
          // Resume snapshots are replayable terminal input, including split escapes.
          // Extending their shared prefix preserves the client's terminal state.
          return frame.running &&
            !frame.truncated &&
            !before.truncated &&
            frame.text.startsWith(before.text) &&
            suffix.length > 0 &&
            suffix.length <= 16 * 1024
            ? { ...frame, kind: "append" as const, text: suffix }
            : frame;
        }),
      ),
    ).pipe(
      Stream.takeUntil((frame) => !frame.running),
      Stream.ensuring(Scope.close(scope, Exit.void)),
    );
  });
