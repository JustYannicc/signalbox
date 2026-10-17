import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { GitHubError } from "./GitHubApi.ts";
import { makeReadCache } from "./cloudReadCache.ts";

const keyOf = (input: { readonly token: string; readonly repository: string }) => ({
  key: JSON.stringify(input),
  scope: input.repository,
  token: input.token,
});
const input = { token: "fixture-token", repository: "acme/web" };

it.effect("shares concurrent host reads and refreshes only the requested repository", () =>
  Effect.gen(function* () {
    const cache = makeReadCache();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const read = cache.memoize(
      (_input: typeof input) =>
        Effect.gen(function* () {
          calls += 1;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return calls;
        }),
      keyOf,
    );
    const a = yield* read(input).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const b = yield* read(input).pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(a)).toBe(1);
    expect(yield* Fiber.join(b)).toBe(1);
    expect(yield* read(input)).toBe(1);
    yield* cache.invalidate("another/repo");
    expect(yield* read(input)).toBe(1);
    yield* cache.invalidate(input.repository);
    expect(yield* read(input)).toBe(2);
    expect(yield* read({ ...input, token: "different-token" })).toBe(3);
  }),
);

it.effect("expires successful reads and retries a transient failure", () =>
  Effect.gen(function* () {
    const cache = makeReadCache();
    let calls = 0;
    const read = cache.memoize(
      (_input: typeof input) =>
        Effect.suspend(() => {
          calls += 1;
          return calls === 1
            ? Effect.fail(
                new GitHubError({ operation: "summary", status: 502, message: "Unavailable" }),
              )
            : Effect.succeed(calls);
        }),
      keyOf,
      1000,
    );
    expect((yield* read(input).pipe(Effect.result))._tag).toBe("Failure");
    expect(yield* read(input)).toBe(2);
    yield* TestClock.adjust(1001);
    expect(yield* read(input)).toBe(3);
  }),
);

it.effect("honors a credential's host rate limit across reads and explicit refreshes", () =>
  Effect.gen(function* () {
    const cache = makeReadCache();
    const now = yield* Clock.currentTimeMillis;
    let firstCalls = 0;
    let otherCalls = 0;
    const first = cache.memoize(
      (_input: typeof input) =>
        Effect.suspend(() => {
          firstCalls += 1;
          return Effect.fail(
            new GitHubError({
              operation: "summary",
              status: 429,
              retryAt: now + 1000,
              message: "Rate limited",
            }),
          );
        }),
      keyOf,
    );
    const other = cache.memoize((_input: typeof input) => Effect.sync(() => ++otherCalls), keyOf);
    yield* first(input).pipe(Effect.result);
    yield* cache.invalidate();
    expect((yield* other(input).pipe(Effect.result))._tag).toBe("Failure");
    expect(otherCalls).toBe(0);
    expect(yield* other({ ...input, token: "another-token" })).toBe(1);
    yield* TestClock.adjust(1001);
    expect(yield* other(input)).toBe(2);
    expect(firstCalls).toBe(1);
  }),
);
