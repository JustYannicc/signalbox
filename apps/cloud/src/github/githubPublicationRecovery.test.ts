import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { publicationFixture } from "./githubPublicationTesting.ts";

describe("cloud publication recovery", () => {
  it.effect("retries after both the accepted push reply and its head read are lost", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.losePushReply = true;
      f.settings.loseRecoveryHead = true;
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      expect(f.github.head("main")).toBe(f.main);
      expect(yield* f.drive.remote()).toMatchObject({ repository: f.input.repository });
      f.settings.failBranchReads = false;
      expect((yield* f.publish()).status).toBe("pushed");
      expect(f.receiveCalls()).toHaveLength(1);
      expect(f.creations).toHaveLength(1);
    }),
  );

  it.effect("refuses recovering a lost create reply without its ownership marker", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.loseCreateReply = true;
      f.settings.failRepositoryReads = true;
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      f.repositories.get(f.input.repository)!.description = "An unrelated repository";
      f.settings.failRepositoryReads = false;
      expect((yield* f.publish().pipe(Effect.flip)).message).toContain("does not match");
      expect(yield* f.drive.remote()).toBeNull();
      expect(f.receiveCalls()).toHaveLength(0);
      expect(f.creations).toHaveLength(1);
    }),
  );

  it.effect("never recreates a recorded repository that disappeared", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.failCleanup = true;
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      f.repositories.delete(f.input.repository);
      expect((yield* f.publish().pipe(Effect.flip)).message).toContain("Nothing was recreated");
      expect(f.creations).toHaveLength(1);
      expect(f.receiveCalls()).toHaveLength(0);
      expect(yield* f.drive.remote()).toBeNull();
    }),
  );

  it.effect("recovers a lost create reply using its marker, then clears the marker", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.loseCreateReply = true;
      expect((yield* f.publish()).status).toBe("pushed");
      expect(f.creations).toHaveLength(1);
      expect(f.repositories.get(f.input.repository)?.description).toBeNull();
      expect(f.github.head("main")).toBe(f.main);
    }),
  );

  it.effect("retries a lost create reply across calls without creating twice", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.loseCreateReply = true;
      f.settings.failRepositoryReads = true;
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      expect(f.creations).toHaveLength(1);
      expect(yield* f.drive.remote()).toBeNull();
      expect(f.repositories.get(f.input.repository)?.description).toMatch(
        /^Signalbox publication /,
      );
      f.settings.failRepositoryReads = false;
      expect((yield* f.publish()).status).toBe("pushed");
      expect(f.creations).toHaveLength(1);
      expect(f.receiveCalls()).toHaveLength(1);
    }),
  );

  it.effect("keeps its durable repository identity when marker cleanup fails", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.failCleanup = true;
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* f.drive.remote()).toBeNull();
      f.repositories.get(f.input.repository)!.description = "Written by the owner";
      f.settings.failCleanup = false;
      expect((yield* f.publish()).status).toBe("pushed");
      expect(f.repositories.get(f.input.repository)?.description).toBe("Written by the owner");
      expect(f.creations).toHaveLength(1);
    }),
  );

  it.effect("recovers a lost push reply by reading the accepted head without pushing twice", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.losePushReply = true;
      expect((yield* f.publish()).status).toBe("pushed");
      expect(f.github.head("main")).toBe(f.main);
      expect((yield* f.publish()).status).toBe("pushed");
      expect(f.receiveCalls()).toHaveLength(1);
      expect(f.creations).toHaveLength(1);
    }),
  );

  it.effect("preserves binding and refs through a failed push and retries its original head", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      const before = yield* f.drive.refs("existing-thread");
      f.settings.failPush = true;
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      const bound = yield* f.drive.refs("existing-thread");
      expect(bound).toEqual({
        ...before,
        remote: { provider: "github", repository: f.input.repository, defaultBranch: "main" },
      });
      expect(f.github.head("main")).toBeNull();
      expect(
        (yield* f.drive.replaceMain("user_1", { expectedMain: f.main, newMain: f.thread }))._tag,
      ).toBe("ok");
      f.settings.failPush = false;
      expect((yield* f.publish()).status).toBe("pushed");
      expect(f.github.head("main")).toBe(f.main);
      expect((yield* f.drive.refs("existing-thread")).main).toBe(f.thread);
      expect(f.creations).toHaveLength(1);
    }),
  );

  it.effect("refuses an existing unrelated repository and allows choosing a new name", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.repositories.set("octo/taken", f.repositoryJson("octo/taken"));
      expect((yield* f.publish({ repository: "octo/taken" }).pipe(Effect.flip)).message).toContain(
        "already exists",
      );
      expect(yield* f.drive.remote()).toBeNull();
      expect(f.creations).toHaveLength(0);
      expect(f.receiveCalls()).toHaveLength(0);
      expect((yield* f.publish()).status).toBe("pushed");
      expect(f.repositories.get("octo/taken")?.description).toBeNull();
      expect(f.creations).toHaveLength(1);
    }),
  );

  it.effect("refuses changed metadata or account once creation has begun", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.failPush = true;
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      const before = yield* f.drive.refs("existing-thread");
      const calls = f.github.calls.length;
      for (const change of [
        { repository: "octo/different" },
        { visibility: "public" as const },
        { protocol: "ssh" as const },
        { remoteName: "upstream" },
      ]) {
        expect((yield* f.publish(change).pipe(Effect.result))._tag).toBe("Failure");
      }
      f.settings.accountId = 999;
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      f.settings.accountId = 1;
      f.settings.accountLogin = "someone-else";
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* f.drive.refs("existing-thread")).toEqual(before);
      expect(f.creations).toHaveLength(1);
      expect(f.receiveCalls()).toHaveLength(1);
      expect(
        f.github.calls
          .slice(calls)
          .some((call) => call.startsWith("POST api/") || call.startsWith("PATCH api/")),
      ).toBe(false);
    }),
  );

  it.effect("refuses a replacement repository id after the original create was recorded", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.failCleanup = true;
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      f.repositories.get(f.input.repository)!.id = 999;
      f.settings.failCleanup = false;
      expect((yield* f.publish().pipe(Effect.flip)).message).toContain("does not match");
      expect(yield* f.drive.remote()).toBeNull();
      expect(f.receiveCalls()).toHaveLength(0);
    }),
  );

  it.effect.each(["Git Repository is empty.", "Repository is locked."])(
    "handles an initial ref 409: %s",
    (message) =>
      Effect.gen(function* () {
        const f = yield* publicationFixture();
        f.settings.branchConflict = message;
        const result = yield* f.publish().pipe(Effect.result);
        expect(result._tag).toBe(message === "Git Repository is empty." ? "Success" : "Failure");
        expect(f.github.head("main")).toBe(message === "Git Repository is empty." ? f.main : null);
        expect(f.receiveCalls()).toHaveLength(message === "Git Repository is empty." ? 1 : 0);
      }),
  );
});
