import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as UserDirectory from "../../user/UserDirectory.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import * as ThreadStore from "../ThreadStore.ts";
import * as TerminalOutbox from "./TerminalOutbox.ts";
import { wire } from "../terminalSync.ts";

export const deliverPendingTerminals = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const store = yield* ThreadStore.ThreadStore;
  const outbox = yield* TerminalOutbox.TerminalOutbox;
  const pending = yield* engine.apply((projection) =>
    Effect.gen(function* () {
      const owner = projection === null ? null : yield* Effect.orDie(store.owner);
      const batch = owner === null ? null : yield* Effect.orDie(outbox.pending);
      return {
        events: [],
        result:
          batch === null || owner === null || projection === null
            ? null
            : {
                ownerId: owner.userId,
                delivery: {
                  ...batch,
                  threadId: projection.thread.id,
                  contextId: owner.contextId,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                },
              },
      };
    }),
  );
  if (pending === null) return true;
  const users = yield* UserDirectory.UserDirectory;
  return yield* users
    .forUser(pending.ownerId)
    .recordTerminalEvents(wire.delivery.encode(pending.delivery))
    .pipe(
      Effect.andThen(
        engine.apply(() =>
          Effect.as(Effect.orDie(outbox.acknowledge(pending.delivery.sequence)), {
            events: [],
            result: undefined,
          }),
        ),
      ),
      Effect.andThen(Effect.map(Effect.orDie(outbox.hasPending), (pending) => !pending)),
      Effect.catchTags({
        UserObjectError: () =>
          Effect.logWarning("terminal delivery failed; will retry", {
            threadId: pending.delivery.threadId,
          }).pipe(Effect.as(false)),
      }),
    );
});
