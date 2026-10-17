import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { layerMemoryStore } from "../testing.ts";
import * as UserStore from "../user/UserStore.ts";
import { OWNER_ONLY } from "./browserPolicy.ts";
import { type KernelApi, KernelApiError } from "./KernelApi.ts";
import { memoryKernel } from "./memoryKernel.ts";
import * as PersonBrowsers from "./PersonBrowsers.ts";

/**
 * The person's browser against a Kernel in memory (#574): sessions per
 * thread, one writer, and the owner rule.
 */

const OWNER = "user_owner";

const signedIn = (kernel: KernelApi | null) =>
  Layer.effectDiscard(
    UserStore.UserStore.use((store) => store.recordSignIn({ id: OWNER, email: "o@example.test" })),
  ).pipe(Layer.provideMerge(PersonBrowsers.layer(kernel)), Layer.provideMerge(layerMemoryStore));

describe("the person's browser (#574)", () => {
  it.effect("opens one session per thread, reused while Kernel runs it", () => {
    const kernel = memoryKernel();
    return Effect.gen(function* () {
      const browsers = yield* PersonBrowsers.PersonBrowsers;
      const first = yield* browsers.open({ threadId: "thread-a", requester: OWNER });
      expect(first).toEqual({
        _tag: "ready",
        sessionId: "browser-1",
        cdpWsUrl: "wss://cdp.test/browser-1",
      });
      expect(yield* browsers.open({ threadId: "thread-a", requester: OWNER })).toEqual(first);
      expect(kernel.created).toHaveLength(1);
      // The profile is the person's, by hash, created once.
      expect(kernel.profiles).toHaveLength(1);
      expect(kernel.profiles[0]).toMatch(/^sb-[0-9a-f]{32}$/);
      expect(kernel.profiles[0]).not.toContain(OWNER);
      expect(kernel.created[0]).toMatchObject({
        profile: { name: kernel.profiles[0], save_changes: true },
        tags: { signalbox_thread: "thread-a" },
      });
    }).pipe(Effect.provide(signedIn(kernel.api)));
  });

  it.effect("lets only one open session write the profile back", () => {
    const kernel = memoryKernel();
    return Effect.gen(function* () {
      const browsers = yield* PersonBrowsers.PersonBrowsers;
      yield* browsers.open({ threadId: "thread-a", requester: OWNER });
      yield* browsers.open({ threadId: "thread-b", requester: OWNER });
      expect(kernel.created.map((request) => request.profile.save_changes)).toEqual([true, false]);

      // Once the writer ends, the next session writes.
      yield* browsers.end({ threadId: "thread-a", sessionId: "browser-1" });
      yield* browsers.open({ threadId: "thread-c", requester: OWNER });
      expect(kernel.created[2]?.profile.save_changes).toBe(true);
    }).pipe(Effect.provide(signedIn(kernel.api)));
  });

  it.effect("opens anew after Kernel timed the session out, which frees the writer", () => {
    const kernel = memoryKernel();
    return Effect.gen(function* () {
      const browsers = yield* PersonBrowsers.PersonBrowsers;
      yield* browsers.open({ threadId: "thread-a", requester: OWNER });
      kernel.browsers.delete("browser-1");
      const again = yield* browsers.open({ threadId: "thread-a", requester: OWNER });
      expect(again).toMatchObject({ _tag: "ready", sessionId: "browser-2" });
      expect(kernel.created[1]?.profile.save_changes).toBe(true);
    }).pipe(Effect.provide(signedIn(kernel.api)));
  });

  it.effect("ends only the thread's own session, once", () => {
    const kernel = memoryKernel();
    return Effect.gen(function* () {
      const browsers = yield* PersonBrowsers.PersonBrowsers;
      yield* browsers.open({ threadId: "thread-a", requester: OWNER });
      yield* browsers.end({ threadId: "thread-b", sessionId: "browser-1" });
      expect(kernel.deleted).toEqual([]);

      yield* browsers.end({ threadId: "thread-a", sessionId: "browser-1" });
      yield* browsers.end({ threadId: "thread-a", sessionId: "browser-1" });
      expect(kernel.deleted).toEqual(["browser-1"]);
      // The ended thread gets a new session next time.
      expect(yield* browsers.open({ threadId: "thread-a", requester: OWNER })).toMatchObject({
        sessionId: "browser-2",
      });
    }).pipe(Effect.provide(signedIn(kernel.api)));
  });

  it.effect(
    "closes every session before forgetting re-login state and deleting the profile",
    () => {
      const kernel = memoryKernel();
      return Effect.gen(function* () {
        const browsers = yield* PersonBrowsers.PersonBrowsers;
        yield* browsers.open({ threadId: "thread-a", requester: OWNER });
        yield* browsers.open({ threadId: "thread-b", requester: OWNER });
        const profileName = kernel.profiles[0]!;

        const status = yield* browsers.profileStatus;
        expect(status).toEqual({ available: true });
        yield* browsers.clearProfile(() =>
          Effect.sync(() => void kernel.calls.push("forget-sign-ins")),
        );

        expect(kernel.browsers.size).toBe(0);
        expect(kernel.profiles).toEqual([]);
        expect(kernel.deletedProfiles).toEqual([expect.stringMatching(/^sb-[0-9a-f]{32}$/)]);
        const forgottenAt = kernel.calls.indexOf("forget-sign-ins");
        const profileDeletedAt = kernel.calls.findIndex((call) =>
          call.startsWith("delete-profile:"),
        );
        const sessionsDeletedAt = kernel.calls
          .map((call, index) => (call.startsWith("delete-browser:") ? index : -1))
          .filter((index) => index >= 0);
        expect(sessionsDeletedAt).toHaveLength(2);
        expect(sessionsDeletedAt.every((index) => index < forgottenAt)).toBe(true);
        expect(forgottenAt).toBeLessThan(profileDeletedAt);

        expect(yield* browsers.open({ threadId: "thread-c", requester: OWNER })).toMatchObject({
          _tag: "ready",
        });
        expect(kernel.profiles).toEqual([profileName]);
      }).pipe(Effect.provide(signedIn(kernel.api)));
    },
  );

  it.effect("leaves the profile and login records when any session cannot close", () => {
    const kernel = memoryKernel();
    kernel.refuseDeleteWith(
      new KernelApiError({
        operation: "deleteBrowser",
        status: 503,
        code: null,
        message: "Kernel is unavailable.",
      }),
    );
    return Effect.gen(function* () {
      const browsers = yield* PersonBrowsers.PersonBrowsers;
      yield* browsers.open({ threadId: "thread-a", requester: OWNER });
      let forgot = false;
      const error = yield* Effect.flip(
        browsers.clearProfile(() => Effect.sync(() => void (forgot = true))),
      );

      expect(error._tag).toBe("KernelApiError");
      expect(forgot).toBe(false);
      expect(kernel.deletedProfiles).toEqual([]);
      expect(kernel.profiles).toHaveLength(1);
    }).pipe(Effect.provide(signedIn(kernel.api)));
  });

  it.effect("serializes profile deletion with a Managed Auth sign-in", () => {
    const kernel = memoryKernel();
    return Effect.gen(function* () {
      const browsers = yield* PersonBrowsers.PersonBrowsers;
      const signInStarted = yield* Deferred.make<string>();
      const finishSignIn = yield* Deferred.make<void>();
      const signIn = yield* Effect.forkChild(
        browsers.withSignIn({
          threadId: null,
          run: (profileName) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(signInStarted, profileName);
              yield* Deferred.await(finishSignIn);
              return profileName;
            }),
        }),
      );
      const profileName = yield* Deferred.await(signInStarted);
      const clear = yield* Effect.forkChild(browsers.clearProfile(() => Effect.void));
      yield* Effect.yieldNow;
      expect(kernel.deletedProfiles).toEqual([]);

      yield* Deferred.succeed(finishSignIn, undefined);
      expect(yield* Fiber.join(signIn)).toBe(profileName);
      yield* Fiber.join(clear);
      expect(kernel.deletedProfiles).toEqual([profileName]);
    }).pipe(Effect.provide(signedIn(kernel.api)));
  });

  it.effect("refuses another person's turn without asking Kernel", () => {
    const kernel = memoryKernel();
    return Effect.gen(function* () {
      const browsers = yield* PersonBrowsers.PersonBrowsers;
      expect(yield* browsers.open({ threadId: "thread-a", requester: "user_teammate" })).toEqual({
        _tag: "refused",
        message: OWNER_ONLY,
      });
      expect(kernel.created).toEqual([]);
      expect(kernel.profiles).toEqual([]);
    }).pipe(Effect.provide(signedIn(kernel.api)));
  });

  it.effect("answers Kernel's failure in its own words, and unconfigured without a key", () => {
    const kernel = memoryKernel();
    kernel.refuseWith(
      new KernelApiError({
        operation: "createBrowser",
        status: 429,
        code: "org_limit_exceeded",
        message: "Concurrent browser limit reached.",
      }),
    );
    return Effect.gen(function* () {
      const browsers = yield* PersonBrowsers.PersonBrowsers;
      expect(yield* browsers.profileStatus).toEqual({ available: true });
      expect(yield* browsers.open({ threadId: "thread-a", requester: OWNER })).toEqual({
        _tag: "refused",
        message:
          "Kernel couldn't open a browser: Concurrent browser limit reached (org_limit_exceeded, HTTP 429).",
      });
      const without = yield* PersonBrowsers.PersonBrowsers.pipe(Effect.provide(signedIn(null)));
      expect(yield* without.profileStatus).toEqual({ available: false });
      expect(yield* without.open({ threadId: "thread-a", requester: OWNER })).toEqual({
        _tag: "unconfigured",
      });
      const clearFailure = yield* Effect.flip(without.clearProfile(() => Effect.void));
      expect(clearFailure._tag).toBe("PersonBrowserUnavailableError");
    }).pipe(Effect.provide(signedIn(kernel.api)));
  });
});
