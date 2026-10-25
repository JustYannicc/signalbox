import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { uploadPack } from "../drive/DriveUploads.ts";
import { DRIVE, publicationFixture, USER } from "./githubPublicationTesting.ts";

describe("cloud publication preflight", () => {
  it.effect("refuses incomplete committed ancestry before creating a repository", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture({ history: false });
      const packed = f.source.pack([f.main], [f.first]);
      expect(
        (yield* uploadPack({
          driveId: DRIVE,
          threadId: "existing-thread",
          ...packed,
          remoteHead: f.main,
        }).pipe(Effect.provide(f.cloud.drives.layer)))._tag,
      ).toBe("ok");
      expect((yield* f.drive.replaceMain(USER, { expectedMain: null, newMain: f.main }))._tag).toBe(
        "ok",
      );
      const before = yield* f.drive.refs("existing-thread");
      expect((yield* f.publish().pipe(Effect.flip)).message).toContain(
        "complete history is not available",
      );
      expect(f.creations).toHaveLength(0);
      expect(f.receiveCalls()).toHaveLength(0);
      expect(yield* f.drive.refs("existing-thread")).toEqual(before);
    }),
  );

  it.effect("refuses unreadable pack storage before creating or binding", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      const before = yield* f.drive.refs("existing-thread");
      yield* Effect.promise(() => f.cloud.drives.bucket.delete([...f.cloud.drives.bucket.keys()]));
      expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
      expect(f.creations).toHaveLength(0);
      expect(f.receiveCalls()).toHaveLength(0);
      expect(yield* f.drive.refs("existing-thread")).toEqual(before);
    }),
  );

  it.effect(
    "refuses overwriting a remote branch that someone populated before the initial push",
    () =>
      Effect.gen(function* () {
        const f = yield* publicationFixture();
        f.settings.failPush = true;
        expect((yield* f.publish().pipe(Effect.result))._tag).toBe("Failure");
        f.git(["fetch", f.source.dir, `${f.first}:refs/heads/main`]);
        f.settings.failPush = false;
        expect((yield* f.publish().pipe(Effect.flip)).message).toContain("Nothing was overwritten");
        expect(f.github.head("main")).toBe(f.first);
        expect(f.receiveCalls()).toHaveLength(1);
        expect(f.creations).toHaveLength(1);
        expect(yield* f.drive.remote()).toMatchObject({ repository: f.input.repository });
      }),
  );
});
