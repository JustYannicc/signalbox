import * as Effect from "effect/Effect";

import { type SessionClient, SessionClientError } from "./RunnerSessionClient.ts";

/**
 * A thread's session store in memory, answering as the cloud's does
 * (`apps/cloud/src/thread/session/SessionRows.ts`): rows land only directly
 * after the stored ones. `failures` makes that many calls fail first;
 * `down` fails every call until cleared.
 */
export const makeMemorySessionStore = (initial: Record<string, ReadonlyArray<string>> = {}) => {
  const streams = new Map<string, Array<string>>(
    Object.entries(initial).map(([stream, rows]) => [stream, [...rows]]),
  );
  const state = { failures: 0, down: false, appends: 0 };
  const attempt = Effect.suspend(() => {
    if (state.down || state.failures > 0) {
      state.failures = Math.max(0, state.failures - 1);
      return Effect.fail(new SessionClientError({ message: "the store is unreachable" }));
    }
    return Effect.void;
  });
  const client: SessionClient = {
    append: (input) =>
      Effect.andThen(
        attempt,
        Effect.sync(() => {
          state.appends += 1;
          const rows = streams.get(input.stream) ?? [];
          if (input.offset > rows.length) return { _tag: "gap", count: rows.length } as const;
          rows.push(...input.rows.slice(rows.length - input.offset));
          streams.set(input.stream, rows);
          return { _tag: "stored", count: rows.length } as const;
        }),
      ),
    streams: (prefix) =>
      Effect.andThen(
        attempt,
        Effect.sync(() =>
          [...streams.entries()]
            .filter(([stream]) => stream.startsWith(prefix))
            .map(([stream, rows]) => ({ stream, count: rows.length })),
        ),
      ),
    rows: (stream) =>
      Effect.andThen(
        attempt,
        Effect.sync(() => [...(streams.get(stream) ?? [])]),
      ),
  };
  return { client, streams, state };
};
