import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { SessionClientError } from "./RunnerSessionClient.ts";
import { makeSessionOutbox } from "./RunnerSessionOutbox.ts";
import { makeMemorySessionStore } from "./sessionStoreTesting.ts";

describe("RunnerSessionOutbox", () => {
  it.effect("lands every row in order and once, however often sending fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = makeMemorySessionStore({ "claude/s": ["held"] });
        const outbox = yield* makeSessionOutbox({
          client: store.client,
          stallAfterMs: 60_000,
          onFailure: () => Effect.void,
        });
        store.state.failures = 3;
        const first = yield* outbox.enqueue("claude/s", ["a", "b"]);
        const second = yield* outbox.enqueue("claude/s", ["c"]);
        // Positions count this machine's rows; the store already held one.
        expect([first, second]).toEqual([2, 3]);
        const landed = yield* Effect.forkChild(outbox.reach("claude/s", second, 60_000));
        yield* TestClock.adjust(10_000);
        yield* Fiber.join(landed);

        expect(store.streams.get("claude/s")).toEqual(["held", "a", "b", "c"]);
        expect(yield* outbox.pending).toBe(false);
      }),
    ),
  );

  it.effect("reports a stall once and keeps every row until the store is back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = makeMemorySessionStore();
        const failures: Array<string> = [];
        const outbox = yield* makeSessionOutbox({
          client: store.client,
          stallAfterMs: 1_000,
          onFailure: (message) => Effect.sync(() => void failures.push(message)),
        });
        store.state.down = true;
        const upTo = yield* outbox.enqueue("codex/r.jsonl", ["a"]);
        yield* outbox.enqueue("codex/r.jsonl", ["b"]);
        // Waiting gives up; the rows do not.
        const waited = yield* Effect.forkChild(
          Effect.flip(outbox.reach("codex/r.jsonl", upTo, 500)),
        );
        yield* TestClock.adjust(2_000);
        expect((yield* Fiber.join(waited))._tag).toBe("SessionNotSavedError");
        expect(yield* outbox.stalled).toBe(true);
        expect(failures).toHaveLength(1);
        yield* TestClock.adjust(20_000);
        expect(failures).toHaveLength(1);

        store.state.down = false;
        const drained = yield* Effect.forkChild(outbox.drain(60_000));
        yield* TestClock.adjust(10_000);
        yield* Fiber.join(drained);
        expect(store.streams.get("codex/r.jsonl")).toEqual(["a", "b"]);
        expect(yield* outbox.stalled).toBe(false);
      }),
    ),
  );

  it.effect("gives up a stream the store refuses, failing every wait on it at once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = makeMemorySessionStore();
        const failures: Array<string> = [];
        const outbox = yield* makeSessionOutbox({
          client: {
            ...store.client,
            append: () => Effect.fail(new SessionClientError({ message: "replaced", status: 403 })),
          },
          stallAfterMs: 60_000,
          onFailure: (message) => Effect.sync(() => void failures.push(message)),
        });
        const position = yield* outbox.enqueue("claude/s", ["a"]);
        const refused = yield* Effect.flip(outbox.reach("claude/s", position, 60_000));
        expect(refused._tag).toBe("SessionNotSavedError");
        expect(failures).toHaveLength(1);
        expect(yield* outbox.stalled).toBe(true);
      }),
    ),
  );
});
