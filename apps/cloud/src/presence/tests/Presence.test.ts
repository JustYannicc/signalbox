import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Presence from "../Presence.ts";
import { makeAccess } from "./accessFixture.ts";

const actor = (userId: string) => ({ userId });
const thread = "canonical-thread";
const folder = "canonical-folder";
const setup = (users = ["reader", "one", "two"]) =>
  Effect.gen(function* () {
    const access = makeAccess();
    for (const userId of users) {
      access.allow(userId, thread);
      access.allow(userId, folder);
    }
    const context = yield* Layer.build(Presence.layer.pipe(Layer.provide(access.layer)));
    const presence = yield* Presence.Presence.pipe(Effect.provideContext(context));
    const join = (userId: string, connection: string, target = thread) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(yield* Scope.Scope);
        yield* presence.join(actor(userId), target, connection).pipe(Scope.provide(scope));
        return { leave: Scope.close(scope, Exit.void) };
      });
    const read = (target = thread) =>
      presence.view(actor("reader"), target).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    return { access, presence, join, read };
  });

describe("Presence", () => {
  it.effect(
    "sticky invalidation before registration rejects a join and withdraws an unread view",
    () =>
      Effect.gen(function* () {
        const { presence, access, read } = yield* setup();
        access.invalidateNextOpen("Revoked");
        const joined = yield* presence.join(actor("one"), thread, "web").pipe(Effect.result);
        expect(Result.isFailure(joined) && joined.failure.reason).toBe("access");
        expect(yield* read()).toEqual({ _tag: "Snapshot", people: [] });
        access.invalidateNextOpen("Reset");
        expect(yield* presence.view(actor("reader"), thread).pipe(Stream.runCollect)).toEqual([
          { _tag: "Reset" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "deduplicates devices and teammates at an exact target, without publishing observers",
    () =>
      Effect.gen(function* () {
        const { join, read } = yield* setup();
        expect(yield* read()).toEqual({ _tag: "Snapshot", people: [] });
        yield* join("one", "web");
        yield* join("one", "phone");
        yield* join("two", "desktop");
        expect(yield* read()).toEqual({ _tag: "Snapshot", people: ["one", "two"] });
        expect(yield* read(folder)).toEqual({ _tag: "Snapshot", people: [] });
      }).pipe(Effect.scoped),
  );

  it.effect("closing an older join cannot erase a replacement using the same connection key", () =>
    Effect.gen(function* () {
      const { join, read } = yield* setup();
      const { leave: leaveOld } = yield* join("one", "connection");
      const { leave: leaveNew } = yield* join("one", "connection");
      yield* leaveOld;
      yield* leaveOld;
      expect(yield* read()).toEqual({ _tag: "Snapshot", people: ["one"] });
      yield* leaveNew;
      expect(yield* read()).toEqual({ _tag: "Snapshot", people: [] });
    }).pipe(Effect.scoped),
  );

  it.effect("a slow subscriber receives current people, not queued stale rosters", () =>
    Effect.gen(function* () {
      const { presence, join } = yield* setup();
      const pull = yield* Stream.toPull(presence.view(actor("reader"), thread));
      expect(yield* pull).toEqual([{ _tag: "Snapshot", people: [] }]);
      const { leave } = yield* join("one", "web");
      yield* leave;
      yield* join("two", "phone");
      expect(yield* pull).toEqual([{ _tag: "Update", people: ["two"] }]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "publisher revocation removes all devices before an already-queued view is pulled",
    () =>
      Effect.gen(function* () {
        const { presence, join, access } = yield* setup();
        const pull = yield* Stream.toPull(presence.view(actor("reader"), thread));
        yield* pull;
        yield* join("one", "web");
        yield* join("one", "phone");
        yield* join("two", "desktop");
        access.invalidate("one", thread, "Revoked");
        expect(yield* pull).toEqual([{ _tag: "Update", people: ["two"] }]);
      }).pipe(Effect.scoped),
  );

  it.effect("observer revocation withdraws a queued roster and reopening reauthorizes", () =>
    Effect.gen(function* () {
      const { presence, join, access, read } = yield* setup();
      const pull = yield* Stream.toPull(presence.view(actor("reader"), thread));
      yield* pull;
      yield* join("one", "web");
      access.invalidate("reader", thread, "Revoked");
      expect(yield* pull).toEqual([{ _tag: "Revoked" }]);
      const reopened = yield* read().pipe(Effect.result);
      expect(Result.isFailure(reopened) && reopened.failure.reason).toBe("access");
    }).pipe(Effect.scoped),
  );

  it.effect("reset clears the old generation; a new view requires a new guard", () =>
    Effect.gen(function* () {
      const { presence, join, access, read } = yield* setup();
      yield* join("one", "web");
      const pull = yield* Stream.toPull(presence.view(actor("reader"), thread));
      yield* pull;
      access.invalidate("reader", thread, "Reset");
      expect(yield* pull).toEqual([{ _tag: "Reset" }]);
      access.allow("reader", thread);
      expect(yield* read()).toEqual({ _tag: "Snapshot", people: ["one"] });
    }).pipe(Effect.scoped),
  );

  it.effect("authority failure stays unavailable instead of becoming an empty roster", () =>
    Effect.gen(function* () {
      const { presence, join, access } = yield* setup();
      yield* join("one", "web");
      const pull = yield* Stream.toPull(presence.view(actor("reader"), thread));
      yield* pull;
      access.invalidate("one", thread, "dependency");
      const failed = yield* pull.pipe(Effect.result);
      expect(Result.isFailure(failed) && failed.failure._tag).toBe("PresenceUnavailable");
    }).pipe(Effect.scoped),
  );

  it.effect("missing and inaccessible targets are indistinguishable for both operations", () =>
    Effect.gen(function* () {
      const { presence } = yield* setup();
      for (const target of ["missing", "private-thread"]) {
        const deniedView = yield* presence
          .view(actor("reader"), target)
          .pipe(Stream.runCollect, Effect.asVoid, Effect.result);
        const deniedJoin = yield* presence.join(actor("reader"), target, "web").pipe(Effect.result);
        for (const result of [deniedView, deniedJoin]) {
          expect(Result.isFailure(result) && result.failure.message).toBe(
            "Presence is unavailable.",
          );
        }
      }
    }).pipe(Effect.scoped),
  );
});
