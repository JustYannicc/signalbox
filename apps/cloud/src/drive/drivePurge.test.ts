import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "./DriveDirectory.ts";
import { MAIN_REF, threadRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";

const DRIVE = "my/personal/user_1";
const writer = (threadId: string) => ({
  threadId,
  userId: "user_1",
  generation: 1,
  live: true,
  packsAfter: 0,
});

const drive = (drives: ReturnType<typeof makeMemoryDrives>, id = DRIVE) =>
  DriveDirectory.use((directory) => Effect.succeed(directory.forDrive(id))).pipe(
    Effect.provide(drives.layer),
  );

describe("drive purge", () => {
  it.effect("collects a due public orphan pack and preserves a pack reachable from main", () =>
    Effect.gen(function* () {
      const drives = makeMemoryDrives();
      const liveRepo = makeRepo();
      const orphanRepo = makeRepo();
      try {
        liveRepo.write("live.txt", "still here\n");
        const live = liveRepo.commit("live");
        const livePack = liveRepo.pack([live]);
        yield* uploadPack({ driveId: DRIVE, threadId: "t1", ...livePack }).pipe(
          Effect.provide(drives.layer),
        );
        const handle = yield* drive(drives);
        yield* handle.open(writer("t1"));
        yield* handle.updateRefs(writer("t1"), [{ name: threadRef("t1"), old: null, new: live }]);
        yield* handle.reconcile(writer("t1"), { expectedMain: null, newMain: live });

        orphanRepo.write("orphan.txt", "collect me\n");
        const orphan = orphanRepo.commit("orphan");
        const orphanPack = orphanRepo.pack([orphan]);
        yield* uploadPack({ driveId: DRIVE, threadId: "t2", ...orphanPack }).pipe(
          Effect.provide(drives.layer),
        );

        const gcAfter = 30 * 24 * 60 * 60 * 1_000;
        yield* handle.purgeThread({
          purgeId: "purge-thread-1",
          threadId: "t1",
          purgedAt: 0,
          gcAfter,
        });
        expect((yield* handle.open(writer("t1")))._tag).toBe("refused");

        const receipt = yield* handle.collectPurgedPacks("purge-thread-1", gcAfter, 100);
        expect(receipt?.removedPackNames).toContain(orphanPack.name);
        expect(receipt?.removedPackNames).not.toContain(livePack.name);
        expect(drives.bucket.keys()).toContain(`${DRIVE}/packs/pack-${livePack.name}.pack`);
        expect(drives.bucket.keys()).not.toContain(`${DRIVE}/packs/pack-${orphanPack.name}.pack`);
      } finally {
        liveRepo.cleanup();
        orphanRepo.cleanup();
      }
    }),
  );

  it.effect("purges a sole-owner folder drive and revokes its indexed membership", () =>
    Effect.gen(function* () {
      const drives = makeMemoryDrives();
      const handle = yield* drive(drives, "folder/personal/folder-1");
      yield* handle.setup({
        name: "Folder",
        members: [{ userId: "user_1", email: "one@example.com", name: null, role: "owner" }],
      });

      const result = yield* handle.purgeDrive({
        userId: "user_1",
        purgeId: "purge-drive-1",
        purgedAt: 1,
        gcAfter: 100,
      });
      expect(result._tag).toBe("purged");
      expect(yield* handle.role("user_1")).toBeNull();
      expect(yield* handle.pendingAccess()).toMatchObject([
        { userId: "user_1", role: null, revision: 2 },
      ]);
    }),
  );

  it.effect("retains a folder drive that has another active member", () =>
    Effect.gen(function* () {
      const drives = makeMemoryDrives();
      const handle = yield* drive(drives, "folder/personal/folder-2");
      const owner = { userId: "user_1", email: "one@example.com", name: null };
      yield* handle.setup({ name: "Folder", members: [{ ...owner, role: "owner" }] });
      yield* handle.share(
        owner,
        {
          userId: "user_2",
          email: "two@example.com",
          name: null,
        },
        "viewer",
      );

      const result = yield* handle.purgeDrive({
        userId: "user_1",
        purgeId: "purge-drive-2",
        purgedAt: 1,
        gcAfter: 100,
      });
      expect(result).toMatchObject({ _tag: "retained" });
      expect(yield* handle.members()).toHaveLength(2);
      expect(yield* handle.ref(MAIN_REF)).toBeNull();
    }),
  );
});
